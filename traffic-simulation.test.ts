/**
 * 6車線比較 渋滞シミュレーション テスト
 *
 * src/core/ のシミュレーションコア
 * （DOM / THREE 非依存のシミュレーションロジック）を検証する。
 *
 * 実行方法:  vp test run  (npm test)
 */
import { describe, expect, test } from 'vitest';
import { CONST, createRng, Vehicle, World } from './src/core';

/* ---------- ヘルパー: シナリオ実行 ---------- */
const DT = 1 / 20;

interface ScenarioOptions {
  seconds?: number;
  measureFrom?: number;
  interval?: number;
}
interface ScenarioResult {
  L: number;
  R: number;
  minGap: number;
  world: World;
}

function runScenario(seed: number, opts: ScenarioOptions = {}): ScenarioResult {
  const seconds = opts.seconds || 300;
  const measureFrom = opts.measureFrom || 120;
  const w = new World({ rng: createRng(seed), spawnInterval: opts.interval || 800 });
  w.populateInitial();
  let sumL = 0,
    sumR = 0,
    samples = 0,
    minGap = Infinity;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    w.step(DT);
    const t = i * DT;
    if (i % 10 === 0) {
      // 貫通チェック（同一車線・車線変更中でない車両同士）
      for (const sec of ['L', 'R'] as const) {
        const arr = w._sec[sec];
        for (let k = 1; k < arr.length; k++) {
          const a = arr[k - 1],
            b = arr[k];
          if (a.lc.state !== 'none' || b.lc.state !== 'none') continue;
          if (a.lane !== b.lane) continue;
          const gap = Math.abs(b.z - a.z) - (a.length + b.length) / 2;
          if (gap < minGap) minGap = gap;
        }
      }
      if (t >= measureFrom) {
        sumL += w.computeSection('L').score;
        sumR += w.computeSection('R').score;
        samples++;
      }
    }
  }
  return { L: sumL / samples, R: sumR / samples, minGap, world: w };
}

/* ============================================================
   1. メイン要件: 渋滞スコアに約10ポイントの差が出ること
   人間らしい運転モデル(ブレーキ連鎖・渋滞波)導入後は渋滞が準安定
   状態を持つため、シードごとの差は±4〜5程度ゆらぐ。個別シードは
   10±4.5、5シード平均は10±2で判定する。
   ============================================================ */
const SEEDS = [11, 22, 33, 44, 55];
const DIFF_TARGET = 10,
  DIFF_TOL = 4.5;

// 5シードのシナリオは重い(シミュレーション内時間300秒×5)ので、
// 最初に必要になった時に一度だけ計算して全テストで共有する
let _results: ({ seed: number } & ScenarioResult)[] | null = null;
function getResults(): ({ seed: number } & ScenarioResult)[] {
  _results ??= SEEDS.map((seed) => ({ seed, ...runScenario(seed) }));
  return _results;
}

describe('渋滞スコア差（義務あり vs 義務なし）', () => {
  test.each(SEEDS)('seed=%i: 義務なし側のスコアが約10ポイント高い', (seed) => {
    const r = getResults().find((x) => x.seed === seed)!;
    const diff = Math.round((r.R - r.L) * 10) / 10; // 表示と同じ精度で判定する
    expect(
      r.R,
      `義務なし側の方が渋滞するはずが逆転 (L=${r.L.toFixed(1)}, R=${r.R.toFixed(1)})`,
    ).toBeGreaterThan(r.L);
    expect(
      Math.abs(diff - DIFF_TARGET),
      `スコア差 ${diff.toFixed(1)} が目標 ${DIFF_TARGET}±${DIFF_TOL} の範囲外`,
    ).toBeLessThanOrEqual(DIFF_TOL);
  });

  test(`5シード平均のスコア差が ${DIFF_TARGET}±2 に収まる`, () => {
    const results = getResults();
    const avg = results.reduce((s, r) => s + (r.R - r.L), 0) / results.length;
    expect(Math.abs(avg - DIFF_TARGET), `平均差 ${avg.toFixed(1)} が範囲外`).toBeLessThanOrEqual(2);
  });
});

/* ============================================================
   2. 「追いつかれた車両の義務」の挙動
   ============================================================ */
describe('追いつかれた車両の義務', () => {
  test('義務あり区間: 速い後続車が迫ると左車線へ譲る', () => {
    const w = new World({ rng: createRng(1), spawnInterval: 1e9 });
    const slow = new Vehicle(w, 'L', 1, 0, 'Truck', 16);
    slow.speed = 16;
    const fast = new Vehicle(w, 'L', 1, 40, 'SportsCar', 34);
    fast.speed = 32;
    w.vehicles.push(slow, fast);
    let yielded = false;
    for (let i = 0; i < 400; i++) {
      w.step(DT);
      if (slow.lane === 2 || (slow.lc.state !== 'none' && slow.lc.to === 2)) {
        yielded = true;
        break;
      }
    }
    expect(yielded, '左車線(レーン2)へ譲る車線変更が発生しなかった').toBe(true);
  });

  test('義務なし区間: 同じ状況でも譲らない', () => {
    const w = new World({ rng: createRng(1), spawnInterval: 1e9 });
    const slow = new Vehicle(w, 'R', 1, 0, 'Truck', 16);
    slow.speed = 16;
    const fast = new Vehicle(w, 'R', 1, 40, 'SportsCar', 34);
    fast.speed = 32;
    w.vehicles.push(slow, fast);
    let yielded = false;
    for (let i = 0; i < 400; i++) {
      w.step(DT);
      if (slow.lane === 2 || (slow.lc.state !== 'none' && slow.lc.to === 2)) {
        yielded = true;
        break;
      }
    }
    expect(yielded, '義務がないのに左車線へ譲ってしまった').toBe(false);
  });
});

/* ============================================================
   3. 追い越し挙動（両区間共通）
   ============================================================ */
describe('追い越し', () => {
  test.each([
    ['義務あり', 'L'],
    ['義務なし', 'R'],
  ] as const)('%s区間: 遅い前方車がいれば右(追い越し車線)へ出る', (_name, sec) => {
    const w = new World({ rng: createRng(2), spawnInterval: 1e9 });
    const slow = new Vehicle(w, sec, 2, 0, 'Truck', 16);
    slow.speed = 16;
    const fast = new Vehicle(w, sec, 2, 60, 'SportsCar', 34);
    fast.speed = 34;
    w.vehicles.push(slow, fast);
    let overtook = false;
    // 人間モデルでは「しばらく抑え込まれてから」追い越しを決意するため長めに観察
    for (let i = 0; i < 1600; i++) {
      w.step(DT);
      if (fast.lane < 2 || (fast.lc.state !== 'none' && fast.lc.to < 2)) {
        overtook = true;
        break;
      }
    }
    expect(overtook, '追い越し車線への車線変更が発生しなかった').toBe(true);
  });

  test('義務あり区間: 追い越し後は走行車線へ復帰する', () => {
    const w = new World({ rng: createRng(3), spawnInterval: 1e9 });
    const v = new Vehicle(w, 'L', 0, 0, 'Sedan', 26);
    v.speed = 26;
    w.vehicles.push(v);
    let returned = false;
    for (let i = 0; i < Math.round((CONST.OVERTAKE_LANE_RETURN_TIME + 4) / DT); i++) {
      w.step(DT);
      if (v.lane === 1 || (v.lc.state !== 'none' && v.lc.to === 1)) {
        returned = true;
        break;
      }
    }
    expect(returned, '追い越し車線から復帰しなかった').toBe(true);
  });

  test('義務なし区間: 復帰は義務あり区間より明確に遅い設定', () => {
    const w = new World({ rng: createRng(4), spawnInterval: 1e9 });
    for (let i = 0; i < 40; i++) {
      const v = new Vehicle(w, 'R', 0, i * 10, 'Sedan', 26);
      expect(
        v.returnTime,
        `returnTime=${v.returnTime.toFixed(1)}s は短すぎる`,
      ).toBeGreaterThanOrEqual(CONST.OVERTAKE_LANE_RETURN_TIME * 3);
    }
  });
});

/* ============================================================
   3.5 加速復帰: 追いつかれた時、塞がれた復帰先へ加速して戻る (Issue #11)
   ============================================================ */
describe('加速復帰（追いつかれ時に並走車を抜いて戻る）', () => {
  // 共通シナリオ: 追い越し車線の a が後続の chaser に追いつかれ、復帰先の
  // レーン1は並走車 side に塞がれている。blocker は side のキープレフトを封じる
  function setup(sideAheadBlocked: boolean) {
    const w = new World({ rng: createRng(9), spawnInterval: 1e9 });
    const a = new Vehicle(w, 'L', 0, 0, 'Sedan', 25);
    a.speed = 25;
    const side = new Vehicle(w, 'L', 1, 0, 'Sedan', 25); // 同速の並走車 = 待っても抜けない
    side.speed = 25;
    const blocker = new Vehicle(w, 'L', 2, -18, 'Truck', 16);
    blocker.speed = 16;
    const chaser = new Vehicle(w, 'L', 0, 55, 'SportsCar', 34);
    chaser.speed = 32;
    w.vehicles.push(a, side, blocker, chaser);
    if (sideAheadBlocked) {
      // side の前方を塞ぎ「前に出ても戻るスペースがない」状況にする
      const wall = new Vehicle(w, 'L', 1, -22, 'Sedan', 24.5);
      wall.speed = 24.5;
      wall.keepLeft = false; // wall がレーン2へ逸れて前方が空いてしまうのを防ぐ
      w.vehicles.push(wall);
    }
    return { w, a, side };
  }

  test('並走車との速度差が小さく前方が空いていれば、加速して前に出て復帰する', () => {
    const { w, a } = setup(false);
    let boosted = false,
      returned = false;
    for (let i = 0; i < Math.round(25 / DT); i++) {
      w.step(DT);
      if (a.returnBoostT > 0) boosted = true;
      if (a.lane === 1 || (a.lc.state !== 'none' && a.lc.to === 1)) {
        returned = true;
        break;
      }
    }
    expect(boosted, '加速復帰(returnBoostT)が発動しなかった').toBe(true);
    expect(returned, '加速しても走行車線へ復帰できなかった').toBe(true);
  });

  test('並走車の前方が塞がっている(戻る見込みがない)場合は加速しない', () => {
    const { w, a } = setup(true);
    for (let i = 0; i < Math.round(10 / DT); i++) {
      w.step(DT);
      expect(a.returnBoostT, '見込みがないのに加速復帰が発動した').toBe(0);
    }
  });
});

/* ============================================================
   4. 安全性: 車両の貫通防止
   ============================================================ */
describe('衝突回避・貫通防止', () => {
  test('長時間運転しても同一車線内で車両が重ならない (許容 -1.0m)', () => {
    let worstGap = Infinity;
    for (const r of getResults()) worstGap = Math.min(worstGap, r.minGap);
    expect(worstGap, `車間が ${worstGap.toFixed(2)}m まで縮まり貫通が発生`).toBeGreaterThan(-1.0);
  });
});

/* ============================================================
   5. ハザードランプ
   ============================================================ */
describe('ハザードランプ', () => {
  test('停止列の最後尾はハザードを点灯し、後続が停車したら次の最後尾へ移る', () => {
    const w = new World({ rng: createRng(3), spawnInterval: 1e9 });
    const tail = new Vehicle(w, 'L', 1, 0, 'Sedan', 25);
    tail.speed = 0;
    w.vehicles.push(tail);
    w.step(DT);
    expect(tail.hazard, '最後尾(後続なし)でハザードが点かない').toBe(true);
    const f = new Vehicle(w, 'L', 1, 8, 'Sedan', 25); // 直後で停車した後続
    f.speed = 0;
    w.vehicles.push(f);
    w.step(DT);
    expect(tail.hazard, '後続が停車してもハザードが消えない').toBe(false);
    expect(f.hazard, '新しい最後尾にハザードが移らない').toBe(true);
  });
});

/* ============================================================
   6. 渋滞スコアの計算式 (速度75% + 密度25%)
   ============================================================ */
describe('渋滞スコア算出', () => {
  test('スコア = (0.75×速度要因 + 0.25×密度要因) × 100', () => {
    const w = new World({ rng: createRng(5), spawnInterval: 1e9 });
    for (let i = 0; i < 4; i++) {
      const v = new Vehicle(w, 'L', i % 3, i * 30, 'Sedan', 24);
      v.speed = 16;
      w.vehicles.push(v);
    }
    const s = w.computeSection('L');
    const expected = (0.75 * (1 - 16 / CONST.REF_SPEED) + 0.25 * (4 / CONST.MAX_PER_SECTION)) * 100;
    expect(Math.abs(s.score - expected), 'スコア計算式が仕様と不一致').toBeLessThanOrEqual(1e-9);
    expect(s.n, `車両数カウント不一致: ${s.n}`).toBe(4);
  });

  test('車両ゼロのときスコアは0', () => {
    const w = new World({ rng: createRng(6) });
    expect(w.computeSection('L').score, 'スコアが0でない').toBe(0);
  });
});

/* ============================================================
   7. ペア生成
   ============================================================ */
describe('車両ペア生成', () => {
  test('ペアは同タイプ・同初期速度で左右に1台ずつ生成される', () => {
    const w = new World({ rng: createRng(7), spawnInterval: 1e9 });
    expect(w.spawnPair(), 'spawnPairが失敗').toBe(true);
    expect(w.vehicles.length, `生成台数 ${w.vehicles.length} ≠ 2`).toBe(2);
    const [a, b] = w.vehicles;
    expect(a.section === 'L' && b.section === 'R', 'セクション割り当てが不正').toBe(true);
    expect(a.typeName, 'ペアのタイプが不一致').toBe(b.typeName);
    expect(
      Math.abs(a.initialDesiredSpeed - b.initialDesiredSpeed),
      'ペアの初期速度が不一致',
    ).toBeLessThanOrEqual(1e-12);
  });

  test('最大車両数280台を超えない', () => {
    const w = new World({ rng: createRng(8), spawnInterval: 50 });
    w.populateInitial();
    for (let i = 0; i < Math.round(300 / DT); i++) w.step(DT);
    expect(
      w.vehicles.length,
      `${w.vehicles.length}台 > 上限${CONST.MAX_VEHICLES}台`,
    ).toBeLessThanOrEqual(CONST.MAX_VEHICLES);
  });
});

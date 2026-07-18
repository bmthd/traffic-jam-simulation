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
  nL: number;
  nR: number;
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
    sumNL = 0,
    sumNR = 0,
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
        const sL = w.computeSection('L'),
          sR = w.computeSection('R');
        sumL += sL.score;
        sumR += sR.score;
        sumNL += sL.n;
        sumNR += sR.n;
        samples++;
      }
    }
  }
  return {
    L: sumL / samples,
    R: sumR / samples,
    nL: sumNL / samples,
    nR: sumNR / samples,
    minGap,
    world: w,
  };
}

/* ============================================================
   1. メイン要件: 渋滞スコアに約10ポイントの差が出ること
   人間らしい運転モデル(ブレーキ連鎖・渋滞波)に加え、Issue #12 で
   流入・流出(混雑側への滞留)が入り台数自体も揺らぐようになったため、
   シードごとの差は±7程度ゆらぐ。個別シードは 10±7、
   10シード平均は 10±2 で判定する。
   ============================================================ */
const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110];
const DIFF_TARGET = 10,
  DIFF_TOL = 7;

// 10シードのシナリオは重い(シミュレーション内時間300秒×10)ので、
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

  test(`10シード平均のスコア差が ${DIFF_TARGET}±2 に収まる`, () => {
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
  // レーン1は並走車 side に塞がれている。ロジックは左右共通(区間差は
  // returnTime のみ)なので、両区間で同じ挙動になることを検証する
  function setup(sec: 'L' | 'R', sideAheadBlocked: boolean) {
    const w = new World({ rng: createRng(9), spawnInterval: 1e9 });
    const a = new Vehicle(w, sec, 0, 0, 'Sedan', 25);
    a.speed = 25;
    // 義務なし区間は「戻る気になるまで」が長いだけでロジックは同じ。
    // 戻る気になった後の挙動を比較するため復帰判定時間を揃える
    a.returnTime = CONST.OVERTAKE_LANE_RETURN_TIME;
    const side = new Vehicle(w, sec, 1, 0, 'Sedan', 25); // 同速の並走車 = 待っても抜けない
    side.speed = 25;
    side.keepLeft = false; // side がレーン移動して前方が空いてしまうのを防ぐ
    side.camper = false;
    const chaser = new Vehicle(w, sec, 0, 55, 'SportsCar', 34);
    chaser.speed = 32;
    w.vehicles.push(a, side, chaser);
    if (sideAheadBlocked) {
      // side の前方を塞ぎ「前に出ても戻るスペースがない」状況にする
      const wall = new Vehicle(w, sec, 1, -22, 'Sedan', 24.5);
      wall.speed = 24.5;
      wall.keepLeft = false; // wall がレーン移動して前方が空いてしまうのを防ぐ
      wall.camper = false;
      w.vehicles.push(wall);
    }
    return { w, a, side };
  }

  test.each([
    ['義務あり', 'L'],
    ['義務なし', 'R'],
  ] as const)(
    '%s区間: 並走車との速度差が小さく前方が空いていれば、加速して前に出て復帰する',
    (_name, sec) => {
      const { w, a } = setup(sec, false);
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
    },
  );

  test.each([
    ['義務あり', 'L'],
    ['義務なし', 'R'],
  ] as const)(
    '%s区間: 並走車の前方が塞がっている(戻る見込みがない)場合は加速しない',
    (_name, sec) => {
      const { w, a } = setup(sec, true);
      for (let i = 0; i < Math.round(10 / DT); i++) {
        w.step(DT);
        expect(a.returnBoostT, '見込みがないのに加速復帰が発動した').toBe(0);
      }
    },
  );
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
   7. 流入・流出と滞留 (Issue #12)
   流入需要は左右で同ペースだが、流出は各道路の交通状況に従う。
   混んでいる側は捌けが遅いぶん車両が滞留し、台数が多くなる。
   ============================================================ */
describe('流入・流出と滞留 (Issue #12)', () => {
  test('流入需要は左右同ペース(混雑側の流入が上回ることはない)', () => {
    for (const r of getResults()) {
      expect(
        r.world.stats.inflow.L,
        `seed=${r.seed}: 混雑側(R)の流入 ${r.world.stats.inflow.R} が L ${r.world.stats.inflow.L} を上回った`,
      ).toBeGreaterThanOrEqual(r.world.stats.inflow.R);
    }
  });

  test('流出は交通状況に従う: 流れの良い義務あり側の方が多く捌ける', () => {
    let outL = 0,
      outR = 0;
    for (const r of getResults()) {
      outL += r.world.stats.outflow.L;
      outR += r.world.stats.outflow.R;
    }
    expect(outL, `流出台数 L=${outL} <= R=${outR}: 混雑側の方が捌けている`).toBeGreaterThan(outR);
    expect(outR, '流出が発生していない').toBeGreaterThan(0);
  });

  test('混雑側(義務なし)に車両が滞留し、平均台数が多くなる', () => {
    const results = getResults();
    const avgGap = results.reduce((s, r) => s + (r.nR - r.nL), 0) / results.length;
    expect(avgGap, `平均台数差 R-L = ${avgGap.toFixed(1)} 台で滞留が見えない`).toBeGreaterThan(2);
  });

  test('入口が受け入れ不能な間は入口待ち(waiting)の列に並ぶ', () => {
    const w = new World({ rng: createRng(9), spawnInterval: 1e9 }); // targetCount=24 (下限) → 片側12台
    for (let i = 0; i < 12; i++) {
      w.vehicles.push(new Vehicle(w, 'L', i % 3, -350 + i * 25, 'Sedan', 25));
    }
    expect(w.spawnPair(), 'spawnPairが失敗').toBe(true);
    const waitL = w.vehicles.filter((v) => v.section === 'L' && v.waiting);
    const activeR = w.vehicles.filter((v) => v.section === 'R' && !v.waiting);
    expect(waitL.length, '満杯の側が入口待ちにならない').toBe(1);
    expect(activeR.length, '空いている側がそのまま流入できない').toBe(1);
    // 席が空いたら入口待ちの車が流入する
    w.vehicles.splice(0, 1); // L側の1台が捌けたとする
    w.admitWaiting();
    expect(waitL[0].waiting, '空きができても入口待ちが解消されない').toBe(false);
  });

  test('終端まで走った車は一定割合で出口から流出する', () => {
    const w = new World({ rng: () => 0, spawnInterval: 1e9 }); // rng=0 → 必ず流出側の抽選
    const v = new Vehicle(w, 'L', 1, -CONST.ROAD_HALF - 7.9, 'Sedan', 25);
    v.speed = 25;
    w.vehicles.push(v);
    w.step(DT);
    expect(w.vehicles.length, '出口で流出しなかった').toBe(0);
    expect(w.stats.outflow.L, '流出が計上されていない').toBe(1);
  });

  test('流出しなかった車は環状線のように周回を続ける', () => {
    const w = new World({ rng: () => 0.99, spawnInterval: 1e9 }); // rng=0.99 → 必ず周回側の抽選
    const v = new Vehicle(w, 'L', 1, -CONST.ROAD_HALF - 7.9, 'Sedan', 25);
    v.speed = 25;
    w.vehicles.push(v);
    w.step(DT);
    expect(w.vehicles.length, '周回すべき車が消えた').toBe(1);
    expect(v.z, '反対側へ回り込んでいない').toBeGreaterThan(CONST.ROAD_HALF - 20);
  });
});

/* ============================================================
   8. ペア生成
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

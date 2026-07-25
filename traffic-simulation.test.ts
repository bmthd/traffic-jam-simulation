/**
 * 6車線比較 渋滞シミュレーション テスト
 *
 * src/core/ のシミュレーションコア
 * （DOM / THREE 非依存のシミュレーションロジック）を検証する。
 *
 * 実行方法:  vp test run  (npm test)
 */
import { describe, expect, test } from 'vitest';
import {
  CONST,
  createRng,
  mergeCongestion,
  nextArrivalDistance,
  Vehicle,
  World,
  WRAP_LENGTH,
} from './src/core';
import { isLandscapeViewport } from './src/render/camera-layout';
import { loopCopies } from './src/render/looping';

/* ---------- ヘルパー: シナリオ実行 ---------- */
const TIME_STEP = 1 / 20;

interface ScenarioOptions {
  seconds?: number;
  measureFrom?: number;
  interval?: number;
}
interface ScenarioResult {
  scoreL: number;
  scoreR: number;
  countL: number;
  countR: number;
  minGap: number;
  world: World;
}

function runScenario(seed: number, opts: ScenarioOptions = {}): ScenarioResult {
  const seconds = opts.seconds || 300;
  const measureFrom = opts.measureFrom || 120;
  const world = new World({ rng: createRng(seed), spawnInterval: opts.interval || 800 });
  world.populateInitial();
  let sumScoreL = 0,
    sumScoreR = 0,
    sumCountL = 0,
    sumCountR = 0,
    samples = 0,
    minGap = Infinity;
  const steps = Math.round(seconds / TIME_STEP);
  for (let i = 0; i < steps; i++) {
    world.step(TIME_STEP);
    const elapsed = i * TIME_STEP;
    if (i % 10 === 0) {
      // 貫通チェック（同一車線・車線変更中でない車両同士）
      for (const section of ['L', 'R'] as const) {
        const vehicles = world.sectionVehicles[section];
        for (let k = 1; k < vehicles.length; k++) {
          const ahead = vehicles[k - 1],
            behind = vehicles[k];
          if (ahead.laneChange.state !== 'none' || behind.laneChange.state !== 'none') continue;
          if (ahead.lane !== behind.lane) continue;
          const gap = Math.abs(behind.z - ahead.z) - (ahead.length + behind.length) / 2;
          if (gap < minGap) minGap = gap;
        }
      }
      if (elapsed >= measureFrom) {
        const statsL = world.computeSection('L'),
          statsR = world.computeSection('R');
        sumScoreL += statsL.score;
        sumScoreR += statsR.score;
        sumCountL += statsL.count;
        sumCountR += statsR.count;
        samples++;
      }
    }
  }
  return {
    scoreL: sumScoreL / samples,
    scoreR: sumScoreR / samples,
    countL: sumCountL / samples,
    countR: sumCountR / samples,
    minGap,
    world,
  };
}

/* ============================================================
   1. メイン要件: 渋滞スコアに約10ポイントの差が出ること
   人間らしい運転モデル(ブレーキ連鎖・渋滞波)に加え、Issue #12 で
   流入・流出(混雑側への滞留)が入り台数自体も揺らぐようになったため、
   シードごとの差の分布は広い(標準偏差 4〜5 程度)。そこで
   「約10ポイント」の大きさは10シード平均(10±2)で判定し、
   個別シードは「逆転しない・過大にならない」ことを判定する。
   ============================================================ */
const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110];
const DIFF_TARGET = 10;
const DIFF_MAX = DIFF_TARGET + 10; // 個別シードの上限(これを超えたら暴走の疑い)

// 10シードのシナリオは重い(シミュレーション内時間300秒×10)ので、
// 最初に必要になった時に一度だけ計算して全テストで共有する
let _results: ({ seed: number } & ScenarioResult)[] | null = null;
function getResults(): ({ seed: number } & ScenarioResult)[] {
  _results ??= SEEDS.map((seed) => ({ seed, ...runScenario(seed) }));
  return _results;
}

describe('渋滞スコア差（義務あり vs 義務なし）', () => {
  test.each(SEEDS)('seed=%i: 義務なし側のスコアが高い(逆転・暴走しない)', (seed) => {
    const result = getResults().find((entry) => entry.seed === seed)!;
    const diff = Math.round((result.scoreR - result.scoreL) * 10) / 10; // 表示と同じ精度で判定する
    expect(
      result.scoreR,
      `義務なし側の方が渋滞するはずが逆転 (L=${result.scoreL.toFixed(1)}, R=${result.scoreR.toFixed(1)})`,
    ).toBeGreaterThan(result.scoreL);
    expect(
      diff,
      `スコア差 ${diff.toFixed(1)} が上限 ${DIFF_MAX} を超過(暴走の疑い)`,
    ).toBeLessThanOrEqual(DIFF_MAX);
  });

  test(`10シード平均のスコア差が ${DIFF_TARGET}±2 に収まる`, () => {
    const results = getResults();
    const avg =
      results.reduce((sum, result) => sum + (result.scoreR - result.scoreL), 0) / results.length;
    expect(Math.abs(avg - DIFF_TARGET), `平均差 ${avg.toFixed(1)} が範囲外`).toBeLessThanOrEqual(2);
  });
});

/* ============================================================
   2. 「追いつかれた車両の義務」の挙動
   ============================================================ */
describe('追いつかれた車両の義務', () => {
  test('義務あり区間: 速い後続車が迫ると左車線へ譲る', () => {
    const world = new World({ rng: createRng(1), spawnInterval: 1e9 });
    const slow = new Vehicle(world, 'L', 1, 0, 'Truck', 16);
    slow.speed = 16;
    const fast = new Vehicle(world, 'L', 1, 40, 'SportsCar', 34);
    fast.speed = 32;
    world.vehicles.push(slow, fast);
    let yielded = false;
    for (let i = 0; i < 400; i++) {
      world.step(TIME_STEP);
      if (slow.lane === 2 || (slow.laneChange.state !== 'none' && slow.laneChange.to === 2)) {
        yielded = true;
        break;
      }
    }
    expect(yielded, '左車線(レーン2)へ譲る車線変更が発生しなかった').toBe(true);
  });

  test('義務なし区間: 同じ状況でも譲らない', () => {
    const world = new World({ rng: createRng(1), spawnInterval: 1e9 });
    const slow = new Vehicle(world, 'R', 1, 0, 'Truck', 16);
    slow.speed = 16;
    const fast = new Vehicle(world, 'R', 1, 40, 'SportsCar', 34);
    fast.speed = 32;
    world.vehicles.push(slow, fast);
    let yielded = false;
    for (let i = 0; i < 400; i++) {
      world.step(TIME_STEP);
      if (slow.lane === 2 || (slow.laneChange.state !== 'none' && slow.laneChange.to === 2)) {
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
  ] as const)('%s区間: 遅い前方車がいれば右(追い越し車線)へ出る', (_name, section) => {
    const world = new World({ rng: createRng(2), spawnInterval: 1e9 });
    const slow = new Vehicle(world, section, 2, 0, 'Truck', 16);
    slow.speed = 16;
    const fast = new Vehicle(world, section, 2, 60, 'SportsCar', 34);
    fast.speed = 34;
    world.vehicles.push(slow, fast);
    let overtook = false;
    // 人間モデルでは「しばらく抑え込まれてから」追い越しを決意するため長めに観察
    for (let i = 0; i < 1600; i++) {
      world.step(TIME_STEP);
      if (fast.lane < 2 || (fast.laneChange.state !== 'none' && fast.laneChange.to < 2)) {
        overtook = true;
        break;
      }
    }
    expect(overtook, '追い越し車線への車線変更が発生しなかった').toBe(true);
  });

  test('義務あり区間: 追い越し後は走行車線へ復帰する', () => {
    const world = new World({ rng: createRng(3), spawnInterval: 1e9 });
    const vehicle = new Vehicle(world, 'L', 0, 0, 'Sedan', 26);
    vehicle.speed = 26;
    world.vehicles.push(vehicle);
    let returned = false;
    for (let i = 0; i < Math.round((CONST.OVERTAKE_LANE_RETURN_TIME + 4) / TIME_STEP); i++) {
      world.step(TIME_STEP);
      if (
        vehicle.lane === 1 ||
        (vehicle.laneChange.state !== 'none' && vehicle.laneChange.to === 1)
      ) {
        returned = true;
        break;
      }
    }
    expect(returned, '追い越し車線から復帰しなかった').toBe(true);
  });

  test('義務なし区間: 復帰は義務あり区間より明確に遅い設定', () => {
    const world = new World({ rng: createRng(4), spawnInterval: 1e9 });
    for (let i = 0; i < 40; i++) {
      const vehicle = new Vehicle(world, 'R', 0, i * 10, 'Sedan', 26);
      expect(
        vehicle.returnTime,
        `returnTime=${vehicle.returnTime.toFixed(1)}s は短すぎる`,
      ).toBeGreaterThanOrEqual(CONST.OVERTAKE_LANE_RETURN_TIME * 3);
    }
  });
});

/* ============================================================
   3.5 加速復帰: 追いつかれた時、塞がれた復帰先へ加速して戻る (Issue #11)
   ============================================================ */
describe('加速復帰（追いつかれ時に並走車を抜いて戻る）', () => {
  // 共通シナリオ: 追い越し車線の overtaker が後続の chaser に追いつかれ、復帰先の
  // レーン1は並走車 side に塞がれている。ロジックは左右共通(区間差は
  // returnTime のみ)なので、両区間で同じ挙動になることを検証する
  function setup(section: 'L' | 'R', sideAheadBlocked: boolean) {
    const world = new World({ rng: createRng(9), spawnInterval: 1e9 });
    const overtaker = new Vehicle(world, section, 0, 0, 'Sedan', 25);
    overtaker.speed = 25;
    // 義務なし区間は「戻る気になるまで」が長いだけでロジックは同じ。
    // 戻る気になった後の挙動を比較するため復帰判定時間を揃える
    overtaker.returnTime = CONST.OVERTAKE_LANE_RETURN_TIME;
    const side = new Vehicle(world, section, 1, 0, 'Sedan', 25); // 同速の並走車 = 待っても抜けない
    side.speed = 25;
    side.keepLeft = false; // side がレーン移動して前方が空いてしまうのを防ぐ
    side.camper = false;
    const chaser = new Vehicle(world, section, 0, 55, 'SportsCar', 34);
    chaser.speed = 32;
    world.vehicles.push(overtaker, side, chaser);
    if (sideAheadBlocked) {
      // side の前方を塞ぎ「前に出ても戻るスペースがない」状況にする
      const wall = new Vehicle(world, section, 1, -22, 'Sedan', 24.5);
      wall.speed = 24.5;
      wall.keepLeft = false; // wall がレーン移動して前方が空いてしまうのを防ぐ
      wall.camper = false;
      world.vehicles.push(wall);
    }
    return { world, overtaker, side };
  }

  test.each([
    ['義務あり', 'L'],
    ['義務なし', 'R'],
  ] as const)(
    '%s区間: 並走車との速度差が小さく前方が空いていれば、加速して前に出て復帰する',
    (_name, section) => {
      const { world, overtaker } = setup(section, false);
      let boosted = false,
        returned = false;
      for (let i = 0; i < Math.round(25 / TIME_STEP); i++) {
        world.step(TIME_STEP);
        if (overtaker.returnBoostTimer > 0) boosted = true;
        if (
          overtaker.lane === 1 ||
          (overtaker.laneChange.state !== 'none' && overtaker.laneChange.to === 1)
        ) {
          returned = true;
          break;
        }
      }
      expect(boosted, '加速復帰(returnBoostTimer)が発動しなかった').toBe(true);
      expect(returned, '加速しても走行車線へ復帰できなかった').toBe(true);
    },
  );

  test.each([
    ['義務あり', 'L'],
    ['義務なし', 'R'],
  ] as const)(
    '%s区間: 並走車の前方が塞がっている(戻る見込みがない)場合は加速しない',
    (_name, section) => {
      const { world, overtaker } = setup(section, true);
      for (let i = 0; i < Math.round(10 / TIME_STEP); i++) {
        world.step(TIME_STEP);
        expect(overtaker.returnBoostTimer, '見込みがないのに加速復帰が発動した').toBe(0);
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
    for (const result of getResults()) worstGap = Math.min(worstGap, result.minGap);
    expect(worstGap, `車間が ${worstGap.toFixed(2)}m まで縮まり貫通が発生`).toBeGreaterThan(-1.0);
  });
});

/* ============================================================
   5. ハザードランプ
   ============================================================ */
describe('ハザードランプ', () => {
  test('停止列の最後尾はハザードを点灯し、後続が停車したら次の最後尾へ移る', () => {
    const world = new World({ rng: createRng(3), spawnInterval: 1e9 });
    const tail = new Vehicle(world, 'L', 1, 0, 'Sedan', 25);
    tail.speed = 0;
    world.vehicles.push(tail);
    world.step(TIME_STEP);
    expect(tail.hazard, '最後尾(後続なし)でハザードが点かない').toBe(true);
    const follower = new Vehicle(world, 'L', 1, 8, 'Sedan', 25); // 直後で停車した後続
    follower.speed = 0;
    world.vehicles.push(follower);
    world.step(TIME_STEP);
    expect(tail.hazard, '後続が停車してもハザードが消えない').toBe(false);
    expect(follower.hazard, '新しい最後尾にハザードが移らない').toBe(true);
  });
});

/* ============================================================
   6. 渋滞スコアの計算式 (速度75% + 密度25%)
   ============================================================ */
describe('渋滞スコア算出', () => {
  test('スコア = (0.75×速度要因 + 0.25×密度要因) × 100', () => {
    const world = new World({ rng: createRng(5), spawnInterval: 1e9 });
    for (let i = 0; i < 4; i++) {
      const vehicle = new Vehicle(world, 'L', i % 3, i * 30, 'Sedan', 24);
      vehicle.speed = 16;
      world.vehicles.push(vehicle);
    }
    const stats = world.computeSection('L');
    const expected = (0.75 * (1 - 16 / CONST.REF_SPEED) + 0.25 * (4 / CONST.MAX_PER_SECTION)) * 100;
    expect(Math.abs(stats.score - expected), 'スコア計算式が仕様と不一致').toBeLessThanOrEqual(
      1e-9,
    );
    expect(stats.count, `車両数カウント不一致: ${stats.count}`).toBe(4);
  });

  test('車両ゼロのときスコアは0', () => {
    const world = new World({ rng: createRng(6) });
    expect(world.computeSection('L').score, 'スコアが0でない').toBe(0);
  });
});

/* ============================================================
   7. 流入・流出と滞留 (Issue #12)
   流入需要は左右で同ペースだが、流出は各道路の交通状況に従う。
   混んでいる側は捌けが遅いぶん車両が滞留し、台数が多くなる。
   ============================================================ */
describe('流入・流出と滞留 (Issue #12)', () => {
  test('流入需要は左右同ペース(混雑側の流入が上回ることはない)', () => {
    for (const result of getResults()) {
      expect(
        result.world.stats.inflow.L,
        `seed=${result.seed}: 混雑側(R)の流入 ${result.world.stats.inflow.R} が L ${result.world.stats.inflow.L} を上回った`,
      ).toBeGreaterThanOrEqual(result.world.stats.inflow.R);
    }
  });

  test('流出は交通状況に従う: 流れの良い義務あり側の方が多く捌ける', () => {
    let outflowL = 0,
      outflowR = 0;
    for (const result of getResults()) {
      outflowL += result.world.stats.outflow.L;
      outflowR += result.world.stats.outflow.R;
    }
    expect(
      outflowL,
      `流出台数 L=${outflowL} <= R=${outflowR}: 混雑側の方が捌けている`,
    ).toBeGreaterThan(outflowR);
    expect(outflowR, '流出が発生していない').toBeGreaterThan(0);
  });

  test('混雑側(義務なし)に車両が滞留し、平均台数が多くなる', () => {
    const results = getResults();
    const avgGap =
      results.reduce((sum, result) => sum + (result.countR - result.countL), 0) / results.length;
    expect(avgGap, `平均台数差 R-L = ${avgGap.toFixed(1)} 台で滞留が見えない`).toBeGreaterThan(1);
  });

  test('入口が受け入れ不能な間は入口待ち(waiting)の列に並ぶ', () => {
    const world = new World({ rng: createRng(9), spawnInterval: 1e9 }); // targetCount=24 (下限) → 片側12台
    for (let i = 0; i < 12; i++) {
      world.vehicles.push(new Vehicle(world, 'L', i % 3, -350 + i * 25, 'Sedan', 25));
    }
    expect(world.spawnPair(), 'spawnPairが失敗').toBe(true);
    const waitingL = world.vehicles.filter((vehicle) => vehicle.section === 'L' && vehicle.waiting);
    const activeR = world.vehicles.filter((vehicle) => vehicle.section === 'R' && !vehicle.waiting);
    expect(waitingL.length, '満杯の側が入口待ちにならない').toBe(1);
    expect(activeR.length, '空いている側がそのまま流入できない').toBe(1);
    // 席が空いたら入口待ちの車が流入する
    world.vehicles.splice(0, 1); // L側の1台が捌けたとする
    world.admitWaiting();
    expect(waitingL[0].waiting, '空きができても入口待ちが解消されない').toBe(false);
  });

  test('終端まで走った車は一定割合で出口から流出する', () => {
    const world = new World({ rng: () => 0, spawnInterval: 1e9 }); // rng=0 → 必ず流出側の抽選
    const vehicle = new Vehicle(world, 'L', 1, -CONST.ROAD_HALF - 7.9, 'Sedan', 25);
    vehicle.speed = 25;
    world.vehicles.push(vehicle);
    world.step(TIME_STEP);
    expect(world.vehicles.length, '出口で流出しなかった').toBe(0);
    expect(world.stats.outflow.L, '流出が計上されていない').toBe(1);
  });

  test('流出しなかった車は環状線のように周回を続ける', () => {
    const world = new World({ rng: () => 0.99, spawnInterval: 1e9 }); // rng=0.99 → 必ず周回側の抽選
    const vehicle = new Vehicle(world, 'L', 1, -CONST.ROAD_HALF - 7.9, 'Sedan', 25);
    vehicle.speed = 25;
    world.vehicles.push(vehicle);
    world.step(TIME_STEP);
    expect(world.vehicles.length, '周回すべき車が消えた').toBe(1);
    expect(vehicle.z, '反対側へ回り込んでいない').toBeGreaterThan(CONST.ROAD_HALF - 20);
  });
});

/* ============================================================
   8. ペア生成
   ============================================================ */
describe('車両ペア生成', () => {
  test('ペアは同タイプ・同初期速度で左右に1台ずつ生成される', () => {
    const world = new World({ rng: createRng(7), spawnInterval: 1e9 });
    expect(world.spawnPair(), 'spawnPairが失敗').toBe(true);
    expect(world.vehicles.length, `生成台数 ${world.vehicles.length} ≠ 2`).toBe(2);
    const [vehicleL, vehicleR] = world.vehicles;
    expect(vehicleL.section === 'L' && vehicleR.section === 'R', 'セクション割り当てが不正').toBe(
      true,
    );
    expect(vehicleL.typeName, 'ペアのタイプが不一致').toBe(vehicleR.typeName);
    expect(
      Math.abs(vehicleL.initialDesiredSpeed - vehicleR.initialDesiredSpeed),
      'ペアの初期速度が不一致',
    ).toBeLessThanOrEqual(1e-12);
  });

  test('最大車両数280台を超えない', () => {
    const world = new World({ rng: createRng(8), spawnInterval: 50 });
    world.populateInitial();
    for (let i = 0; i < Math.round(300 / TIME_STEP); i++) world.step(TIME_STEP);
    expect(
      world.vehicles.length,
      `${world.vehicles.length}台 > 上限${CONST.MAX_VEHICLES}台`,
    ).toBeLessThanOrEqual(CONST.MAX_VEHICLES);
  });
});

/* ============================================================
   9. 「こちらがスムーズだった時間」の累積 (Issue #26)
   渋滞するかはランダムなので、一時的な優劣ではなく開始からの
   累積時間でどちらが混みやすい道路かを判断できるようにする。
   ============================================================ */
describe('スムーズだった時間の累積 (Issue #26)', () => {
  // 指定区間に、速度を揃えた車両を n 台置く(スコアを狙った値に作るため)
  function fill(world: World, section: 'L' | 'R', count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const vehicle = new Vehicle(world, section, i % 3, i * 30, 'Sedan', speed);
      vehicle.speed = speed;
      world.vehicles.push(vehicle);
    }
  }
  function makeWorld(): World {
    return new World({ rng: createRng(26), spawnInterval: 1e9 });
  }

  test('スコアが明確に低い(スムーズな)側に時間が積まれる', () => {
    const world = makeWorld();
    fill(world, 'L', 10, 25); // L は流れている
    fill(world, 'R', 10, 10); // R は詰まっている
    expect(world.smootherSection(), 'スムーズな側の判定が不正').toBe('L');
    world.accumulateSmoothTime(2);
    expect(world.smoothTime.L, 'L に時間が積まれていない').toBeCloseTo(2, 10);
    expect(world.smoothTime.R, 'R に時間が積まれた').toBe(0);
    expect(world.smoothTime.draw, '引き分けに時間が積まれた').toBe(0);
  });

  test('スコア差がデッドゾーン以内なら引き分けとして扱う', () => {
    const world = makeWorld();
    // 速度差 1m/s ≒ スコア差3ポイント(デッドゾーン5未満)。
    // この程度の揺らぎで優勢側が入れ替わらないことを保証する
    fill(world, 'L', 10, 25);
    fill(world, 'R', 10, 24);
    const diff = world.computeSection('L').score - world.computeSection('R').score;
    expect(Math.abs(diff), 'テスト前提: スコア差がデッドゾーン内でない').toBeLessThan(
      CONST.SMOOTH_SCORE_DEADZONE,
    );
    expect(world.smootherSection(), '僅差なのに優勢と判定された').toBe(null);
    world.accumulateSmoothTime(2);
    expect(world.smoothTime.draw, '引き分け時間が積まれていない').toBeCloseTo(2, 10);
    expect(world.smoothTime.L + world.smoothTime.R, '僅差なのに片側へ積まれた').toBe(0);
  });

  test('台数が少なすぎる間は判定を保留する(引き分け扱い)', () => {
    const world = makeWorld();
    fill(world, 'L', CONST.SMOOTH_MIN_COUNT, 25);
    fill(world, 'R', CONST.SMOOTH_MIN_COUNT, 5); // 大差だが台数不足
    expect(world.smootherSection(), '台数不足でも判定してしまった').toBe(null);
    world.accumulateSmoothTime(1);
    expect(world.smoothTime.draw, '判定保留分が引き分けに積まれていない').toBeCloseTo(1, 10);
  });

  test('累積時間の合計は経過時間に一致する', () => {
    const world = new World({ rng: createRng(27), spawnInterval: 800 });
    world.populateInitial();
    const steps = Math.round(30 / TIME_STEP);
    for (let i = 0; i < steps; i++) world.step(TIME_STEP);
    const { L, R, draw } = world.smoothTime;
    expect(L + R + draw, '累積時間の合計が経過時間と不一致').toBeCloseTo(world.time, 6);
    expect(world.time, 'シミュレーション時間が進んでいない').toBeGreaterThan(0);
  });

  test('リセットで累積時間もクリアされる', () => {
    const world = new World({ rng: createRng(28), spawnInterval: 800 });
    world.populateInitial();
    for (let i = 0; i < Math.round(20 / TIME_STEP); i++) world.step(TIME_STEP);
    const { L, R, draw } = world.smoothTime;
    expect(L + R + draw, 'テスト前提: 累積が発生していない').toBeGreaterThan(0);
    world.reset();
    expect(world.smoothTime, 'リセット後も累積が残っている').toEqual({ L: 0, R: 0, draw: 0 });
  });
});

/* ============================================================
   10. 車線配置 (Issue #28)
   両区間とも進行方向は -Z(前方 = z が小さい側)なので、進行方向を向いた
   時の「右」は +X 側。追い越し車線(index 0)が両区間とも右端に来ること、
   R区間がL区間の鏡像ではなく平行移動コピー(= 合流条件が完全に同一)で
   あることを検証する。
   ============================================================ */
describe('車線配置（追い越し車線は右側）', () => {
  const SECTIONS = ['L', 'R'] as const;

  test('前方は z が小さい側（進行方向 -Z）', () => {
    const world = new World({ rng: createRng(28), spawnInterval: 1e9 });
    const vehicle = new Vehicle(world, 'L', 1, 0, 'Sedan', 25);
    world.vehicles.push(vehicle);
    world.rebuildSectionIndex();
    for (let i = 0; i < 20; i++) world.step(TIME_STEP);
    expect(vehicle.z, '車両は -Z 方向へ進む').toBeLessThan(0);
  });

  test.each(SECTIONS)('%s区間: 追い越し車線が右端・加速車線が左外側', (section) => {
    const laneXs = CONST.LANE_X[section];
    // 右 = +X。index が増えるほど左へ並ぶ(0 = 追い越し, 2 = 走行, 3 = 加速車線)
    for (let lane = 1; lane < laneXs.length; lane++) {
      expect(
        laneXs[lane],
        `${section}区間: 車線${lane} が 車線${lane - 1} より右にある`,
      ).toBeLessThan(laneXs[lane - 1]);
    }
  });

  test('R区間はL区間の鏡像ではなく平行移動コピー（合流条件が同一）', () => {
    const offset = CONST.SECTION_OFFSET_X.R - CONST.SECTION_OFFSET_X.L;
    expect(offset, '平行移動量が 0 だと2区間が重なる').toBeGreaterThan(0);
    for (let lane = 0; lane < CONST.LANE_X.L.length; lane++) {
      expect(
        CONST.LANE_X.R[lane] - CONST.LANE_X.L[lane],
        `車線${lane} の左右オフセットが一定でない`,
      ).toBeCloseTo(offset, 10);
    }
  });

  test.each(SECTIONS)('%s区間: 加速車線は合流先の走行車線(2)の左隣', (section) => {
    const laneXs = CONST.LANE_X[section];
    expect(laneXs[3], '加速車線が走行車線より左にない').toBeLessThan(laneXs[2]);
    expect(laneXs[2] - laneXs[3], '加速車線と走行車線の間隔が車線幅と異なる').toBeCloseTo(
      laneXs[1] - laneXs[2],
      10,
    );
  });

  test('生成された車両のXは車線位置に一致する', () => {
    const world = new World({ rng: createRng(29), spawnInterval: 1e9 });
    for (const section of SECTIONS) {
      for (let lane = 0; lane < 4; lane++) {
        const vehicle = new Vehicle(world, section, lane, 0, 'Sedan', 25);
        expect(vehicle.x, `${section}区間 車線${lane} のXが不一致`).toBe(
          CONST.LANE_X[section][lane],
        );
      }
    }
  });
});

/* ============================================================
   11. 合流(加速車線 lane 3)の協調 (Issue #33)
   加速車線は「止まって待つ」車線ではなく本線の流れに乗るための車線。
   ・合流車は加速して本線へ入り、いつまでも lane 3 で止まらない
   ・本線車(lane 2)は接近する合流車を認識し、退避 or 減速で譲る
   ・速度差が小さいときは合流車を優先する(速度差が大きい時は譲らない)
   合流協調は「合流という状況への一般的な運転挙動」なので両区間で完全に同一
   (区間差は「追いつかれた車両の義務」ただ1つに限る — 交絡を作らない)。
   ============================================================ */
describe('合流(加速車線)の協調 (Issue #33)', () => {
  // 本線(lane 2)を一定間隔・同速で満たした流れの中に合流車を1台置く。
  // keepLeft を切って本線車が勝手に車線を離れないようにする(合流枠の再現)。
  function fillLane2(world: World, section: 'L' | 'R', count: number, speed: number): void {
    const span = (CONST.ROAD_HALF * 2) / count;
    for (let i = 0; i < count; i++) {
      const vehicle = new Vehicle(world, section, 2, -CONST.ROAD_HALF + i * span, 'Sedan', speed);
      vehicle.speed = speed;
      vehicle.keepLeft = false;
      world.vehicles.push(vehicle);
    }
  }

  test('合流車は一定時間内に本線(lane 2)へ合流し、永久に加速車線で止まらない', () => {
    const world = new World({ rng: createRng(33), spawnInterval: 1e9 });
    fillLane2(world, 'L', 24, 25); // 流れている本線
    const merger = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP - 20, 'Sedan', 24);
    merger.speed = 18;
    world.vehicles.push(merger);
    let merged = false;
    for (let i = 0; i < Math.round(40 / TIME_STEP); i++) {
      world.step(TIME_STEP);
      if (merger.lane === 2 && merger.laneChange.state === 'none') {
        merged = true;
        break;
      }
    }
    expect(merged, '合流車が40秒以内に本線へ合流できず加速車線で止まったままだった').toBe(true);
  });

  // 本線車のすぐ前(真横〜わずかに前方)の加速車線に、まだ入れずにいる合流車を置く。
  // behindClear を満たさない近さにして、合流車が本線車の協調を必要とする状況を作る。
  function coopSetup(mergerSpeed: number, blockLane1: boolean) {
    const world = new World({ rng: createRng(1), spawnInterval: 1e9 });
    const main = new Vehicle(world, 'L', 2, 300, 'Sedan', 25);
    main.speed = 25;
    main.keepLeft = false;
    const front = new Vehicle(world, 'L', 2, 258, 'Sedan', 25);
    front.speed = 25;
    front.keepLeft = false;
    const merger = new Vehicle(world, 'L', 3, 298, 'Sedan', mergerSpeed);
    merger.speed = mergerSpeed;
    world.vehicles.push(main, front, merger);
    if (blockLane1) {
      // 退避先(lane 1)を真横で塞ぎ、本線車が lane 1 へ逃げられなくする
      const wall = new Vehicle(world, 'L', 1, 300, 'Sedan', 24);
      wall.speed = 24;
      wall.keepLeft = false;
      wall.camper = false;
      world.vehicles.push(wall);
    }
    return { world, main, merger };
  }

  test('本線車は前方の合流車を認識し、追い越し車線側(lane 1)へ退避して枠を空ける', () => {
    const { world, main } = coopSetup(24, false); // lane 1 は空いている
    let evaded = false;
    for (let i = 0; i < Math.round(3 / TIME_STEP); i++) {
      world.step(TIME_STEP);
      if (main.lane === 1 || (main.laneChange.state !== 'none' && main.laneChange.to === 1)) {
        evaded = true;
        break;
      }
    }
    expect(evaded, '合流車を認識して lane 1 へ退避しなかった').toBe(true);
  });

  test('退避できず速度差が小さいときは減速して譲る(合流車が優先)', () => {
    const { world, main } = coopSetup(23, true); // 速度差 |25-23|=2 < 閾値, lane 1 は塞がれている
    expect(Math.abs(25 - 23), 'テスト前提: 速度差が閾値未満でない').toBeLessThan(
      CONST.MERGE_YIELD_SPEED_DIFF,
    );
    world.step(TIME_STEP);
    expect(main.lane, '退避できないはずが lane 2 を離れた').toBe(2);
    expect(main.mergeCooperationTarget, '速度差が小さいのに減速枠を予約しなかった').not.toBeNull();
  });

  test('退避できず速度差が大きいときは即commitせず穏やかな協調に留める', () => {
    const { world, main } = coopSetup(8, true); // 速度差 |25-8|=17 > 閾値, lane 1 は塞がれている
    expect(Math.abs(25 - 8), 'テスト前提: 速度差が閾値以上でない').toBeGreaterThan(
      CONST.MERGE_YIELD_SPEED_DIFF,
    );
    world.step(TIME_STEP);
    expect(world.rampLeader('L')?.mergePlan.state).not.toBe('committed');
    expect((25 - main.speed) / TIME_STEP).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL + 0.01);
  });
});

/* ============================================================
   10. 追い越し車線からの復帰は区間非依存 (Issue #49)
   復帰先が並走車に塞がれ、加速復帰にも見込みがない時のフォールバック
   (少し減速して並走車の後ろに入る)は「追いつかれた車両の義務」とは
   無関係な一般的な運転挙動なので、L/R 両区間でまったく同じ条件で
   発動しなければならない(AGENTS.md A項: 区間依存変数を挙動分岐に使わない)。
   ============================================================ */
describe('復帰フォールバックの区間非依存性 (Issue #49)', () => {
  // 追い越し車線(lane 0)の車が後続に追いつかれ、復帰先(lane 1)は同速の並走車に
  // 塞がれ、さらに並走車の前方も塞がっているため加速復帰の見込みもない状況。
  // このとき「少し減速して並走車の後ろに入る」(yieldSlowTimer) が発動する。
  function setupBlockedReturn(section: 'L' | 'R') {
    const world = new World({ rng: createRng(9), spawnInterval: 1e9 });
    const overtaker = new Vehicle(world, section, 0, 0, 'Sedan', 25);
    overtaker.speed = 25;
    // 復帰判定時間は気質(義務の有無)由来なので、発動条件の比較のため揃える
    overtaker.returnTime = CONST.OVERTAKE_LANE_RETURN_TIME;
    overtaker.returnTimer = overtaker.returnTime + TIME_STEP;
    overtaker.returnBoostCooldown = 1;
    overtaker.keepLeft = false;
    overtaker.camper = false;
    const side = new Vehicle(world, section, 1, 0, 'Sedan', 25); // 同速の並走車
    side.speed = 25;
    side.keepLeft = false;
    side.camper = false;
    const wall = new Vehicle(world, section, 1, -22, 'Sedan', 24.5); // 並走車の前方を塞ぐ
    wall.speed = 24.5;
    wall.keepLeft = false;
    wall.camper = false;
    const chaser = new Vehicle(world, section, 0, 55, 'SportsCar', 34);
    chaser.speed = 32;
    world.vehicles.push(overtaker, side, wall, chaser);
    world.rebuildSectionIndex();
    return { world, overtaker };
  }

  function runUntilSlowed(section: 'L' | 'R'): boolean {
    const { overtaker } = setupBlockedReturn(section);
    overtaker.decide(null, TIME_STEP);
    return overtaker.lane === 0 && overtaker.yieldSlowTimer > 0;
  }

  test.each([
    ['義務あり', 'L'],
    ['義務なし', 'R'],
  ] as const)(
    '%s区間: 復帰先が塞がれ加速復帰も見込めない時は減速して後ろに入る',
    (_name, section) => {
      expect(runUntilSlowed(section), '減速フォールバック(yieldSlowTimer)が発動しなかった').toBe(
        true,
      );
    },
  );

  test('L/R で発動可否が一致する(区間依存の分岐が残っていない)', () => {
    expect(runUntilSlowed('R'), 'R区間だけ発動しない = section 依存の分岐が残っている').toBe(
      runUntilSlowed('L'),
    );
  });
});

/* ============================================================
   11. リセット時の内部状態初期化 (Issue #54)
   コンストラクタで初期化される集計・索引・モード用タイマーは、リセット後に
   前回実行の状態を持ち越してはならない。
   ============================================================ */
describe('リセット時の内部状態初期化 (Issue #54)', () => {
  test('reset() は累積値と古い車両索引を初期状態へ戻す', () => {
    const world = new World({ rng: createRng(54), spawnInterval: 1e9 });
    world.populateInitial();
    world.step(TIME_STEP);
    const staleVehicle = world.vehicles[0];

    world.stats.changes.L = 7;
    world.stats.yields.R = 8;
    world.stats.cancels.L = 9;
    world.stats.inflow.R = 10;
    world.stats.outflow.L = 11;
    world.sectionVehicles.L = [staleVehicle];
    world.sectionVehicles.R = [staleVehicle];
    world.laneRoundRobin = 2;
    world.perturbTimer = 3;
    world.absorberRoundRobin = [1, 2, 3];

    world.reset();

    expect(world.spawnAccumulator).toBe(0);
    expect(world.time).toBe(0);
    expect(world.stats).toEqual({
      changes: { L: 0, R: 0 },
      yields: { L: 0, R: 0 },
      cancels: { L: 0, R: 0 },
      inflow: { L: 0, R: 0 },
      outflow: { L: 0, R: 0 },
    });
    expect(world.smoothTime).toEqual({ L: 0, R: 0, draw: 0 });
    expect(world.sectionVehicles.L).not.toContain(staleVehicle);
    expect(world.sectionVehicles.R).not.toContain(staleVehicle);
    expect(world.laneRoundRobin).toBe(0);
    expect(world.perturbTimer).toBeNull();
    expect(world.absorberRoundRobin).toBeNull();
  });
});

/* ============================================================
   12. 周回道路の描画 (Issue #73)
   車両が周回境界を越える追尾視点でも、道路設備が前後に続いて見える。
   ============================================================ */
describe('周回道路の描画 (Issue #73)', () => {
  test('境界の前後1周ぶんに同じ道路設備を配置する', () => {
    expect(loopCopies(0)).toEqual([-816, 0, 816]);
  });
});

/* ============================================================
   13. 俯瞰カメラの端末向き (Issue #76)
   ============================================================ */
describe('俯瞰カメラの端末向き (Issue #76)', () => {
  test.each([
    [1280, 720, true],
    [720, 1280, false],
    [900, 900, true],
  ])('%ix%i は横向き判定が %s', (width, height, expected) => {
    expect(isLandscapeViewport(width, height)).toBe(expected);
  });
});

describe('複数台の安全で自然な合流 (Issue #48)', () => {
  function addVehicle(
    world: World,
    section: 'L' | 'R',
    lane: number,
    z: number,
    speed: number,
  ): Vehicle {
    const vehicle = new Vehicle(world, section, lane, z, 'Sedan', speed);
    vehicle.speed = speed;
    vehicle.keepLeft = false;
    vehicle.camper = false;
    world.vehicles.push(vehicle);
    return vehicle;
  }

  test('速度比と車間比から混雑度を連続値で求める', () => {
    expect(mergeCongestion(30, 30, 36, 20)).toBeCloseTo(0, 6);
    expect(mergeCongestion(10.5, 30, 16, 20)).toBeCloseTo(1, 6);
    const values = Array.from({ length: 101 }, (_, index) =>
      mergeCongestion(10.5 + index * 0.12, 30, 16 + index * 0.2, 20),
    );
    for (let index = 1; index < values.length; index++) {
      expect(values[index]).toBeLessThanOrEqual(values[index - 1]);
      expect(Math.abs(values[index] - values[index - 1])).toBeLessThanOrEqual(0.05);
    }
  });

  test('ランプ車は明示的な五状態と空の予約で初期化される', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, CONST.RAMP_Z_TOP - 10, 25);
    expect(ramp.mergePlan).toMatchObject({
      state: 'queued',
      front: null,
      rear: null,
      congestion: 0,
      targetPassTime: 0,
      nextSource: null,
    });
  });

  test('ランプ先頭車だけが探索し、完了後に初期z順で次車へ引き継ぐ', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramps = [290, 315, 340].map((z) => {
      const vehicle = new Vehicle(world, 'L', 3, z, 'Sedan', 20);
      vehicle.speed = 20;
      world.vehicles.push(vehicle);
      return vehicle;
    });
    world.rebuildSectionIndex();
    world.prepareMergeCoordination(TIME_STEP);
    expect(ramps.map((vehicle) => vehicle.mergePlan.state)).toEqual([
      'committed',
      'queued',
      'queued',
    ]);
    expect(
      ramps.filter((vehicle) => vehicle.mergePlan.front || vehicle.mergePlan.rear),
    ).toHaveLength(0);

    ramps[0].lane = 2;
    ramps[0].laneChange.state = 'none';
    ramps[0].mergePlan.state = 'completed';
    world.rebuildSectionIndex();
    world.prepareMergeCoordination(TIME_STEP);
    expect(ramps[1].mergePlan.state).toBe('seeking');
    expect(ramps[2].mergePlan.state).toBe('queued');
  });

  test('同じ生成順なら車両配列を並べ替えてもランプ先頭が変わらない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const front = new Vehicle(world, 'L', 3, 290, 'Sedan', 20);
    const rear = new Vehicle(world, 'L', 3, 320, 'Sedan', 20);
    world.vehicles.push(rear, front);
    world.rebuildSectionIndex();
    expect(world.rampLeader('L')).toBe(front);
    world.vehicles.reverse();
    world.rebuildSectionIndex();
    expect(world.rampLeader('L')).toBe(front);
  });

  test('本線協調はqueued後続よりランプ先頭を対象にする', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const main = addVehicle(world, 'L', 2, 300, 20);
    const front = addVehicle(world, 'L', 2, 290, 20);
    const leader = addVehicle(world, 'L', 3, 294, 20);
    const follower = addVehicle(world, 'L', 3, 320, 20);
    world.rebuildSectionIndex();
    world.prepareMergeCoordination(TIME_STEP);

    expect(leader.mergePlan).toMatchObject({
      state: 'coordinating',
      front,
      rear: main,
    });
    expect(follower.mergePlan.state).toBe('queued');
  });

  test('三台は初期z順に完了し、先頭変更中も追い越さない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    addVehicle(world, 'L', 2, 250, 18);
    addVehicle(world, 'L', 2, 390, 18);
    const ramps = [290, 315, 340].map((z) => addVehicle(world, 'L', 3, z, 18));
    const completed: Vehicle[] = [];
    for (let step = 0; step < 2400 && completed.length < ramps.length; step++) {
      world.step(TIME_STEP);
      for (const vehicle of ramps)
        if (vehicle.mergePlan.state === 'completed' && !completed.includes(vehicle))
          completed.push(vehicle);
      const unfinished = ramps.filter((vehicle) => vehicle.mergePlan.state !== 'completed');
      for (let index = 1; index < unfinished.length; index++)
        expect(unfinished[index].z).toBeGreaterThan(unfinished[index - 1].z);
    }
    expect(completed).toEqual(ramps);
  });
});

describe('自由流の合流枠予約 (Issue #48)', () => {
  function addVehicle(
    world: World,
    section: 'L' | 'R',
    lane: number,
    z: number,
    speed: number,
  ): Vehicle {
    const vehicle = new Vehicle(world, section, lane, z, 'Sedan', speed);
    vehicle.speed = speed;
    vehicle.keepLeft = false;
    vehicle.camper = false;
    world.vehicles.push(vehicle);
    return vehicle;
  }

  test('合流点を通過済みの本線車は816m先の次回到着として扱う', () => {
    expect(nextArrivalDistance(CONST.MERGE_POINT_Z - 10, CONST.MERGE_POINT_Z)).toBeCloseTo(
      WRAP_LENGTH - 10,
      8,
    );
    expect(nextArrivalDistance(CONST.MERGE_POINT_Z + 10, CONST.MERGE_POINT_Z)).toBeCloseTo(10, 8);
  });

  test('ramp ETAの直前直後に到着するlane 2車だけを候補枠にする', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 25);
    const passed = addVehicle(world, 'L', 2, CONST.MERGE_POINT_Z - 5, 25);
    const before = addVehicle(world, 'L', 2, 315.5, 25);
    const after = addVehicle(world, 'L', 2, 340.5, 25);
    const remote = addVehicle(world, 'L', 2, 390.5, 25);
    world.rebuildSectionIndex();
    const slot = ramp.projectMergeSlot(2);
    expect(slot).toMatchObject({ front: before, rear: after });
    expect(slot?.front).not.toBe(passed);
    expect(slot?.rear).not.toBe(remote);
  });

  test('時間gapは自由流1.4/1.6秒から低速0.8/0.8秒へ連続補間する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 25);
    expect(ramp.mergeHeadways(0)).toEqual({ front: 1.4, rear: 1.6 });
    expect(ramp.mergeHeadways(0.5)).toEqual({ front: 1.1, rear: 1.2 });
    expect(ramp.mergeHeadways(1)).toEqual({ front: 0.8, rear: 0.8 });
  });

  test('現在のraw z間隔ではなく合流時点へ外挿した前後gapで判定する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 25);
    addVehicle(world, 'L', 2, 310.5, 25);
    addVehicle(world, 'L', 2, 365.5, 35);
    world.rebuildSectionIndex();
    const slot = ramp.projectMergeSlot(2);
    expect(slot?.rearGap).toBeLessThan(ramp.mergeHeadways(0).rear * 35);
    expect(ramp.isProjectedSlotSafe(slot!, 0)).toBe(false);
  });

  test('後車が接近中ならcommit開始TTC 4秒以上を要求し3秒未満は絶対禁止する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 20);
    const rear = addVehicle(world, 'L', 2, 358, 30);
    const slot = {
      front: null,
      rear,
      frontGap: Infinity,
      rearGap: 60,
      rearClosingTtc: 3.5,
      rampEta: 2,
    };
    expect(ramp.isProjectedSlotSafe(slot, 0)).toBe(false);
    slot.rearClosingTtc = 2.9;
    expect(ramp.isProjectedSlotSafe(slot, 1)).toBe(false);
    slot.rearClosingTtc = 4.1;
    expect(ramp.isProjectedSlotSafe(slot, 0)).toBe(true);
  });

  test('局所枠が不足すると予約後車一台だけが減速より先にlane 1へ退避する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    addVehicle(world, 'L', 3, 328, 24);
    const rear = addVehicle(world, 'L', 2, 340, 25);
    addVehicle(world, 'L', 2, 300, 25);
    world.step(TIME_STEP);
    expect(rear.laneChange.to).toBe(1);
    expect(rear.mergeCooperationTarget).toBeNull();
    expect(world.sectionVehicles.L.filter((vehicle) => vehicle.laneChange.to === 1)).toHaveLength(
      1,
    );
  });

  test('退避不能時だけ目標1.2m/s²、最大3.0m/s²で局所枠を作る', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    addVehicle(world, 'L', 3, 328, 24);
    const rear = addVehicle(world, 'L', 2, 340, 25);
    addVehicle(world, 'L', 2, 300, 25);
    addVehicle(world, 'L', 1, 340, 25);
    world.step(TIME_STEP);
    expect(rear.lane).toBe(2);
    expect(rear.mergeCooperationTarget).not.toBeNull();
    expect(rear.mergeCooperationDecel).toBeCloseTo(CONST.MERGE_TARGET_COOP_DECEL, 6);
    expect((25 - rear.speed) / TIME_STEP).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL + 0.01);
  });

  test('減速協調中は予約後車と通過目標時刻を毎frame先送りしない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    addVehicle(world, 'L', 3, 328, 24);
    const rear = addVehicle(world, 'L', 2, 340, 25);
    addVehicle(world, 'L', 2, 300, 25);
    addVehicle(world, 'L', 1, 340, 25);
    world.step(TIME_STEP);
    const targetPassTime = rear.mergeCooperationTarget;
    world.step(TIME_STEP);
    expect(targetPassTime).not.toBeNull();
    expect(rear.mergeCooperationTarget).toBe(targetPassTime);
  });

  test('3.0m/s²を超える協調が必要な局所枠はcommitしない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 285, 15);
    addVehicle(world, 'L', 2, 310, 35);
    addVehicle(world, 'L', 1, 310, 35);
    world.step(TIME_STEP);
    expect(ramp.mergePlan.state).not.toBe('committed');
  });

  test('評価後に現地がdangerへ変わった枠はapply直前にcommitしない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 25);
    addVehicle(world, 'L', 2, 280, 25);
    addVehicle(world, 'L', 2, 390, 25);
    world.rebuildSectionIndex();
    const plan = ramp.evaluateMergePlan(TIME_STEP, null);
    expect(plan.state).toBe('committed');
    addVehicle(world, 'L', 2, 328, 1);
    world.rebuildSectionIndex();
    ramp.applyMergePlan(plan);
    expect(ramp.mergePlan.state).not.toBe('committed');
    expect(ramp.laneChange.state).toBe('none');
  });

  test('dangerでcancelした車へ古いcommitted planを次frameで無条件再適用しない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 25);
    addVehicle(world, 'L', 2, 280, 25);
    addVehicle(world, 'L', 2, 390, 25);
    world.step(TIME_STEP);
    expect(ramp.mergePlan.state).toBe('committed');
    expect(ramp.laneChange.state).toBe('changing');
    ramp.cancelLaneChange();
    expect(ramp.mergePlan.state).toBe('seeking');
    addVehicle(world, 'L', 2, ramp.z, 1);
    world.step(TIME_STEP);
    expect(ramp.laneChange.state).not.toBe('changing');
    expect(ramp.mergePlan.state).toBe('seeking');
  });

  test('自由流の既存安全枠へ導流帯より手前で即commitする', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 330, 25);
    addVehicle(world, 'L', 2, 280, 27);
    addVehicle(world, 'L', 2, 390, 27);

    world.step(TIME_STEP);

    expect(ramp.mergePlan.state).toBe('committed');
    expect(ramp.laneChange).toMatchObject({ from: 3, to: 2, state: 'changing' });
    expect(ramp.z).toBeGreaterThan(CONST.GORE_Z_START);
  });

  test('空き不足では予約後車が一台だけlane 1へ退避し、減速を選ばない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 310, 24);
    const rear = addVehicle(world, 'L', 2, 316, 25);
    const front = addVehicle(world, 'L', 2, 280, 25);

    world.step(TIME_STEP);

    expect(ramp.mergePlan).toMatchObject({
      state: 'coordinating',
      front,
      rear,
    });
    expect(rear.laneChange.to).toBe(1);
    expect(rear.mergeCooperationTarget).toBeNull();
    expect(
      world.sectionVehicles.L.filter(
        (vehicle) => vehicle.laneChange.state !== 'none' && vehicle.laneChange.to === 1,
      ),
    ).toHaveLength(1);
  });

  test('予約後車のlane 1退避は再評価されても進捗を維持する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    addVehicle(world, 'L', 3, 310, 24);
    const rear = addVehicle(world, 'L', 2, 316, 25);
    addVehicle(world, 'L', 2, 280, 25);

    world.step(TIME_STEP);
    const firstProgress = rear.laneChange.progress;
    world.step(TIME_STEP);

    expect(firstProgress).toBeGreaterThan(0);
    expect(rear.laneChange.progress).toBeGreaterThan(firstProgress);
  });

  test('予約後車のlane 1退避完了後は同じ枠をcommitする', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 310, 24);
    const rear = addVehicle(world, 'L', 2, 316, 25);
    addVehicle(world, 'L', 2, 280, 25);

    for (let step = 0; step < 60 && rear.lane !== 1; step++) world.step(TIME_STEP);
    world.step(TIME_STEP);

    expect(rear.lane).toBe(1);
    expect(ramp.mergePlan).toMatchObject({
      state: 'committed',
      rear,
    });
  });

  test('退避不能時だけ3.0m/s²以下の減速で枠を形成する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 310, 24);
    const rear = addVehicle(world, 'L', 2, 316, 25);
    const front = addVehicle(world, 'L', 2, 280, 25);
    addVehicle(world, 'L', 1, 316, 25);

    world.step(TIME_STEP);

    expect(ramp.mergePlan).toMatchObject({
      state: 'coordinating',
      front,
      rear,
    });
    expect(rear.lane).toBe(2);
    expect(rear.mergeCooperationTarget).not.toBeNull();
    expect((25 - rear.speed) / TIME_STEP).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL + 0.01);
  });

  test('減速で枠を形成中のランプ車はcommit前に車線変更を始めない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 310, 24);
    addVehicle(world, 'L', 2, 330, 25);
    addVehicle(world, 'L', 2, 280, 25);
    addVehicle(world, 'L', 1, 330, 25);

    world.step(TIME_STEP);

    expect(ramp.mergePlan.state).toBe('coordinating');
    expect(ramp.laneChange.state).toBe('none');
  });

  test('減速で形成した枠の協調目標はcommit後も合流完了まで維持する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 310, 24);
    const rear = addVehicle(world, 'L', 2, 316, 25);
    const front = addVehicle(world, 'L', 2, 280, 25);
    addVehicle(world, 'L', 1, 316, 25);

    world.step(TIME_STEP);
    const cooperationTarget = rear.mergeCooperationTarget;
    front.z = 250;
    rear.z = 360;
    world.step(TIME_STEP);

    expect(cooperationTarget).not.toBeNull();
    expect(ramp.mergePlan.state).toBe('committed');
    expect(rear.mergeCooperationTarget).toBe(cooperationTarget);
  });

  test('複数ランプ車は同じfront/rear枠を同時に予約しない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramps = [addVehicle(world, 'L', 3, 310, 24), addVehicle(world, 'L', 3, 312, 24)];
    const rear = addVehicle(world, 'L', 2, 316, 25);
    const front = addVehicle(world, 'L', 2, 280, 25);

    world.rebuildSectionIndex();
    const evaluations = ramps.map((leader) => ({
      leader,
      plan: leader.evaluateMergePlan(TIME_STEP, null),
    }));
    expect(
      evaluations.filter(({ plan }) => plan.front === front && plan.rear === rear),
    ).toHaveLength(2);

    world.applyMergeEvaluations(evaluations);

    const appliedReservations = ramps.filter(
      (ramp) => ramp.mergePlan.front === front && ramp.mergePlan.rear === rear,
    );
    expect(appliedReservations).toEqual([ramps[0]]);
    expect(ramps[1].mergePlan).toMatchObject({
      state: 'seeking',
      front: null,
      rear: null,
    });
  });
});

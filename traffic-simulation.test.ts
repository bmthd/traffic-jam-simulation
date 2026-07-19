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

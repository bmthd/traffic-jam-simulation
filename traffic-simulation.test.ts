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
  createAnimationFaultBoundary,
  createFixedStepAccumulator,
  FIXED_SIMULATION_DELTA_TIME,
} from './src/animation-loop';
import {
  buildMergeDependencyClosure,
  CONST,
  createRng,
  isMergeTransactionAdmissible,
  mergeCongestion,
  nextArrivalDistance,
  planMergeTransaction,
  RAMP_GEOMETRY,
  rampBodyIntersectsGore,
  sectionTrackX,
  validateMergeTransactionHorizon,
  Vehicle,
  World,
  WRAP_LENGTH,
} from './src/core';
import { isLandscapeViewport } from './src/render/camera-layout';
import { flybyPose } from './src/render/flyby';
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
  minGapDetail: string;
  /** 検査した「同一車線の前後ペア」の延べ数(検出力そのものの回帰ガード用) */
  checkedPairs: number;
  /** 車間が負 = 実際に車体が重なっていたペアの延べ数 */
  overlaps: number;
  world: World;
}

/* ---------- ヘルパー: 貫通(同一車線内の重なり)検査 (Issue #53) ---------- */
interface PenetrationPair {
  section: 'L' | 'R';
  lane: number;
  ahead: Vehicle;
  behind: Vehicle;
  /** 後続から前方車までの周回路上の前方距離 (m) */
  distance: number;
  /** 車体間の車間 (m)。負なら重なっている */
  gap: number;
}
interface PenetrationResult {
  pairs: number;
  overlaps: number;
  minGap: number;
  /** 最小車間を記録したペア。ペアが1つも無ければ null */
  worst: PenetrationPair | null;
}

/**
 * ある瞬間のワールドについて、同一車線の「真の前後ペア」を漏れなく検査する (Issue #53)。
 *
 * 旧実装は「区間全体を z 昇順に並べた配列の隣接 index」だけを見ていた。そのため
 *   (1) 同一車線の前後ペアの間に他車線の車が1台でも挟まるとそのペアは永久に漏れる
 *   (2) 周回の継ぎ目ペア(配列の端と端)を比較しない
 *   (3) 距離が Math.abs(z 差) で周回非対応
 * という3つの穴があり、実測では真の前後ペアの約1割しか比較できていなかった。
 *
 * ここでは車線ごとにグルーピングしてから z 昇順に並べ、リング上の隣接ペアを
 * 全件見る。計算量は車線ごとのソートで O(N log N) に収まる。
 */
function checkPenetration(world: World): PenetrationResult {
  let pairs = 0,
    overlaps = 0,
    minGap = Infinity;
  let worst: PenetrationPair | null = null;
  for (const section of ['L', 'R'] as const) {
    const byLane = new Map<number, Vehicle[]>();
    for (const vehicle of world.sectionVehicles[section]) {
      // 車線変更中の車は occupies() が示すとおり2車線にまたがっており、
      // 「どちらの車線に居るか」が定まらない。重なりの定義が曖昧になるため除外する
      // (この除外は旧実装と同じ。除外を外すと車線変更のたびに偽陽性が出る)
      if (vehicle.laneChange.state !== 'none') continue;
      const group = byLane.get(vehicle.lane);
      if (group) group.push(vehicle);
      else byLane.set(vehicle.lane, [vehicle]);
    }
    for (const [lane, group] of byLane) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.z - b.z); // 前方 = z が小さい側
      for (let k = 0; k < group.length; k++) {
        // k=0 は周回の継ぎ目ペア: z 最小(最前方)の車の前方は、一周回った先の
        // z 最大の車。貫通が起きやすい継ぎ目こそ盲点にしてはならない
        const behind = group[k],
          ahead = group[(k + group.length - 1) % group.length];
        // 前方距離は [0, WRAP_LENGTH) で測る。Vehicle.findAhead が周回時に
        // `this.z - other.z + WRAP_LENGTH` としているのと同じ尺度。
        // 符号付き最短の wrapDelta を使うと、周回しない加速車線(lane 3)の
        // 継ぎ目ペアのように半周を超える距離が負へ折り返り誤検出になる
        const distance = (((behind.z - ahead.z) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
        const gap = distance - (ahead.length + behind.length) / 2;
        pairs++;
        if (gap < 0) overlaps++;
        if (gap < minGap) {
          minGap = gap;
          worst = { section, lane, ahead, behind, distance, gap };
        }
      }
    }
  }
  return { pairs, overlaps, minGap, worst };
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
    minGap = Infinity,
    checkedPairs = 0,
    overlaps = 0;
  let minGapDetail = '';
  const steps = Math.round(seconds / TIME_STEP);
  for (let i = 0; i < steps; i++) {
    world.step(TIME_STEP);
    const elapsed = i * TIME_STEP;
    if (i % 10 === 0) {
      // 貫通チェック(同一車線・車線変更中でない車両同士を、リング全周にわたり漏れなく)
      const penetration = checkPenetration(world);
      checkedPairs += penetration.pairs;
      overlaps += penetration.overlaps;
      if (penetration.worst && penetration.minGap < minGap) {
        minGap = penetration.minGap;
        const { section, lane, ahead, behind, distance } = penetration.worst;
        const activeClosures = world.vehicles
          .filter((vehicle) => vehicle.mergePlan.certificate)
          .map((vehicle) => ({
            ramp: vehicle.spawnOrder,
            lane: vehicle.lane,
            state: vehicle.mergePlan.state,
            targetPassTime: vehicle.mergePlan.certificate!.targetPassTime,
            orders: vehicle.mergePlan.certificate!.closure.orders,
            edges: vehicle.mergePlan.certificate!.closure.edges,
          }));
        minGapDetail =
          `seed=${seed},time=${world.time},section=${section},lane=${lane},` +
          `ahead=${ahead.spawnOrder}@${ahead.z},behind=${behind.spawnOrder}@${behind.z},` +
          `distance=${distance},speed=${ahead.speed}/${behind.speed},` +
          `closures=${JSON.stringify(activeClosures)}`;
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
    minGapDetail,
    checkedPairs,
    overlaps,
    world,
  };
}

/* ============================================================
   1. メイン要件: 渋滞スコアに約10ポイントの差が出ること
   人間らしい運転モデル(ブレーキ連鎖・渋滞波)に加え、Issue #12 で
   流入・流出(混雑側への滞留)が入り台数自体も揺らぐようになったため、
   シードごとの差の分布は広い(標準偏差 4〜5 程度)。そこで
   「約10ポイント」の大きさは10シード平均で判定し、
   個別シードは「逆転しない・過大にならない」ことを判定する。
   ============================================================ */
const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110];
const DIFF_TARGET = 10;
// ユーザー承認により、終端安全の物理修正を評価する間だけ平均差の下限を 7 に緩和する。
// 目標値 10 と従来の上限 12 は維持し、区間依存の補正は導入しない。
const DIFF_AVERAGE_MIN = 7;
const DIFF_AVERAGE_MAX = 12;
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

  test(`10シード平均のスコア差が ${DIFF_AVERAGE_MIN}〜${DIFF_AVERAGE_MAX} に収まる`, () => {
    const results = getResults();
    const avg =
      results.reduce((sum, result) => sum + (result.scoreR - result.scoreL), 0) / results.length;
    expect(avg, `平均差 ${avg.toFixed(1)} が下限未満`).toBeGreaterThanOrEqual(DIFF_AVERAGE_MIN);
    expect(avg, `平均差 ${avg.toFixed(1)} が上限超過`).toBeLessThanOrEqual(DIFF_AVERAGE_MAX);
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
  test('長時間運転しても同一車線内で車両が重ならない', () => {
    let worstGap = Infinity,
      overlaps = 0;
    for (const result of getResults()) {
      worstGap = Math.min(worstGap, result.minGap);
      overlaps += result.overlaps;
    }
    const result = getResults().find((entry) => entry.minGap === worstGap)!;
    // 車間 0m = 前後の車体が触れる境界。これを下回ったら車体が重なっている
    // = 貫通であり、シミュレーションとして成立しない。
    // 旧しきい値の -1.0m は「1m めり込んでも合格」で、貫通防止という
    // テストの目的に対して意味を成していなかった (Issue #53)。
    expect(
      overlaps,
      `同一車線で車体が重なったペアが ${overlaps} 件` +
        ` (最小車間 ${worstGap.toFixed(2)}m): ${result.minGapDetail}`,
    ).toBe(0);
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
    const results = getResults();
    for (const result of results) {
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

  test('最大車両数(片側上限×2区間)を超えない', () => {
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

  test('退避できず速度差が大きくTTCも短いときは譲らない', () => {
    const { world, main, merger } = coopSetup(8, true); // 速度差 |25-8|=17 > 閾値, lane 1 は塞がれている
    expect(Math.abs(25 - 8), 'テスト前提: 速度差が閾値以上でない').toBeGreaterThan(
      CONST.MERGE_YIELD_SPEED_DIFF,
    );
    merger.z = merger.latestMergeCommitZ() - 0.1;
    world.rebuildSectionIndex();
    const slot = merger.projectMergeSlot(merger.estimateMergeEta());
    expect(slot?.rear, 'テスト前提: 本線車が予約後車でない').toBe(main);
    expect(slot?.rearClosingTtc, 'テスト前提: TTCが3秒未満でない').toBeLessThan(3);
    world.step(TIME_STEP);
    expect(world.rampLeader('L')?.mergePlan.state).not.toBe('committed');
    expect(main.mergeCooperationTarget).toBeNull();
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
   13. フライバイカメラ (Issue #77)
   ============================================================ */
describe('フライバイカメラ (Issue #77)', () => {
  test('時間経過とともに車両と逆の +Z へ進み、移動方向を向く', () => {
    const start = flybyPose(0, 12);
    const afterTenSeconds = flybyPose(10, 12);

    expect(start.position).toEqual({ x: 12, y: 25, z: -400 });
    expect(afterTenSeconds.position).toEqual({ x: 12, y: 25, z: -160 });
    expect(afterTenSeconds.target).toEqual({ x: 12, y: 4, z: -112 });
  });

  test('車両を参照せず道路の周回長を越えると開始地点へ戻る', () => {
    expect(flybyPose(34, 12)).toEqual({
      position: { x: 12, y: 25, z: -400 },
      target: { x: 12, y: 4, z: -352 },
    });
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
    expect(ramps[1].mergePlan.state).toBe('coordinating');
    expect(ramps[1].mergePlan.nextSource).toBe('main');
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

  test('局所本線の速度と車間から混雑度を平滑化し実際のheadwayへ反映する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 25);
    const front = addVehicle(world, 'L', 2, 291, 10);
    const rear = addVehicle(world, 'L', 2, 305, 10);
    front.desiredSpeed = 30;
    rear.desiredSpeed = 30;
    world.rebuildSectionIndex();

    const plan = ramp.evaluateMergePlan(1, null);
    const headways = ramp.mergeHeadways(plan.congestion);

    expect(plan.congestion).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(headways.front).toBeLessThan(CONST.MERGE_FREE_FRONT_HEADWAY);
    expect(headways.rear).toBeLessThan(CONST.MERGE_FREE_REAR_HEADWAY);
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

  test('予約維持中も期限時の必要減速度を再計算し3.0m/s²超なら再探索する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 24);
    const rear = addVehicle(world, 'L', 2, 340, 25);
    const front = addVehicle(world, 'L', 2, 300, 25);
    const wall = addVehicle(world, 'L', 1, 340, 25);
    world.step(TIME_STEP);
    expect(ramp.mergePlan).toMatchObject({ state: 'coordinating', front, rear });

    ramp.z = ramp.latestMergeCommitZ() - 0.1;
    front.z = 290;
    rear.z = 315;
    wall.z = 315;
    world.rebuildSectionIndex();
    const reevaluated = ramp.evaluateMergePlan(TIME_STEP, null);

    expect(reevaluated).toMatchObject({
      state: 'seeking',
      front: null,
      rear: null,
    });
  });

  test('協調目標時刻は半車長合計を含めて予約後車とのnet gapを確保する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 24);
    const rear = addVehicle(world, 'L', 2, 340, 25);
    addVehicle(world, 'L', 2, 300, 25);
    addVehicle(world, 'L', 1, 340, 25);
    world.rebuildSectionIndex();

    const plan = ramp.evaluateMergePlan(0, null);
    const rearNetGapAtTarget =
      (plan.targetPassTime - world.time - ramp.estimateMergeEta()) * rear.speed -
      (ramp.length + rear.length) / 2;

    expect(plan).toMatchObject({ state: 'coordinating', rear });
    expect(rearNetGapAtTarget).toBeCloseTo(40, 6);
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

describe('低速ジッパー合流 (Issue #48)', () => {
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

  test('低速密集では本線とランプを一台ずつ通し、lane 1退避を要求しない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    world.lastMergeSource.L = 'main';
    const ramp = addVehicle(world, 'L', 3, 305, 6);
    const rear = addVehicle(world, 'L', 2, 309, 6);
    const front = addVehicle(world, 'L', 2, 293, 6);
    rear.desiredSpeed = 30;
    front.desiredSpeed = 30;
    world.step(TIME_STEP);
    expect(ramp.mergePlan.congestion).toBeGreaterThan(0);
    expect(ramp.mergePlan.congestion).toBeLessThan(0.1);
    expect(ramp.mergePlan.nextSource).toBe('ramp');
    expect(rear.laneChange.state).toBe('none');
  });

  test('ETA差がpassHeadwayを超えると交互順より早い到着を優先する', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    world.lastMergeSource.L = 'main';
    const ramp = addVehicle(world, 'L', 3, 350, 3);
    const front = addVehicle(world, 'L', 2, 290, 6);
    const main = addVehicle(world, 'L', 2, 306, 6);
    front.desiredSpeed = 30;
    main.desiredSpeed = 30;
    world.step(TIME_STEP);
    expect(ramp.mergePlan.nextSource).toBe('main');
    expect(main.laneChange.state).toBe('none');
    expect(main.mergeCooperationTarget).toBeNull();
  });

  test('低速ジッパーで本線が次順なら本線車を減速させない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    world.lastMergeSource.L = 'ramp';
    const ramp = addVehicle(world, 'L', 3, 305, 6);
    const main = addVehicle(world, 'L', 2, 309, 6);
    const front = addVehicle(world, 'L', 2, 293, 6);
    main.desiredSpeed = 30;
    front.desiredSpeed = 30;
    world.step(TIME_STEP);
    expect(ramp.mergePlan.nextSource).toBe('main');
    expect(main.laneChange.state).toBe('none');
    expect(main.mergeCooperationTarget).toBeNull();
  });

  test('中間混雑でも本線が次順ならlane 1退避も減速協調も要求しない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    world.lastMergeSource.L = 'ramp';
    const ramp = addVehicle(world, 'L', 3, 305, 6);
    const main = addVehicle(world, 'L', 2, 309, 6);
    const front = addVehicle(world, 'L', 2, 293, 6);
    main.desiredSpeed = 10;
    front.desiredSpeed = 10;
    world.rebuildSectionIndex();
    const rawCongestion = ramp.projectMergeCongestionSample(
      ramp.projectMergeSlot(ramp.estimateMergeEta()),
    );
    expect(rawCongestion).toBeGreaterThan(0);
    expect(rawCongestion).toBeLessThan(0.9);

    world.step(TIME_STEP);

    expect(ramp.mergePlan.nextSource).toBe('main');
    expect(main.laneChange.state).toBe('none');
    expect(main.mergeCooperationTarget).toBeNull();
  });

  test('commit後は本線速度が変わっても予約枠・混雑度・順番を変えない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 325, 22);
    const front = addVehicle(world, 'L', 2, 285, 24);
    const rear = addVehicle(world, 'L', 2, 365, 24);
    world.step(TIME_STEP);
    const fixedPlan = ramp.mergePlan;
    const fixed = {
      front: ramp.mergePlan.front,
      rear: ramp.mergePlan.rear,
      congestion: ramp.mergePlan.congestion,
      nextSource: ramp.mergePlan.nextSource,
    };
    front.speed = 2;
    rear.speed = 2;
    world.prepareMergeCoordination(TIME_STEP);
    expect(ramp.mergePlan).toBe(fixedPlan);
    expect(ramp.evaluateMergePlan(TIME_STEP, world.lastMergeSource.L)).toBe(fixedPlan);
    expect(ramp.mergePlan).toMatchObject(fixed);
  });

  test('commit前に危険になった枠は解除して別の安全枠を選ぶ', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 330, 20);
    const oldRear = addVehicle(world, 'L', 2, 337, 22);
    addVehicle(world, 'L', 2, 290, 22);
    addVehicle(world, 'L', 1, 335, 22);
    world.step(TIME_STEP);
    expect(ramp.mergePlan.state).toBe('coordinating');
    const blocker = addVehicle(world, 'L', 2, 335, 22);
    world.rebuildSectionIndex();
    world.prepareMergeCoordination(TIME_STEP);
    expect(ramp.mergePlan.rear).not.toBe(oldRear);
    expect(ramp.mergePlan.front === blocker || ramp.mergePlan.rear === blocker).toBe(true);
  });

  test('入力を0.01ずつ変えても通過時刻と協調速度は単調かつ全幅の5%以内で変わる', () => {
    const passTimes: number[] = [];
    const targetSpeeds: number[] = [];
    for (let index = 0; index <= 100; index++) {
      const ratio = 0.35 + index * 0.01;
      const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
      const ramp = addVehicle(world, 'L', 3, 320, 20);
      const rear = addVehicle(world, 'L', 2, 335, 30 * ratio);
      addVehicle(world, 'L', 2, 290, 30 * ratio);
      world.step(TIME_STEP);
      passTimes.push(ramp.mergePlan.targetPassTime);
      targetSpeeds.push(rear.targetSpeed);
    }
    const passRange = Math.max(...passTimes) - Math.min(...passTimes);
    const speedRange = Math.max(...targetSpeeds) - Math.min(...targetSpeeds);
    for (let index = 1; index < passTimes.length; index++) {
      expect(Math.abs(passTimes[index] - passTimes[index - 1])).toBeLessThanOrEqual(
        passRange * 0.05,
      );
      expect(Math.abs(targetSpeeds[index] - targetSpeeds[index - 1])).toBeLessThanOrEqual(
        speedRange * 0.05,
      );
      expect(passTimes[index]).toBeLessThanOrEqual(passTimes[index - 1] + 1e-9);
      expect(targetSpeeds[index]).toBeGreaterThanOrEqual(targetSpeeds[index - 1] - 1e-9);
    }
  });

  test('合流点の通過元を記録し、resetで履歴を消す', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    addVehicle(world, 'L', 2, CONST.MERGE_POINT_Z + 0.1, 10);
    world.step(TIME_STEP);
    expect(world.lastMergeSource.L).toBe('main');

    const ramp = addVehicle(world, 'L', 3, CONST.MERGE_POINT_Z + 1, 10);
    ramp.mergePlan.state = 'committed';
    ramp.laneChange = {
      state: 'changing',
      from: 3,
      to: 2,
      progress: 0.99,
      holdTime: 0,
      checkTimer: 1,
    };
    world.step(TIME_STEP);
    expect(world.lastMergeSource.L).toBe('ramp');

    ramp.previousZ = CONST.MERGE_POINT_Z + 0.1;
    ramp.z = CONST.MERGE_POINT_Z - 0.1;
    world.recordMergePasses();
    expect(world.lastMergeSource.L).toBe('ramp');

    ramp.previousZ = CONST.MERGE_POINT_Z + 0.1;
    ramp.z = CONST.MERGE_POINT_Z - 0.1;
    world.recordMergePasses();
    expect(world.lastMergeSource.L).toBe('main');

    world.lastMergeSource.R = 'main';
    world.reset();
    expect(world.lastMergeSource).toEqual({ L: null, R: null });
  });

  test('合流点下流でランプ合流が完了しても次周のmain通過を捨てない', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    world.lastMergeSource.L = 'main';
    const ramp = addVehicle(world, 'L', 3, CONST.MERGE_POINT_Z - 5, 10);
    ramp.mergePlan.state = 'committed';
    ramp.laneChange = {
      state: 'changing',
      from: 3,
      to: 2,
      progress: 0.99,
      holdTime: 0,
      checkTimer: 1,
    };

    world.step(TIME_STEP);
    expect(world.lastMergeSource.L).toBe('ramp');

    ramp.previousZ = CONST.MERGE_POINT_Z + 0.1;
    ramp.z = CONST.MERGE_POINT_Z - 0.1;
    world.recordMergePasses();
    expect(world.lastMergeSource.L).toBe('main');
  });
});

describe('合流の終端安全と区間同一性 (Issue #48)', () => {
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

  test.each([
    ['自由流', 25, 60],
    ['低速密集', 6, 14],
    ['極端密集', 2, 10],
  ] as const)('%sでもlane 3の導流帯侵入・停止・削除・瞬間移動がない', (_, speed, spacing) => {
    const world = new World({ rng: createRng(48), spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 350, speed);
    for (let z = 250; z <= 390; z += spacing) addVehicle(world, 'L', 2, z, speed);
    const count = world.vehicles.length;
    let previousZ = ramp.z;
    for (let step = 0; step < 1200 && ramp.mergePlan.state !== 'completed'; step++) {
      world.step(TIME_STEP);
      expect(ramp.z).toBeLessThanOrEqual(previousZ + 0.001);
      expect(previousZ - ramp.z).toBeLessThanOrEqual(ramp.desiredSpeed * TIME_STEP + 0.5);
      expect(ramp.x).toBeGreaterThanOrEqual(CONST.LANE_X.L[3]);
      expect(ramp.x).toBeLessThanOrEqual(CONST.LANE_X.L[2]);
      expect(ramp.lane === 3 && ramp.z <= CONST.GORE_Z_START).toBe(false);
      if (ramp.z <= CONST.GORE_Z_START) expect(ramp.speed).toBeGreaterThan(0);
      previousZ = ramp.z;
    }
    expect(ramp.mergePlan.state).toBe('completed');
    expect(world.vehicles).toHaveLength(count);
  });

  test('L/RはX平行移動以外の合流状態・予約相手・時刻が一致する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramps = (['L', 'R'] as const).map((section) => addVehicle(world, section, 3, 330, 20));
    for (const section of ['L', 'R'] as const) {
      addVehicle(world, section, 2, 285, 22);
      addVehicle(world, section, 2, 360, 22);
    }
    const previousX = ramps.map((ramp) => ramp.x);
    const maxLateralStep =
      (Math.abs(CONST.LANE_X.L[2] - CONST.LANE_X.L[3]) * TIME_STEP * 1.5) /
      CONST.LANE_CHANGE_DURATION;
    for (let step = 0; step < 100; step++) {
      world.step(TIME_STEP);
      expect(ramps[0].z).toBeCloseTo(ramps[1].z, 8);
      expect(ramps[0].speed).toBeCloseTo(ramps[1].speed, 8);
      expect(ramps[0].targetSpeed).toBeCloseTo(ramps[1].targetSpeed, 8);
      expect(ramps[0].lane).toBe(ramps[1].lane);
      expect(ramps[0].laneChange).toEqual(ramps[1].laneChange);
      expect(ramps[0].mergePlan.state).toBe(ramps[1].mergePlan.state);
      expect(ramps[0].mergePlan.congestion).toBeCloseTo(ramps[1].mergePlan.congestion, 8);
      expect(ramps[0].mergePlan.targetPassTime).toBeCloseTo(ramps[1].mergePlan.targetPassTime, 8);
      for (const key of ['front', 'rear'] as const) {
        const left = ramps[0].mergePlan[key];
        const right = ramps[1].mergePlan[key];
        expect(left === null).toBe(right === null);
        if (left && right) {
          expect(left.lane).toBe(right.lane);
          expect(left.z).toBeCloseTo(right.z, 8);
          expect(left.speed).toBeCloseTo(right.speed, 8);
        }
      }
      for (let index = 0; index < ramps.length; index++) {
        expect(Math.abs(ramps[index].x - previousX[index])).toBeLessThanOrEqual(
          maxLateralStep + 1e-8,
        );
        previousX[index] = ramps[index].x;
      }
      expect(ramps[1].x - ramps[0].x).toBeCloseTo(CONST.SECTION_OFFSET_X.R, 8);
    }
  });

  test('区間差属性を反転しても合流調停結果は変わらない', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const rampL = addVehicle(world, 'L', 3, 330, 20);
    const rampR = addVehicle(world, 'R', 3, 330, 20);
    const rearL = addVehicle(world, 'L', 2, 360, 22);
    const rearR = addVehicle(world, 'R', 2, 360, 22);
    addVehicle(world, 'L', 2, 285, 22);
    addVehicle(world, 'R', 2, 285, 22);
    Object.assign(rampL, { yields: true, camper: false, keepLeft: true, returnTime: 1 });
    Object.assign(rampR, { yields: false, camper: true, keepLeft: false, returnTime: 99 });
    Object.assign(rearL, { yields: true, camper: false, keepLeft: true, returnTime: 1 });
    Object.assign(rearR, { yields: false, camper: true, keepLeft: false, returnTime: 99 });
    world.rebuildSectionIndex();
    world.prepareMergeCoordination(TIME_STEP);
    expect(rampL.mergePlan.state).toBe(rampR.mergePlan.state);
    expect(rampL.mergePlan.congestion).toBeCloseTo(rampR.mergePlan.congestion, 8);
    expect(rampL.mergePlan.targetPassTime).toBeCloseTo(rampR.mergePlan.targetPassTime, 8);
  });

  test('最新commit位置へ近づくほど予約による到着遅延を連続的に縮める', () => {
    function arrivalDelay(z: number): number {
      const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
      const ramp = addVehicle(world, 'L', 3, z, 20);
      const rear = addVehicle(world, 'L', 2, z + 44, 20);
      rear.desiredSpeed = 30;
      world.rebuildSectionIndex();
      const plan = ramp.evaluateMergePlan(TIME_STEP, null);
      return plan.targetPassTime - (world.time + ramp.estimateMergeEta());
    }

    const sample = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = addVehicle(sample, 'L', 3, 330, 20);
    const deadline = ramp.latestMergeCommitZ();
    const delays = Array.from({ length: 101 }, (_, index) =>
      arrivalDelay(deadline + CONST.MERGE_DETECT_RANGE * (1 - index / 100)),
    );
    const delayRange = delays[0] - delays.at(-1)!;

    expect(delays[0]).toBeGreaterThan(0);
    expect(delays.at(-1)).toBeGreaterThan(0);
    expect(delayRange).toBeGreaterThan(0);
    for (let index = 1; index < delays.length; index++) {
      expect(delays[index]).toBeLessThanOrEqual(delays[index - 1] + 1e-9);
      expect(delays[index - 1] - delays[index]).toBeLessThanOrEqual(delayRange * 0.02);
    }
  });

  test('ジッパー時刻が早くても安全予約時刻より前へ進めない', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 328, 10);
    ramp.z = ramp.latestMergeCommitZ();
    const rear = addVehicle(world, 'L', 2, ramp.z + 2, 10);
    rear.desiredSpeed = 30;
    world.rebuildSectionIndex();

    const plan = ramp.evaluateMergePlan(1, 'main');
    const rearHeadway = ramp.mergeHeadways(plan.congestion).rear;
    const safeReservedPassTime =
      world.time +
      ramp.estimateMergeEta() +
      (rearHeadway * rear.speed + (ramp.length + rear.length) / 2) / rear.speed;

    expect(plan.nextSource).toBe('ramp');
    expect(plan.targetPassTime).toBeGreaterThanOrEqual(safeReservedPassTime - 1e-9);
  });

  test('ランプ始点の同速横並びから検知範囲でgapを作り期限前に合流する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 20);
    const main = addVehicle(world, 'L', 2, ramp.z, 20);
    let previousRampSpeed = ramp.speed;
    let previousRampZ = ramp.z;
    let previousDeadline = ramp.latestMergeCommitZ();
    let committedBeforeDeadline = false;
    let coordinationStarted = false;

    for (let step = 0; step < 400 && ramp.mergePlan.state !== 'completed'; step++) {
      world.step(TIME_STEP);
      if (
        previousRampZ - previousDeadline <= CONST.MERGE_DETECT_RANGE &&
        (ramp.targetSpeed < ramp.desiredSpeed - 1e-8 ||
          main.mergeCooperationTarget !== null ||
          (main.laneChange.state !== 'none' && main.laneChange.to === 1))
      )
        coordinationStarted = true;
      if (!committedBeforeDeadline && ramp.mergePlan.state === 'committed') {
        expect(previousRampZ).toBeGreaterThanOrEqual(previousDeadline - 1e-8);
        committedBeforeDeadline = true;
      }
      const rampDeceleration = (previousRampSpeed - ramp.speed) / TIME_STEP;
      expect(rampDeceleration).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL + 0.01);
      expect(main.mergeCooperationDecel).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL);
      expect(ramp.lane === 3 && ramp.z <= CONST.GORE_Z_START).toBe(false);
      previousRampSpeed = ramp.speed;
      previousRampZ = ramp.z;
      previousDeadline = ramp.latestMergeCommitZ();
    }

    expect(coordinationStarted).toBe(true);
    expect(committedBeforeDeadline).toBe(true);
    expect(ramp.mergePlan.state).toBe('completed');
    expect(ramp.lane).toBe(2);
  });

  test.each([
    ['main z=300・5m/s', 300, 5],
    ['main z=320・10m/s', 320, 10],
  ] as const)('%sとの投影gapが成立するまで速度協調を継続する', (_, mainZ, mainSpeed) => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 380, 20);
    const main = addVehicle(world, 'L', 2, mainZ, mainSpeed);
    let previousRampSpeed = ramp.speed;
    let previousRampZ = ramp.z;
    let previousDeadline = ramp.latestMergeCommitZ();
    let committedBeforeDeadline = false;
    let observedCurrentSafeBeforeProjectedGap = false;

    for (let step = 0; step < 600 && ramp.mergePlan.state !== 'completed'; step++) {
      world.step(TIME_STEP);
      const reservedSlot = ramp.projectReservedMergeSlot(ramp.mergePlan);
      if (
        ramp.mergePlan.state === 'coordinating' &&
        reservedSlot &&
        ramp.checkLaneSafetyForChange(2) === 'safe' &&
        !ramp.isProjectedSlotSafe(reservedSlot, ramp.mergePlan.congestion)
      )
        observedCurrentSafeBeforeProjectedGap = true;
      if (!committedBeforeDeadline && ramp.mergePlan.state === 'committed') {
        expect(previousRampZ).toBeGreaterThanOrEqual(previousDeadline - 1e-8);
        expect(reservedSlot).not.toBeNull();
        expect(ramp.isProjectedSlotSafe(reservedSlot!, ramp.mergePlan.congestion)).toBe(true);
        committedBeforeDeadline = true;
      }
      expect((previousRampSpeed - ramp.speed) / TIME_STEP).toBeLessThanOrEqual(
        CONST.MERGE_MAX_COOP_DECEL + 0.01,
      );
      expect(main.mergeCooperationDecel).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL);
      expect(ramp.lane === 3 && ramp.z <= CONST.GORE_Z_START).toBe(false);
      previousRampSpeed = ramp.speed;
      previousRampZ = ramp.z;
      previousDeadline = ramp.latestMergeCommitZ();
    }

    expect(observedCurrentSafeBeforeProjectedGap).toBe(true);
    expect(committedBeforeDeadline).toBe(true);
    expect(ramp.mergePlan.state).toBe('completed');
    expect(ramp.lane).toBe(2);
    expect(ramp.z).toBeGreaterThan(CONST.GORE_Z_START);
  });

  test('deadline直前の危険な横並びを安全確認なしでcommitしない', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 300, 2);
    ramp.desiredSpeed = 30;
    ramp.z = ramp.latestMergeCommitZ();
    const main = addVehicle(world, 'L', 2, ramp.z, 2);
    main.desiredSpeed = 30;
    world.rebuildSectionIndex();
    world.prepareMergeCoordination(TIME_STEP);

    expect(ramp.mergePlan.state).toBe('coordinating');
    expect(ramp.laneChange.state).toBe('none');
    const previousSpeed = ramp.speed;
    const previousX = ramp.x;
    ramp.update(TIME_STEP);

    expect(ramp.mergePlan.state).not.toBe('committed');
    expect(ramp.lane).toBe(3);
    expect(ramp.laneChange.state).toBe('none');
    expect(ramp.x).toBe(previousX);
    expect(ramp.speed).toBeGreaterThanOrEqual(0);
    expect((previousSpeed - ramp.speed) / TIME_STEP).toBeLessThanOrEqual(
      CONST.MERGE_MAX_COOP_DECEL + 0.01,
    );
    expect(main.mergeCooperationDecel).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL);
  });

  test('lane 3車をランプ終端の停止可能速度へ制限しない', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, CONST.RAMP_Z_END + 20, 20);
    addVehicle(world, 'L', 2, CONST.RAMP_Z_END + 10, 20);
    world.rebuildSectionIndex();

    ramp.update(TIME_STEP);

    expect(ramp.targetSpeed).toBeCloseTo(20, 8);
    expect(ramp.speed).toBeCloseTo(20, 8);
  });

  test('危険な横並びのランプ先頭車は予約時刻へ合う速度まで減速する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = addVehicle(world, 'L', 3, 300, 20);
    const main = addVehicle(world, 'L', 2, 300, 20);
    ramp.mergePlan.state = 'coordinating';
    ramp.mergePlan.front = main;
    ramp.mergePlan.targetPassTime = 3;
    ramp.mergePlan.nextSource = 'main';
    world.rebuildSectionIndex();

    ramp.update(TIME_STEP);

    expect(ramp.targetSpeed).toBeCloseTo((300 - CONST.MERGE_POINT_Z) / 3, 8);
  });

  test('合流完了時に予約車と協調目標を解除する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const front = addVehicle(world, 'L', 2, 280, 20);
    const rear = addVehicle(world, 'L', 2, 350, 20);
    const ramp = addVehicle(world, 'L', 3, 310, 20);
    ramp.mergePlan = {
      state: 'committed',
      front,
      rear,
      congestion: 0,
      targetPassTime: 2,
      nextSource: 'ramp',
    };
    rear.mergeCooperationTarget = ramp.mergePlan.targetPassTime;
    rear.mergeCooperationDecel = CONST.MERGE_TARGET_COOP_DECEL;
    ramp.laneChange = {
      state: 'changing',
      from: 3,
      to: 2,
      progress: 0.99,
      holdTime: 0,
      checkTimer: 1,
    };

    ramp.updateLaneChange(TIME_STEP);

    expect(ramp.mergePlan).toMatchObject({
      state: 'completed',
      front: null,
      rear: null,
    });
    expect(rear.mergeCooperationTarget).toBeNull();
    expect(rear.mergeCooperationDecel).toBe(0);
  });
});

describe('時刻スナップショットと合流期限 (Issue #48)', () => {
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

  test.each([15, 20])(
    '25m/sから30m/sを目指すランプ車はmain z=320・%dm/sとの枠を期限前に確定する',
    (mainSpeed) => {
      const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
      const ramp = addVehicle(world, 'L', 3, 380, 25);
      ramp.desiredSpeed = 30;
      addVehicle(world, 'L', 2, 320, mainSpeed);
      let commitEvent: number | null = null;
      let deadlineCrossEvent: number | null = null;
      let completionEvent: number | null = null;
      let goreCrossEvent: number | null = null;

      for (let step = 0; step < 600 && goreCrossEvent === null; step++) {
        const stateBefore = ramp.mergePlan.state;
        const deadlineMarginBefore = ramp.z - ramp.latestMergeCommitZ();
        const goreMarginBefore = ramp.z - CONST.GORE_Z_START;
        world.step(TIME_STEP);

        if (
          commitEvent === null &&
          stateBefore !== 'committed' &&
          ramp.mergePlan.state === 'committed'
        )
          commitEvent = step * 2;
        if (
          deadlineCrossEvent === null &&
          deadlineMarginBefore >= 0 &&
          ramp.z - ramp.latestMergeCommitZ() < 0
        )
          deadlineCrossEvent = step * 2 + 1;
        if (
          completionEvent === null &&
          stateBefore !== 'completed' &&
          ramp.mergePlan.state === 'completed'
        )
          completionEvent = step * 2;
        if (goreCrossEvent === null && goreMarginBefore > 0 && ramp.z <= CONST.GORE_Z_START)
          goreCrossEvent = step * 2 + 1;
      }

      expect(commitEvent).not.toBeNull();
      expect(deadlineCrossEvent).not.toBeNull();
      expect(commitEvent!).toBeLessThan(deadlineCrossEvent!);
      expect(completionEvent).not.toBeNull();
      expect(goreCrossEvent).not.toBeNull();
      expect(completionEvent!).toBeLessThan(goreCrossEvent!);
    },
  );
});

describe('導流帯越境不変条件 (Issue #48)', () => {
  function expectNoGoreVehicle(world: World): void {
    for (const vehicle of world.vehicles) {
      if (vehicle.waiting || vehicle.lane !== 3) continue;
      expect(vehicle.z).toBeGreaterThan(CONST.GORE_Z_START);
      expect(
        rampBodyIntersectsGore(
          sectionTrackX(vehicle.section, vehicle.x),
          vehicle.z,
          vehicle.width,
          vehicle.length,
        ),
      ).toBe(false);
    }
  }

  test('導流帯座標はコアで共有し、R区間の実座標をL区間座標へ正規化する', () => {
    expect(RAMP_GEOMETRY.gore.startZ).toBe(CONST.GORE_Z_START);
    expect(sectionTrackX('R', CONST.LANE_X.R[3])).toBe(CONST.LANE_X.L[3]);
  });

  test('加速車線の車体先端が導流帯の始端を越えると導流帯と交差する', () => {
    expect(rampBodyIntersectsGore(-15, 260, 1.8, 4.6)).toBe(true);
    expect(rampBodyIntersectsGore(-15, 261, 1.8, 4.6)).toBe(false);
  });

  test('lane 2 の到着枠を証明できないランプ需要は入口待ちに留まり、台数とスコアに残る', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const blocker = new Vehicle(world, 'L', 2, CONST.RAMP_Z_TOP, 'Sedan', 24);
    blocker.speed = 24;
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    ramp.speed = 24;
    ramp.waiting = true;
    world.vehicles.push(blocker, ramp);

    world.admitWaiting();

    expectNoGoreVehicle(world);
    expect(ramp.waiting).toBe(true);
    expect(world.computeSection('L').count).toBe(2);
    expect(world.computeSection('L').score).toBeGreaterThan(0);
    expect((ramp.mergePlan as { certificate?: unknown }).certificate).toBeNull();
  });

  test('有効な投影枠ができるとFIFO先頭だけを予約付きで有効化する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const first = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const second = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    first.speed = 24;
    second.speed = 24;
    first.waiting = true;
    second.waiting = true;
    world.vehicles.push(first, second);

    world.admitWaiting();

    const certificate = (
      first.mergePlan as {
        certificate?: { completionZ: number; targetPassTime: number };
      }
    ).certificate;
    expectNoGoreVehicle(world);
    expect(first.waiting).toBe(false);
    expect(second.waiting).toBe(true);
    expect(certificate).not.toBeNull();
    expect(certificate!.targetPassTime).toBeGreaterThan(world.time);
    expect(certificate!.completionZ).toBeGreaterThan(
      CONST.GORE_Z_START + first.length / 2 + CONST.MERGE_BODY_CLEARANCE,
    );
  });

  test('同時の入口要求は車両配列の順序ではなく待ち列順で確定する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const first = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const second = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    first.speed = 24;
    second.speed = 24;
    first.waiting = true;
    second.waiting = true;
    world.vehicles.push(second, first);
    world.vehicles.reverse();

    world.admitWaiting();

    expect(first.waiting).toBe(false);
    expect(second.waiting).toBe(true);
  });

  test('入口で確定した予約は走行開始後も保持する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    ramp.speed = 24;
    ramp.waiting = true;
    world.vehicles.push(ramp);

    world.step(TIME_STEP);

    expectNoGoreVehicle(world);
    expect(ramp.waiting).toBe(false);
    expect(ramp.mergePlan.certificate).toBeDefined();
    expect(ramp.mergePlan.certificate).not.toBeNull();
  });

  test('rear が許容減速度で投影headwayとTTCを満たせる場合は協調付きで証明する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const rear = new Vehicle(world, 'L', 2, 375, 'Sedan', 20);
    ramp.speed = 24;
    rear.speed = 20;
    ramp.waiting = true;
    world.vehicles.push(ramp, rear);

    const certificate = ramp.evaluateEntryCertificate(world.captureSnapshot());

    expect(certificate).not.toBeNull();
    expect(certificate!.cooperation).toEqual({
      rearOrder: rear.spawnOrder,
      decel: expect.any(Number),
    });
    expect(certificate!.cooperation!.decel).toBeLessThanOrEqual(CONST.MERGE_MAX_COOP_DECEL);
  });

  test('予約後にrear速度が回廊を空にすると移動前に不変条件エラーにする', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const rear = new Vehicle(world, 'L', 2, 375, 'Sedan', 20);
    ramp.speed = 24;
    rear.speed = 20;
    ramp.waiting = true;
    world.vehicles.push(ramp, rear);
    world.admitWaiting();
    rear.speed = 60;
    const zBefore = ramp.z;

    expect(() => world.step(TIME_STEP)).toThrow('合流予約回廊が空');
    expect(ramp.z).toBe(zBefore);
  });

  test('証明書の全roleは一つのsnapshotから配列順序に依存しない運動を確定する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const front = new Vehicle(world, 'L', 2, 310, 'Sedan', 20);
    const rear = new Vehicle(world, 'L', 2, 375, 'Sedan', 20);
    ramp.speed = 24;
    front.speed = 20;
    rear.speed = 20;
    ramp.waiting = true;
    world.vehicles.push(ramp, front, rear);
    world.admitWaiting();
    const snapshot = world.captureSnapshot();

    const first = world.evaluateTick(snapshot, TIME_STEP);
    world.vehicles.reverse();
    const second = world.evaluateTick(snapshot, TIME_STEP);
    const orderedMotions = (motions: typeof first.motions) =>
      [...motions].sort((left, right) => left.vehicleOrder - right.vehicleOrder);

    expect(ramp.mergePlan.certificate?.cooperation?.rearOrder).toBe(rear.spawnOrder);
    expect(first.motions.map((motion) => motion.vehicleOrder).sort((a, b) => a - b)).toEqual(
      [ramp.spawnOrder, front.spawnOrder, rear.spawnOrder].sort((a, b) => a - b),
    );
    expect(orderedMotions(second.motions)).toEqual(orderedMotions(first.motions));
  });

  test('protected roleは通常の摂動と意思決定を通らず予約運動だけを反映する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const front = new Vehicle(world, 'L', 2, 310, 'Sedan', 20);
    const rear = new Vehicle(world, 'L', 2, 375, 'Sedan', 20);
    ramp.speed = 24;
    front.speed = 20;
    rear.speed = 20;
    ramp.waiting = true;
    world.vehicles.push(ramp, front, rear);
    world.admitWaiting();
    front.perturbTimer = 2;
    const speedBefore = front.speed;

    world.step(TIME_STEP);

    expect(front.speed).toBe(speedBefore);
    expect(front.perturbTimer).toBe(2);
    expect(front.laneChange.state).toBe('none');
  });

  test('現在位置が安全でも将来のfront枠が壊れた場合は全roleを移動前に停止する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const front = new Vehicle(world, 'L', 2, 310, 'Sedan', 20);
    const rear = new Vehicle(world, 'L', 2, 375, 'Sedan', 20);
    ramp.speed = 24;
    front.speed = 20;
    rear.speed = 20;
    ramp.waiting = true;
    world.vehicles.push(ramp, front, rear);
    world.admitWaiting();
    front.speed = 0;
    expect(ramp.checkLaneSafetyForChange(2)).toBe('safe');
    const positions = new Map(
      world.vehicles.map((vehicle) => [vehicle.spawnOrder, { z: vehicle.z, x: vehicle.x }]),
    );

    expect(() => world.step(TIME_STEP)).toThrow('合流予約回廊が空');
    for (const vehicle of world.vehicles)
      expect({ z: vehicle.z, x: vehicle.x }).toEqual(positions.get(vehicle.spawnOrder));
    expect(ramp.laneChange.state).toBe('none');
    expect(world.stats.cancels.L).toBe(0);
  });

  test('車線変更中に希望速度が変動しても予約運動は連続し導流帯前で完了する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    ramp.speed = 24;
    ramp.waiting = true;
    world.vehicles.push(ramp);
    world.admitWaiting();
    let sawLaneChange = false;

    for (let step = 0; step < 120 && ramp.lane === 3; step++) {
      const previous = { z: ramp.z, x: ramp.x, speed: ramp.speed };
      ramp.desiredSpeed = step % 2 === 0 ? 8 : 32;
      world.step(TIME_STEP);
      expectNoGoreVehicle(world);
      expect(ramp.waiting).toBe(false);
      expect(world.vehicles).toContain(ramp);
      expect(previous.z - ramp.z).toBeGreaterThanOrEqual(0);
      expect(previous.z - ramp.z).toBeLessThanOrEqual(
        Math.max(previous.speed, ramp.speed) * TIME_STEP + 1e-9,
      );
      expect(Math.abs(ramp.x - previous.x)).toBeLessThanOrEqual(0.3);
      if (ramp.laneChange.state !== 'none') sawLaneChange = true;
    }

    expect(sawLaneChange).toBe(true);
    expect(ramp.lane).toBe(2);
    expect(ramp.z).toBeGreaterThan(CONST.GORE_Z_START + ramp.length / 2);
  });

  test('予約枠へ割り込むlane 2車線変更は開始前に拒否する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    ramp.speed = 24;
    ramp.waiting = true;
    world.vehicles.push(ramp);
    world.admitWaiting();
    const intruder = new Vehicle(world, 'L', 1, 350, 'Sedan', 20);
    intruder.speed = 20;
    world.vehicles.push(intruder);
    world.rebuildSectionIndex();

    expect(intruder.checkLaneSafetyForChange(2)).toBe('safe');
    expect(intruder.tryLaneChange(2)).toBe(false);
    expect(intruder.laneChange.state).toBe('none');
  });
});

describe('前方縦列予約 transaction (Issue #48)', () => {
  function dependencyWorld(): World {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const front = new Vehicle(world, 'L', 2, 310, 'Sedan', 20);
    const frontAhead = new Vehicle(world, 'L', 2, 285, 'Sedan', 20);
    const rear = new Vehicle(world, 'L', 2, 375, 'Sedan', 20);
    const safeBoundary = new Vehicle(world, 'L', 2, 150, 'Sedan', 20);
    ramp.speed = 24;
    ramp.waiting = true;
    for (const vehicle of [front, frontAhead, rear, safeBoundary]) vehicle.speed = 20;
    world.vehicles.push(ramp, front, frontAhead, rear, safeBoundary);
    return world;
  }

  test('roleの予定走行距離で境界を証明できない前方車だけをclosureへ含める', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const role = new Vehicle(world, 'L', 2, 320, 'Sedan', 20);
    const dependency = new Vehicle(world, 'L', 2, 300, 'Sedan', 20);
    const safeBoundary = new Vehicle(world, 'L', 2, 200, 'Sedan', 20);
    for (const vehicle of [role, dependency, safeBoundary]) vehicle.speed = 20;
    world.vehicles.push(role, dependency, safeBoundary);
    const result = buildMergeDependencyClosure(
      world.captureSnapshot(),
      'L',
      [role.spawnOrder],
      world.time + 2,
    );

    expect(result).toEqual({
      ok: true,
      closure: {
        orders: [role.spawnOrder, dependency.spawnOrder].sort((a, b) => a - b),
        edges: [{ followerOrder: role.spawnOrder, aheadOrder: dependency.spawnOrder }],
      },
    });
  });

  test('道路端をまたぐ直前車をwrapped距離でdependencyにする', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const role = new Vehicle(world, 'L', 2, -390, 'Sedan', 20);
    const wrappedAhead = new Vehicle(world, 'L', 2, 390, 'Sedan', 20);
    const safeBoundary = new Vehicle(world, 'L', 2, 280, 'Sedan', 20);
    for (const vehicle of [role, wrappedAhead, safeBoundary]) vehicle.speed = 20;
    world.vehicles.push(role, wrappedAhead, safeBoundary);

    const result = buildMergeDependencyClosure(
      world.captureSnapshot(),
      'L',
      [role.spawnOrder],
      world.time + 2,
    );

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.closure.edges).toContainEqual({
        followerOrder: role.spawnOrder,
        aheadOrder: wrappedAhead.spawnOrder,
      });
  });

  test('周回して始点へ戻るclosureはcycleとして証明書候補を拒否する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const first = new Vehicle(world, 'L', 2, 320, 'Sedan', 20);
    const second = new Vehicle(world, 'L', 2, -80, 'Sedan', 20);
    first.speed = second.speed = 20;
    world.vehicles.push(first, second);

    expect(
      buildMergeDependencyClosure(
        world.captureSnapshot(),
        'L',
        [first.spawnOrder],
        world.time + 60,
      ),
    ).toMatchObject({ ok: false, reason: 'cycle' });
  });

  test('closure上限を超える候補をlimitとして拒否する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const vehicles = [320, 300, 280].map((z) => {
      const vehicle = new Vehicle(world, 'L', 2, z, 'Sedan', 20);
      vehicle.speed = 20;
      world.vehicles.push(vehicle);
      return vehicle;
    });

    expect(
      buildMergeDependencyClosure(
        world.captureSnapshot(),
        'L',
        [vehicles[0].spawnOrder],
        world.time + 10,
        1,
      ),
    ).toMatchObject({ ok: false, reason: 'limit' });
  });

  test('lane 2へ変更中の直前車を途中で凍結せず候補を拒否する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const role = new Vehicle(world, 'L', 2, 320, 'Sedan', 20);
    const changingAhead = new Vehicle(world, 'L', 1, 300, 'Sedan', 20);
    role.speed = changingAhead.speed = 20;
    changingAhead.laneChange = {
      state: 'changing',
      from: 1,
      to: 2,
      progress: 0.5,
      holdTime: 0,
      checkTimer: 0,
    };
    world.vehicles.push(role, changingAhead);

    expect(
      buildMergeDependencyClosure(world.captureSnapshot(), 'L', [role.spawnOrder], world.time + 2),
    ).toMatchObject({
      ok: false,
      reason: 'lane-change-in-progress',
      order: changingAhead.spawnOrder,
    });
  });

  test('frontとrearから必要な前方縦列を証明書へ固定する', () => {
    const world = dependencyWorld();
    const ramp = world.vehicles.find((vehicle) => vehicle.lane === 3)!;
    const [front, frontAhead, rear] = world.vehicles.filter((vehicle) => vehicle.lane === 2);

    world.admitWaiting();

    expect(ramp.waiting).toBe(false);
    expect(ramp.mergePlan.certificate?.closure.orders).toEqual(
      [front.spawnOrder, frontAhead.spawnOrder, rear.spawnOrder].sort((a, b) => a - b),
    );
    expect(ramp.mergePlan.certificate?.closure.edges).toEqual(
      expect.arrayContaining([
        { followerOrder: rear.spawnOrder, aheadOrder: front.spawnOrder },
        { followerOrder: front.spawnOrder, aheadOrder: frontAhead.spawnOrder },
      ]),
    );
  });

  test('停止member・lane change・cycle・limitの候補はwaitingを解除しない', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const stoppedFront = new Vehicle(world, 'L', 2, 310, 'Sedan', 20);
    ramp.speed = 24;
    ramp.waiting = true;
    stoppedFront.speed = 0;
    world.vehicles.push(ramp, stoppedFront);

    world.admitWaiting();

    expect(ramp.waiting).toBe(true);
    expect(ramp.mergePlan.certificate).toBeNull();
  });

  test('direct roleだけでなく前方dependencyも同じtransaction motionを持つ', () => {
    const world = dependencyWorld();
    const ramp = world.vehicles.find((vehicle) => vehicle.lane === 3)!;
    world.admitWaiting();
    const snapshot = world.captureSnapshot();

    const transaction = world.evaluateTick(snapshot, TIME_STEP);
    const expected = [ramp.spawnOrder, ...(ramp.mergePlan.certificate?.closure.orders ?? [])].sort(
      (a, b) => a - b,
    );

    expect(transaction.motions.map((motion) => motion.vehicleOrder).sort((a, b) => a - b)).toEqual(
      expected,
    );
  });

  test('follower速度は同時更新するahead速度と車体間隔から得たhard upper bound以下になる', () => {
    const world = dependencyWorld();
    const ramp = world.vehicles.find((vehicle) => vehicle.lane === 3)!;
    world.admitWaiting();
    const snapshot = world.captureSnapshot();
    const transaction = world.evaluateTick(snapshot, TIME_STEP);
    const edge = ramp.mergePlan.certificate!.closure.edges[0];
    const bySnapshot = new Map(snapshot.vehicles.map((vehicle) => [vehicle.order, vehicle]));
    const byMotion = new Map(transaction.motions.map((motion) => [motion.vehicleOrder, motion]));
    const follower = bySnapshot.get(edge.followerOrder)!;
    const ahead = bySnapshot.get(edge.aheadOrder)!;
    const distance = (((follower.z - ahead.z) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
    const bodyGap = distance - (follower.length + ahead.length) / 2;
    const collisionMax =
      byMotion.get(ahead.order)!.nextSpeed + (bodyGap - CONST.MERGE_BODY_CLEARANCE) / TIME_STEP;

    expect(byMotion.get(follower.order)!.nextSpeed).toBeLessThanOrEqual(collisionMax + 1e-9);
    expect(byMotion.get(follower.order)!.nextSpeed).toBeGreaterThan(0);
  });

  test('全motionのnextZは同じsnapshotとnextSpeedから一度だけ計算する', () => {
    const world = dependencyWorld();
    world.admitWaiting();
    const snapshot = world.captureSnapshot();
    const transaction = world.evaluateTick(snapshot, TIME_STEP);
    const bySnapshot = new Map(snapshot.vehicles.map((vehicle) => [vehicle.order, vehicle]));

    for (const motion of transaction.motions) {
      const vehicle = bySnapshot.get(motion.vehicleOrder)!;
      let expectedZ = vehicle.z - motion.nextSpeed * TIME_STEP;
      if (expectedZ < -CONST.ROAD_HALF - 8) expectedZ += WRAP_LENGTH;
      expect(motion.nextZ).toBeCloseTo(expectedZ, 12);
    }
  });

  test('次tickに速度区間が空になるclosureは初回motion前に拒否する', () => {
    const world = dependencyWorld();
    const ramp = world.vehicles.find((vehicle) => vehicle.lane === 3)!;
    world.admitWaiting();
    const certificate = ramp.mergePlan.certificate!;
    const edge = certificate.closure.edges.find(
      (candidate) => candidate.followerOrder === certificate.frontOrder,
    )!;
    const follower = world.vehicles.find((vehicle) => vehicle.spawnOrder === edge.followerOrder)!;
    const ahead = world.vehicles.find((vehicle) => vehicle.spawnOrder === edge.aheadOrder)!;
    follower.speed = 28;
    ahead.speed = 20;
    follower.z = 300;
    ahead.z = 292.9;
    const snapshot = world.captureSnapshot();

    expect(() =>
      planMergeTransaction(
        snapshot,
        [
          {
            plan: ramp.mergePlan,
            envelope: certificate.envelope,
            startLaneChange: false,
            cooperation: certificate.cooperation
              ? {
                  vehicleOrder: certificate.cooperation.rearOrder,
                  decel: certificate.cooperation.decel,
                }
              : null,
          },
        ],
        TIME_STEP,
      ),
    ).toThrow(/closure速度区間なし/);
  });

  test('aheadの期限時減速を後続memberの初回motionへ伝播する', () => {
    const world = dependencyWorld();
    const ramp = world.vehicles.find((vehicle) => vehicle.lane === 3)!;
    world.admitWaiting();
    const original = ramp.mergePlan.certificate!;
    const front = world.vehicles.find((vehicle) => vehicle.spawnOrder === original.frontOrder)!;
    const rear = world.vehicles.find((vehicle) => vehicle.spawnOrder === original.rearOrder)!;
    front.speed = 20;
    rear.speed = 20;
    front.z = 300;
    rear.z = 307.1;
    const certificate = {
      ...original,
      cooperation: { rearOrder: front.spawnOrder, decel: CONST.MERGE_MAX_COOP_DECEL },
    };
    const plan = { ...ramp.mergePlan, certificate };

    const transaction = planMergeTransaction(
      world.captureSnapshot(),
      [
        {
          plan,
          envelope: certificate.envelope,
          startLaneChange: false,
          cooperation: {
            vehicleOrder: front.spawnOrder,
            decel: CONST.MERGE_MAX_COOP_DECEL,
          },
        },
      ],
      TIME_STEP,
    );
    const motions = new Map(transaction.motions.map((motion) => [motion.vehicleOrder, motion]));

    expect(motions.get(rear.spawnOrder)!.nextSpeed).toBeLessThanOrEqual(
      motions.get(front.spawnOrder)!.nextSpeed,
    );
  });

  test('closure付きtransactionはvehicle配列をreverseしても同じになる', () => {
    const world = dependencyWorld();
    world.admitWaiting();
    const snapshot = world.captureSnapshot();
    const first = world.evaluateTick(snapshot, TIME_STEP);

    world.vehicles.reverse();
    const second = world.evaluateTick(snapshot, TIME_STEP);
    const ordered = (transaction: typeof first) => ({
      directives: [...transaction.directives].sort(
        (left, right) => left.plan.certificate!.rampOrder - right.plan.certificate!.rampOrder,
      ),
      motions: [...transaction.motions].sort(
        (left, right) => left.vehicleOrder - right.vehicleOrder,
      ),
    });

    expect(ordered(second)).toEqual(ordered(first));
  });

  test('予約がなければtransactionは空で通常車だけがlegacy更新される', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const normal = new Vehicle(world, 'L', 1, 0, 'Sedan', 20);
    normal.speed = 20;
    normal.perturbTimer = 1;
    world.vehicles.push(normal);

    expect(world.evaluateTick(world.captureSnapshot(), TIME_STEP)).toEqual({
      directives: [],
      motions: [],
    });
    world.step(TIME_STEP);
    expect(normal.perturbTimer).toBeLessThan(1);
  });

  test('closure memberはlegacyを通らず非closure車だけが通常更新される', () => {
    const world = dependencyWorld();
    const unrelated = new Vehicle(world, 'L', 1, 50, 'Sedan', 20);
    unrelated.speed = 20;
    unrelated.perturbTimer = 1;
    world.vehicles.push(unrelated);
    world.admitWaiting();
    const closureOrders = new Set(
      world.vehicles.find((vehicle) => vehicle.lane === 3)!.mergePlan.certificate!.closure.orders,
    );
    for (const vehicle of world.vehicles)
      if (closureOrders.has(vehicle.spawnOrder)) vehicle.perturbTimer = 1;

    world.step(TIME_STEP);

    expect(unrelated.perturbTimer).toBeLessThan(1);
    for (const vehicle of world.vehicles)
      if (closureOrders.has(vehicle.spawnOrder)) expect(vehicle.perturbTimer).toBe(1);
  });

  test('事前計算済み位置を一括適用しephemeral予約状態をtick末に破棄する', () => {
    const world = dependencyWorld();
    world.admitWaiting();
    const transaction = world.evaluateTick(world.captureSnapshot(), TIME_STEP);
    const motions = new Map(transaction.motions.map((motion) => [motion.vehicleOrder, motion]));

    world.step(TIME_STEP);

    for (const vehicle of world.vehicles) {
      const motion = motions.get(vehicle.spawnOrder);
      if (motion) {
        expect(vehicle.z).toBe(motion.nextZ);
        expect(vehicle.x).toBe(motion.nextX);
      }
      expect(vehicle.reservedMotion).toBeNull();
      expect(vehicle.mergeDirective).toBeNull();
    }
  });

  test('closureから離れたlane 2車線変更は予約中も一律拒否しない', () => {
    const world = dependencyWorld();
    world.admitWaiting();
    const far = new Vehicle(world, 'L', 1, -200, 'Sedan', 20);
    far.speed = 20;
    world.vehicles.push(far);
    world.rebuildSectionIndex();

    expect(world.blocksReservedLaneChange(far, 2)).toBe(false);
  });

  test('target laneの直前または直後がclosure memberなら割込みを拒否する', () => {
    const world = dependencyWorld();
    world.admitWaiting();
    const ramp = world.vehicles.find((vehicle) => vehicle.lane === 3)!;
    const roleOrder = ramp.mergePlan.certificate!.closure.orders[0];
    const role = world.vehicles.find((vehicle) => vehicle.spawnOrder === roleOrder)!;
    const intruder = new Vehicle(world, 'L', 1, role.z + 3, 'Sedan', role.speed);
    intruder.speed = role.speed;
    world.vehicles.push(intruder);
    world.rebuildSectionIndex();

    expect(world.blocksReservedLaneChange(intruder, 2)).toBe(true);
  });

  test('予約合流完了時にcertificateとclosure lockを解放する', () => {
    const world = dependencyWorld();
    world.admitWaiting();
    const ramp = world.vehicles.find((vehicle) => vehicle.lane === 3)!;
    const observer = new Vehicle(world, 'L', 1, 310, 'Sedan', 20);
    observer.speed = 20;
    world.vehicles.push(observer);

    for (let step = 0; step < 200 && ramp.lane === 3; step++) world.step(TIME_STEP);

    expect(ramp.lane).toBe(2);
    expect(ramp.mergePlan.certificate).toBeNull();
    expect(ramp.mergePlan.envelope).toBeUndefined();
    expect(world.blocksReservedLaneChange(observer, 2)).toBe(false);
  });

  test('高流入を300秒監査しwaitingから合流完了まで車両identityと状態遷移を守る', () => {
    const world = new World({ rng: createRng(48), spawnInterval: 300 });
    world.populateInitial();
    const knownByOrder = new Map<number, Vehicle>();
    const queuedRampVehicles = new Set<Vehicle>();
    let sawRampWaiting = false;
    let sawQueuedAdmission = false;
    let sawQueuedCompletion = false;
    let sawExit = false;
    let firstViolation: string | null = null;

    for (let step = 0; step < 6000; step++) {
      const reject = (condition: boolean, detail: string): void => {
        if (!condition && firstViolation === null) firstViolation = `step=${step}: ${detail}`;
      };
      const before = new Map(
        world.vehicles.map((vehicle) => [
          vehicle,
          {
            waiting: vehicle.waiting,
            lane: vehicle.lane,
            z: vehicle.z,
            x: vehicle.x,
            speed: vehicle.speed,
            laneChangeState: vehicle.laneChange.state,
            laneChangeTo: vehicle.laneChange.to,
            reserved: vehicle.mergePlan.certificate !== null,
          },
        ]),
      );
      for (const vehicle of world.vehicles) {
        const known = knownByOrder.get(vehicle.spawnOrder);
        if (known)
          reject(
            vehicle === known,
            `spawnOrder=${vehicle.spawnOrder}のVehicle identityが置換された`,
          );
        else knownByOrder.set(vehicle.spawnOrder, vehicle);
        if (vehicle.waiting && vehicle.lane === 3) queuedRampVehicles.add(vehicle);
      }

      world.step(TIME_STEP);
      const activeIdentities = new Set(world.vehicles);
      reject(
        activeIdentities.size === world.vehicles.length,
        '同じVehicle identityがvehiclesへ重複登録された',
      );

      for (const [vehicle, previous] of before) {
        if (!activeIdentities.has(vehicle)) {
          reject(vehicle.exited, `spawnOrder=${vehicle.spawnOrder}がexitedを経ず削除された`);
          sawExit = true;
          continue;
        }
        reject(
          previous.waiting || !vehicle.waiting,
          `spawnOrder=${vehicle.spawnOrder}がactiveからwaitingへ戻った`,
        );
        if (previous.waiting && previous.lane === 3 && !vehicle.waiting) {
          reject(
            vehicle.lane === 3,
            `spawnOrder=${vehicle.spawnOrder}のramp待機車がlane ${vehicle.lane}へ強制流入した`,
          );
          reject(
            vehicle.mergePlan.certificate !== null,
            `spawnOrder=${vehicle.spawnOrder}のramp待機車がcertificateなしで流入した`,
          );
          sawQueuedAdmission = true;
        }
        if (!previous.waiting && !vehicle.waiting) {
          const forwardDistance =
            (((previous.z - vehicle.z) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
          const maximumDistance = Math.max(previous.speed, vehicle.speed) * TIME_STEP;
          reject(
            forwardDistance <= maximumDistance + 1e-9,
            `spawnOrder=${vehicle.spawnOrder}が縦方向へteleportした (${forwardDistance}m)`,
          );
          reject(
            Math.abs(vehicle.x - previous.x) <= 0.3,
            `spawnOrder=${vehicle.spawnOrder}が横方向へteleportした`,
          );
          if (vehicle.lane !== previous.lane) {
            reject(
              previous.laneChangeState === 'changing',
              `spawnOrder=${vehicle.spawnOrder}が車線変更状態なしでlaneを変更した`,
            );
            reject(
              vehicle.lane === previous.laneChangeTo,
              `spawnOrder=${vehicle.spawnOrder}がlaneChange.to以外へ変更した`,
            );
          }
        }
        if (
          queuedRampVehicles.has(vehicle) &&
          previous.lane === 3 &&
          previous.reserved &&
          vehicle.lane === 2
        ) {
          reject(
            vehicle.mergePlan.state === 'completed',
            `spawnOrder=${vehicle.spawnOrder}がcompletedを経ずramp合流した`,
          );
          reject(
            vehicle.mergePlan.certificate === null,
            `spawnOrder=${vehicle.spawnOrder}が合流後もcertificateを保持した`,
          );
          sawQueuedCompletion = true;
        }
      }

      sawRampWaiting ||= world.vehicles.some((vehicle) => vehicle.waiting && vehicle.lane === 3);
      for (const vehicle of world.vehicles) {
        const known = knownByOrder.get(vehicle.spawnOrder);
        if (known)
          reject(
            vehicle === known,
            `spawnOrder=${vehicle.spawnOrder}のVehicle identityが置換された`,
          );
        else knownByOrder.set(vehicle.spawnOrder, vehicle);
        if (vehicle.waiting || vehicle.lane !== 3) continue;
        reject(vehicle.speed > 0, `spawnOrder=${vehicle.spawnOrder}がlane 3で停止した`);
        reject(
          vehicle.z > CONST.GORE_Z_START,
          `spawnOrder=${vehicle.spawnOrder}がlane 3の終端を越えた`,
        );
        reject(
          !rampBodyIntersectsGore(
            sectionTrackX(vehicle.section, vehicle.x),
            vehicle.z,
            vehicle.width,
            vehicle.length,
          ),
          `spawnOrder=${vehicle.spawnOrder}が導流帯へ侵入した`,
        );
      }
      if (firstViolation !== null) break;
    }

    expect(firstViolation).toBeNull();
    expect(sawRampWaiting).toBe(true);
    expect(sawQueuedAdmission).toBe(true);
    expect(sawQueuedCompletion).toBe(true);
    expect(sawExit).toBe(true);
  });

  function mirroredDependencyWorld(): World {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    for (const section of ['L', 'R'] as const) {
      const ramp = new Vehicle(world, section, 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
      const front = new Vehicle(world, section, 2, 310, 'Sedan', 20);
      const frontAhead = new Vehicle(world, section, 2, 285, 'Sedan', 20);
      const rear = new Vehicle(world, section, 2, 375, 'Sedan', 20);
      const safeBoundary = new Vehicle(world, section, 2, 150, 'Sedan', 20);
      ramp.speed = 24;
      ramp.waiting = true;
      for (const vehicle of [front, frontAhead, rear, safeBoundary]) vehicle.speed = 20;
      world.vehicles.push(ramp, front, frontAhead, rear, safeBoundary);
    }
    return world;
  }

  function sectionOrderRanks(world: World, section: 'L' | 'R'): Map<number, number> {
    return new Map(
      world.vehicles
        .filter((vehicle) => vehicle.section === section)
        .sort((left, right) => left.spawnOrder - right.spawnOrder)
        .map((vehicle, index) => [vehicle.spawnOrder, index]),
    );
  }

  function normalizeClosure(ramp: Vehicle) {
    const ranks = sectionOrderRanks(ramp.world, ramp.section);
    const closure = ramp.mergePlan.certificate!.closure;
    return {
      orders: closure.orders.map((order) => ranks.get(order)!),
      edges: closure.edges
        .map((edge) => ({
          followerOrder: ranks.get(edge.followerOrder)!,
          aheadOrder: ranks.get(edge.aheadOrder)!,
        }))
        .sort(
          (left, right) =>
            left.followerOrder - right.followerOrder || left.aheadOrder - right.aheadOrder,
        ),
    };
  }

  function normalizeMotions(
    world: World,
    transaction: ReturnType<World['evaluateTick']>,
    section: 'L' | 'R',
  ) {
    const ranks = sectionOrderRanks(world, section);
    const byOrder = new Map(world.vehicles.map((vehicle) => [vehicle.spawnOrder, vehicle]));
    return transaction.motions
      .filter((motion) => byOrder.get(motion.vehicleOrder)?.section === section)
      .map((motion) => ({
        vehicleOrder: ranks.get(motion.vehicleOrder)!,
        nextSpeed: motion.nextSpeed,
        nextZ: motion.nextZ,
        nextX: motion.nextX - CONST.SECTION_OFFSET_X[section],
        laneChangeProgress: motion.laneChangeProgress,
      }))
      .sort((left, right) => left.vehicleOrder - right.vehicleOrder);
  }

  test('L/Rのdependency closureとmotionはorder正規化後に一致する', () => {
    const world = mirroredDependencyWorld();
    world.admitWaiting();
    const transaction = world.evaluateTick(world.captureSnapshot(), TIME_STEP);
    const ramps = (['L', 'R'] as const).map(
      (section) =>
        world.vehicles.find((vehicle) => vehicle.section === section && vehicle.lane === 3)!,
    );

    expect(normalizeClosure(ramps[0])).toEqual(normalizeClosure(ramps[1]));
    expect(normalizeMotions(world, transaction, 'L')).toEqual(
      normalizeMotions(world, transaction, 'R'),
    );
  });

  test('seed=44でも義務あり側の流入が義務なし側を下回らない', () => {
    const result = getResults().find((entry) => entry.seed === 44)!;
    expect(
      result.world.stats.inflow.L,
      `seed=44: inflow L=${result.world.stats.inflow.L}, R=${result.world.stats.inflow.R}`,
    ).toBeGreaterThanOrEqual(result.world.stats.inflow.R);
  });

  test('初期は前方でも合流途中にrearとなる車両との時空間交差を拒否する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Van', 18.97017482877709);
    const front = new Vehicle(world, 'L', 2, 278.02193000383994, 'Van', 18.059128418564796);
    const rear = new Vehicle(world, 'L', 2, 310.30953521438084, 'Truck', 15.46403223881498);
    ramp.speed = 17.724271619194656;
    ramp.waiting = true;
    front.speed = 18.049215928541813;
    rear.speed = 4.67294305712168;
    world.vehicles.push(ramp, front, rear);
    const snapshot = world.captureSnapshot();
    const certificate = ramp.evaluateEntryCertificate(snapshot)!;
    const plan = {
      ...ramp.mergePlan,
      targetPassTime: certificate.targetPassTime,
      completionZ: certificate.completionZ,
      envelope: certificate.envelope,
      certificate,
    };

    expect(() =>
      validateMergeTransactionHorizon(
        snapshot,
        {
          plan,
          envelope: certificate.envelope,
          startLaneChange: false,
          cooperation: certificate.cooperation
            ? {
                vehicleOrder: certificate.cooperation.rearOrder,
                decel: certificate.cooperation.decel,
              }
            : null,
        },
        TIME_STEP,
      ),
    ).toThrow(/rear車体間隔/);
  });

  test('ランプ待ちが本線側の独立した入口待ちを塞がない', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const blocker = new Vehicle(world, 'L', 2, CONST.RAMP_Z_TOP, 'Sedan', 20);
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const mainline = new Vehicle(world, 'L', 0, CONST.ROAD_HALF + 4.6, 'Sedan', 24);
    blocker.speed = 24;
    ramp.speed = 24;
    ramp.waiting = true;
    mainline.waiting = true;
    world.vehicles.push(blocker, ramp, mainline);

    world.admitWaiting();

    expect(ramp.waiting).toBe(true);
    expect(mainline.waiting).toBe(false);
  });

  test('closureの終端速度へは必要な制動開始時刻まで現在速度を保つ', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const follower = new Vehicle(world, 'L', 2, 350, 'Sedan', 20);
    const ahead = new Vehicle(world, 'L', 2, 280, 'Sedan', 10);
    ramp.speed = 24;
    follower.speed = 20;
    ahead.speed = 10;
    world.vehicles.push(ramp, follower, ahead);
    const certificate = {
      rampOrder: ramp.spawnOrder,
      frontOrder: follower.spawnOrder,
      rearOrder: null,
      targetPassTime: world.time + 4,
      completionZ: CONST.MERGE_POINT_Z,
      envelope: { min: 1, max: 30 },
      cooperation: null,
      closure: {
        orders: [follower.spawnOrder, ahead.spawnOrder].sort((left, right) => left - right),
        edges: [
          {
            followerOrder: follower.spawnOrder,
            aheadOrder: ahead.spawnOrder,
          },
        ],
      },
    };
    const transaction = planMergeTransaction(
      world.captureSnapshot(),
      [
        {
          plan: {
            ...ramp.mergePlan,
            targetPassTime: certificate.targetPassTime,
            completionZ: certificate.completionZ,
            envelope: certificate.envelope,
            certificate,
          },
          envelope: certificate.envelope,
          startLaneChange: false,
          cooperation: null,
        },
      ],
      TIME_STEP,
    );
    const motion = transaction.motions.find(
      (candidate) => candidate.vehicleOrder === follower.spawnOrder,
    )!;

    expect(motion.nextSpeed).toBe(follower.speed);
  });

  test('入口待ち上限はランプと本線の独立した待ち列ごとに数える', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    for (let index = 0; index < CONST.RAMP_QUEUE_MAX; index++) {
      const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
      ramp.waiting = true;
      world.vehicles.push(ramp);
    }

    world.spawnPair();

    expect(world.stats.inflow.L).toBe(1);
    expect(world.stats.inflow.R).toBe(1);
  });

  test('certificateを作ったramp速度をactive化後の初tickまで維持する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    ramp.speed = 12;
    ramp.waiting = true;
    world.vehicles.push(ramp);
    const beforeAdmission = world.captureSnapshot();
    const certificate = ramp.evaluateEntryCertificate(beforeAdmission)!;
    const plan = {
      ...ramp.mergePlan,
      targetPassTime: certificate.targetPassTime,
      completionZ: certificate.completionZ,
      envelope: certificate.envelope,
      certificate,
    };
    const expectedMotion = planMergeTransaction(
      beforeAdmission,
      [
        {
          plan,
          envelope: certificate.envelope,
          startLaneChange: false,
          cooperation: null,
        },
      ],
      TIME_STEP,
    ).motions.find((motion) => motion.vehicleOrder === ramp.spawnOrder)!;

    world.admitWaiting(beforeAdmission, TIME_STEP);
    const actualMotion = world
      .evaluateTick(world.captureSnapshot(), TIME_STEP)
      .motions.find((motion) => motion.vehicleOrder === ramp.spawnOrder)!;

    expect(ramp.waiting).toBe(false);
    expect(ramp.speed).toBe(12);
    expect(actualMotion.nextSpeed).toBe(expectedMotion.nextSpeed);
    expect(actualMotion.nextZ).toBe(expectedMotion.nextZ);
  });
});

describe('離散時間の合流証明書 (Issue #48)', () => {
  test('ログで再現したclosure edgeが最大減速度で届かない証明書はactive化前に拒否する', () => {
    const deltaTime = 0.016700000002980234;
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    world.time = 40.72679999998917;
    const ramp = new Vehicle(world, 'L', 3, 289.906, 'Sedan', 19.023411173242454);
    const follower = new Vehicle(world, 'L', 2, -274.601, 'Sedan', 13.77235242512215);
    const ahead = new Vehicle(world, 'L', 2, -281.7486726740629, 'Sedan', 11.87032148304499);
    ramp.speed = 19.023411173242454;
    ramp.waiting = true;
    follower.speed = 13.77235242512215;
    ahead.speed = 11.87032148304499;
    world.vehicles.push(ramp, follower, ahead);
    const snapshot = world.captureSnapshot();
    const certificate = {
      rampOrder: ramp.spawnOrder,
      frontOrder: null,
      rearOrder: null,
      targetPassTime: 41.35268198166156,
      completionZ: CONST.MERGE_POINT_Z,
      envelope: {
        min: 18.97287904935719,
        max: 19.023411173242454,
      },
      cooperation: null,
      closure: {
        orders: [follower.spawnOrder, ahead.spawnOrder],
        edges: [
          {
            followerOrder: follower.spawnOrder,
            aheadOrder: ahead.spawnOrder,
          },
        ],
      },
    };
    const plan = {
      ...ramp.mergePlan,
      targetPassTime: certificate.targetPassTime,
      completionZ: certificate.completionZ,
      envelope: certificate.envelope,
      certificate,
    };

    expect(
      isMergeTransactionAdmissible(
        snapshot,
        {
          plan,
          envelope: certificate.envelope,
          startLaneChange: false,
          cooperation: null,
        },
        deltaTime,
      ),
    ).toBe(false);
    expect(ramp.waiting).toBe(true);
    expect(ramp.mergePlan.certificate).toBeNull();
  });

  test('seed=48の高流入を60fpsで300秒進めても回廊例外・導流帯侵入・activeからwaitingへの逆戻りがない', () => {
    const deltaTime = 0.016700000002980234;
    const world = new World({ rng: createRng(48), spawnInterval: 300 });
    world.populateInitial();
    let firstViolation: string | null = null;
    let sawRampWaiting = false;

    for (let step = 0; step < 300 / deltaTime && firstViolation === null; step++) {
      const activeRampOrders = new Set(
        world.vehicles
          .filter((vehicle) => !vehicle.waiting && vehicle.lane === 3)
          .map((vehicle) => vehicle.spawnOrder),
      );
      try {
        world.step(deltaTime);
      } catch (error) {
        firstViolation = `step=${step}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
      sawRampWaiting ||= world.vehicles.some((vehicle) => vehicle.waiting && vehicle.lane === 3);
      for (const vehicle of world.vehicles) {
        if (activeRampOrders.has(vehicle.spawnOrder) && vehicle.waiting)
          firstViolation = `step=${step}: active車両${vehicle.spawnOrder}がwaitingへ戻った`;
        if (vehicle.waiting || vehicle.lane !== 3) continue;
        if (
          vehicle.z <= CONST.GORE_Z_START ||
          rampBodyIntersectsGore(
            sectionTrackX(vehicle.section, vehicle.x),
            vehicle.z,
            vehicle.width,
            vehicle.length,
          )
        )
          firstViolation = `step=${step}: lane 3車両${vehicle.spawnOrder}が導流帯へ侵入した`;
      }
    }

    expect(firstViolation).toBeNull();
    expect(sawRampWaiting).toBe(true);
  });
});

describe('アニメーションループの障害境界 (Issue #48)', () => {
  test('更新例外を一度だけ記録して更新を停止し、静止描画と明示リセットを維持する', () => {
    const invariantError = new Error('導流帯不変条件違反');
    const reported: unknown[] = [];
    const boundary = createAnimationFaultBoundary((error) => reported.push(error));
    let steps = 0;
    let renders = 0;

    boundary.runFrame(
      () => {
        steps++;
        throw invariantError;
      },
      () => renders++,
    );
    boundary.runFrame(
      () => steps++,
      () => renders++,
    );

    expect(steps).toBe(1);
    expect(renders).toBe(2);
    expect(reported).toEqual([invariantError]);
    expect(boundary.fault?.error).toBe(invariantError);

    boundary.reset();
    boundary.runFrame(
      () => steps++,
      () => renders++,
    );

    expect(boundary.fault).toBeNull();
    expect(steps).toBe(2);
    expect(renders).toBe(3);
    expect(reported).toEqual([invariantError]);
  });
});

describe('可変描画周期と固定物理tick (Issue #48)', () => {
  test('可変dtの高流入でもactive証明書を同一tickで実行し回廊例外・導流帯侵入を起こさない', () => {
    const frameDeltas = [0.0167, 0.014, 0.05, 0.02];
    const world = new World({ rng: createRng(48), spawnInterval: 300 });
    const fixedStep = createFixedStepAccumulator(FIXED_SIMULATION_DELTA_TIME);
    const reported: unknown[] = [];
    const boundary = createAnimationFaultBoundary((error) => reported.push(error));
    let elapsed = 0;
    let frame = 0;
    let activeCertificateCount = 0;
    let goreViolation: string | null = null;
    world.populateInitial();

    while (elapsed < 300 && boundary.fault === null && goreViolation === null) {
      const frameDelta = frameDeltas[frame % frameDeltas.length];
      boundary.runFrame(
        () => {
          fixedStep.advance(frameDelta, (deltaTime) => {
            activeCertificateCount += world.vehicles.filter(
              (vehicle) =>
                !vehicle.waiting && vehicle.lane === 3 && vehicle.mergePlan.certificate !== null,
            ).length;
            world.step(deltaTime);
            for (const vehicle of world.vehicles) {
              if (vehicle.waiting || vehicle.lane !== 3) continue;
              if (
                vehicle.z <= CONST.GORE_Z_START ||
                rampBodyIntersectsGore(
                  sectionTrackX(vehicle.section, vehicle.x),
                  vehicle.z,
                  vehicle.width,
                  vehicle.length,
                )
              )
                goreViolation = `frame=${frame}: lane 3車両${vehicle.spawnOrder}が導流帯へ侵入`;
            }
          });
        },
        () => {},
      );
      elapsed += frameDelta;
      frame++;
    }

    expect(boundary.fault).toBeNull();
    expect(reported).toEqual([]);
    expect(goreViolation).toBeNull();
    expect(activeCertificateCount).toBeGreaterThan(0);
    expect(Math.abs(world.time - elapsed)).toBeLessThan(0.0167);
  });

  test('固定tickでもactive化後に回廊を壊す真の違反は安全性faultとして停止する', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 1e9 });
    const ramp = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 24);
    const rear = new Vehicle(world, 'L', 2, 375, 'Sedan', 20);
    ramp.speed = 24;
    rear.speed = 20;
    ramp.waiting = true;
    world.vehicles.push(ramp, rear);
    world.admitWaiting(world.captureSnapshot(), FIXED_SIMULATION_DELTA_TIME);
    rear.speed = 60;
    const fixedStep = createFixedStepAccumulator(FIXED_SIMULATION_DELTA_TIME);
    const reported: unknown[] = [];
    const boundary = createAnimationFaultBoundary((error) => reported.push(error));
    const zBefore = ramp.z;

    boundary.runFrame(
      () => fixedStep.advance(FIXED_SIMULATION_DELTA_TIME, (deltaTime) => world.step(deltaTime)),
      () => {},
    );

    const faultError = boundary.fault?.error;
    expect(faultError).toBeInstanceOf(Error);
    if (!(faultError instanceof Error)) throw new Error('安全性faultがErrorではない');
    expect(faultError.message).toContain('合流予約回廊が空');
    expect(reported).toEqual([faultError]);
    expect(ramp.z).toBe(zBefore);
  });

  test('HUD・描画例外は安全性faultに分類せず描画継続を試みる', () => {
    const safetyErrors: unknown[] = [];
    const presentationErrors: unknown[] = [];
    const boundary = createAnimationFaultBoundary(
      (error) => safetyErrors.push(error),
      (error) => presentationErrors.push(error),
    );
    const hudError = new Error('HUD更新失敗');
    const renderError = new Error('描画失敗');
    let simulations = 0;
    let renders = 0;

    boundary.runFrame(
      () => simulations++,
      () => renders++,
      () => {
        throw hudError;
      },
    );
    boundary.runFrame(
      () => simulations++,
      () => {
        renders++;
        throw renderError;
      },
    );
    boundary.runFrame(
      () => simulations++,
      () => renders++,
    );

    expect(boundary.fault).toBeNull();
    expect(safetyErrors).toEqual([]);
    expect(presentationErrors).toEqual([hudError, renderError]);
    expect(simulations).toBe(3);
    expect(renders).toBe(3);
  });
});

describe('車両数上限の区間独立性 (Issue #72)', () => {
  /*
   * 上限をL/R合計で共有すると、片方の混雑がもう片方の流入を止めて対照実験に交絡が生じる。
   * そのため、同一の片側上限を各区間へ独立に適用する。
   */
  function addVehicles(world: World, section: 'L' | 'R', count: number): void {
    for (let index = 0; index < count; index++) {
      world.vehicles.push(new Vehicle(world, section, index % 3, index * 20, 'Sedan', 20));
    }
  }

  test('片方が上限でも、上限未満の区間には流入できる', () => {
    const world = new World({ rng: () => 0.5, spawnInterval: 50 });
    addVehicles(world, 'L', CONST.MAX_VEHICLES_PER_SECTION);
    addVehicles(world, 'R', CONST.MAX_VEHICLES_PER_SECTION - 1);
    const countLBefore = world.vehicles.filter((vehicle) => vehicle.section === 'L').length;
    const countRBefore = world.vehicles.filter((vehicle) => vehicle.section === 'R').length;

    expect(
      world.spawnPair(),
      `L側 ${countLBefore}台が上限でも、R側 ${countRBefore}台に流入できなかった`,
    ).toBe(true);
    const countLAfter = world.vehicles.filter((vehicle) => vehicle.section === 'L').length;
    const countRAfter = world.vehicles.filter((vehicle) => vehicle.section === 'R').length;
    expect(
      countLAfter,
      `上限到達済みのL側が ${countLBefore}台から ${countLAfter}台に増減した`,
    ).toBe(countLBefore);
    expect(
      countRAfter,
      `空きのあるR側が ${countRBefore}台から ${countRAfter}台になり、1台流入しなかった`,
    ).toBe(countRBefore + 1);
  });

  test('高需要でも各区間の台数が片側上限を超えない', () => {
    const world = new World({ rng: createRng(72), spawnInterval: 50 });
    world.populateInitial();
    for (let index = 0; index < Math.round(60 / TIME_STEP); index++) world.step(TIME_STEP);

    for (const section of ['L', 'R'] as const) {
      const count = world.vehicles.filter((vehicle) => vehicle.section === section).length;
      expect(
        count,
        `${section}側 ${count}台 > 片側上限 ${CONST.MAX_VEHICLES_PER_SECTION}台`,
      ).toBeLessThanOrEqual(CONST.MAX_VEHICLES_PER_SECTION);
    }
  });

  test('片側上限は道路形状から求めた物理収容台数以上で、総上限はその2倍である', () => {
    const averageLength = 4.6 * 0.46 + 5.4 * 0.25 + 9.2 * 0.11 + 4.2 * 0.18;
    const stoppedFrontToFrontDistance = averageLength * 1.2 + 2.5 + averageLength;
    const mainlineCapacity = Math.floor((WRAP_LENGTH * 3) / stoppedFrontToFrontDistance);
    const rampCapacity = Math.floor(
      (CONST.RAMP_Z_TOP - CONST.GORE_Z_START) / stoppedFrontToFrontDistance,
    );
    const waitingCapacity = CONST.RAMP_QUEUE_MAX * 2;
    const physicalCapacity = mainlineCapacity + rampCapacity + waitingCapacity;

    expect(
      CONST.MAX_VEHICLES_PER_SECTION,
      `片側上限 ${CONST.MAX_VEHICLES_PER_SECTION}台 < 物理収容台数 ${physicalCapacity}台`,
    ).toBeGreaterThanOrEqual(physicalCapacity);
    expect(
      CONST.MAX_VEHICLES,
      `総上限 ${CONST.MAX_VEHICLES}台 !== 片側上限 ${CONST.MAX_VEHICLES_PER_SECTION}台の2倍`,
    ).toBe(CONST.MAX_VEHICLES_PER_SECTION * 2);
  });
});

/* ============================================================
   29. 貫通検査のカバレッジ (Issue #53)
   貫通(同一車線内の重なり)検査そのものの検出力を検証する。
   旧実装は「区間全体の z 昇順配列の隣接 index」だけを見ていたため、
   同一車線の真の前後ペアのうち約1割しか比較できていなかった。
   ここでは checkPenetration が
     (a) 他車線の車が間に挟まっても同一車線ペアを見る
     (b) 周回の継ぎ目ペアを見る
     (c) 距離をラップ対応で測る
   を満たすことを、意図的に作った配置で確認する。
   ============================================================ */
describe('貫通検査のカバレッジ (Issue #53)', () => {
  function makeWorld(): World {
    return new World({ rng: createRng(53), spawnInterval: 1e9 });
  }

  test('同一車線ペアの間に他車線の車が挟まっても検査される', () => {
    const world = makeWorld();
    // z 昇順に並べると lane1 → lane0 → lane1 となり、隣接 index だけを見る
    // 旧方式では lane1 同士の重なりが永久に検査対象から漏れる配置
    const ahead = new Vehicle(world, 'L', 1, 0, 'Sedan', 25);
    const between = new Vehicle(world, 'L', 0, 1.5, 'Sedan', 25);
    const behind = new Vehicle(world, 'L', 1, 3, 'Sedan', 25);
    world.vehicles.push(ahead, between, behind);
    world.rebuildSectionIndex();

    const result = checkPenetration(world);
    expect(result.overlaps, '他車線に挟まれた同一車線ペアの重なりを見逃した').toBe(1);
    // 車間 = 3m(車頭間) - 4.6m(Sedan 2台の半長の和)
    expect(result.minGap).toBeCloseTo(3 - 4.6, 6);
  });

  test('周回の継ぎ目ペア(z 最小 → z 最大)も検査される', () => {
    const world = makeWorld();
    // リング上では 2m しか離れていないが、z の差は 814m ある配置。
    // 継ぎ目ペアを比較しない、あるいは Math.abs(z 差) で測ると見逃す
    const behind = new Vehicle(world, 'L', 1, -407, 'Sedan', 25);
    const ahead = new Vehicle(world, 'L', 1, 407, 'Sedan', 25);
    world.vehicles.push(behind, ahead);
    world.rebuildSectionIndex();

    const result = checkPenetration(world);
    expect(result.pairs, '継ぎ目ペアが検査されていない').toBe(2);
    expect(result.overlaps, '継ぎ目をまたぐ重なりを見逃した').toBe(1);
    expect(result.minGap).toBeCloseTo(WRAP_LENGTH - 814 - 4.6, 6);
  });

  test('周回しない加速車線(lane 3)の継ぎ目ペアを重なりと誤検出しない', () => {
    const world = makeWorld();
    // 加速車線は本線と違い周回しない。ラップ距離を符号付き最短(wrapDelta)で
    // 測ると半周を超える継ぎ目ペアが負に折り返り、存在しない貫通を報告する
    const ahead = new Vehicle(world, 'L', 3, CONST.RAMP_Z_END, 'Sedan', 25);
    const behind = new Vehicle(world, 'L', 3, CONST.RAMP_Z_TOP, 'Sedan', 25);
    world.vehicles.push(ahead, behind);
    world.rebuildSectionIndex();

    const result = checkPenetration(world);
    expect(result.overlaps, '周回しない車線で存在しない重なりを誤検出した').toBe(0);
    expect(result.minGap).toBeCloseTo(CONST.RAMP_Z_TOP - CONST.RAMP_Z_END - 4.6, 6);
  });

  test('車線変更中の車は対象外(どちらの車線に居るか定まらないため)', () => {
    const world = makeWorld();
    const ahead = new Vehicle(world, 'L', 1, 0, 'Sedan', 25);
    const behind = new Vehicle(world, 'L', 1, 3, 'Sedan', 25);
    behind.laneChange.state = 'changing';
    behind.laneChange.from = 2;
    behind.laneChange.to = 1;
    world.vehicles.push(ahead, behind);
    world.rebuildSectionIndex();

    expect(checkPenetration(world).pairs).toBe(0);
  });

  test('シナリオ実行中にリング全周の同一車線ペアを十分な数だけ検査している', () => {
    // 検出力そのものの回帰ガード。実測(10シード×300秒、10ステップおき)では
    // 約 77.5 万ペアを検査しており、旧方式の約 7.8 万ペア(真のペアの約 10%)から
    // 一桁増えた。将来この数が旧方式の水準まで落ちたら検査の穴が再発している
    const pairs = getResults().reduce((sum, result) => sum + result.checkedPairs, 0);
    expect(pairs, `検査した同一車線ペアが ${pairs} 件しかない(検出力の後退)`).toBeGreaterThan(
      500_000,
    );
  });
});

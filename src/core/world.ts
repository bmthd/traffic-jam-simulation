/* ============================================================
   シミュレーションコア: ワールド（車両生成・時間発展・スコア）
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import {
  CONST,
  FACILITIES,
  facilityIndexForZ,
  rampBodyIntersectsGore,
  sectionTrackX,
  toFacilityLocalZ,
  TYPES,
  TYPE_WEIGHTS,
} from './constants';
import type { Section, SimMode, VehicleTypeName } from './constants';
import { clamp, wrapDelta, WRAP_LENGTH } from './utils';
import type { Rng } from './utils';
import { createWorldDeps } from './factory';
import {
  isMergeTransactionAdmissible,
  MergeTransactionPlanningError,
  planMergeTransaction,
} from './merge-transaction';
import type {
  MergeCandidate,
  MergeCertificate,
  MergeDirective,
  NeighborInfo,
  MergePlan,
  MergeSource,
  MergeTransaction,
  ReservedMotion,
  Vehicle,
  VehicleDeps,
  VehicleFactory,
  VehicleSnapshot,
  WorldSnapshot,
} from './vehicle';

export interface WorldOptions {
  rng?: Rng;
  mode?: SimMode;
  spawnInterval?: number;
}

/**
 * World が使う依存 (Issue #120)。
 * 実体は初期化用モジュール (factory.ts) が供給するため、
 * ここから Vehicle 実装への値 import は持たない (import cycle 防止)。
 */
export interface WorldDeps {
  /** 車両の生成。テストでは偽物の車両生成へ差し替えられる。 */
  readonly createVehicle: VehicleFactory;
  /** 生成した車両へ引き継ぐコントローラ群の初期化。 */
  readonly vehicleDeps: VehicleDeps;
}

export interface SectionStats {
  count: number;
  averageSpeed: number;
  score: number;
}

/** 開始からの累積で「どちらがスムーズだったか」の時間 (秒) */
export interface SmoothTime {
  L: number;
  R: number;
  draw: number; // 差が僅かで引き分け扱いだった時間
}

export class World {
  /** 生成時に注入された依存 (以降は差し替えない) */
  readonly deps: WorldDeps;
  rng: Rng;
  mode: SimMode;
  spawnInterval: number;
  vehicles: Vehicle[];
  spawnAccumulator: number;
  time: number;
  sectionVehicles: Record<Section, Vehicle[]>;
  laneVehicles: Record<Section, Vehicle[][]>;
  private laneVehicleOrder = new Map<Vehicle, number>();
  private laneMemberships = new Map<Vehicle, number[]>();
  lastMergeSource: Record<Section, MergeSource | null> = { L: null, R: null };
  private lastMergeSourceByFacility: Record<Section, (MergeSource | null)[]> = {
    L: FACILITIES.map(() => null),
    R: FACILITIES.map(() => null),
  };
  nextVehicleOrder = 0;
  nextMergePlanId = 0;
  stats: {
    changes: Record<Section, number>;
    yields: Record<Section, number>;
    cancels: Record<Section, number>;
    inflow: Record<Section, number>; // 流入した台数(入口待ち含む)
    outflow: Record<Section, number>; // 出口から捌けた台数
  };
  smoothTime: SmoothTime; // 開始からの累積「スムーズだった時間」(Issue #26)
  absorberRoundRobin: number[] | null = null; // absorbモード: 吸収運転車を等間隔に混ぜるカウンタ
  laneRoundRobin = 0; // absorbモード: レーン割当のラウンドロビン
  perturbTimer: number | null = null; // absorbモード: 次のよそ見ブレーキまでの残り時間

  constructor(options: WorldOptions = {}, deps: WorldDeps = createWorldDeps()) {
    this.deps = deps;
    this.rng = options.rng || Math.random;
    this.mode = options.mode || 'rules'; // 'rules' = ルール比較 / 'absorb' = 渋滞吸収運転
    this.spawnInterval = options.spawnInterval != null ? options.spawnInterval : 800;
    this.vehicles = [];
    this.spawnAccumulator = 0;
    this.time = 0;
    this.sectionVehicles = { L: [], R: [] };
    this.laneVehicles = { L: [[], [], [], []], R: [[], [], [], []] };
    this.stats = {
      changes: { L: 0, R: 0 },
      yields: { L: 0, R: 0 },
      cancels: { L: 0, R: 0 },
      inflow: { L: 0, R: 0 },
      outflow: { L: 0, R: 0 },
    };
    this.smoothTime = { L: 0, R: 0, draw: 0 };
  }

  /**
   * 車両を生成する。実体の選択は注入された依存に委ねる (Issue #120)。
   * 車両側の依存も明示的に渡し、生成関数を差し替えても
   * vehicleDeps の差し替えが黙って無視されないようにする。
   */
  createVehicle(
    section: Section,
    lane: number,
    z: number,
    typeName: VehicleTypeName,
    desiredSpeed: number,
  ): Vehicle {
    return this.deps.createVehicle(
      this,
      section,
      lane,
      z,
      typeName,
      desiredSpeed,
      this.deps.vehicleDeps,
    );
  }

  pickType(): VehicleTypeName {
    // absorbモード: 車種を統一(円周実験と同条件)。車長の違いが車線ごとの
    // 実効密度を準安定帯域から外し、波の比較を濁すのを防ぐ
    if (this.mode === 'absorb') return 'Sedan';
    let roll = this.rng();
    for (const [name, weight] of TYPE_WEIGHTS) {
      if ((roll -= weight) <= 0) return name;
    }
    return 'Sedan';
  }

  // 生成間隔から片側の基準車両数を導出する(「間隔が短い = 交通需要が多い」)。
  // rulesモード: 都市高速の流入調整(ランプメータリング)と同じく、本線上の
  // 台数がこの値を超えないよう入口で流入を待たせる。
  // 待たされた車は入口待ち(waiting)として台数・スコアに計上される。
  // absorbモード: 円周実験(車両は退出しない)なので、この値を上限として
  // 間隔に応じた密度を維持する。
  targetCountPerSection(): number {
    const absorbMode = this.mode === 'absorb';
    const factor = absorbMode ? CONST.ABSORB_DENSITY_FACTOR : CONST.DEMAND_FACTOR;
    // rules需要係数の意味を維持し、将来の道路延長にも同じ台数密度で追従させる。
    // absorb係数は準安定密度そのものとして周長変更時に再較正する。
    const lengthRatio = WRAP_LENGTH / 816;
    return clamp(
      Math.round((factor * (absorbMode ? 1 : lengthRatio)) / this.spawnInterval / 2),
      12 * lengthRatio,
      CONST.MAX_VEHICLES_PER_SECTION,
    );
  }

  // HUDなど両区間合計を扱う呼び出し元向けの基準台数。
  targetCount(): number {
    return this.targetCountPerSection() * 2;
  }

  isSpawnClear(section: Section, lane: number, z: number, exclude: Vehicle | null): boolean {
    for (const vehicle of this.vehicles) {
      if (
        vehicle === exclude ||
        vehicle.waiting ||
        vehicle.section !== section ||
        !vehicle.occupies(lane)
      )
        continue;
      if (Math.abs(wrapDelta(vehicle.z - z)) < 15 + vehicle.length) return false;
    }
    return true;
  }

  // 指定地点から見た直近前方車の車間と速度(スポーン時の安全速度算出用・周回対応)
  aheadInfo(
    section: Section,
    lane: number,
    z: number,
    length: number,
    exclude: Vehicle | null,
  ): { gap: number; speed: number } | null {
    let best: Vehicle | null = null,
      bestDistance = Infinity;
    for (const vehicle of this.vehicles) {
      if (
        vehicle === exclude ||
        vehicle.waiting ||
        vehicle.section !== section ||
        !vehicle.occupies(lane)
      )
        continue;
      let distance = z - vehicle.z; // 前方 = z が小さい側。周回を考慮して正の最短距離に
      distance = ((distance % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
      if (distance < 0.001) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vehicle;
      }
    }
    if (!best) return null;
    return { gap: bestDistance - (length + best.length) / 2, speed: best.speed };
  }

  // 車間内で物理的に止まれる速度に丸める(渋滞の列がスポーン地点まで伸びた場合の追突防止)
  safeSpawnSpeed(
    section: Section,
    lane: number,
    z: number,
    length: number,
    wantSpeed: number,
    exclude: Vehicle | null,
  ): number {
    const info = this.aheadInfo(section, lane, z, length, exclude);
    if (!info) return wantSpeed;
    const maxSafeSpeed = info.speed + Math.sqrt(Math.max(0, 2 * 7 * (info.gap - 4)));
    return clamp(Math.min(wantSpeed, maxSafeSpeed), 0, wantSpeed);
  }

  // 本線上(入口待ちを除く)の台数
  roadCount(section: Section): number {
    let count = 0;
    for (const vehicle of this.vehicles)
      if (!vehicle.waiting && vehicle.section === section) count++;
    return count;
  }

  // 入口待ちを含む、その区間の総台数
  sectionCount(section: Section): number {
    let count = 0;
    for (const vehicle of this.vehicles) if (vehicle.section === section) count++;
    return count;
  }

  // その側の入口が今受け入れ可能か(流入調整の枠内 かつ 入口が物理的に空いている)
  // 空いているレーンを返す。受け入れ不可なら null
  admissibleLane(section: Section, lanes: number[], z: number): number | null {
    if (this.roadCount(section) >= this.targetCountPerSection()) return null; // 流入調整
    const lane = lanes.find((candidate) => this.isSpawnClear(section, candidate, z, null));
    return lane != null ? lane : null;
  }

  // 車両は左右に1台ずつ、同タイプ・同初期速度のペアで「流入しようと」する。
  // 流入需要(追加ペース)は左右で完全に同一だが、実際に道路へ入れるか・
  // いつ捌けるかは各道路の交通状況に従う — ここが Issue #12 の核心。
  // 混んでいる側は出口まで到達する車が少なく流出が遅れるため、入口で
  // 受け入れられず滞留し、道路全体(入口待ち含む)の台数が自然に増える。
  //
  // rulesモード: 各側は独立に流入する。受け入れ可能ならそのまま流入し、
  // 塞がっていれば入口待ち(waiting)の列に並ぶ。
  // 待機列まで溢れている側だけ、その1台の流入を諦める(入口渋滞の敬遠)。
  // absorbモード(円周実験): 従来通り、両側同時に置ける時だけミラー配置する。
  spawnPair(): boolean {
    if (this.mode === 'absorb') {
      const limit = Math.min(CONST.MAX_VEHICLES_PER_SECTION, this.targetCountPerSection());
      if (this.sectionCount('L') >= limit || this.sectionCount('R') >= limit) return false;
      const typeName = this.pickType();
      const spec = TYPES[typeName];
      const speed = spec.minSpeed + this.rng() * (spec.maxSpeed - spec.minSpeed);
      // 左右のレーン配置をミラー、かつラウンドロビンで均等にする
      // (車線変更がないため、各車線を準安定密度の帯域に揃える)
      const lane = (this.laneRoundRobin = (this.laneRoundRobin + 1) % 3);
      const z = CONST.ROAD_HALF + spec.length;
      if (!this.isSpawnClear('L', lane, z, null) || !this.isSpawnClear('R', lane, z, null))
        return false;
      const vehicleL = this.createVehicle('L', lane, z, typeName, speed);
      const vehicleR = this.createVehicle('R', lane, z, typeName, speed);
      vehicleL.speed = this.safeSpawnSpeed('L', lane, z, vehicleL.length, vehicleL.speed, null);
      vehicleR.speed = this.safeSpawnSpeed('R', lane, z, vehicleR.length, vehicleR.speed, null);
      this.vehicles.push(vehicleL, vehicleR);
      this.stats.inflow.L++;
      this.stats.inflow.R++;
      return true;
    }
    // rulesモード: 需要の大半は上流本線(レーン0〜2の始端)から、残りは
    // 合流ランプ(レーン3)から入る。入口条件は左右で完全に同一にする
    const typeName = this.pickType();
    const spec = TYPES[typeName];
    let speed = spec.minSpeed + this.rng() * (spec.maxSpeed - spec.minSpeed);
    // 飛ばし屋: ごく一部、流れより明確に速い車がいる(両区間に同条件で出現)
    if ((typeName === 'Sedan' || typeName === 'SportsCar') && this.rng() < 0.05) {
      speed = Math.max(speed, 32 + this.rng() * 4); // 希望速度 ≒ 115〜130km/h
    }
    const viaRamp = this.rng() < CONST.RAMP_SHARE;
    // 施設番号はペアにつき一度だけ抽選し、L/Rへ同じ入口座標を渡す。
    const facility = viaRamp ? FACILITIES[Math.floor(this.rng() * FACILITIES.length)] : null;
    const preferredLane = viaRamp ? 3 : Math.floor(this.rng() * 3);
    // 本線流入は空いているレーンを選んで入る(上流から来る車は自然に分散する)。
    // 候補の優先順は左右で同一にし、どのレーンに入れるかだけ各道路の状況に従う
    const lanes = viaRamp ? [3] : [preferredLane, (preferredLane + 1) % 3, (preferredLane + 2) % 3];
    const rawZ = viaRamp ? CONST.RAMP_Z_TOP + facility!.offsetZ : CONST.ROAD_HALF + spec.length;
    const z = viaRamp
      ? ((((rawZ + CONST.ROAD_HALF + 8) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH) -
        CONST.ROAD_HALF -
        8
      : rawZ;
    let added = false;
    for (const section of ['L', 'R'] as const) {
      if (this.sectionCount(section) >= CONST.MAX_VEHICLES_PER_SECTION) continue;
      if (
        (viaRamp
          ? this.vehicles.filter(
              (vehicle) =>
                vehicle.waiting &&
                vehicle.section === section &&
                vehicle.lane === 3 &&
                facilityIndexForZ(vehicle.z) === facility!.index,
            ).length
          : this.waitingCount(section, 'mainline')) >= CONST.RAMP_QUEUE_MAX
      )
        continue;
      // ランプ需要は入口の lane 3 が空いていても、lane 2 の将来枠を証明するまで
      // 有効道路状態へ入れない。本線需要は従来通り入口判定だけで扱う。
      const lane = viaRamp ? null : this.admissibleLane(section, lanes, z);
      const vehicle = this.createVehicle(
        section,
        lane != null ? lane : preferredLane,
        z,
        typeName,
        speed,
      );
      if (viaRamp) {
        vehicle.waiting = true;
      } else if (lane != null) {
        vehicle.speed = this.safeSpawnSpeed(section, lane, z, vehicle.length, vehicle.speed, null);
      } else {
        vehicle.waiting = true; // 入口が塞がっている → 手前で待つ(見えない上流の滞留)
      }
      this.vehicles.push(vehicle);
      this.stats.inflow[section]++;
      added = true;
    }
    return added;
  }

  waitingCount(section: Section, entrance: 'all' | 'ramp' | 'mainline' = 'all'): number {
    let count = 0;
    for (const vehicle of this.vehicles) {
      if (!vehicle.waiting || vehicle.section !== section) continue;
      if (entrance === 'ramp' && vehicle.lane !== 3) continue;
      if (entrance === 'mainline' && vehicle.lane === 3) continue;
      count++;
    }
    return count;
  }

  /** 更新中に不変な合流評価用の状態を取得する。 */
  captureSnapshot(): WorldSnapshot {
    const vehicles: VehicleSnapshot[] = this.vehicles
      .map((vehicle) => ({
        order: vehicle.spawnOrder,
        section: vehicle.section,
        lane: vehicle.lane,
        z: vehicle.z,
        x: vehicle.x,
        speed: vehicle.speed,
        desiredSpeed: vehicle.desiredSpeed,
        maxAcceleration: vehicle.type.acceleration,
        length: vehicle.length,
        width: vehicle.width,
        waiting: vehicle.waiting,
        laneChange: { ...vehicle.laneChange },
      }))
      .sort((a, b) => a.order - b.order);
    const byOrder = new Map(vehicles.map((vehicle) => [vehicle.order, vehicle]));
    const lane2BySection = {
      L: vehicles
        .filter(
          (vehicle) =>
            vehicle.section === 'L' &&
            (vehicle.lane === 2 ||
              (vehicle.laneChange.state !== 'none' && vehicle.laneChange.to === 2)) &&
            !vehicle.waiting &&
            vehicle.lane !== 3,
        )
        .sort((left, right) => left.z - right.z || left.order - right.order),
      R: vehicles
        .filter(
          (vehicle) =>
            vehicle.section === 'R' &&
            (vehicle.lane === 2 ||
              (vehicle.laneChange.state !== 'none' && vehicle.laneChange.to === 2)) &&
            !vehicle.waiting &&
            vehicle.lane !== 3,
        )
        .sort((left, right) => left.z - right.z || left.order - right.order),
    };
    return { time: this.time, vehicles, byOrder, lane2BySection };
  }

  private entryLockKey(section: Section, order: number): string {
    return `${section}:${order}`;
  }

  /** 走行中のランプ車の証明書を lock として再構築する。 */
  private activeEntryLocks(): Set<string> {
    const locks = new Set<string>();
    for (const vehicle of this.vehicles) {
      if (vehicle.waiting || vehicle.lane !== 3) continue;
      const certificate = vehicle.mergePlan.certificate;
      if (!certificate) continue;
      for (const order of certificate.closure.orders)
        locks.add(this.entryLockKey(vehicle.section, order));
    }
    return locks;
  }

  /** 確定済み回廊へ投影上割り込む lane 2 車線変更を開始させない。 */
  blocksReservedLaneChange(vehicle: Vehicle, toLane: number): boolean {
    if (toLane !== 2) return false;
    const lockedOrders = new Set<number>();
    const activeReservations: {
      ramp: Vehicle;
      certificate: MergeCertificate;
    }[] = [];
    for (const ramp of this.vehicles) {
      if (ramp.waiting || ramp.lane !== 3 || ramp.section !== vehicle.section) continue;
      const certificate = ramp.mergePlan.certificate;
      if (!certificate) continue;
      activeReservations.push({ ramp, certificate });
      for (const order of certificate.closure.orders) lockedOrders.add(order);
    }
    if (activeReservations.length === 0) return false;
    if (lockedOrders.has(vehicle.spawnOrder)) return true;
    if (
      activeReservations.some(({ certificate }) => {
        const remaining = certificate.targetPassTime - this.time;
        const distance =
          (((vehicle.z - certificate.completionZ) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
        const arrivalTime = distance / Math.max(vehicle.speed, 1);
        return Math.abs(arrivalTime - remaining) <= CONST.LANE_CHANGE_DURATION;
      })
    )
      return true;

    let nearestAhead: { vehicle: Vehicle; distance: number } | null = null;
    let nearestBehind: { vehicle: Vehicle; distance: number } | null = null;
    for (const candidate of this.sectionVehicles[vehicle.section]) {
      if (candidate === vehicle || candidate.waiting || !candidate.occupies(toLane)) continue;
      const aheadDistance = (((vehicle.z - candidate.z) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
      const behindDistance =
        (((candidate.z - vehicle.z) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
      if (aheadDistance > 0.001 && (!nearestAhead || aheadDistance < nearestAhead.distance))
        nearestAhead = {
          vehicle: candidate,
          distance: aheadDistance,
        };
      if (behindDistance > 0.001 && (!nearestBehind || behindDistance < nearestBehind.distance))
        nearestBehind = {
          vehicle: candidate,
          distance: behindDistance,
        };
    }
    const remaining = Math.max(
      ...activeReservations.map(({ certificate }) =>
        Math.max(0, certificate.targetPassTime - this.time),
      ),
    );
    const blocks = (
      neighbor: { vehicle: Vehicle; distance: number } | null,
      closingSpeed: number,
    ) =>
      neighbor !== null &&
      lockedOrders.has(neighbor.vehicle.spawnOrder) &&
      neighbor.distance <=
        (vehicle.length + neighbor.vehicle.length) / 2 +
          CONST.MERGE_BODY_CLEARANCE +
          Math.max(0, closingSpeed) * remaining;
    return (
      blocks(nearestAhead, vehicle.speed - (nearestAhead?.vehicle.speed ?? vehicle.speed)) ||
      blocks(nearestBehind, (nearestBehind?.vehicle.speed ?? vehicle.speed) - vehicle.speed)
    );
  }

  private certificateLocks(section: Section, certificate: MergeCertificate): string[] {
    return certificate.closure.orders.map((order) => this.entryLockKey(section, order));
  }

  /**
   * 入口待ちランプ車を一つの snapshot で評価し、衝突しない証明書だけを同時に適用する。
   * 各区間の FIFO 先頭だけを候補にするため、後続が先に割り込むことはない。
   */
  private admitRampWaiting(
    snapshot: WorldSnapshot,
    heads: readonly Vehicle[],
    deltaTime: number,
  ): void {
    const candidates: { vehicle: Vehicle; candidate: MergeCandidate }[] = [];
    const activeRampFacilities = new Set(
      this.vehicles
        .filter((vehicle) => !vehicle.waiting && vehicle.lane === 3)
        .map((vehicle) => `${vehicle.section}:${facilityIndexForZ(vehicle.z)}`),
    );
    for (const vehicle of heads) {
      if (!vehicle.waiting || vehicle.lane !== 3) continue;
      if (activeRampFacilities.has(`${vehicle.section}:${facilityIndexForZ(vehicle.z)}`)) continue;
      const certificate = vehicle.evaluateEntryCertificate(snapshot, deltaTime);
      if (!certificate) continue;
      const provisionalPlan: MergePlan = {
        ...vehicle.mergePlan,
        state: 'seeking',
        targetPassTime: certificate.targetPassTime,
        completionZ: certificate.completionZ,
        envelope: certificate.envelope,
        certificate,
      };
      if (
        !isMergeTransactionAdmissible(
          snapshot,
          {
            plan: provisionalPlan,
            envelope: certificate.envelope,
            startLaneChange: false,
            cooperation: certificate.cooperation
              ? {
                  vehicleOrder: certificate.cooperation.rearOrder,
                  decel: certificate.cooperation.decel,
                }
              : null,
          },
          deltaTime,
        )
      )
        continue;
      candidates.push({
        vehicle,
        candidate: {
          certificate,
          queueOrder: vehicle.spawnOrder,
          reservationTime: snapshot.time,
        },
      });
    }
    const locks = this.activeEntryLocks();
    const accepted = candidates
      .sort(
        (left, right) =>
          left.candidate.queueOrder - right.candidate.queueOrder ||
          left.candidate.certificate.targetPassTime - right.candidate.certificate.targetPassTime ||
          left.vehicle.spawnOrder - right.vehicle.spawnOrder,
      )
      .filter(({ vehicle, candidate }) => {
        const candidateLocks = this.certificateLocks(vehicle.section, candidate.certificate);
        if (candidateLocks.some((lock) => locks.has(lock))) return false;
        for (const lock of candidateLocks) locks.add(lock);
        return true;
      });
    for (const { vehicle, candidate } of accepted) {
      const { certificate } = candidate;
      vehicle.waiting = false;
      vehicle.x = CONST.LANE_X[vehicle.section][3];
      vehicle.speed = snapshot.byOrder.get(vehicle.spawnOrder)!.speed;
      vehicle.mergePlan = {
        ...vehicle.mergePlan,
        id: this.nextMergePlanId++,
        state: 'seeking',
        targetPassTime: certificate.targetPassTime,
        completionZ: certificate.completionZ,
        envelope: certificate.envelope,
        certificate,
      };
    }
  }

  /** tick 境界で lane 3 の車体が導流帯へ侵入していないことを検査する。 */
  assertGoreInvariant(phase: 'start' | 'end'): void {
    for (const vehicle of this.vehicles) {
      if (vehicle.waiting || vehicle.lane !== 3) continue;
      const intersects = rampBodyIntersectsGore(
        sectionTrackX(vehicle.section, vehicle.x),
        vehicle.z,
        vehicle.width,
        vehicle.length,
      );
      if (toFacilityLocalZ(vehicle.z) <= CONST.GORE_Z_START || intersects)
        throw new Error(`導流帯不変条件違反(${phase}): vehicle=${vehicle.spawnOrder}`);
    }
  }

  private corridorError(
    plan: MergePlan,
    snapshot: WorldSnapshot,
    deltaTime: number,
    reason: string,
  ): Error {
    const certificate = plan.certificate;
    const roleOrders = certificate ? [certificate.rampOrder, ...certificate.closure.orders] : [];
    const roles = roleOrders.map((order) => {
      const vehicle = snapshot.byOrder.get(order);
      return vehicle
        ? `${order}:${vehicle.lane}@${vehicle.z.toFixed(3)}/${vehicle.speed.toFixed(3)}`
        : `${order}:missing`;
    });
    return new Error(
      [
        '合流予約回廊が空:',
        `plan=${plan.id}`,
        `ramp=${certificate?.rampOrder}`,
        `front=${certificate?.frontOrder}`,
        `rear=${certificate?.rearOrder}`,
        `cooperator=${certificate?.cooperation?.rearOrder ?? null}`,
        `target=${certificate?.targetPassTime}`,
        `time=${snapshot.time}`,
        `dt=${deltaTime}`,
        `envelope=[${plan.envelope?.min},${plan.envelope?.max}]`,
        `roles=[${roles.join(',')}]`,
        `reason=${reason}`,
      ].join(' '),
    );
  }

  /** 全ての証明済みランプ予約と protected role の運動を同一 snapshot から確定する。 */
  evaluateTick(snapshot: WorldSnapshot, deltaTime: number): MergeTransaction {
    const directives: MergeDirective[] = [];
    for (const vehicle of this.vehicles) {
      if (vehicle.waiting || vehicle.lane !== 3 || !vehicle.mergePlan.certificate) continue;
      const directive = vehicle.projectReservation(snapshot, vehicle.mergePlan, deltaTime);
      if (!directive)
        throw this.corridorError(vehicle.mergePlan, snapshot, deltaTime, '予約投影不能');
      directives.push(directive);
    }
    try {
      return planMergeTransaction(snapshot, directives, deltaTime);
    } catch (error) {
      if (error instanceof MergeTransactionPlanningError)
        throw this.corridorError(error.plan, snapshot, deltaTime, error.reason);
      throw error;
    }
  }

  private assertTransactionSafety(
    snapshot: WorldSnapshot,
    transaction: MergeTransaction,
    deltaTime: number,
  ): void {
    const snapshots = new Map(snapshot.vehicles.map((vehicle) => [vehicle.order, vehicle]));
    const motions = new Map(transaction.motions.map((motion) => [motion.vehicleOrder, motion]));
    const projectedZ = (order: number): number | null => motions.get(order)?.nextZ ?? null;
    for (const directive of transaction.directives) {
      const certificate = directive.plan.certificate;
      if (!certificate)
        throw this.corridorError(directive.plan, snapshot, deltaTime, '適用前証明書なし');
      const ramp = snapshots.get(certificate.rampOrder);
      const rampMotion = motions.get(certificate.rampOrder);
      if (!ramp || !rampMotion)
        throw this.corridorError(directive.plan, snapshot, deltaTime, 'ランプ運動なし');
      const changing = rampMotion.laneChangeProgress !== null;
      const nextProgress = rampMotion.laneChangeProgress ?? ramp.laneChange.progress;
      const nextRampZ = rampMotion.nextZ;
      const nextRampX = rampMotion.nextX;
      if (
        nextProgress < 1 &&
        (toFacilityLocalZ(nextRampZ) <= CONST.GORE_Z_START ||
          rampBodyIntersectsGore(
            sectionTrackX(ramp.section, nextRampX),
            nextRampZ,
            ramp.width,
            ramp.length,
          ))
      )
        throw this.corridorError(directive.plan, snapshot, deltaTime, '次位置が導流帯へ侵入');
      if (!changing) continue;
      for (const [role, order] of [
        ['front', certificate.frontOrder],
        ['rear', certificate.rearOrder],
      ] as const) {
        if (order === null) continue;
        const roleSnapshot = snapshots.get(order);
        const nextRoleZ = projectedZ(order);
        if (!roleSnapshot || nextRoleZ === null)
          throw this.corridorError(directive.plan, snapshot, deltaTime, `${role}運動なし`);
        const centerDistance =
          role === 'front'
            ? (((nextRampZ - nextRoleZ) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH
            : (((nextRoleZ - nextRampZ) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
        const bodyGap = centerDistance - (ramp.length + roleSnapshot.length) / 2;
        const lateralGap =
          Math.abs(nextRampX - roleSnapshot.x) - (ramp.width + roleSnapshot.width) / 2;
        if (bodyGap < 0 && lateralGap < 0)
          throw this.corridorError(
            directive.plan,
            snapshot,
            deltaTime,
            `${role}車体間隔=${bodyGap},rampZ=${nextRampZ},roleZ=${nextRoleZ},` +
              `rampSpeed=${rampMotion.nextSpeed},roleSpeed=${motions.get(order)?.nextSpeed},` +
              `横間隔=${lateralGap},progress=${nextProgress}`,
          );
      }
      for (const edge of certificate.closure.edges) {
        const follower = snapshots.get(edge.followerOrder);
        const ahead = snapshots.get(edge.aheadOrder);
        const followerMotion = motions.get(edge.followerOrder);
        const aheadMotion = motions.get(edge.aheadOrder);
        if (!follower || !ahead || !followerMotion || !aheadMotion)
          throw this.corridorError(
            directive.plan,
            snapshot,
            deltaTime,
            `closure運動なし:${edge.followerOrder}->${edge.aheadOrder}`,
          );
        const centerDistance =
          (((followerMotion.nextZ - aheadMotion.nextZ) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
        const bodyGap = centerDistance - (follower.length + ahead.length) / 2;
        if (bodyGap + 1e-9 < CONST.MERGE_BODY_CLEARANCE)
          throw this.corridorError(
            directive.plan,
            snapshot,
            deltaTime,
            `closure車体間隔=${bodyGap}:${edge.followerOrder}->${edge.aheadOrder}`,
          );
      }
    }
  }

  private applyMergeTransaction(
    transaction: MergeTransaction,
  ): ReadonlyMap<number, ReservedMotion> {
    const motionByOrder = new Map(
      transaction.motions.map((motion) => [motion.vehicleOrder, motion]),
    );
    for (const vehicle of this.vehicles) {
      vehicle.reservedMotion = null;
      vehicle.mergeDirective = null;
    }
    for (const directive of transaction.directives) {
      const certificate = directive.plan.certificate;
      const ramp = certificate
        ? this.vehicles.find((vehicle) => vehicle.spawnOrder === certificate.rampOrder)
        : null;
      if (!ramp) continue;
      ramp.mergeDirective = directive;
      ramp.mergePlan = directive.plan;
      if (directive.cooperation) {
        const rear = this.vehicles.find(
          (candidate) => candidate.spawnOrder === directive.cooperation!.vehicleOrder,
        );
        if (rear) {
          rear.mergeCooperationTarget = directive.plan.targetPassTime;
          rear.mergeCooperationDecel = directive.cooperation.decel;
        }
      }
      if (directive.startLaneChange) {
        ramp.startReservedMergeLaneChange();
        this.syncLaneMembership(ramp);
      }
    }
    return motionByOrder;
  }

  // 入口待ちの車を、受け入れ可能になり次第(各側1台/ステップ)流入させる。
  // ランプ待ちはランプへ、本線待ちは空いている本線レーンへ入る。
  // 本線は控えめな安全速度、ランプはcertificateを証明したsnapshot速度で発進する。
  admitWaiting(snapshot: WorldSnapshot = this.captureSnapshot(), deltaTime = 1 / 20): void {
    const rampHeads: Vehicle[] = [];
    const mainlineHeads: Vehicle[] = [];
    for (const section of ['L', 'R'] as const) {
      const waiting = this.vehicles
        .filter((candidate) => candidate.waiting && candidate.section === section)
        .sort((left, right) => left.spawnOrder - right.spawnOrder);
      const rampHeadsByFacility = FACILITIES.map((facility) =>
        waiting.find(
          (vehicle) => vehicle.lane === 3 && facilityIndexForZ(vehicle.z) === facility.index,
        ),
      );
      const mainlineHead = waiting.find((vehicle) => vehicle.lane !== 3);
      for (const rampHead of rampHeadsByFacility) if (rampHead) rampHeads.push(rampHead);
      if (mainlineHead) mainlineHeads.push(mainlineHead);
    }
    for (const vehicle of mainlineHeads) {
      const section = vehicle.section;
      const lanes = [vehicle.lane, 0, 1, 2].filter(
        (lane, index, all) => all.indexOf(lane) === index,
      );
      const lane = this.admissibleLane(section, lanes, vehicle.z);
      if (lane == null) continue;
      vehicle.waiting = false;
      vehicle.lane = lane;
      vehicle.x = CONST.LANE_X[section][lane];
      vehicle.speed = this.safeSpawnSpeed(
        section,
        lane,
        vehicle.z,
        vehicle.length,
        Math.min(vehicle.desiredSpeed * 0.6, 14),
        vehicle,
      );
    }
    this.admitRampWaiting(snapshot, rampHeads, deltaTime);
  }

  // 出口まで走り切った車を流出させる(rulesモードのみ。absorbは周回で退出しない)
  collectExited(): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const vehicle = this.vehicles[i];
      if (vehicle.exited) {
        this.stats.outflow[vehicle.section]++;
        this.vehicles.splice(i, 1);
      }
    }
  }

  populateInitial(): void {
    // 基準台数ぶんを最初から本線に配置する(ウォームスタート)。
    // 以降の台数は「同じペースの流入」と「各道路の交通状況に応じた流出」の
    // つり合いで決まり、混んでいる側は捌けずに自然に台数が増えていく
    const pairs = this.targetCountPerSection();
    for (let i = 0; i < pairs; i++) {
      for (let tries = 0; tries < 50; tries++) {
        const typeName = this.pickType();
        const spec = TYPES[typeName];
        let speed = spec.minSpeed + this.rng() * (spec.maxSpeed - spec.minSpeed);
        if ((typeName === 'Sedan' || typeName === 'SportsCar') && this.rng() < 0.05) {
          speed = Math.max(speed, 32 + this.rng() * 4); // 飛ばし屋
        }
        const z = -CONST.ROAD_HALF + 25 + this.rng() * (CONST.ROAD_HALF * 2 - 40);
        const laneL =
          this.mode === 'absorb'
            ? (this.laneRoundRobin = (this.laneRoundRobin + 1) % 3)
            : Math.floor(this.rng() * 3);
        const laneR = this.mode === 'absorb' ? laneL : Math.floor(this.rng() * 3);
        if (this.isSpawnClear('L', laneL, z, null) && this.isSpawnClear('R', laneR, z, null)) {
          this.vehicles.push(this.createVehicle('L', laneL, z, typeName, speed));
          this.vehicles.push(this.createVehicle('R', laneR, z, typeName, speed));
          break;
        }
      }
    }
  }

  reset(): void {
    this.vehicles.length = 0;
    this.nextVehicleOrder = 0;
    this.nextMergePlanId = 0;
    this.spawnAccumulator = 0;
    this.time = 0;
    this.sectionVehicles = { L: [], R: [] };
    this.laneVehicles = { L: [[], [], [], []], R: [[], [], [], []] };
    this.laneVehicleOrder.clear();
    this.laneMemberships.clear();
    this.stats = {
      changes: { L: 0, R: 0 },
      yields: { L: 0, R: 0 },
      cancels: { L: 0, R: 0 },
      inflow: { L: 0, R: 0 },
      outflow: { L: 0, R: 0 },
    };
    this.lastMergeSource = { L: null, R: null };
    this.lastMergeSourceByFacility = {
      L: FACILITIES.map(() => null),
      R: FACILITIES.map(() => null),
    };
    this.smoothTime = { L: 0, R: 0, draw: 0 }; // 累積の比較もやり直す
    this.absorberRoundRobin = null;
    this.laneRoundRobin = 0;
    this.perturbTimer = null;
    this.populateInitial();
    this.rebuildSectionIndex();
  }

  /**
   * 区間ごとの走行中車両リストを作り直す。step 冒頭に一度だけ呼ぶ。
   *
   * z 昇順に並べるが、この並び順は「step 冒頭の縦列を見たい」用途
   * (貫通チェックなど) のためのものである。update ループの途中では各車が
   * 移動して順序が崩れるため、前後車の探索がこの並び順に依存してはならない
   * (Issue #52)。探索は Vehicle#findNeighbor がリング上の距離で行う。
   */
  rebuildSectionIndex(): void {
    const vehiclesL: Vehicle[] = [],
      vehiclesR: Vehicle[] = [];
    for (const vehicle of this.vehicles)
      if (!vehicle.waiting) (vehicle.section === 'L' ? vehiclesL : vehiclesR).push(vehicle);
    vehiclesL.sort((a, b) => a.z - b.z);
    vehiclesR.sort((a, b) => a.z - b.z);
    this.sectionVehicles.L = vehiclesL;
    this.sectionVehicles.R = vehiclesR;
    this.rebuildLaneIndex();
  }

  /** 現在の車線占有状態から車線別索引を作り直す。 */
  private rebuildLaneIndex(): void {
    this.laneVehicleOrder.clear();
    this.laneMemberships.clear();
    this.laneVehicles = { L: [[], [], [], []], R: [[], [], [], []] };
    for (const section of ['L', 'R'] as const) {
      const sectionVehicles = this.sectionVehicles[section];
      sectionVehicles.forEach((vehicle, index) => this.laneVehicleOrder.set(vehicle, index));
      for (const vehicle of sectionVehicles) {
        const lanes: number[] = [];
        for (let lane = 0; lane < 4; lane++) {
          if (!vehicle.occupies(lane)) continue;
          this.laneVehicles[section][lane].push(vehicle);
          lanes.push(lane);
        }
        this.laneMemberships.set(vehicle, lanes);
      }
      for (const laneVehicles of this.laneVehicles[section])
        laneVehicles.sort((left, right) => this.compareLaneVehicles(left, right));
    }
  }

  /** 周回上で同値なzを同じ索引位置へ写す。 */
  private laneIndexZ(z: number): number {
    const roadStart = -CONST.ROAD_HALF - 8;
    return (((z - roadStart) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
  }

  private compareLaneVehicles(left: Vehicle, right: Vehicle): number {
    return (
      this.laneIndexZ(left.z) - this.laneIndexZ(right.z) ||
      this.laneVehicleOrder.get(left)! - this.laneVehicleOrder.get(right)!
    );
  }

  /** 逐次更新された1台だけを車線別索引へ挿入し直す。 */
  reindexVehicle(vehicle: Vehicle): void {
    const order = this.laneVehicleOrder.get(vehicle);
    if (order === undefined) return;
    for (const lane of this.laneMemberships.get(vehicle) ?? []) {
      const vehicles = this.laneVehicles[vehicle.section][lane];
      const index = vehicles.indexOf(vehicle);
      if (index >= 0) vehicles.splice(index, 1);
    }
    const lanes: number[] = [];
    for (let lane = 0; lane < 4; lane++) {
      if (!vehicle.occupies(lane)) continue;
      const vehicles = this.laneVehicles[vehicle.section][lane];
      let low = 0,
        high = vehicles.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.compareLaneVehicles(vehicles[middle], vehicle) <= 0) low = middle + 1;
        else high = middle;
      }
      vehicles.splice(low, 0, vehicle);
      lanes.push(lane);
    }
    this.laneMemberships.set(vehicle, lanes);
  }

  /** zを変えずに変化した車線占有だけを索引へ同期する。 */
  private syncLaneMembership(vehicle: Vehicle): void {
    if (!this.laneVehicleOrder.has(vehicle)) return;
    const lanes: number[] = [];
    for (let lane = 0; lane < 4; lane++) if (vehicle.occupies(lane)) lanes.push(lane);
    const indexed = this.laneMemberships.get(vehicle) ?? [];
    if (lanes.length !== indexed.length || lanes.some((lane, index) => lane !== indexed[index]))
      this.reindexVehicle(vehicle);
  }

  /** zソート済み車線索引から周回上の最近接車を二分探索する。 */
  findLaneNeighbor(vehicle: Vehicle, lane: number, ahead: boolean): NeighborInfo | null {
    const vehicles = this.laneVehicles[vehicle.section][lane];
    if (vehicles.length === 0 || (vehicles.length === 1 && vehicles[0] === vehicle)) return null;
    const key = this.laneIndexZ(vehicle.z);
    let low = 0,
      high = vehicles.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const middleKey = this.laneIndexZ(vehicles[middle].z);
      if (middleKey < key || (!ahead && middleKey === key)) low = middle + 1;
      else high = middle;
    }
    let index = ahead ? low - 1 : low;
    if (index < 0) index = vehicles.length - 1;
    if (index >= vehicles.length) index = 0;
    const candidateKey = this.laneIndexZ(vehicles[index].z);
    let first = index;
    while (first > 0 && this.laneIndexZ(vehicles[first - 1].z) === candidateKey) first--;
    let best: Vehicle | null = null;
    for (
      let cursor = first;
      cursor < vehicles.length && this.laneIndexZ(vehicles[cursor].z) === candidateKey;
      cursor++
    ) {
      const candidate = vehicles[cursor];
      if (
        candidate !== vehicle &&
        (best === null || this.laneVehicleOrder.get(candidate)! < this.laneVehicleOrder.get(best)!)
      )
        best = candidate;
    }
    if (best === null) return null;
    const raw = ahead ? vehicle.z - best.z : best.z - vehicle.z;
    const distance = ((raw % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH || WRAP_LENGTH;
    return { vehicle: best, gap: distance - (vehicle.length + best.length) / 2 };
  }

  recordMergePasses(): void {
    for (const vehicle of this.vehicles) {
      if (vehicle.waiting) continue;
      const crossedMergePoint =
        toFacilityLocalZ(vehicle.previousZ) >= CONST.MERGE_POINT_Z &&
        toFacilityLocalZ(vehicle.z) < CONST.MERGE_POINT_Z;
      if (vehicle.rampMergePassPending) {
        this.lastMergeSource[vehicle.section] = 'ramp';
        this.lastMergeSourceByFacility[vehicle.section][facilityIndexForZ(vehicle.z)] = 'ramp';
        vehicle.rampMergePassPending = false;
        if (crossedMergePoint) vehicle.mergedFromRamp = false;
        continue;
      }
      if (!crossedMergePoint || vehicle.lane !== 2) continue;
      if (vehicle.mergedFromRamp) {
        vehicle.mergedFromRamp = false;
      } else {
        this.lastMergeSource[vehicle.section] = 'main';
        this.lastMergeSourceByFacility[vehicle.section][facilityIndexForZ(vehicle.z)] = 'main';
      }
    }
  }

  rampLeaders(section: Section): Vehicle[] {
    const rampVehicles = this.sectionVehicles[section].filter(
      (vehicle) =>
        vehicle.lane === 3 ||
        (vehicle.laneChange.from === 3 && vehicle.laneChange.state !== 'none'),
    );
    return FACILITIES.map(
      (facility) =>
        rampVehicles
          .filter((vehicle) => facilityIndexForZ(vehicle.z) === facility.index)
          .sort(
            (a, b) => toFacilityLocalZ(a.z) - toFacilityLocalZ(b.z) || a.spawnOrder - b.spawnOrder,
          )[0] ?? null,
    ).filter((vehicle): vehicle is Vehicle => vehicle !== null);
  }

  /** 単一施設時代の呼び出し互換。進行上もっとも先頭のランプ車を返す。 */
  rampLeader(section: Section): Vehicle | null {
    return (
      this.rampLeaders(section).sort(
        (a, b) => toFacilityLocalZ(a.z) - toFacilityLocalZ(b.z) || a.spawnOrder - b.spawnOrder,
      )[0] ?? null
    );
  }

  applyMergeEvaluations(evaluations: { leader: Vehicle; plan: MergePlan }[]): void {
    const reservedRears = new Set<Vehicle>();
    const sorted = [...evaluations].sort(
      (a, b) =>
        a.plan.targetPassTime - b.plan.targetPassTime ||
        Math.abs(toFacilityLocalZ(a.leader.z) - CONST.MERGE_POINT_Z) -
          Math.abs(toFacilityLocalZ(b.leader.z) - CONST.MERGE_POINT_Z) ||
        a.leader.spawnOrder - b.leader.spawnOrder,
    );
    for (const evaluation of sorted) {
      const rear = evaluation.plan.rear;
      if (rear && reservedRears.has(rear)) {
        evaluation.leader.applyMergePlan({
          ...evaluation.leader.mergePlan,
          state: 'seeking',
          front: null,
          rear: null,
          targetPassTime: 0,
          nextSource: null,
        });
        this.syncLaneMembership(evaluation.leader);
        continue;
      }
      if (rear) reservedRears.add(rear);
      evaluation.leader.applyMergePlan(evaluation.plan);
      this.syncLaneMembership(evaluation.leader);
      if (rear) this.syncLaneMembership(rear);
    }
  }

  prepareMergeCoordination(
    deltaTime: number,
    protectedOrders: ReadonlySet<number> = new Set(),
  ): void {
    const leaders = (['L', 'R'] as const).flatMap((section) => this.rampLeaders(section));
    const leaderSet = new Set(leaders);
    for (const vehicle of this.vehicles) {
      if (
        vehicle.waiting ||
        vehicle.mergePlan.state === 'completed' ||
        protectedOrders.has(vehicle.spawnOrder)
      )
        continue;
      if (!leaderSet.has(vehicle)) vehicle.mergePlan.state = 'queued';
    }
    const evaluations = leaders
      .filter(
        (leader) => leader.mergePlan.state !== 'committed' && leader.mergePlan.certificate === null,
      )
      .map((leader) => ({
        leader,
        plan: leader.evaluateMergePlan(
          deltaTime,
          this.lastMergeSourceByFacility[leader.section][facilityIndexForZ(leader.z)] ??
            this.lastMergeSource[leader.section],
        ),
      }));
    this.applyMergeEvaluations(evaluations);
    const activeRears = new Set(
      leaders
        .filter(
          (leader) =>
            leader.mergePlan.state === 'coordinating' || leader.mergePlan.state === 'committed',
        )
        .map((leader) => leader.mergePlan.rear)
        .filter((rear): rear is Vehicle => rear !== null),
    );
    for (const leader of leaders) {
      const rearOrder = leader?.mergePlan.certificate?.cooperation?.rearOrder;
      if (rearOrder === undefined) continue;
      const rear = this.vehicles.find((vehicle) => vehicle.spawnOrder === rearOrder);
      if (rear) activeRears.add(rear);
    }
    for (const vehicle of this.vehicles) {
      if (activeRears.has(vehicle) || protectedOrders.has(vehicle.spawnOrder)) continue;
      vehicle.mergeCooperationTarget = null;
      vehicle.mergeCooperationDecel = 0;
    }
  }

  step(deltaTime: number): void {
    this.assertGoreInvariant('start');
    this.spawnAccumulator += deltaTime * 1000;
    // rulesモードの流入間隔は、終端で流出する分(EXIT_RATIO)とつり合う需要に換算する。
    // 「間隔が短い = 交通需要が多い」の意味は従来通り(密度は間隔に反比例)
    const pace =
      this.mode === 'absorb' ? this.spawnInterval : this.spawnInterval * CONST.INFLOW_PACE;
    if (this.spawnAccumulator >= pace) {
      if (this.spawnPair()) this.spawnAccumulator = 0;
      else this.spawnAccumulator = Math.max(0, pace - 200); // 塞がっていれば少し待つ
    }
    // absorbモード: 渋滞のきっかけ(よそ見ブレーキ)を左右のミラーペアに同時注入。
    // 同じきっかけが、通常側では波に育ち、吸収側では吸収されて消えるのを比較する
    if (this.mode === 'absorb') {
      if (this.perturbTimer == null) this.perturbTimer = 15;
      this.perturbTimer -= deltaTime;
      if (this.perturbTimer <= 0) {
        this.perturbTimer = CONST.PERTURB_INTERVAL;
        const pairs: [Vehicle, Vehicle][] = [];
        for (let i = 0; i + 1 < this.vehicles.length; i += 2) {
          const vehicleA = this.vehicles[i],
            vehicleB = this.vehicles[i + 1];
          if (
            vehicleA.section === 'L' &&
            vehicleB.section === 'R' &&
            !vehicleA.waiting &&
            !vehicleB.waiting
          )
            pairs.push([vehicleA, vehicleB]);
        }
        if (pairs.length) {
          const [vehicleA, vehicleB] = pairs[Math.floor(this.rng() * pairs.length)];
          vehicleA.perturbTimer = CONST.PERTURB_DURATION;
          vehicleB.perturbTimer = CONST.PERTURB_DURATION;
        }
      }
    }
    this.rebuildSectionIndex();
    const snapshot = this.captureSnapshot();
    const transaction = this.evaluateTick(snapshot, deltaTime);
    this.assertTransactionSafety(snapshot, transaction, deltaTime);
    const motionByOrder = this.applyMergeTransaction(transaction);
    const protectedOrders = new Set(motionByOrder.keys());
    this.prepareMergeCoordination(deltaTime, protectedOrders);
    for (const vehicle of this.vehicles) {
      if (vehicle.waiting) continue;
      const motion = motionByOrder.get(vehicle.spawnOrder);
      if (motion) vehicle.applyReservedMotion(motion, deltaTime);
      else vehicle.update(deltaTime);
      this.syncLaneMembership(vehicle);
    }
    // 合流評価と速度更新は移動前の位置と同じ時刻スナップショットで行い、
    // 全車両を次フレームの位置へ進めた後にシミュレーション時刻を更新する
    this.time += deltaTime;
    this.assertGoreInvariant('end');
    this.recordMergePasses();
    // rulesモード: 出口まで走り切った車は流出する(捌けた分だけ出る)
    if (this.mode !== 'absorb') this.collectExited();
    // 待機車の有効化は移動後 snapshot から証明し、この tick の運動へ混ぜない。
    if (this.mode !== 'absorb') this.admitWaiting(this.captureSnapshot(), deltaTime);
    for (const vehicle of this.vehicles) {
      vehicle.reservedMotion = null;
      vehicle.mergeDirective = null;
    }
    this.accumulateSmoothTime(deltaTime);
  }

  // 今この瞬間どちらがスムーズか。差が僅かなら引き分け(null)。
  // 判定材料は HUD と同じ渋滞スコア(computeSection)。速度と密度(滞留)を
  // 併せ持つ既存の総合指標なので、平均速度だけ・台数だけを見るより
  // 「空いている側」の実感に近い。スコアは小さいほどスムーズ
  smootherSection(): Section | null {
    const left = this.computeSection('L'),
      right = this.computeSection('R');
    // 走り出し直後や片側が空の間はスコアが暴れるので判定を保留する
    if (left.count <= CONST.SMOOTH_MIN_COUNT || right.count <= CONST.SMOOTH_MIN_COUNT) return null;
    const diff = left.score - right.score;
    if (Math.abs(diff) <= CONST.SMOOTH_SCORE_DEADZONE) return null; // デッドゾーン
    return diff < 0 ? 'L' : 'R';
  }

  // 1ステップぶんの時間を、その時スムーズだった側へ積む(Issue #26)。
  // 累積差を見れば、ランダム性で一時的に逆転していても
  // 「どちらが混みやすい道路なのか」が時間の重みで判断できる
  accumulateSmoothTime(deltaTime: number): void {
    const smoother = this.smootherSection();
    if (smoother) this.smoothTime[smoother] += deltaTime;
    else this.smoothTime.draw += deltaTime;
  }

  // 渋滞スコア: 平均速度(重み75%) + 密度(重み25%) → 0～100
  // 台数 count は入口待ちも含む。流入ペースが同じでも、混んでいる側は捌けずに
  // 台数が増える(滞留する)ため、密度項がその滞留をスコアに反映する
  computeSection(section: Section): SectionStats {
    let count = 0,
      speedSum = 0;
    for (const vehicle of this.vehicles) {
      if (vehicle.section !== section) continue;
      count++;
      // 待機車 = 入口まで伸びた渋滞最後尾の見えない延長。速度0として計上しないと
      // 「渋滞がひどい区間ほど待機に逃げてスコアが良くなる」という嘘になる
      speedSum += vehicle.waiting ? 0 : vehicle.speed;
    }
    if (count === 0) return { count: 0, averageSpeed: 0, score: 0 };
    const averageSpeed = speedSum / count;
    const speedFactor = clamp(1 - averageSpeed / CONST.REF_SPEED, 0, 1);
    const densityFactor = clamp(count / CONST.MAX_PER_SECTION, 0, 1);
    return {
      count,
      averageSpeed,
      score:
        (CONST.SCORE_WEIGHT_SPEED * speedFactor + CONST.SCORE_WEIGHT_DENSITY * densityFactor) * 100,
    };
  }
}

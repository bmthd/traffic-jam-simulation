/* ============================================================
   シミュレーションコア: 車両（ドライバーモデル）
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import { CONST, TYPES } from './constants';
import type { Section, VehicleTypeName, VehicleTypeSpec } from './constants';
import type { LaneChangeController } from './lane-change-controller';
import type { LongitudinalController } from './longitudinal-controller';
import type { MergeCoordinator } from './merge-coordinator';
import { clamp, lerp, smooth, WRAP_LENGTH } from './utils';
import type { World } from './world';

export type LaneChangeState = 'none' | 'changing' | 'cancel';
export interface LaneChange {
  state: LaneChangeState;
  from: number;
  to: number;
  progress: number;
  holdTime: number;
  checkTimer: number;
}

/** tick 開始時点の車両状態。合流入場の判定中は変更しない。 */
export interface VehicleSnapshot {
  readonly order: number;
  readonly section: Section;
  readonly lane: number;
  readonly z: number;
  readonly x: number;
  readonly speed: number;
  readonly desiredSpeed: number;
  readonly maxAcceleration: number;
  readonly length: number;
  readonly width: number;
  readonly waiting: boolean;
  readonly laneChange: Readonly<LaneChange>;
}

/** 合流入場を評価するための読み取り専用 world 状態。 */
export interface WorldSnapshot {
  readonly time: number;
  readonly vehicles: readonly VehicleSnapshot[];
  readonly byOrder: ReadonlyMap<number, VehicleSnapshot>;
  readonly lane2BySection: Readonly<Record<Section, readonly VehicleSnapshot[]>>;
}

export interface MergeDependencyEdge {
  readonly followerOrder: number;
  readonly aheadOrder: number;
}

export interface MergeDependencyClosure {
  /** ramp は含めず、本線 member だけを spawnOrder 昇順で保持する。 */
  readonly orders: readonly number[];
  /** follower -> ahead。cycle のない DAG だけを証明書へ入れる。 */
  readonly edges: readonly MergeDependencyEdge[];
}

export type MergeClosureRejectReason =
  | 'missing-root'
  | 'lane-change-in-progress'
  | 'stationary-member'
  | 'cycle'
  | 'limit';

export type MergeClosureResult =
  | Readonly<{ ok: true; closure: MergeDependencyClosure }>
  | Readonly<{ ok: false; reason: MergeClosureRejectReason; order: number | null }>;

/** 証明された回廊で許容される速度域。 */
export interface SpeedEnvelope {
  readonly min: number;
  readonly max: number;
}

/** lane 3 を有効化する前に確定する、合流回廊の証明。 */
export interface MergeCertificate {
  readonly rampOrder: number;
  readonly frontOrder: number | null;
  readonly rearOrder: number | null;
  readonly targetPassTime: number;
  readonly completionZ: number;
  readonly envelope: SpeedEnvelope;
  readonly cooperation: Readonly<{ rearOrder: number; decel: number }> | null;
  readonly closure: MergeDependencyClosure;
}

/** snapshot から評価した待機ランプ車の入場候補。 */
export interface MergeCandidate {
  readonly certificate: MergeCertificate;
  readonly queueOrder: number;
  readonly reservationTime: number;
}

/** snapshot で確定してから運動へ渡す、合流予約の指示。 */
export interface MergeDirective {
  readonly plan: MergePlan;
  readonly envelope: SpeedEnvelope;
  readonly startLaneChange: boolean;
  readonly cooperation: Readonly<{ vehicleOrder: number; decel: number }> | null;
}

/** 予約 transaction が role 車両へ一括適用する次フレームの運動。 */
export interface ReservedMotion {
  readonly vehicleOrder: number;
  readonly nextSpeed: number;
  readonly nextZ: number;
  readonly nextX: number;
  readonly laneChangeProgress: number | null;
}

export interface MergeTransaction {
  readonly directives: readonly MergeDirective[];
  readonly motions: readonly ReservedMotion[];
}
/** 前方/後方車の探索結果 */
export interface NeighborInfo {
  vehicle: Vehicle;
  gap: number;
}

export type MergeState = 'queued' | 'seeking' | 'coordinating' | 'committed' | 'completed';
export type MergeSource = 'main' | 'ramp';
export interface MergePlan {
  state: MergeState;
  front: Vehicle | null;
  rear: Vehicle | null;
  congestion: number;
  targetPassTime: number;
  nextSource: MergeSource | null;
  cooperationDecel?: number;
  /** 入口待ちから有効化した時点の不変な証明書。 */
  certificate?: MergeCertificate | null;
  id?: number;
  completionZ?: number;
  envelope?: SpeedEnvelope;
}

export interface ProjectedMergeSlot {
  front: Vehicle | null;
  rear: Vehicle | null;
  frontGap: number;
  rearGap: number;
  rearClosingTtc: number;
  rampEta: number;
}

/**
 * 車両が判断を委譲するコントローラ群の初期化関数 (Issue #120)。
 * 実体は初期化用モジュール (factory.ts) が供給するため、
 * ここからコントローラ実装への値 import は持たない (import cycle 防止)。
 */
export interface VehicleDeps {
  readonly createLaneChangeController: (vehicle: Vehicle) => LaneChangeController;
  readonly createLongitudinalController: (vehicle: Vehicle) => LongitudinalController;
  readonly createMergeCoordinator: (vehicle: Vehicle) => MergeCoordinator;
}

/** 車両の生成関数。World は実体を直接 new せずこれを介して車両を作る。 */
export type VehicleFactory = (
  world: World,
  section: Section,
  lane: number,
  z: number,
  typeName: VehicleTypeName,
  desiredSpeed: number,
  deps?: VehicleDeps,
) => Vehicle;

export class Vehicle {
  world: World;
  /** 判断の委譲先。生成時に注入され、以降は差し替えない (Issue #120) */
  readonly laneChangeController: LaneChangeController;
  readonly longitudinalController: LongitudinalController;
  readonly mergeCoordinator: MergeCoordinator;
  spawnOrder: number;
  section: Section;
  lane: number;
  z: number;
  previousZ: number;
  mergedFromRamp = false;
  rampMergePassPending = false;
  typeName: VehicleTypeName;
  type: VehicleTypeSpec;
  length: number;
  width: number;
  initialDesiredSpeed: number;
  desiredSpeed: number;
  speed: number;
  targetSpeed: number;
  x: number;
  laneChange: LaneChange;
  mergePlan: MergePlan;
  laneChangeCooldown: number;
  laneChangeBlockedLane: number | null;
  returnTimer: number;
  keepLeftTimer: number;
  noOvertakeTimer: number;
  yieldSlowTimer: number;
  braking: boolean;
  emergency: boolean;
  waiting: boolean;
  exited: boolean;
  waitTimer: number;
  perturbTimer: number;
  color: number;
  isTaxi: boolean;
  absorber: boolean;
  yields: boolean;
  keepLeft: boolean;
  camper: boolean;
  returnTime: number;
  perceivedSpeed: number;
  perceptionTimer: number;
  accelDelayTimer: number;
  anticipatedSpeed: number;
  reactionTime: number;
  followGain: number;
  accelLagDuration: number;
  headwayFactor: number;
  brakeChainFactor: number;
  frustration: number;
  noise: number;
  hazard: boolean;
  hazardTimer: number;
  lampDeceleration: number;
  brakeLampHold: number;
  brakeChainSignal: boolean;
  laneChangeAversion: number;
  slowAheadTimer: number;
  noiseAmplitude: number;
  keepRightTimer = 0; // マイペース派が追い越し車線へ戻るまでの計時
  returnBoostTimer = 0; // 加速復帰(塞がれた復帰先の並走車を抜くための一時加速)の残り時間
  returnBoostCooldown = 0; // 加速復帰を諦めた後の再挑戦クールダウン
  mergeCooperationTarget: number | null = null;
  mergeCooperationDecel = 0;
  mergeDirective: MergeDirective | null = null;
  reservedMotion: ReservedMotion | null = null;

  constructor(
    world: World,
    section: Section,
    lane: number,
    z: number,
    typeName: VehicleTypeName,
    desiredSpeed: number,
    deps: VehicleDeps = world.deps.vehicleDeps,
  ) {
    this.world = world;
    this.spawnOrder = world.nextVehicleOrder++;
    this.section = section; // 'L' = 義務あり / 'R' = 義務なし
    this.lane = lane; // 0 = 追い越し車線(進行方向の右端)
    this.z = z;
    this.previousZ = z;
    this.typeName = typeName;
    this.type = TYPES[typeName];
    this.length = this.type.length;
    this.width = this.type.width;
    this.initialDesiredSpeed = desiredSpeed;
    this.desiredSpeed = desiredSpeed;
    const random = world.rng;
    this.speed = desiredSpeed * (0.85 + random() * 0.15);
    this.targetSpeed = desiredSpeed;
    this.x = CONST.LANE_X[section][lane];
    this.laneChange = {
      state: 'none',
      from: lane,
      to: lane,
      progress: 0,
      holdTime: 0,
      checkTimer: 0,
    };
    this.mergePlan = {
      state: lane === 3 ? 'queued' : 'completed',
      front: null,
      rear: null,
      congestion: 0,
      targetPassTime: 0,
      nextSource: null,
      certificate: null,
    };
    this.laneChangeCooldown = 0;
    this.laneChangeBlockedLane = null;
    this.returnTimer = 0;
    this.keepLeftTimer = 0;
    this.noOvertakeTimer = 0; // 譲った直後の「我慢」時間(頻繁な変更による乱流防止)
    this.yieldSlowTimer = 0; // 譲り先が塞がっている時に少し減速して後ろに入るための時間
    this.braking = false;
    this.emergency = false;
    this.waiting = false; // 入口(ランプ)が塞がっている間の流入待ち
    this.exited = false; // 出口まで走り切って流出した(Worldが回収する)
    this.waitTimer = 0;
    this.perturbTimer = 0; // よそ見ブレーキの残り時間(absorbモードでWorldが設定)
    this.color = this.type.colors[Math.floor(random() * this.type.colors.length)];
    this.isTaxi = typeName === 'Sedan' && random() < 0.08;
    if (this.isTaxi) this.color = 0xf5f0dc;

    // ===== 区間ごとのドライバー気質（モードごとの比較対象の核心） =====
    this.absorber = false;
    if (world.mode === 'absorb') {
      // 渋滞吸収運転モード: 車線変更ルールは両区間とも同一(法令通り)。
      // 違いは「吸収側(L)の一部ドライバーが車間を広く取り波を吸収する」ことだけ。
      this.yields = true;
      this.keepLeft = true;
      this.camper = false;
      this.returnTime = CONST.OVERTAKE_LANE_RETURN_TIME;
      // 吸収運転車は各車線に均等に混ぜる(おおよそ ABSORBER_RATIO の割合で等間隔)
      if (section === 'L') {
        world.absorberRoundRobin = world.absorberRoundRobin || [0, 0, 0];
        const period = Math.max(1, Math.round(1 / CONST.ABSORBER_RATIO));
        this.absorber = world.absorberRoundRobin[lane]++ % period === 1 % period;
      }
      // 円周実験と同じく希望速度はほぼ均一にする。車線変更がない世界では
      // 1台の極端に遅い車が車線全体を支配してしまい、波の比較ができなくなる
      this.desiredSpeed = 23.5 + random() * 3.0;
    } else if (section === 'L') {
      // 義務あり: 譲る・キープレフト・追い越し後はすぐ戻る
      this.yields = true;
      this.keepLeft = true;
      this.camper = false;
      this.returnTime = CONST.OVERTAKE_LANE_RETURN_TIME;
    } else {
      // 義務なし: ルール上の義務はないが、現実には自発的に譲る人も一定割合いる。
      // 「義務」はこの割合を全員に引き上げるもの — ここがルール比較の核心
      this.yields = random() < CONST.VOLUNTARY_YIELD_RATIO;
      this.keepLeft = this.yields && random() < 0.5; // 自発的に譲る人の半数はキープレフトも実践
      this.camper = !this.yields && random() < CONST.CAMPER_RATIO;
      this.returnTime = this.camper
        ? CONST.CAMPER_RETURN_TIME_MIN +
          random() * (CONST.CAMPER_RETURN_TIME_MAX - CONST.CAMPER_RETURN_TIME_MIN)
        : CONST.NO_DUTY_RETURN_TIME_MIN +
          random() * (CONST.NO_DUTY_RETURN_TIME_MAX - CONST.NO_DUTY_RETURN_TIME_MIN);
    }

    // ===== 人間らしさ: ドライバーごとの個性(全モード共通) =====
    // 実際の渋滞は「前のブレーキを見て減速→後ろも減速…」の連鎖で生まれる。
    // 知覚の遅れ・反応の強さ・車間の好みに個人差を持たせ、波が自然に発生・増幅する
    this.perceivedSpeed = this.speed; // 知覚している前方車速度(遅れて更新)
    this.perceptionTimer = random() * CONST.HUMAN_REACTION; // 知覚更新タイマー(位相をばらす)
    this.accelDelayTimer = CONST.HUMAN_ACCEL_LAG; // 再加速の出遅れタイマー
    this.anticipatedSpeed = this.speed; // 吸収運転: 下流の平均ペースの推定値
    this.reactionTime = CONST.HUMAN_REACTION * (0.7 + random() * 0.8); // 注意力の個人差
    this.followGain = CONST.HUMAN_GAIN * (0.85 + random() * 0.4); // 車間調整の反応の強さ
    this.accelLagDuration = CONST.HUMAN_ACCEL_LAG * (0.7 + random() * 0.8); // 再加速の出遅れの個人差
    this.headwayFactor = 0.9 + random() * 0.45; // 車間の好み(詰める人/空ける人)
    this.brakeChainFactor = 1.6 + random() * 1.0; // ブレーキ灯に身構える距離の係数
    this.frustration = 0; // 苛立ち(0〜1): 塞がれ続けると上がる
    this.noise = 0; // ペダル操作の揺らぎ(現在値)
    this.hazard = false; // ハザードランプ点灯中
    this.hazardTimer = 0; // 急ブレーキ後の点灯残り時間
    this.lampDeceleration = 0; // 直近フレームの減速度(灯火判定用)
    this.brakeLampHold = 0; // ブレーキ灯の最低保持時間
    this.brakeChainSignal = false; // 連鎖反応用の瞬時ブレーキ信号
    this.laneChangeAversion = 0.7 + random() * 0.6; // 車線変更への腰の重さ(個人差)
    this.slowAheadTimer = 0; // 遅い車に抑え込まれている時間
    this.noiseAmplitude = 0.5 + random() * 0.7; // 揺らぎの大きさの個人差

    // コントローラは状態を持たない委譲先なので、1台につき1組だけ作る。
    // 生成時に車両の状態を読んでも安全なよう、初期化を終えてから作る
    this.laneChangeController = deps.createLaneChangeController(this);
    this.longitudinalController = deps.createLongitudinalController(this);
    this.mergeCoordinator = deps.createMergeCoordinator(this);
  }

  occupies(lane: number): boolean {
    return lane === this.lane || (this.laneChange.state !== 'none' && lane === this.laneChange.to);
  }

  /** legacy 判断を通さず、snapshot から確定済みの運動だけを反映する。 */
  applyReservedMotion(motion: ReservedMotion, deltaTime: number): void {
    this.previousZ = this.z;
    const previousSpeed = this.speed;
    this.speed = motion.nextSpeed;
    this.targetSpeed = motion.nextSpeed;
    this.lampDeceleration = Math.max(0, (previousSpeed - this.speed) / deltaTime);
    this.brakeChainSignal = this.lampDeceleration >= 1.5;
    this.braking = this.lampDeceleration >= 5;
    this.z = motion.nextZ;
    this.x = motion.nextX;
    if (motion.laneChangeProgress !== null)
      this.advanceReservedLaneChange(motion.laneChangeProgress);
  }

  /** 証明済み transaction だけが呼ぶ、再評価も cancel も行わない合流開始。 */
  startReservedMergeLaneChange(): void {
    if (this.lane !== 3 || this.laneChange.state !== 'none') return;
    if (this.laneChangeBlockedLane === 2) {
      if (this.checkLaneSafetyForChange(2) !== 'safe') return;
      this.laneChangeBlockedLane = null;
    }
    this.laneChange.state = 'changing';
    this.laneChange.from = 3;
    this.laneChange.to = 2;
    this.laneChange.progress = 0;
    this.laneChange.holdTime = 0;
    this.laneChange.checkTimer = 0;
    this.world.stats.changes[this.section]++;
  }

  /** transaction が証明した横移動を、mutable な周囲状態を読み直さず進める。 */
  private advanceReservedLaneChange(progress: number): void {
    const laneChange = this.laneChange;
    if (laneChange.state === 'none') return;
    if (laneChange.from !== 3 || laneChange.to !== 2 || laneChange.state !== 'changing')
      throw new Error(`予約外の車線変更状態: vehicle=${this.spawnOrder}`);
    laneChange.progress = progress;
    if (laneChange.progress < 1 - 1e-9) return;
    laneChange.progress = 1;
    this.lane = 2;
    laneChange.state = 'none';
    const cooperation = this.mergePlan.certificate?.cooperation;
    const cooperator = cooperation
      ? this.world.vehicles.find((vehicle) => vehicle.spawnOrder === cooperation.rearOrder)
      : null;
    if (cooperator?.mergeCooperationTarget === this.mergePlan.targetPassTime) {
      cooperator.mergeCooperationTarget = null;
      cooperator.mergeCooperationDecel = 0;
    }
    this.mergePlan = {
      ...this.mergePlan,
      state: 'completed',
      front: null,
      rear: null,
      targetPassTime: 0,
      nextSource: null,
      cooperationDecel: undefined,
      certificate: null,
      envelope: undefined,
      completionZ: undefined,
    };
    this.mergedFromRamp = this.z >= CONST.MERGE_POINT_Z;
    this.rampMergePassPending = true;
    this.laneChangeCooldown = 4.0 + this.world.rng() * 5;
  }

  mergeHeadways(congestion: number): { front: number; rear: number } {
    return this.mergeCoordinator.mergeHeadways(congestion);
  }

  evaluateEntryCertificate(snapshot: WorldSnapshot, deltaTime = 1 / 20): MergeCertificate | null {
    return this.mergeCoordinator.evaluateEntryCertificate(snapshot, deltaTime);
  }

  projectReservation(
    snapshot: WorldSnapshot,
    plan: MergePlan,
    deltaTime: number,
  ): MergeDirective | null {
    return this.mergeCoordinator.projectReservation(snapshot, plan, deltaTime);
  }

  projectMergeSlot(rampEta: number): ProjectedMergeSlot | null {
    return this.mergeCoordinator.projectMergeSlot(rampEta);
  }

  projectReservedMergeSlot(plan: MergePlan): ProjectedMergeSlot | null {
    return this.mergeCoordinator.projectReservedMergeSlot(plan);
  }

  isProjectedSlotSafe(slot: ProjectedMergeSlot, congestion: number): boolean {
    return this.mergeCoordinator.isProjectedSlotSafe(slot, congestion);
  }

  projectMergeCongestionSample(slot: ProjectedMergeSlot | null): number {
    return this.mergeCoordinator.projectMergeCongestionSample(slot);
  }

  projectMergeCongestion(
    slot: ProjectedMergeSlot | null,
    deltaTime: number,
    sample = this.projectMergeCongestionSample(slot),
  ): number {
    return this.mergeCoordinator.projectMergeCongestion(slot, deltaTime, sample);
  }

  estimateMergeEta(): number {
    return this.mergeCoordinator.estimateMergeEta();
  }

  latestMergeCommitZ(): number {
    return this.mergeCoordinator.latestMergeCommitZ();
  }

  evaluateMergePlan(deltaTime: number, lastSource: MergeSource | null): MergePlan {
    return this.mergeCoordinator.evaluateMergePlan(deltaTime, lastSource);
  }

  isMergeApplySafe(plan: MergePlan): boolean {
    return this.mergeCoordinator.isMergeApplySafe(plan);
  }

  applyMergePlan(plan: MergePlan): void {
    if (plan.state === 'committed' && this.laneChangeBlockedLane === 2) {
      if (this.checkLaneSafetyForChange(2) !== 'safe') return;
      this.laneChangeBlockedLane = null;
    }
    const mergeLaneChange =
      this.laneChange.from === 3 && this.laneChange.to === 2 && this.laneChange.state !== 'none';
    if (mergeLaneChange && this.laneChange.state === 'cancel') {
      this.mergePlan = {
        ...plan,
        state: 'seeking',
        front: null,
        rear: null,
        targetPassTime: 0,
        nextSource: null,
        cooperationDecel: undefined,
      };
      return;
    }
    if (mergeLaneChange && plan.state === 'committed') {
      this.mergePlan = plan;
      return;
    }
    if (plan.state === 'committed' && !this.isMergeApplySafe(plan)) {
      const keepsRampArrivalReservation =
        (plan.rear === null || plan.nextSource === 'main') &&
        this.projectReservedMergeSlot(plan) !== null;
      if (keepsRampArrivalReservation) {
        this.mergePlan = {
          ...plan,
          state: 'coordinating',
        };
        return;
      }
      if (plan.rear?.mergeCooperationTarget === plan.targetPassTime) {
        plan.rear.mergeCooperationTarget = null;
        plan.rear.mergeCooperationDecel = 0;
      }
      this.mergePlan = {
        ...plan,
        state: 'seeking',
        front: null,
        rear: null,
        targetPassTime: 0,
        nextSource: null,
        cooperationDecel: undefined,
      };
      return;
    }
    this.mergePlan = plan;
    if (plan.state === 'coordinating' && plan.cooperationDecel === 0) {
      if (plan.rear) {
        plan.rear.mergeCooperationTarget = null;
        plan.rear.mergeCooperationDecel = 0;
      }
      return;
    }
    if (
      plan.state === 'coordinating' &&
      plan.cooperationDecel === undefined &&
      plan.rear &&
      plan.rear.laneChange.state === 'changing' &&
      plan.rear.laneChange.from === 2 &&
      plan.rear.laneChange.to === 1
    ) {
      plan.rear.noOvertakeTimer = 3;
      return;
    }
    if (
      plan.state === 'coordinating' &&
      plan.cooperationDecel === undefined &&
      plan.rear?.tryLaneChange(1)
    ) {
      plan.rear.noOvertakeTimer = 3;
      return;
    }
    if (plan.state === 'coordinating' && plan.rear) {
      plan.rear.mergeCooperationTarget = plan.targetPassTime;
      plan.rear.mergeCooperationDecel = plan.cooperationDecel ?? CONST.MERGE_TARGET_COOP_DECEL;
      return;
    }
    if (plan.state !== 'committed') return;
    this.laneChange.state = 'changing';
    this.laneChange.from = 3;
    this.laneChange.to = 2;
    this.laneChange.progress = 0;
    this.laneChange.holdTime = 0;
    this.laneChange.checkTimer = 0.15;
    this.world.stats.changes[this.section]++;
  }

  // 隣車線にほぼ同速で並走する車両がいるか(車線変更を物理的に塞ぐ「象レース」検知)
  hasDeadlockAlongside(lane: number): boolean {
    return this.laneChangeController.hasDeadlockAlongside(lane);
  }

  // 復帰先車線で自分の真横(±車体+8m)を占有し、車線変更を物理的に塞ぐ並走車を返す
  findAlongside(lane: number): Vehicle | null {
    return this.laneChangeController.findAlongside(lane);
  }

  // 加速復帰の開始判定: 追い越し車線で後続に追いつかれ、復帰先(レーン1)が並走車に
  // 塞がれている時、「速度差が小さく、並走車の前方が空いていて前に出れば戻れる
  // 見込みがある」なら一時的に加速して並走車を抜き、車線復帰を狙う
  tryStartReturnBoost(ahead: NeighborInfo | null): boolean {
    return this.laneChangeController.tryStartReturnBoost(ahead);
  }

  /**
   * 周回路上で最も近い同一車線の隣接車を返す。ahead = true で前方(z が小さい側)。
   *
   * sectionVehicles は step 冒頭の rebuildSectionIndex() で z 昇順に並べ替えられるが、
   * その後の update ループで各車が移動するため、step の途中では並び順が崩れている
   * (特に周回した車は z が +WRAP_LENGTH され、配列の末尾にあるべき位置へ飛ぶ)。
   * そのため添字順の走査で「最初に見つかった一台」を返すことはできず、
   * リング上の一方向距離が最小の一台を選び直す (Issue #52)。
   */
  private findNeighbor(lane: number, ahead: boolean): NeighborInfo | null {
    const vehicles = this.world.sectionVehicles[this.section];
    let best: Vehicle | null = null;
    let bestDistance = Infinity;
    for (const other of vehicles) {
      if (other === this || !other.occupies(lane)) continue;
      const raw = ahead ? this.z - other.z : other.z - this.z;
      // リング上の一方向距離 (0, WRAP_LENGTH]。
      // 距離 0(完全に同じ z)は従来と同じく「一周先」として扱う。
      const distance = ((raw % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH || WRAP_LENGTH;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    if (best === null) return null;
    return { vehicle: best, gap: bestDistance - (this.length + best.length) / 2 };
  }

  // 前方車探索（ahead = 進行方向側 = z が小さい側。周回路として探索）
  findAhead(lane: number): NeighborInfo | null {
    return this.findNeighbor(lane, true);
  }

  findBehind(lane: number): NeighborInfo | null {
    return this.findNeighbor(lane, false);
  }

  // 車線変更先の安全確認: 'safe' | 'hold' | 'danger'
  // 左方向(譲り・キープレフト)は遅い車線へ移るため、要求マージンをやや緩和する
  checkLaneSafetyForChange(toLane: number): 'safe' | 'hold' | 'danger' {
    return this.laneChangeController.checkLaneSafetyForChange(toLane);
  }

  tryLaneChange(toLane: number): boolean {
    return this.laneChangeController.tryLaneChange(toLane);
  }

  cancelLaneChange(emergency = false): void {
    return this.laneChangeController.cancelLaneChange(emergency);
  }

  updateLaneChange(deltaTime: number): void {
    return this.laneChangeController.updateLaneChange(deltaTime);
  }

  decide(ahead: NeighborInfo | null, deltaTime: number): void {
    return this.laneChangeController.decide(ahead, deltaTime);
  }

  update(deltaTime: number): void {
    this.previousZ = this.z;
    this.laneChangeCooldown = Math.max(0, this.laneChangeCooldown - deltaTime);
    this.noOvertakeTimer = Math.max(0, this.noOvertakeTimer - deltaTime);
    this.yieldSlowTimer = Math.max(0, this.yieldSlowTimer - deltaTime);
    this.returnBoostCooldown = Math.max(0, this.returnBoostCooldown - deltaTime);
    if (this.returnBoostTimer > 0) {
      this.returnBoostTimer -= deltaTime;
      // 復帰(車線変更)開始後もタイマーが切れるまでは速度を維持し、元の並走車
      // (=戻った先の後続)との車間を開けてから元のペースへ戻す(急な割り込みで
      // 後続にブレーキを踏ませ、渋滞波の起点になるのを防ぐ)
      if (this.returnBoostTimer <= 0 && this.lane === 0 && this.laneChange.state === 'none') {
        this.returnBoostCooldown = CONST.RETURN_BOOST_RETRY_COOLDOWN; // 抜けなかったので一旦諦める
      }
    }
    this.updateLaneChange(deltaTime);

    const ahead = this.longitudinalController.update(deltaTime);
    this.z -= this.speed * deltaTime;

    // --- 意思決定 ---
    if (this.laneChange.state === 'none' && this.laneChangeCooldown <= 0)
      this.decide(ahead, deltaTime);

    this.longitudinalController.updateHazard(deltaTime);

    // --- 終端処理 ---
    // rulesモード: 終端 = 出口。一定割合の車がここで流出する(捌けた分だけ出る)。
    // 流出量は「出口を通過する交通量 × 割合」なので、混んでいる側ほど捌けるのが
    // 遅くなり、同じ流入ペースでも道路上に車両が自然に滞留する(Issue #12)。
    // 残りは都市高速の環状線のように周回を続ける(波は継ぎ目なく通過)。
    // absorbモード: 円周実験なので全車が反対側へ連続的に回り込む
    if (this.z < -CONST.ROAD_HALF - 8) {
      if (this.world.mode !== 'absorb' && this.world.rng() < CONST.EXIT_RATIO) {
        this.exited = true;
      } else {
        this.z += WRAP_LENGTH;
      }
    }

    this.updateX();
  }

  updateX(): void {
    const laneXs = CONST.LANE_X[this.section],
      laneChange = this.laneChange;
    if (laneChange.state !== 'none') {
      this.x = lerp(
        laneXs[laneChange.from],
        laneXs[laneChange.to],
        smooth(clamp(laneChange.progress, 0, 1)),
      );
    } else {
      this.x = laneXs[this.lane];
    }
  }
}

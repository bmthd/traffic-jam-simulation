/* ============================================================
   シミュレーションコア: 車両（ドライバーモデル）
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import { CONST, TYPES } from './constants';
import type { Section, VehicleTypeName, VehicleTypeSpec } from './constants';
import { clamp, lerp, smooth, wrapDelta, WRAP_LENGTH } from './utils';
import type { World } from './world';

export type LaneChangeState = 'none' | 'changing' | 'holding' | 'cancel';
export interface LaneChange {
  state: LaneChangeState;
  from: number;
  to: number;
  progress: number;
  holdTime: number;
  checkTimer: number;
}
/** 前方/後方車の探索結果 */
export interface NeighborInfo {
  vehicle: Vehicle;
  gap: number;
}

export class Vehicle {
  world: World;
  section: Section;
  lane: number;
  z: number;
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
  laneChangeCooldown: number;
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
  sectionIndex: number;
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

  constructor(
    world: World,
    section: Section,
    lane: number,
    z: number,
    typeName: VehicleTypeName,
    desiredSpeed: number,
  ) {
    this.world = world;
    this.section = section; // 'L' = 義務あり / 'R' = 義務なし
    this.lane = lane; // 0 = 追い越し車線(進行方向の右端)
    this.z = z;
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
    this.laneChangeCooldown = 0;
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
    this.sectionIndex = 0;
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
  }

  occupies(lane: number): boolean {
    return lane === this.lane || (this.laneChange.state !== 'none' && lane === this.laneChange.to);
  }

  // 隣車線にほぼ同速で並走する車両がいるか(車線変更を物理的に塞ぐ「象レース」検知)
  hasDeadlockAlongside(lane: number): boolean {
    const vehicles = this.world.sectionVehicles[this.section];
    for (const other of vehicles) {
      if (other === this || !other.occupies(lane)) continue;
      if (
        Math.abs(wrapDelta(other.z - this.z)) < (this.length + other.length) / 2 + 5 &&
        Math.abs(other.speed - this.speed) < 1.5
      )
        return true;
    }
    return false;
  }

  // 復帰先車線で自分の真横(±車体+8m)を占有し、車線変更を物理的に塞ぐ並走車を返す
  findAlongside(lane: number): Vehicle | null {
    const vehicles = this.world.sectionVehicles[this.section];
    let best: Vehicle | null = null,
      bestDistance = Infinity;
    for (const other of vehicles) {
      if (other === this || !other.occupies(lane)) continue;
      const distance = Math.abs(wrapDelta(other.z - this.z));
      if (distance < (this.length + other.length) / 2 + 8 && distance < bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    return best;
  }

  // 加速復帰の開始判定: 追い越し車線で後続に追いつかれ、復帰先(レーン1)が並走車に
  // 塞がれている時、「速度差が小さく、並走車の前方が空いていて前に出れば戻れる
  // 見込みがある」なら一時的に加速して並走車を抜き、車線復帰を狙う
  tryStartReturnBoost(ahead: NeighborInfo | null): boolean {
    // ロジックは左右共通。区間差は「戻ろうとする早さ」(returnTime = 義務の有無に
    // 由来する気質)からのみ生まれ、この判定自体は両区間とも同じ条件で発動する。
    // 流れが悪い時に加速すると自分がブレーキ連鎖の起点になる。ほぼ自分の
    // ペースで走れている(=本当に並走車だけが障害)時に限って踏み込む
    if (this.speed < this.desiredSpeed * 0.85) return false;
    // (a) 明確に速い後続に追いつかれている(=どいてあげたい動機がある)時だけ
    //     発動する(閾値は「追いつかれた車両の義務」の譲り判定と同一)
    const behind = this.findBehind(this.lane);
    if (!behind) return false;
    const relativeSpeed = behind.vehicle.speed - this.speed;
    if (relativeSpeed < 2.5 || behind.gap > 24 + relativeSpeed * 4.5) return false;
    // (b) 復帰先を並走車が塞いでおり、待っていても抜けず(相手が同速以上)、
    //     かつ速度差が小さい(少し加速すれば前に出られる)
    const side = this.findAlongside(1);
    if (!side) return false;
    const sideSpeedDiff = side.speed - this.speed;
    if (sideSpeedDiff < -0.5 || sideSpeedDiff > CONST.RETURN_BOOST_MAX_SPEED_DIFF) return false;
    // (c) 並走車の前方に空きがあり、前に出れば戻るスペースができる見込みがある
    const sideAhead = side.findAhead(1);
    if (sideAhead && sideAhead.gap < CONST.RETURN_BOOST_TARGET_CLEARANCE) return false;
    // (d) 自車線の前方にも加速の余地がある(前が詰まっているのに踏まない)
    if (ahead && ahead.gap < CONST.RETURN_BOOST_AHEAD_CLEARANCE + this.speed * 0.5) return false;
    this.returnBoostTimer = CONST.RETURN_BOOST_DURATION;
    return true;
  }

  // 前方車探索（z昇順インデックスを利用。ahead = z が小さい側。周回路として探索）
  findAhead(lane: number): NeighborInfo | null {
    const vehicles = this.world.sectionVehicles[this.section];
    for (let i = this.sectionIndex - 1; i >= 0; i--) {
      const other = vehicles[i];
      if (other === this || !other.occupies(lane)) continue;
      if (other.z >= this.z) continue;
      return { vehicle: other, gap: this.z - other.z - (this.length + other.length) / 2 };
    }
    // 周回: 自分より手前に誰もいなければ、最も奥(z最大)の同一車線車が前方
    for (let i = vehicles.length - 1; i > this.sectionIndex; i--) {
      const other = vehicles[i];
      if (other === this || !other.occupies(lane)) continue;
      return {
        vehicle: other,
        gap: this.z - other.z + WRAP_LENGTH - (this.length + other.length) / 2,
      };
    }
    return null;
  }

  findBehind(lane: number): NeighborInfo | null {
    const vehicles = this.world.sectionVehicles[this.section];
    for (let i = this.sectionIndex + 1; i < vehicles.length; i++) {
      const other = vehicles[i];
      if (other === this || !other.occupies(lane)) continue;
      if (other.z < this.z) continue;
      return { vehicle: other, gap: other.z - this.z - (this.length + other.length) / 2 };
    }
    // 周回: 自分より奥に誰もいなければ、最も手前(z最小)の車が後続
    for (let i = 0; i < this.sectionIndex; i++) {
      const other = vehicles[i];
      if (other === this || !other.occupies(lane)) continue;
      return {
        vehicle: other,
        gap: other.z - this.z + WRAP_LENGTH - (this.length + other.length) / 2,
      };
    }
    return null;
  }

  // 車線変更先の安全確認: 'safe' | 'hold' | 'danger'
  // 左方向(譲り・キープレフト)は遅い車線へ移るため、要求マージンをやや緩和する
  checkLaneSafetyForChange(toLane: number): 'safe' | 'hold' | 'danger' {
    let result: 'safe' | 'hold' | 'danger' = 'safe';
    const relax = toLane > this.lane ? 0.8 : 1.0;
    const vehicles = this.world.sectionVehicles[this.section];
    for (const other of vehicles) {
      if (other === this || !other.occupies(toLane)) continue;
      const deltaZ = Math.abs(other.z - this.z);
      if (deltaZ > 90) continue;
      if (other.z <= this.z) {
        // 変更先の前方車
        const gap = this.z - other.z - (this.length + other.length) / 2;
        if (gap < 1.5) return 'danger';
        const requiredGap = (4 + this.speed * 0.45) * relax;
        if (gap < requiredGap) {
          if (other.speed >= this.speed + 1)
            result = 'hold'; // 前方だが自車より速い → 待機
          else return 'danger';
        }
      } else {
        // 変更先の後方車
        const gap = other.z - this.z - (this.length + other.length) / 2;
        if (gap < 1.5) return 'danger';
        const relativeSpeed = other.speed - this.speed;
        const requiredGap = (4 + Math.max(0, relativeSpeed) * 2.2 + other.speed * 0.22) * relax;
        if (gap < requiredGap) {
          if (relativeSpeed <= -1)
            result = 'hold'; // 後方だが自車より遅い → 待機
          else return 'danger';
        }
      }
    }
    return result;
  }

  tryLaneChange(toLane: number): boolean {
    if (toLane < 0 || toLane > 2) return false;
    if (this.checkLaneSafetyForChange(toLane) !== 'safe') return false;
    this.laneChange.state = 'changing';
    this.laneChange.from = this.lane;
    this.laneChange.to = toLane;
    this.laneChange.progress = 0;
    this.laneChange.holdTime = 0;
    this.laneChange.checkTimer = 0.15;
    this.world.stats.changes[this.section]++;
    return true;
  }

  cancelLaneChange(): void {
    if (this.laneChange.state !== 'cancel') {
      this.laneChange.state = 'cancel';
      this.world.stats.cancels[this.section]++;
    }
  }

  updateLaneChange(deltaTime: number): void {
    const laneChange = this.laneChange;
    if (laneChange.state === 'none') return;
    laneChange.checkTimer -= deltaTime;

    if (laneChange.state === 'changing') {
      laneChange.progress += deltaTime / CONST.LANE_CHANGE_DURATION;
      if (laneChange.checkTimer <= 0) {
        laneChange.checkTimer = 0.15;
        const safety = this.checkLaneSafetyForChange(laneChange.to);
        if (safety === 'danger') {
          this.cancelLaneChange();
          return;
        }
        if (safety === 'hold' && laneChange.progress < 0.3) {
          laneChange.state = 'holding';
          laneChange.holdTime = 0;
        }
      }
      if (laneChange.progress >= 1) {
        laneChange.progress = 1;
        this.lane = laneChange.to;
        laneChange.state = 'none';
        this.laneChangeCooldown = 4.0 + this.world.rng() * 5; // 変更直後は当分しない(面倒・疲れる)
      }
    } else if (laneChange.state === 'holding') {
      laneChange.holdTime += deltaTime;
      if (laneChange.checkTimer <= 0) {
        laneChange.checkTimer = 0.15;
        const safety = this.checkLaneSafetyForChange(laneChange.to);
        if (safety === 'safe') laneChange.state = 'changing';
        else if (safety === 'danger' || laneChange.holdTime > CONST.LANE_CHANGE_WAIT_MAX_DURATION)
          this.cancelLaneChange();
      }
    } else if (laneChange.state === 'cancel') {
      laneChange.progress -= deltaTime / (CONST.LANE_CHANGE_DURATION * 0.8);
      if (laneChange.progress <= 0) {
        laneChange.progress = 0;
        laneChange.state = 'none';
        this.lane = laneChange.from;
        this.laneChangeCooldown = CONST.LANE_CHANGE_RETRY_COOLDOWN;
      }
    }
  }

  decide(ahead: NeighborInfo | null, deltaTime: number): void {
    // 渋滞吸収運転モードでは車線変更なし(単一車線の追従実験と同じ純粋比較)。
    // 車線変更があると吸収運転車の広い車間が追い越しで埋められ、比較が濁る。
    if (this.world.mode === 'absorb') return;
    // 合流(加速車線): 本線の隙間を見つけ次第、走行車線へ入る。
    // 終端が近づくほど、現実のドライバー同様に受け入れる隙間を妥協する
    if (this.lane === 3) {
      const remainingDistance = this.z - CONST.RAMP_Z_END;
      const mergePressure = clamp(1 - remainingDistance / 80, 0, 1);
      const mergeAhead = this.findAhead(2),
        mergeBehind = this.findBehind(2);
      const aheadClear =
        !mergeAhead || mergeAhead.gap > (this.speed * 0.45 + 4) * (1 - 0.5 * mergePressure);
      const behindClear =
        !mergeBehind ||
        mergeBehind.gap >
          Math.max(
            2.0,
            (mergeBehind.vehicle.speed - this.speed) * (1.4 - 0.7 * mergePressure) + 2.5,
          );
      if (aheadClear && behindClear) {
        this.laneChange.state = 'changing';
        this.laneChange.from = 3;
        this.laneChange.to = 2;
        this.laneChange.progress = 0;
        this.laneChange.holdTime = 0;
        this.laneChange.checkTimer = 0.15;
        this.world.stats.changes[this.section]++;
      }
      return;
    }
    // 渋滞にはまっている時は譲り・復帰・キープレフトの車線変更はしない。
    // 実際のドライバーも、流れている時にだけ譲り合いの車線変更をする
    const flowing = this.speed > this.desiredSpeed * 0.6;
    // (0) 渋滞中の乗り換え: 自分の車線が進まず、隣が明確に流れている/空いている
    // 時は隣へ移る(全員ではなく苛立っている人ほど。左右では左を優先)。
    // これがないと「追い越し車線だけ詰まり、隣がガラ空き」の不自然な状態になる
    if (!flowing && this.frustration > 0.5 && this.world.rng() < deltaTime / 3) {
      const here = this.findAhead(this.lane);
      const hereGap = here ? here.gap : 999;
      const hereSpeed = here ? here.vehicle.speed : this.desiredSpeed;
      let bestLane = -1,
        bestScore = 4; // 「明確に良い」時だけ動く
      for (const laneOffset of [1, -1]) {
        // 左(走行車線側)から評価 = 同点なら左へ
        const lane = this.lane + laneOffset;
        if (lane < 0 || lane > 2) continue;
        const candidateAhead = this.findAhead(lane);
        // 渋滞中の判断は一瞥なので雑(隣の芝生は青く見える): ノイズ込みで評価
        const score =
          ((candidateAhead ? candidateAhead.gap : 999) - hereGap) * 0.15 +
          ((candidateAhead ? candidateAhead.vehicle.speed : this.desiredSpeed) - hereSpeed) +
          (this.world.rng() * 2 - 1) * 3;
        if (score > bestScore) {
          bestScore = score;
          bestLane = lane;
        }
      }
      if (bestLane >= 0 && this.tryLaneChange(bestLane)) {
        this.yieldSlowTimer = 0.6; // 移った直後は体勢を立て直すため少し緩める
        return;
      }
    }
    // (0.5) マイペース派(義務なし区間): 走行車線に縛られず、追い越し車線を
    // 定位置にして自分のペースで巡航する(これが義務なし文化の象徴)
    if (this.camper && this.lane > 0 && flowing) {
      this.keepRightTimer += deltaTime;
      if (this.keepRightTimer > 6 && this.tryLaneChange(this.lane - 1)) {
        this.keepRightTimer = 0;
        return;
      }
    }
    // (1) 「追いつかれた車両の義務」— 義務あり区間のみ: 速い後続車に進路を譲る。
    // ただし現実のドライバー同様、(a)明確に速い車が来た時だけ、(b)移った先でも
    // 自分のペースを保てる時だけ譲る(遅いトラックの直後への自己犠牲はしない)
    if (this.yields && flowing && this.lane < 2) {
      const behind = this.findBehind(this.lane);
      if (behind) {
        const relativeSpeed = behind.vehicle.speed - this.speed;
        if (relativeSpeed > 2.5 && behind.gap < 24 + relativeSpeed * 4.5) {
          const targetAhead = this.findAhead(this.lane + 1);
          const okTarget =
            !targetAhead ||
            targetAhead.gap > 45 ||
            targetAhead.vehicle.speed > this.desiredSpeed - 2;
          if (okTarget && this.tryLaneChange(this.lane + 1)) {
            this.world.stats.yields[this.section]++;
            this.noOvertakeTimer = 6; // 譲った直後はしばらく追い越しを我慢する
            return;
          }
          // 並走車に塞がれて譲れない(象レース)場合のみ、少し減速して後ろに入る
          if (okTarget && this.hasDeadlockAlongside(this.lane + 1)) this.yieldSlowTimer = 1.0;
        }
      }
    }
    // (2) 追い越し — 両区間共通: 遅い前方車がいれば右車線へ。
    // ただし人間は危険と面倒から車線変更を嫌うので、明確に遅い車に
    // 「しばらく」抑え込まれて初めて決意する(イライラしているほど早い)
    if (this.lane > 0) {
      const blockedNow =
        ahead &&
        ahead.gap < 18 + this.speed * 0.9 &&
        (ahead.vehicle.speed < this.desiredSpeed - 2 || this.speed < this.desiredSpeed * 0.88);
      this.slowAheadTimer = blockedNow ? this.slowAheadTimer + deltaTime : 0;
      let want = this.slowAheadTimer > 3.0 * this.laneChangeAversion * (1 - 0.6 * this.frustration);
      // 吸収運転車は車線を維持して波を吸収する。よほど遅くない限り追い越さない
      if (want && this.absorber && this.speed > this.desiredSpeed * 0.55) want = false;
      // 移った先が今より悪ければ追い越さない(渋滞した追い越し車線へは突っ込まない)
      if (want && ahead) {
        const targetAhead = this.findAhead(this.lane - 1);
        if (
          targetAhead &&
          targetAhead.vehicle.speed < ahead.vehicle.speed + 1 &&
          targetAhead.gap < ahead.gap + 10
        )
          want = false;
      }
      if (want && this.noOvertakeTimer > 0) {
        // 我慢中はよほど詰まらない限り追い越さない(譲り→追い越しの往復を防ぐ)
        want =
          !!ahead &&
          ahead.gap < 12 + this.speed * 0.5 &&
          ahead.vehicle.speed < this.desiredSpeed - 5;
      }
      if (want && this.tryLaneChange(this.lane - 1)) return;
    }
    // (3) 追い越し車線からの復帰 — 両区間共通だが、復帰の早さは気質 (returnTime) で異なる
    if (this.lane === 0) {
      const slowAhead = ahead && ahead.gap < 55 && ahead.vehicle.speed < this.desiredSpeed - 1;
      if (!slowAhead) this.returnTimer += deltaTime;
      else this.returnTimer = 0;
      if (this.returnTimer > this.returnTime && flowing) {
        if (this.tryLaneChange(1)) {
          this.returnTimer = 0; // 加速中なら残り時間だけ速度を維持したまま戻る
        } else if (this.returnBoostTimer <= 0) {
          // 復帰先が塞がっている: まず「加速して並走車の前に出て戻る」を試み、
          // 見込みがなければ従来どおり少し減速して並走車の後ろに入る
          if (this.returnBoostCooldown > 0 || !this.tryStartReturnBoost(ahead)) {
            if (this.section === 'L' && this.hasDeadlockAlongside(1)) this.yieldSlowTimer = 1.0;
          }
        }
      }
      this.keepLeftTimer = 0;
    } else if (this.keepLeft && flowing && this.lane === 1) {
      // (4) キープレフト — 義務あり区間のみ: 空いていれば走行車線へ寄る
      this.returnTimer = 0;
      // 70m先まで見て、自分のペースで走れる場合だけ走行車線へ寄る(トラック隊列の罠を回避)
      const leftAhead = this.findAhead(2);
      const leftClear =
        !leftAhead || leftAhead.gap > 70 || leftAhead.vehicle.speed > this.desiredSpeed - 1;
      const notBlocked = !ahead || ahead.gap > 22;
      if (leftClear && notBlocked) {
        this.keepLeftTimer += deltaTime;
        if (this.keepLeftTimer > 2.0 && this.tryLaneChange(2)) {
          this.keepLeftTimer = 0;
          this.noOvertakeTimer = 2;
        }
      } else {
        this.keepLeftTimer = 0;
      }
    } else {
      this.returnTimer = 0;
      this.keepLeftTimer = 0;
    }
  }

  update(deltaTime: number): void {
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

    // --- 衝突回避: 前方車両追従 ---
    let ahead = this.findAhead(this.lane);
    if (this.laneChange.state !== 'none') {
      const targetLaneAhead = this.findAhead(this.laneChange.to);
      if (targetLaneAhead && (!ahead || targetLaneAhead.gap < ahead.gap)) ahead = targetLaneAhead;
    }
    this.emergency = false;
    const isAbsorbMode = this.world.mode === 'absorb';
    const isHuman = !this.absorber; // 吸収運転車以外は全員「人間」(全モード共通)
    // 苛立ち: 希望速度よりずっと遅い状態が続くと車間を詰め、反応も荒くなる。
    // マイペース車に塞がれ続ける側ほど運転が荒れ、渋滞の波が生まれやすくなる
    if (isHuman) {
      // 苛立ちは「動けてはいるが遅い」帯域でのみ蓄積する。ノロノロ運転まで
      // 落ちると諦めて穏やかになる(これが渋滞の自己固定ループを解き、
      // 渋滞が「解けるべき条件では解ける」ようになる)
      const ratio = this.speed / this.desiredSpeed;
      const blocked = ratio < 0.8 && ratio > 0.3;
      this.frustration = clamp(
        this.frustration + (blocked ? deltaTime / 10 : -deltaTime / 5),
        0,
        1,
      );
      // ペダル操作の揺らぎ: 人間は一定速度を保てない。この小さな揺らぎが
      // 長い隊列の中で増幅され、渋滞の波の「種」になる(dt非依存のOU過程)
      this.noise +=
        -1.2 * this.noise * deltaTime +
        (this.world.rng() * 2 - 1) * this.noiseAmplitude * 1.7 * Math.sqrt(deltaTime);
    }
    const frustration = this.frustration;
    // サグ部(上り坂): 通常ドライバーは無意識に減速し、渋滞の種を作る
    let desire = this.desiredSpeed;
    if (isAbsorbMode && this.z > CONST.SAG_Z_MIN && this.z < CONST.SAG_Z_MAX) {
      desire *= this.absorber ? CONST.SAG_SLOWDOWN_ABSORBER : CONST.SAG_SLOWDOWN;
    }
    // 加速復帰中は希望速度を一時的に上乗せして並走車の前に出る(上限 RETURN_BOOST_SPEED_DELTA)。
    // 前方車への追従・緊急ブレーキはこの後の通常ロジックがそのまま制限するため安全は保たれる
    if (this.returnBoostTimer > 0) desire += CONST.RETURN_BOOST_SPEED_DELTA;
    let targetSpeed = this.yieldSlowTimer > 0 ? Math.max(8, desire - 2.5) : desire;
    // 加速車線: 終端で止まれる速度に常に制限(合流できなければ端で待つ)
    if (
      this.lane === 3 ||
      (this.laneChange.state !== 'none' &&
        this.laneChange.from === 3 &&
        this.laneChange.progress < 0.5)
    ) {
      const remainingDistance = Math.max(0, this.z - CONST.RAMP_Z_END);
      targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * 3.5 * Math.max(0, remainingDistance - 3)));
    }
    let requiredDecel = 0; // 衝突回避に物理的に必要な減速度
    if (ahead) {
      // 安全車間サーボ。苛立つほど車間を詰める(詰めた分だけ波に弱くなる)
      const effectiveHeadway = this.absorber ? 1 : this.headwayFactor * (1 - 0.35 * frustration);
      const safeDistance = this.length * 1.2 + 2.5 + this.speed * 0.55 * effectiveHeadway;
      const emergencyGap = this.length * 0.5 + 1.4;
      const relativeSpeed = this.speed - ahead.vehicle.speed;
      if (relativeSpeed > 0) {
        requiredDecel =
          (relativeSpeed * relativeSpeed) / (2 * Math.max(0.5, ahead.gap - emergencyGap));
      }
      // 人間ドライバー: 前方車の速度変化に気づくまで知覚の遅れがある。
      // この遅れが車間サーボを通じて波を増幅する(渋滞波の標準的な発生機構)。
      // 物理的に強い減速が必要な場面は下の実値オーバーライドが即座に介入する
      let aheadSpeed = ahead.vehicle.speed;
      if (isHuman) {
        this.perceptionTimer -= deltaTime;
        if (this.perceptionTimer <= 0) {
          this.perceptionTimer = this.reactionTime;
          this.perceivedSpeed = ahead.vehicle.speed;
        }
        aheadSpeed = this.perceivedSpeed;
      }
      // ウインカーを出して車線変更中の車への反応: 自分と同等以上の速度で入って
      // くる車には減速は不要(車間は開いていく)。遅い車が目の前に割り込む場合
      // だけ実ブレーキを強いられる — 渋滞中の乗り換えが渋滞を悪化させる理由
      const predictable =
        ahead.vehicle.laneChange.state !== 'none' &&
        (ahead.vehicle.speed >= this.speed - 0.5 || ahead.gap > this.speed * 0.5 + 4);
      const gain = this.absorber || predictable ? 0.6 : this.followGain * (1 + 0.5 * frustration);
      if (ahead.gap < emergencyGap) {
        // 貫通防止: 緊急ブレーキ
        targetSpeed = 0;
        this.emergency = true;
      } else if (ahead.gap < safeDistance) {
        targetSpeed = Math.min(
          targetSpeed,
          Math.max(0, aheadSpeed + (ahead.gap - safeDistance) * gain),
        );
      } else if (requiredDecel > 4) {
        // 車間はあるが接近が速すぎる場合も減速
        targetSpeed = Math.min(targetSpeed, ahead.vehicle.speed);
      }
      // 知覚が遅れていても、物理的に強い減速が必要なら実値で介入(安全は知覚に依存しない)
      if (!this.emergency && requiredDecel > 3.5)
        targetSpeed = Math.min(targetSpeed, ahead.vehicle.speed);
      // ===== ブレーキランプ連鎖(実渋滞の主因) =====
      // 前のブレーキ灯を見たら、車間に余裕があっても身構えてアクセルを抜き、
      // 前車より少し下まで速度を落とす。この過剰反応が後ろへ行くほど波を増幅し、
      // 先頭では誰も悪くないのに後方は完全停止する「幽霊渋滞」になる。
      // ただし自分の方が既に遅い場合(譲りのカットイン等)は身構えるだけで踏まない
      if (
        isHuman &&
        !this.emergency &&
        !predictable &&
        ahead.vehicle.brakeChainSignal &&
        relativeSpeed > -0.5 &&
        ahead.gap < this.speed * this.brakeChainFactor + 8
      ) {
        targetSpeed = Math.min(
          targetSpeed,
          Math.max(0, ahead.vehicle.speed - (0.5 + 2.5 * frustration)),
        );
      }
      // ===== 渋滞吸収運転: 下流の「平均ペース」で定速走行し、波に乗らない =====
      // 前方の振動(0⇔20km/h等)に追従せず平均速度で淡々と走る。広い車間が
      // 振動を吸収するバッファになり、後続には滑らかな速度だけが伝わる。
      if (this.absorber) {
        // 非対称な平均化: 前方の減速にはすぐ乗らず(波を吸収)、回復には素早く追従する
        const timeConstant =
          ahead.vehicle.speed > this.anticipatedSpeed
            ? CONST.ABSORBER_RECOVER
            : CONST.ABSORBER_ANTICIPATION;
        this.anticipatedSpeed +=
          (ahead.vehicle.speed - this.anticipatedSpeed) * Math.min(1, deltaTime / timeConstant);
        const desiredGap = this.length * 1.2 + 2.5 + this.speed * 0.55 * CONST.ABSORBER_HEADWAY;
        const paceBias = ahead.gap < desiredGap ? CONST.ABSORBER_PACE_BIAS : 0; // バッファ構築
        targetSpeed = Math.min(targetSpeed, Math.max(0, this.anticipatedSpeed - paceBias));
      }
    } else if (this.absorber) {
      this.anticipatedSpeed +=
        (desire - this.anticipatedSpeed) * Math.min(1, deltaTime / CONST.ABSORBER_ANTICIPATION);
    }
    this.targetSpeed = targetSpeed;
    // ペダル揺らぎの適用(緊急時を除く)。自由走行では自然な速度の波打ちに、
    // 密な追従では後続が増幅する小さな乱れになる
    if (isHuman && !this.emergency) targetSpeed = Math.max(0, targetSpeed + this.noise);
    // よそ見ブレーキ(渋滞のきっかけ): 本人の意思とは無関係に減速する
    if (this.perturbTimer > 0) {
      this.perturbTimer -= deltaTime;
      targetSpeed = Math.min(targetSpeed, this.desiredSpeed * CONST.PERTURB_FACTOR);
      this.targetSpeed = targetSpeed;
    }
    const speedDiff = targetSpeed - this.speed;
    if (speedDiff > 0) {
      this.lampDeceleration = 0;
      if (isHuman && this.accelDelayTimer < this.accelLagDuration) {
        this.accelDelayTimer += deltaTime; // 再加速の出遅れ: 前が動いてもすぐには踏まない(渋滞先頭の容量低下)
      } else {
        // 吸収運転は加速も滑らか(波を下流に作らない)
        const acceleration = this.absorber ? this.type.acceleration * 0.6 : this.type.acceleration;
        this.speed = Math.min(targetSpeed, this.speed + acceleration * deltaTime);
      }
    } else {
      if (isHuman && speedDiff < -1.0) this.accelDelayTimer = 0; // 減速したら次の再加速はまた出遅れる
      // 必要減速度に応じてブレーキ強度を可変に。前方車要因がない自発的な減速
      // (譲りのための速度調整など)はエンジンブレーキ程度に緩やかにする
      const voluntaryDecel = isHuman ? 9 : 3.5; // 人間はアクセルオフも雑(波を増幅)
      const brakeAmp = isHuman ? CONST.HUMAN_BRAKE_AMP : 1.4; // ブレーキの踏みすぎ
      const minBrakeDecel = isHuman ? 12 : 9;
      let decel = this.emergency
        ? 30
        : requiredDecel > 0.5
          ? clamp(requiredDecel * brakeAmp, minBrakeDecel, 30)
          : voluntaryDecel;
      if (this.perturbTimer > 0) decel = Math.max(decel, 9); // よそ見ブレーキは全員同じ強さ(公平)
      // 急ブレーキを踏んだら後続への警告にハザードを焚く
      if (decel >= 14 && this.speed > 8) this.hazardTimer = 2.5;
      this.lampDeceleration = decel;
      this.speed = Math.max(Math.max(0, targetSpeed), this.speed - decel * deltaTime);
    }
    // 連鎖反応(力学)用の瞬時信号は従来どおり
    this.brakeChainSignal = speedDiff < -1.5 || this.emergency;
    // ブレーキ灯(見た目): 実際にブレーキ相当の減速をしている時だけ点け、点いたら
    // 最低0.7秒は保持する。人間の踏み替えは秒オーダーで、チラつき(パカパカ)はしない
    const pressing = this.emergency || (this.lampDeceleration >= 5 && speedDiff < -1.0);
    this.brakeLampHold = pressing ? 0.7 : Math.max(0, this.brakeLampHold - deltaTime);
    this.braking = pressing || this.brakeLampHold > 0;

    this.z -= this.speed * deltaTime;

    // --- 意思決定 ---
    if (this.laneChange.state === 'none' && this.laneChangeCooldown <= 0)
      this.decide(ahead, deltaTime);

    // --- ハザード: 急ブレーキ直後、および停止列の最後尾で後続に知らせる(日本の習慣)。
    //     後続が近くまで来て減速し終えたら消す ---
    this.hazardTimer = Math.max(0, this.hazardTimer - deltaTime);
    let queueTail = false;
    if (this.speed < 2.5) {
      const behind = this.findBehind(this.lane);
      queueTail = !behind || behind.gap > 30 || behind.vehicle.speed > 6;
    }
    this.hazard = queueTail || this.hazardTimer > 0;

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

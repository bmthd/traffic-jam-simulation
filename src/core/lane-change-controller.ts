import { CONST } from './constants';
import { clamp, lerp, smooth, wrapDelta } from './utils';
import type { NeighborInfo, Vehicle } from './vehicle';

export class LaneChangeController {
  constructor(private readonly vehicle: Vehicle) {}

  hasDeadlockAlongside(lane: number): boolean {
    const vehicles = this.vehicle.world.sectionVehicles[this.vehicle.section];
    for (const other of vehicles) {
      if (other === this.vehicle || !other.occupies(lane)) continue;
      if (
        Math.abs(wrapDelta(other.z - this.vehicle.z)) <
          (this.vehicle.length + other.length) / 2 + 5 &&
        Math.abs(other.speed - this.vehicle.speed) < 1.5
      )
        return true;
    }
    return false;
  }

  findAlongside(lane: number): Vehicle | null {
    const vehicles = this.vehicle.world.sectionVehicles[this.vehicle.section];
    let best: Vehicle | null = null,
      bestDistance = Infinity;
    for (const other of vehicles) {
      if (other === this.vehicle || !other.occupies(lane)) continue;
      const distance = Math.abs(wrapDelta(other.z - this.vehicle.z));
      if (distance < (this.vehicle.length + other.length) / 2 + 8 && distance < bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    return best;
  }

  tryStartReturnBoost(ahead: NeighborInfo | null): boolean {
    // ロジックは左右共通。区間差は「戻ろうとする早さ」(returnTime = 義務の有無に
    // 由来する気質)からのみ生まれ、この判定自体は両区間とも同じ条件で発動する。
    // 流れが悪い時に加速すると自分がブレーキ連鎖の起点になる。ほぼ自分の
    // ペースで走れている(=本当に並走車だけが障害)時に限って踏み込む
    if (this.vehicle.speed < this.vehicle.desiredSpeed * 0.85) return false;
    // (a) 明確に速い後続に追いつかれている(=どいてあげたい動機がある)時だけ
    //     発動する(閾値は「追いつかれた車両の義務」の譲り判定と同一)
    const behind = this.vehicle.findBehind(this.vehicle.lane);
    if (!behind) return false;
    const relativeSpeed = behind.vehicle.speed - this.vehicle.speed;
    if (relativeSpeed < 2.5 || behind.gap > 24 + relativeSpeed * 4.5) return false;
    // (b) 復帰先を並走車が塞いでおり、待っていても抜けず(相手が同速以上)、
    //     かつ速度差が小さい(少し加速すれば前に出られる)
    const side = this.vehicle.findAlongside(1);
    if (!side) return false;
    const sideSpeedDiff = side.speed - this.vehicle.speed;
    if (sideSpeedDiff < -0.5 || sideSpeedDiff > CONST.RETURN_BOOST_MAX_SPEED_DIFF) return false;
    // (c) 並走車の前方に空きがあり、前に出れば戻るスペースができる見込みがある
    const sideAhead = side.findAhead(1);
    if (sideAhead && sideAhead.gap < CONST.RETURN_BOOST_TARGET_CLEARANCE) return false;
    // (d) 自車線の前方にも加速の余地がある(前が詰まっているのに踏まない)
    if (ahead && ahead.gap < CONST.RETURN_BOOST_AHEAD_CLEARANCE + this.vehicle.speed * 0.5)
      return false;
    this.vehicle.returnBoostTimer = CONST.RETURN_BOOST_DURATION;
    return true;
  }

  checkLaneSafetyForChange(toLane: number): 'safe' | 'hold' | 'danger' {
    let result: 'safe' | 'hold' | 'danger' = 'safe';
    const relax = toLane > this.vehicle.lane ? 0.8 : 1.0;
    const vehicles = this.vehicle.world.sectionVehicles[this.vehicle.section];
    for (const other of vehicles) {
      if (other === this.vehicle || !other.occupies(toLane)) continue;
      // 周回路なので符号付き最短距離で前後を判定する(継ぎ目をまたぐ相手も拾う)。
      // deltaZ <= 0 なら相手は前方(z が小さい側)、> 0 なら後方。
      const deltaZ = wrapDelta(other.z - this.vehicle.z);
      if (Math.abs(deltaZ) > 90) continue;
      if (deltaZ <= 0) {
        // 変更先の前方車
        const gap = -deltaZ - (this.vehicle.length + other.length) / 2;
        if (gap < 1.5) return 'danger';
        const requiredGap = (4 + this.vehicle.speed * 0.45) * relax;
        if (gap < requiredGap) {
          if (other.speed >= this.vehicle.speed + 1)
            result = 'hold'; // 前方だが自車より速い → 待機
          else return 'danger';
        }
      } else {
        // 変更先の後方車
        const gap = deltaZ - (this.vehicle.length + other.length) / 2;
        if (gap < 1.5) return 'danger';
        const relativeSpeed = other.speed - this.vehicle.speed;
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
    if (this.vehicle.laneChange.state !== 'none') return false;
    if (this.vehicle.world.blocksReservedLaneChange(this.vehicle, toLane)) return false;
    const safety = this.vehicle.checkLaneSafetyForChange(toLane);
    if (this.vehicle.laneChangeBlockedLane === toLane) {
      if (safety !== 'safe') return false;
      this.vehicle.laneChangeBlockedLane = null;
    } else if (safety !== 'safe') return false;
    this.vehicle.laneChange.state = 'changing';
    this.vehicle.laneChange.from = this.vehicle.lane;
    this.vehicle.laneChange.to = toLane;
    this.vehicle.laneChange.progress = 0;
    this.vehicle.laneChange.holdTime = 0;
    this.vehicle.laneChange.checkTimer = 0.15;
    this.vehicle.world.stats.changes[this.vehicle.section]++;
    return true;
  }

  cancelLaneChange(emergency = false): void {
    if (this.vehicle.laneChange.from === 3 && this.vehicle.laneChange.to === 2) {
      const rear = this.vehicle.mergePlan.rear;
      if (rear?.mergeCooperationTarget === this.vehicle.mergePlan.targetPassTime) {
        rear.mergeCooperationTarget = null;
        rear.mergeCooperationDecel = 0;
      }
      this.vehicle.mergePlan = {
        ...this.vehicle.mergePlan,
        state: 'seeking',
        front: null,
        rear: null,
        targetPassTime: 0,
        nextSource: null,
        cooperationDecel: undefined,
      };
    }
    if (this.vehicle.laneChange.state !== 'cancel') {
      if (emergency) this.vehicle.laneChangeBlockedLane = this.vehicle.laneChange.to;
      this.vehicle.laneChange.state = 'cancel';
      this.vehicle.world.stats.cancels[this.vehicle.section]++;
    }
  }

  updateLaneChange(deltaTime: number): void {
    const laneChange = this.vehicle.laneChange;
    if (laneChange.state === 'none') return;
    laneChange.checkTimer -= deltaTime;

    if (laneChange.state === 'changing') {
      laneChange.progress += deltaTime / CONST.LANE_CHANGE_DURATION;
      // 開始後は通常の車間不足で切り返さず、実車体の重複だけを緊急停止する。
      if (this.hasPhysicalOverlap(laneChange.to, laneChange.progress)) {
        this.vehicle.cancelLaneChange(true);
        return;
      }
      if (laneChange.progress >= 1) {
        laneChange.progress = 1;
        this.vehicle.lane = laneChange.to;
        laneChange.state = 'none';
        if (laneChange.from === 3 && laneChange.to === 2) {
          const targetPassTime = this.vehicle.mergePlan.targetPassTime;
          const rear = this.vehicle.mergePlan.rear;
          if (rear?.mergeCooperationTarget === targetPassTime) {
            rear.mergeCooperationTarget = null;
            rear.mergeCooperationDecel = 0;
          }
          this.vehicle.mergePlan = {
            ...this.vehicle.mergePlan,
            state: 'completed',
            front: null,
            rear: null,
            targetPassTime: 0,
            nextSource: null,
            cooperationDecel: undefined,
          };
          this.vehicle.mergedFromRamp = this.vehicle.z >= CONST.MERGE_POINT_Z;
          this.vehicle.rampMergePassPending = true;
        }
        this.vehicle.laneChangeCooldown = 4.0 + this.vehicle.world.rng() * 5; // 変更直後は当分しない(面倒・疲れる)
      }
    } else if (laneChange.state === 'cancel') {
      laneChange.progress -= deltaTime / (CONST.LANE_CHANGE_DURATION * 0.8);
      if (laneChange.progress <= 0) {
        laneChange.progress = 0;
        laneChange.state = 'none';
        this.vehicle.lane = laneChange.from;
        this.vehicle.laneChangeCooldown = CONST.LANE_CHANGE_RETRY_COOLDOWN;
      }
    }
  }

  private hasPhysicalOverlap(toLane: number, progress: number): boolean {
    const laneXs = CONST.LANE_X[this.vehicle.section];
    const x = lerp(
      laneXs[this.vehicle.laneChange.from],
      laneXs[toLane],
      smooth(clamp(progress, 0, 1)),
    );
    for (const other of this.vehicle.world.sectionVehicles[this.vehicle.section]) {
      if (other === this.vehicle || !other.occupies(toLane)) continue;
      const horizontalOverlap = Math.abs(other.x - x) < (this.vehicle.width + other.width) / 2;
      const longitudinalOverlap =
        Math.abs(wrapDelta(other.z - this.vehicle.z)) < (this.vehicle.length + other.length) / 2;
      if (horizontalOverlap && longitudinalOverlap) return true;
    }
    return false;
  }

  decide(ahead: NeighborInfo | null, deltaTime: number): void {
    // 渋滞吸収運転モードでは車線変更なし(単一車線の追従実験と同じ純粋比較)。
    // 車線変更があると吸収運転車の広い車間が追い越しで埋められ、比較が濁る。
    if (this.vehicle.world.mode === 'absorb') return;
    // ランプ車の合流開始は予約を確定した applyMergePlan だけが行う。
    if (this.vehicle.lane === 3) return;
    // 渋滞にはまっている時は譲り・復帰・キープレフトの車線変更はしない。
    // 実際のドライバーも、流れている時にだけ譲り合いの車線変更をする
    const flowing = this.vehicle.speed > this.vehicle.desiredSpeed * 0.6;
    // (0) 渋滞中の乗り換え: 自分の車線が進まず、隣が明確に流れている/空いている
    // 時は隣へ移る(全員ではなく苛立っている人ほど。左右では左を優先)。
    // これがないと「追い越し車線だけ詰まり、隣がガラ空き」の不自然な状態になる
    if (!flowing && this.vehicle.frustration > 0.5 && this.vehicle.world.rng() < deltaTime / 3) {
      const here = this.vehicle.findAhead(this.vehicle.lane);
      const hereGap = here ? here.gap : 999;
      const hereSpeed = here ? here.vehicle.speed : this.vehicle.desiredSpeed;
      let bestLane = -1,
        bestScore = 4; // 「明確に良い」時だけ動く
      for (const laneOffset of [1, -1]) {
        // 左(走行車線側)から評価 = 同点なら左へ
        const lane = this.vehicle.lane + laneOffset;
        if (lane < 0 || lane > 2) continue;
        const candidateAhead = this.vehicle.findAhead(lane);
        // 渋滞中の判断は一瞥なので雑(隣の芝生は青く見える): ノイズ込みで評価
        const score =
          ((candidateAhead ? candidateAhead.gap : 999) - hereGap) * 0.15 +
          ((candidateAhead ? candidateAhead.vehicle.speed : this.vehicle.desiredSpeed) -
            hereSpeed) +
          (this.vehicle.world.rng() * 2 - 1) * 3;
        if (score > bestScore) {
          bestScore = score;
          bestLane = lane;
        }
      }
      if (bestLane >= 0 && this.vehicle.tryLaneChange(bestLane)) {
        this.vehicle.yieldSlowTimer = 0.6; // 移った直後は体勢を立て直すため少し緩める
        return;
      }
    }
    // (0.5) マイペース派(義務なし区間): 走行車線に縛られず、追い越し車線を
    // 定位置にして自分のペースで巡航する(これが義務なし文化の象徴)
    if (this.vehicle.camper && this.vehicle.lane > 0 && flowing) {
      this.vehicle.keepRightTimer += deltaTime;
      if (this.vehicle.keepRightTimer > 6 && this.vehicle.tryLaneChange(this.vehicle.lane - 1)) {
        this.vehicle.keepRightTimer = 0;
        return;
      }
    }
    // (1) 「追いつかれた車両の義務」— 義務あり区間のみ: 速い後続車に進路を譲る。
    // ただし現実のドライバー同様、(a)明確に速い車が来た時だけ、(b)移った先でも
    // 自分のペースを保てる時だけ譲る(遅いトラックの直後への自己犠牲はしない)
    if (this.vehicle.yields && flowing && this.vehicle.lane < 2) {
      const behind = this.vehicle.findBehind(this.vehicle.lane);
      if (behind) {
        const relativeSpeed = behind.vehicle.speed - this.vehicle.speed;
        if (relativeSpeed > 2.5 && behind.gap < 24 + relativeSpeed * 4.5) {
          const targetAhead = this.vehicle.findAhead(this.vehicle.lane + 1);
          const okTarget =
            !targetAhead ||
            targetAhead.gap > 45 ||
            targetAhead.vehicle.speed > this.vehicle.desiredSpeed - 2;
          if (okTarget && this.vehicle.tryLaneChange(this.vehicle.lane + 1)) {
            this.vehicle.world.stats.yields[this.vehicle.section]++;
            this.vehicle.noOvertakeTimer = 6; // 譲った直後はしばらく追い越しを我慢する
            return;
          }
          // 並走車に塞がれて譲れない(象レース)場合のみ、少し減速して後ろに入る
          if (okTarget && this.vehicle.hasDeadlockAlongside(this.vehicle.lane + 1))
            this.vehicle.yieldSlowTimer = 1.0;
        }
      }
    }
    // (2) 追い越し — 両区間共通: 遅い前方車がいれば右車線へ。
    // ただし人間は危険と面倒から車線変更を嫌うので、明確に遅い車に
    // 「しばらく」抑え込まれて初めて決意する(イライラしているほど早い)
    if (this.vehicle.lane > 0) {
      const blockedNow =
        ahead &&
        ahead.gap < 18 + this.vehicle.speed * 0.9 &&
        (ahead.vehicle.speed < this.vehicle.desiredSpeed - 2 ||
          this.vehicle.speed < this.vehicle.desiredSpeed * 0.88);
      this.vehicle.slowAheadTimer = blockedNow ? this.vehicle.slowAheadTimer + deltaTime : 0;
      let want =
        this.vehicle.slowAheadTimer >
        3.0 * this.vehicle.laneChangeAversion * (1 - 0.6 * this.vehicle.frustration);
      // 吸収運転車は車線を維持して波を吸収する。よほど遅くない限り追い越さない
      if (want && this.vehicle.absorber && this.vehicle.speed > this.vehicle.desiredSpeed * 0.55)
        want = false;
      // 移った先が今より悪ければ追い越さない(渋滞した追い越し車線へは突っ込まない)
      if (want && ahead) {
        const targetAhead = this.vehicle.findAhead(this.vehicle.lane - 1);
        if (
          targetAhead &&
          targetAhead.vehicle.speed < ahead.vehicle.speed + 1 &&
          targetAhead.gap < ahead.gap + 10
        )
          want = false;
      }
      if (want && this.vehicle.noOvertakeTimer > 0) {
        // 我慢中はよほど詰まらない限り追い越さない(譲り→追い越しの往復を防ぐ)
        want =
          !!ahead &&
          ahead.gap < 12 + this.vehicle.speed * 0.5 &&
          ahead.vehicle.speed < this.vehicle.desiredSpeed - 5;
      }
      if (want && this.vehicle.tryLaneChange(this.vehicle.lane - 1)) return;
    }
    // (3) 追い越し車線からの復帰 — 両区間共通だが、復帰の早さは気質 (returnTime) で異なる
    if (this.vehicle.lane === 0) {
      const slowAhead =
        ahead && ahead.gap < 55 && ahead.vehicle.speed < this.vehicle.desiredSpeed - 1;
      if (!slowAhead) this.vehicle.returnTimer += deltaTime;
      else this.vehicle.returnTimer = 0;
      if (this.vehicle.returnTimer > this.vehicle.returnTime && flowing) {
        if (this.vehicle.tryLaneChange(1)) {
          this.vehicle.returnTimer = 0; // 加速中なら残り時間だけ速度を維持したまま戻る
        } else if (this.vehicle.returnBoostTimer <= 0) {
          // 復帰先が塞がっている: まず「加速して並走車の前に出て戻る」を試み、
          // 見込みがなければ従来どおり少し減速して並走車の後ろに入る
          if (this.vehicle.returnBoostCooldown > 0 || !this.vehicle.tryStartReturnBoost(ahead)) {
            if (this.vehicle.hasDeadlockAlongside(1)) this.vehicle.yieldSlowTimer = 1.0;
          }
        }
      }
      this.vehicle.keepLeftTimer = 0;
    } else if (this.vehicle.keepLeft && flowing && this.vehicle.lane === 1) {
      // (4) キープレフト — 義務あり区間のみ: 空いていれば走行車線へ寄る
      this.vehicle.returnTimer = 0;
      // 70m先まで見て、自分のペースで走れる場合だけ走行車線へ寄る(トラック隊列の罠を回避)
      const leftAhead = this.vehicle.findAhead(2);
      const leftClear =
        !leftAhead || leftAhead.gap > 70 || leftAhead.vehicle.speed > this.vehicle.desiredSpeed - 1;
      const notBlocked = !ahead || ahead.gap > 22;
      if (leftClear && notBlocked) {
        this.vehicle.keepLeftTimer += deltaTime;
        if (this.vehicle.keepLeftTimer > 2.0 && this.vehicle.tryLaneChange(2)) {
          this.vehicle.keepLeftTimer = 0;
          this.vehicle.noOvertakeTimer = 2;
        }
      } else {
        this.vehicle.keepLeftTimer = 0;
      }
    } else {
      this.vehicle.returnTimer = 0;
      this.vehicle.keepLeftTimer = 0;
    }
  }
}

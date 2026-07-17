/* ============================================================
   シミュレーションコア: 車両（ドライバーモデル）
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import { CONST, TYPES } from './constants';
import type { Section, VehicleTypeName, VehicleTypeSpec } from './constants';
import { clamp, lerp, smooth, wrapDelta, WRAP } from './utils';
import type { World } from './world';

export type LaneChangeState = 'none' | 'changing' | 'holding' | 'cancel';
export interface LaneChange {
  state: LaneChangeState;
  from: number;
  to: number;
  t: number;
  hold: number;
  checkT: number;
}
/** 前方/後方車の探索結果 */
export interface NeighborInfo {
  v: Vehicle;
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
  lc: LaneChange;
  cooldown: number;
  returnTimer: number;
  keepLeftTimer: number;
  noOvertakeT: number;
  yieldSlowT: number;
  braking: boolean;
  emergency: boolean;
  waiting: boolean;
  waitT: number;
  perturbT: number;
  _idx: number;
  color: number;
  isTaxi: boolean;
  absorber: boolean;
  yields: boolean;
  keepLeft: boolean;
  camper: boolean;
  returnTime: number;
  percSpeed: number;
  percT: number;
  accT: number;
  anticip: number;
  reaction: number;
  gainF: number;
  lagF: number;
  headwayF: number;
  chainF: number;
  frust: number;
  noise: number;
  hazard: boolean;
  hazardT: number;
  lampDec: number;
  brakeHold: number;
  chainSig: boolean;
  lcAversion: number;
  slowAheadT: number;
  noiseAmp: number;
  keepRightT = 0; // マイペース派が追い越し車線へ戻るまでの計時

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
    this.lane = lane; // 0 = 追い越し車線
    this.z = z;
    this.typeName = typeName;
    this.type = TYPES[typeName];
    this.length = this.type.len;
    this.width = this.type.w;
    this.initialDesiredSpeed = desiredSpeed;
    this.desiredSpeed = desiredSpeed;
    const r = world.rng;
    this.speed = desiredSpeed * (0.85 + r() * 0.15);
    this.targetSpeed = desiredSpeed;
    this.x = CONST.LANE_X[section][lane];
    this.lc = { state: 'none', from: lane, to: lane, t: 0, hold: 0, checkT: 0 };
    this.cooldown = 0;
    this.returnTimer = 0;
    this.keepLeftTimer = 0;
    this.noOvertakeT = 0; // 譲った直後の「我慢」時間(頻繁な変更による乱流防止)
    this.yieldSlowT = 0; // 譲り先が塞がっている時に少し減速して後ろに入るための時間
    this.braking = false;
    this.emergency = false;
    this.waiting = false; // ループ再出現の待機中
    this.waitT = 0;
    this.perturbT = 0; // よそ見ブレーキの残り時間(absorbモードでWorldが設定)
    this._idx = 0;
    this.color = this.type.colors[Math.floor(r() * this.type.colors.length)];
    this.isTaxi = typeName === 'Sedan' && r() < 0.08;
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
        world._absRR = world._absRR || [0, 0, 0];
        const period = Math.max(1, Math.round(1 / CONST.ABSORBER_RATIO));
        this.absorber = world._absRR[lane]++ % period === 1 % period;
      }
      // 円周実験と同じく希望速度はほぼ均一にする。車線変更がない世界では
      // 1台の極端に遅い車が車線全体を支配してしまい、波の比較ができなくなる
      this.desiredSpeed = 23.5 + r() * 3.0;
    } else if (section === 'L') {
      // 義務あり: 譲る・キープレフト・追い越し後はすぐ戻る
      this.yields = true;
      this.keepLeft = true;
      this.camper = false;
      this.returnTime = CONST.OVERTAKE_LANE_RETURN_TIME;
    } else {
      // 義務なし: ルール上の義務はないが、現実には自発的に譲る人も一定割合いる。
      // 「義務」はこの割合を全員に引き上げるもの — ここがルール比較の核心
      this.yields = r() < CONST.VOLUNTARY_YIELD_RATIO;
      this.keepLeft = this.yields && r() < 0.5; // 自発的に譲る人の半数はキープレフトも実践
      this.camper = !this.yields && r() < CONST.CAMPER_RATIO;
      this.returnTime = this.camper
        ? CONST.CAMPER_RETURN_TIME_MIN +
          r() * (CONST.CAMPER_RETURN_TIME_MAX - CONST.CAMPER_RETURN_TIME_MIN)
        : CONST.NO_DUTY_RETURN_TIME_MIN +
          r() * (CONST.NO_DUTY_RETURN_TIME_MAX - CONST.NO_DUTY_RETURN_TIME_MIN);
    }

    // ===== 人間らしさ: ドライバーごとの個性(全モード共通) =====
    // 実際の渋滞は「前のブレーキを見て減速→後ろも減速…」の連鎖で生まれる。
    // 知覚の遅れ・反応の強さ・車間の好みに個人差を持たせ、波が自然に発生・増幅する
    this.percSpeed = this.speed; // 知覚している前方車速度(遅れて更新)
    this.percT = r() * CONST.HUMAN_REACTION; // 知覚更新タイマー(位相をばらす)
    this.accT = CONST.HUMAN_ACCEL_LAG; // 再加速の出遅れタイマー
    this.anticip = this.speed; // 吸収運転: 下流の平均ペースの推定値
    this.reaction = CONST.HUMAN_REACTION * (0.7 + r() * 0.8); // 注意力の個人差
    this.gainF = CONST.HUMAN_GAIN * (0.85 + r() * 0.4); // 車間調整の反応の強さ
    this.lagF = CONST.HUMAN_ACCEL_LAG * (0.7 + r() * 0.8); // 再加速の出遅れの個人差
    this.headwayF = 0.9 + r() * 0.45; // 車間の好み(詰める人/空ける人)
    this.chainF = 1.6 + r() * 1.0; // ブレーキ灯に身構える距離の係数
    this.frust = 0; // 苛立ち(0〜1): 塞がれ続けると上がる
    this.noise = 0; // ペダル操作の揺らぎ(現在値)
    this.hazard = false; // ハザードランプ点灯中
    this.hazardT = 0; // 急ブレーキ後の点灯残り時間
    this.lampDec = 0; // 直近フレームの減速度(灯火判定用)
    this.brakeHold = 0; // ブレーキ灯の最低保持時間
    this.chainSig = false; // 連鎖反応用の瞬時ブレーキ信号
    this.lcAversion = 0.7 + r() * 0.6; // 車線変更への腰の重さ(個人差)
    this.slowAheadT = 0; // 遅い車に抑え込まれている時間
    this.noiseAmp = 0.5 + r() * 0.7; // 揺らぎの大きさの個人差
  }

  occupies(lane: number): boolean {
    return lane === this.lane || (this.lc.state !== 'none' && lane === this.lc.to);
  }

  // 隣車線にほぼ同速で並走する車両がいるか(車線変更を物理的に塞ぐ「象レース」検知)
  hasDeadlockAlongside(lane: number): boolean {
    const arr = this.world._sec[this.section];
    for (const v of arr) {
      if (v === this || !v.occupies(lane)) continue;
      if (
        Math.abs(wrapDelta(v.z - this.z)) < (this.length + v.length) / 2 + 5 &&
        Math.abs(v.speed - this.speed) < 1.5
      )
        return true;
    }
    return false;
  }

  // 前方車探索（z昇順インデックスを利用。ahead = z が小さい側。周回路として探索）
  findAhead(lane: number): NeighborInfo | null {
    const arr = this.world._sec[this.section];
    for (let i = this._idx - 1; i >= 0; i--) {
      const v = arr[i];
      if (v === this || !v.occupies(lane)) continue;
      if (v.z >= this.z) continue;
      return { v, gap: this.z - v.z - (this.length + v.length) / 2 };
    }
    // 周回: 自分より手前に誰もいなければ、最も奥(z最大)の同一車線車が前方
    for (let i = arr.length - 1; i > this._idx; i--) {
      const v = arr[i];
      if (v === this || !v.occupies(lane)) continue;
      return { v, gap: this.z - v.z + WRAP - (this.length + v.length) / 2 };
    }
    return null;
  }

  findBehind(lane: number): NeighborInfo | null {
    const arr = this.world._sec[this.section];
    for (let i = this._idx + 1; i < arr.length; i++) {
      const v = arr[i];
      if (v === this || !v.occupies(lane)) continue;
      if (v.z < this.z) continue;
      return { v, gap: v.z - this.z - (this.length + v.length) / 2 };
    }
    // 周回: 自分より奥に誰もいなければ、最も手前(z最小)の車が後続
    for (let i = 0; i < this._idx; i++) {
      const v = arr[i];
      if (v === this || !v.occupies(lane)) continue;
      return { v, gap: v.z - this.z + WRAP - (this.length + v.length) / 2 };
    }
    return null;
  }

  // 車線変更先の安全確認: 'safe' | 'hold' | 'danger'
  // 左方向(譲り・キープレフト)は遅い車線へ移るため、要求マージンをやや緩和する
  checkLaneSafetyForChange(toLane: number): 'safe' | 'hold' | 'danger' {
    let result: 'safe' | 'hold' | 'danger' = 'safe';
    const relax = toLane > this.lane ? 0.8 : 1.0;
    const arr = this.world._sec[this.section];
    for (const v of arr) {
      if (v === this || !v.occupies(toLane)) continue;
      const dz = Math.abs(v.z - this.z);
      if (dz > 90) continue;
      if (v.z <= this.z) {
        // 変更先の前方車
        const gap = this.z - v.z - (this.length + v.length) / 2;
        if (gap < 1.5) return 'danger';
        const need = (4 + this.speed * 0.45) * relax;
        if (gap < need) {
          if (v.speed >= this.speed + 1)
            result = 'hold'; // 前方だが自車より速い → 待機
          else return 'danger';
        }
      } else {
        // 変更先の後方車
        const gap = v.z - this.z - (this.length + v.length) / 2;
        if (gap < 1.5) return 'danger';
        const rel = v.speed - this.speed;
        const need = (4 + Math.max(0, rel) * 2.2 + v.speed * 0.22) * relax;
        if (gap < need) {
          if (rel <= -1)
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
    this.lc.state = 'changing';
    this.lc.from = this.lane;
    this.lc.to = toLane;
    this.lc.t = 0;
    this.lc.hold = 0;
    this.lc.checkT = 0.15;
    this.world.stats.changes[this.section]++;
    return true;
  }

  cancelLaneChange(): void {
    if (this.lc.state !== 'cancel') {
      this.lc.state = 'cancel';
      this.world.stats.cancels[this.section]++;
    }
  }

  updateLaneChange(dt: number): void {
    const lc = this.lc,
      C = CONST;
    if (lc.state === 'none') return;
    lc.checkT -= dt;

    if (lc.state === 'changing') {
      lc.t += dt / C.LANE_CHANGE_DURATION;
      if (lc.checkT <= 0) {
        lc.checkT = 0.15;
        const s = this.checkLaneSafetyForChange(lc.to);
        if (s === 'danger') {
          this.cancelLaneChange();
          return;
        }
        if (s === 'hold' && lc.t < 0.3) {
          lc.state = 'holding';
          lc.hold = 0;
        }
      }
      if (lc.t >= 1) {
        lc.t = 1;
        this.lane = lc.to;
        lc.state = 'none';
        this.cooldown = 4.0 + this.world.rng() * 5; // 変更直後は当分しない(面倒・疲れる)
      }
    } else if (lc.state === 'holding') {
      lc.hold += dt;
      if (lc.checkT <= 0) {
        lc.checkT = 0.15;
        const s = this.checkLaneSafetyForChange(lc.to);
        if (s === 'safe') lc.state = 'changing';
        else if (s === 'danger' || lc.hold > C.LANE_CHANGE_WAIT_MAX_DURATION)
          this.cancelLaneChange();
      }
    } else if (lc.state === 'cancel') {
      lc.t -= dt / (C.LANE_CHANGE_DURATION * 0.8);
      if (lc.t <= 0) {
        lc.t = 0;
        lc.state = 'none';
        this.lane = lc.from;
        this.cooldown = C.LANE_CHANGE_RETRY_COOLDOWN;
      }
    }
  }

  decide(ahead: NeighborInfo | null, dt: number): void {
    // 渋滞吸収運転モードでは車線変更なし(単一車線の追従実験と同じ純粋比較)。
    // 車線変更があると吸収運転車の広い車間が追い越しで埋められ、比較が濁る。
    if (this.world.mode === 'absorb') return;
    // 合流(加速車線): 本線の隙間を見つけ次第、走行車線へ入る。
    // 終端が近づくほど、現実のドライバー同様に受け入れる隙間を妥協する
    if (this.lane === 3) {
      const remain = this.z - CONST.RAMP_Z_END;
      const press = clamp(1 - remain / 80, 0, 1);
      const a = this.findAhead(2),
        b = this.findBehind(2);
      const okA = !a || a.gap > (this.speed * 0.45 + 4) * (1 - 0.5 * press);
      const okB = !b || b.gap > Math.max(2.0, (b.v.speed - this.speed) * (1.4 - 0.7 * press) + 2.5);
      if (okA && okB) {
        this.lc.state = 'changing';
        this.lc.from = 3;
        this.lc.to = 2;
        this.lc.t = 0;
        this.lc.hold = 0;
        this.lc.checkT = 0.15;
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
    if (!flowing && this.frust > 0.5 && this.world.rng() < dt / 3) {
      const here = this.findAhead(this.lane);
      const hereGap = here ? here.gap : 999;
      const hereSp = here ? here.v.speed : this.desiredSpeed;
      let bestLane = -1,
        bestScore = 4; // 「明確に良い」時だけ動く
      for (const dl of [1, -1]) {
        // 左(走行車線側)から評価 = 同点なら左へ
        const lane = this.lane + dl;
        if (lane < 0 || lane > 2) continue;
        const a = this.findAhead(lane);
        // 渋滞中の判断は一瞥なので雑(隣の芝生は青く見える): ノイズ込みで評価
        const score =
          ((a ? a.gap : 999) - hereGap) * 0.15 +
          ((a ? a.v.speed : this.desiredSpeed) - hereSp) +
          (this.world.rng() * 2 - 1) * 3;
        if (score > bestScore) {
          bestScore = score;
          bestLane = lane;
        }
      }
      if (bestLane >= 0 && this.tryLaneChange(bestLane)) {
        this.yieldSlowT = 0.6; // 移った直後は体勢を立て直すため少し緩める
        return;
      }
    }
    // (0.5) マイペース派(義務なし区間): 走行車線に縛られず、追い越し車線を
    // 定位置にして自分のペースで巡航する(これが義務なし文化の象徴)
    if (this.camper && this.lane > 0 && flowing) {
      this.keepRightT += dt;
      if (this.keepRightT > 6 && this.tryLaneChange(this.lane - 1)) {
        this.keepRightT = 0;
        return;
      }
    }
    // (1) 「追いつかれた車両の義務」— 義務あり区間のみ: 速い後続車に進路を譲る。
    // ただし現実のドライバー同様、(a)明確に速い車が来た時だけ、(b)移った先でも
    // 自分のペースを保てる時だけ譲る(遅いトラックの直後への自己犠牲はしない)
    if (this.yields && flowing && this.lane < 2) {
      const behind = this.findBehind(this.lane);
      if (behind) {
        const rel = behind.v.speed - this.speed;
        if (rel > 2.5 && behind.gap < 24 + rel * 4.5) {
          const t = this.findAhead(this.lane + 1);
          const okTarget = !t || t.gap > 45 || t.v.speed > this.desiredSpeed - 2;
          if (okTarget && this.tryLaneChange(this.lane + 1)) {
            this.world.stats.yields[this.section]++;
            this.noOvertakeT = 6; // 譲った直後はしばらく追い越しを我慢する
            return;
          }
          // 並走車に塞がれて譲れない(象レース)場合のみ、少し減速して後ろに入る
          if (okTarget && this.hasDeadlockAlongside(this.lane + 1)) this.yieldSlowT = 1.0;
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
        (ahead.v.speed < this.desiredSpeed - 2 || this.speed < this.desiredSpeed * 0.88);
      this.slowAheadT = blockedNow ? this.slowAheadT + dt : 0;
      let want = this.slowAheadT > 3.0 * this.lcAversion * (1 - 0.6 * this.frust);
      // 吸収運転車は車線を維持して波を吸収する。よほど遅くない限り追い越さない
      if (want && this.absorber && this.speed > this.desiredSpeed * 0.55) want = false;
      // 移った先が今より悪ければ追い越さない(渋滞した追い越し車線へは突っ込まない)
      if (want && ahead) {
        const t = this.findAhead(this.lane - 1);
        if (t && t.v.speed < ahead.v.speed + 1 && t.gap < ahead.gap + 10) want = false;
      }
      if (want && this.noOvertakeT > 0) {
        // 我慢中はよほど詰まらない限り追い越さない(譲り→追い越しの往復を防ぐ)
        want =
          !!ahead && ahead.gap < 12 + this.speed * 0.5 && ahead.v.speed < this.desiredSpeed - 5;
      }
      if (want && this.tryLaneChange(this.lane - 1)) return;
    }
    // (3) 追い越し車線からの復帰 — 両区間共通だが、復帰の早さは気質 (returnTime) で異なる
    if (this.lane === 0) {
      const slowAhead = ahead && ahead.gap < 55 && ahead.v.speed < this.desiredSpeed - 1;
      if (!slowAhead) this.returnTimer += dt;
      else this.returnTimer = 0;
      if (this.returnTimer > this.returnTime && flowing) {
        if (this.tryLaneChange(1)) this.returnTimer = 0;
        else if (this.section === 'L' && this.hasDeadlockAlongside(1)) this.yieldSlowT = 1.0;
      }
      this.keepLeftTimer = 0;
    } else if (this.keepLeft && flowing && this.lane === 1) {
      // (4) キープレフト — 義務あり区間のみ: 空いていれば走行車線へ寄る
      this.returnTimer = 0;
      // 70m先まで見て、自分のペースで走れる場合だけ走行車線へ寄る(トラック隊列の罠を回避)
      const leftAhead = this.findAhead(2);
      const leftClear =
        !leftAhead || leftAhead.gap > 70 || leftAhead.v.speed > this.desiredSpeed - 1;
      const notBlocked = !ahead || ahead.gap > 22;
      if (leftClear && notBlocked) {
        this.keepLeftTimer += dt;
        if (this.keepLeftTimer > 2.0 && this.tryLaneChange(2)) {
          this.keepLeftTimer = 0;
          this.noOvertakeT = 2;
        }
      } else {
        this.keepLeftTimer = 0;
      }
    } else {
      this.returnTimer = 0;
      this.keepLeftTimer = 0;
    }
  }

  update(dt: number): void {
    const C = CONST;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.noOvertakeT = Math.max(0, this.noOvertakeT - dt);
    this.yieldSlowT = Math.max(0, this.yieldSlowT - dt);
    this.updateLaneChange(dt);

    // --- 衝突回避: 前方車両追従 ---
    let ahead = this.findAhead(this.lane);
    if (this.lc.state !== 'none') {
      const a2 = this.findAhead(this.lc.to);
      if (a2 && (!ahead || a2.gap < ahead.gap)) ahead = a2;
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
      this.frust = clamp(this.frust + (blocked ? dt / 10 : -dt / 5), 0, 1);
      // ペダル操作の揺らぎ: 人間は一定速度を保てない。この小さな揺らぎが
      // 長い隊列の中で増幅され、渋滞の波の「種」になる(dt非依存のOU過程)
      this.noise +=
        -1.2 * this.noise * dt + (this.world.rng() * 2 - 1) * this.noiseAmp * 1.7 * Math.sqrt(dt);
    }
    const frust = this.frust;
    // サグ部(上り坂): 通常ドライバーは無意識に減速し、渋滞の種を作る
    let desire = this.desiredSpeed;
    if (isAbsorbMode && this.z > CONST.SAG_Z_MIN && this.z < CONST.SAG_Z_MAX) {
      desire *= this.absorber ? CONST.SAG_SLOWDOWN_ABSORBER : CONST.SAG_SLOWDOWN;
    }
    let ts = this.yieldSlowT > 0 ? Math.max(8, desire - 2.5) : desire;
    // 加速車線: 終端で止まれる速度に常に制限(合流できなければ端で待つ)
    if (this.lane === 3 || (this.lc.state !== 'none' && this.lc.from === 3 && this.lc.t < 0.5)) {
      const remain = Math.max(0, this.z - CONST.RAMP_Z_END);
      ts = Math.min(ts, Math.sqrt(2 * 3.5 * Math.max(0, remain - 3)));
    }
    let reqDec = 0; // 衝突回避に物理的に必要な減速度
    if (ahead) {
      // 安全車間サーボ。苛立つほど車間を詰める(詰めた分だけ波に弱くなる)
      const hwF = this.absorber ? 1 : this.headwayF * (1 - 0.35 * frust);
      const safeDist = this.length * 1.2 + 2.5 + this.speed * 0.55 * hwF;
      const emergencyGap = this.length * 0.5 + 1.4;
      const rel = this.speed - ahead.v.speed;
      if (rel > 0) {
        reqDec = (rel * rel) / (2 * Math.max(0.5, ahead.gap - emergencyGap));
      }
      // 人間ドライバー: 前方車の速度変化に気づくまで知覚の遅れがある。
      // この遅れが車間サーボを通じて波を増幅する(渋滞波の標準的な発生機構)。
      // 物理的に強い減速が必要な場面は下の実値オーバーライドが即座に介入する
      let aSpeed = ahead.v.speed;
      if (isHuman) {
        this.percT -= dt;
        if (this.percT <= 0) {
          this.percT = this.reaction;
          this.percSpeed = ahead.v.speed;
        }
        aSpeed = this.percSpeed;
      }
      // ウインカーを出して車線変更中の車への反応: 自分と同等以上の速度で入って
      // くる車には減速は不要(車間は開いていく)。遅い車が目の前に割り込む場合
      // だけ実ブレーキを強いられる — 渋滞中の乗り換えが渋滞を悪化させる理由
      const predictable =
        ahead.v.lc.state !== 'none' &&
        (ahead.v.speed >= this.speed - 0.5 || ahead.gap > this.speed * 0.5 + 4);
      const gain = this.absorber || predictable ? 0.6 : this.gainF * (1 + 0.5 * frust);
      if (ahead.gap < emergencyGap) {
        // 貫通防止: 緊急ブレーキ
        ts = 0;
        this.emergency = true;
      } else if (ahead.gap < safeDist) {
        ts = Math.min(ts, Math.max(0, aSpeed + (ahead.gap - safeDist) * gain));
      } else if (reqDec > 4) {
        // 車間はあるが接近が速すぎる場合も減速
        ts = Math.min(ts, ahead.v.speed);
      }
      // 知覚が遅れていても、物理的に強い減速が必要なら実値で介入(安全は知覚に依存しない)
      if (!this.emergency && reqDec > 3.5) ts = Math.min(ts, ahead.v.speed);
      // ===== ブレーキランプ連鎖(実渋滞の主因) =====
      // 前のブレーキ灯を見たら、車間に余裕があっても身構えてアクセルを抜き、
      // 前車より少し下まで速度を落とす。この過剰反応が後ろへ行くほど波を増幅し、
      // 先頭では誰も悪くないのに後方は完全停止する「幽霊渋滞」になる。
      // ただし自分の方が既に遅い場合(譲りのカットイン等)は身構えるだけで踏まない
      if (
        isHuman &&
        !this.emergency &&
        !predictable &&
        ahead.v.chainSig &&
        rel > -0.5 &&
        ahead.gap < this.speed * this.chainF + 8
      ) {
        ts = Math.min(ts, Math.max(0, ahead.v.speed - (0.5 + 2.5 * frust)));
      }
      // ===== 渋滞吸収運転: 下流の「平均ペース」で定速走行し、波に乗らない =====
      // 前方の振動(0⇔20km/h等)に追従せず平均速度で淡々と走る。広い車間が
      // 振動を吸収するバッファになり、後続には滑らかな速度だけが伝わる。
      if (this.absorber) {
        // 非対称な平均化: 前方の減速にはすぐ乗らず(波を吸収)、回復には素早く追従する
        const tau =
          ahead.v.speed > this.anticip ? CONST.ABSORBER_RECOVER : CONST.ABSORBER_ANTICIPATION;
        this.anticip += (ahead.v.speed - this.anticip) * Math.min(1, dt / tau);
        const wantGap = this.length * 1.2 + 2.5 + this.speed * 0.55 * CONST.ABSORBER_HEADWAY;
        const bias = ahead.gap < wantGap ? CONST.ABSORBER_PACE_BIAS : 0; // バッファ構築
        ts = Math.min(ts, Math.max(0, this.anticip - bias));
      }
    } else if (this.absorber) {
      this.anticip += (desire - this.anticip) * Math.min(1, dt / CONST.ABSORBER_ANTICIPATION);
    }
    this.targetSpeed = ts;
    // ペダル揺らぎの適用(緊急時を除く)。自由走行では自然な速度の波打ちに、
    // 密な追従では後続が増幅する小さな乱れになる
    if (isHuman && !this.emergency) ts = Math.max(0, ts + this.noise);
    // よそ見ブレーキ(渋滞のきっかけ): 本人の意思とは無関係に減速する
    if (this.perturbT > 0) {
      this.perturbT -= dt;
      ts = Math.min(ts, this.desiredSpeed * CONST.PERTURB_FACTOR);
      this.targetSpeed = ts;
    }
    const diff = ts - this.speed;
    if (diff > 0) {
      this.lampDec = 0;
      if (isHuman && this.accT < this.lagF) {
        this.accT += dt; // 再加速の出遅れ: 前が動いてもすぐには踏まない(渋滞先頭の容量低下)
      } else {
        // 吸収運転は加速も滑らか(波を下流に作らない)
        const acc = this.absorber ? this.type.acc * 0.6 : this.type.acc;
        this.speed = Math.min(ts, this.speed + acc * dt);
      }
    } else {
      if (isHuman && diff < -1.0) this.accT = 0; // 減速したら次の再加速はまた出遅れる
      // 必要減速度に応じてブレーキ強度を可変に。前方車要因がない自発的な減速
      // (譲りのための速度調整など)はエンジンブレーキ程度に緩やかにする
      const volDec = isHuman ? 9 : 3.5; // 人間はアクセルオフも雑(波を増幅)
      const brakeAmp = isHuman ? CONST.HUMAN_BRAKE_AMP : 1.4; // ブレーキの踏みすぎ
      const brakeMin = isHuman ? 12 : 9;
      let dec = this.emergency
        ? 30
        : reqDec > 0.5
          ? clamp(reqDec * brakeAmp, brakeMin, 30)
          : volDec;
      if (this.perturbT > 0) dec = Math.max(dec, 9); // よそ見ブレーキは全員同じ強さ(公平)
      // 急ブレーキを踏んだら後続への警告にハザードを焚く
      if (dec >= 14 && this.speed > 8) this.hazardT = 2.5;
      this.lampDec = dec;
      this.speed = Math.max(Math.max(0, ts), this.speed - dec * dt);
    }
    // 連鎖反応(力学)用の瞬時信号は従来どおり
    this.chainSig = diff < -1.5 || this.emergency;
    // ブレーキ灯(見た目): 実際にブレーキ相当の減速をしている時だけ点け、点いたら
    // 最低0.7秒は保持する。人間の踏み替えは秒オーダーで、チラつき(パカパカ)はしない
    const pressing = this.emergency || (this.lampDec >= 5 && diff < -1.0);
    this.brakeHold = pressing ? 0.7 : Math.max(0, this.brakeHold - dt);
    this.braking = pressing || this.brakeHold > 0;

    this.z -= this.speed * dt;

    // --- 意思決定 ---
    if (this.lc.state === 'none' && this.cooldown <= 0) this.decide(ahead, dt);

    // --- ハザード: 急ブレーキ直後、および停止列の最後尾で後続に知らせる(日本の習慣)。
    //     後続が近くまで来て減速し終えたら消す ---
    this.hazardT = Math.max(0, this.hazardT - dt);
    let queueTail = false;
    if (this.speed < 2.5) {
      const b = this.findBehind(this.lane);
      queueTail = !b || b.gap > 30 || b.v.speed > 6;
    }
    this.hazard = queueTail || this.hazardT > 0;

    // --- 周回路: 手前端まで来たら反対側へ連続的に回り込む(波は継ぎ目なく通過) ---
    if (this.z < -C.ROAD_HALF - 8) this.z += WRAP;

    this.updateX();
  }

  updateX(): void {
    const lx = CONST.LANE_X[this.section],
      lc = this.lc;
    if (lc.state !== 'none') {
      this.x = lerp(lx[lc.from], lx[lc.to], smooth(clamp(lc.t, 0, 1)));
    } else {
      this.x = lx[this.lane];
    }
  }
}

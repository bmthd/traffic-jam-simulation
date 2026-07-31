import { CONST } from './constants';
import { clamp } from './utils';
import type { NeighborInfo, Vehicle } from './vehicle';

export class LongitudinalController {
  constructor(private readonly vehicle: Vehicle) {}

  update(deltaTime: number): NeighborInfo | null {
    // --- 衝突回避: 前方車両追従 ---
    let ahead = this.vehicle.findAhead(this.vehicle.lane);
    if (this.vehicle.laneChange.state !== 'none') {
      const targetLaneAhead = this.vehicle.findAhead(this.vehicle.laneChange.to);
      if (targetLaneAhead && (!ahead || targetLaneAhead.gap < ahead.gap)) ahead = targetLaneAhead;
    }
    this.vehicle.emergency = false;
    const isAbsorbMode = this.vehicle.world.mode === 'absorb';
    const isHuman = !this.vehicle.absorber; // 吸収運転車以外は全員「人間」(全モード共通)
    // 苛立ち: 希望速度よりずっと遅い状態が続くと車間を詰め、反応も荒くなる。
    // マイペース車に塞がれ続ける側ほど運転が荒れ、渋滞の波が生まれやすくなる
    if (isHuman) {
      // 苛立ちは「動けてはいるが遅い」帯域でのみ蓄積する。ノロノロ運転まで
      // 落ちると諦めて穏やかになる(これが渋滞の自己固定ループを解き、
      // 渋滞が「解けるべき条件では解ける」ようになる)
      const ratio = this.vehicle.speed / this.vehicle.desiredSpeed;
      const blocked = ratio < 0.8 && ratio > 0.3;
      this.vehicle.frustration = clamp(
        this.vehicle.frustration + (blocked ? deltaTime / 10 : -deltaTime / 5),
        0,
        1,
      );
      // ペダル操作の揺らぎ: 人間は一定速度を保てない。この小さな揺らぎが
      // 長い隊列の中で増幅され、渋滞の波の「種」になる(dt非依存のOU過程)
      this.vehicle.noise +=
        -1.2 * this.vehicle.noise * deltaTime +
        (this.vehicle.world.rng() * 2 - 1) *
          this.vehicle.noiseAmplitude *
          1.7 *
          Math.sqrt(deltaTime);
    }
    const frustration = this.vehicle.frustration;
    // サグ部(上り坂): 通常ドライバーは無意識に減速し、渋滞の種を作る
    let desire = this.vehicle.desiredSpeed;
    if (isAbsorbMode && this.vehicle.z > CONST.SAG_Z_MIN && this.vehicle.z < CONST.SAG_Z_MAX) {
      desire *= this.vehicle.absorber ? CONST.SAG_SLOWDOWN_ABSORBER : CONST.SAG_SLOWDOWN;
    }
    // 加速復帰中は希望速度を一時的に上乗せして並走車の前に出る(上限 RETURN_BOOST_SPEED_DELTA)。
    // 前方車への追従・緊急ブレーキはこの後の通常ロジックがそのまま制限するため安全は保たれる
    if (this.vehicle.returnBoostTimer > 0) desire += CONST.RETURN_BOOST_SPEED_DELTA;
    let targetSpeed = this.vehicle.yieldSlowTimer > 0 ? Math.max(8, desire - 2.5) : desire;
    let mergeArrivalDecel = 0;
    let mergeArrivalLimited = false;
    if (
      this.vehicle.lane === 3 &&
      this.vehicle.mergePlan.state !== 'queued' &&
      this.vehicle.mergePlan.targetPassTime > this.vehicle.world.time
    ) {
      const time = this.vehicle.mergePlan.targetPassTime - this.vehicle.world.time;
      const mergeSpeed = Math.max(1, (this.vehicle.z - CONST.MERGE_POINT_Z) / time);
      const reservedSlot = this.vehicle.projectReservedMergeSlot(this.vehicle.mergePlan);
      mergeArrivalLimited = reservedSlot !== null;
      const keepsReservedArrivalBeforeCommit =
        (this.vehicle.mergePlan.state === 'seeking' ||
          this.vehicle.mergePlan.state === 'coordinating') &&
        (this.vehicle.mergePlan.rear === null || this.vehicle.mergePlan.nextSource === 'main') &&
        reservedSlot !== null;
      if (keepsReservedArrivalBeforeCommit) {
        const frontSpeedLimit = reservedSlot.front
          ? reservedSlot.frontGap /
            this.vehicle.mergeHeadways(this.vehicle.mergePlan.congestion).front
          : Infinity;
        const arrivalSpeed = Math.max(1, Math.min(mergeSpeed, frontSpeedLimit));
        const timeToCommitDeadline = Math.max(
          (this.vehicle.z - this.vehicle.latestMergeCommitZ()) / Math.max(this.vehicle.speed, 1) -
            deltaTime,
          deltaTime,
        );
        // commit は移動前に評価するため1 step手前を期限とし、予約時刻との早い方までに
        // 到着速度へ合わせる。必要減速度は既存上限を越えない
        mergeArrivalDecel = clamp(
          (this.vehicle.speed - arrivalSpeed) / Math.min(time, timeToCommitDeadline),
          0,
          CONST.MERGE_MAX_COOP_DECEL,
        );
        targetSpeed = Math.min(targetSpeed, arrivalSpeed);
      } else targetSpeed = Math.min(targetSpeed, Math.max(this.vehicle.speed, mergeSpeed));
    }
    let mergeCooperationLimited = false;
    if (this.vehicle.mergeCooperationTarget !== null) {
      const remaining = Math.max(
        this.vehicle.mergeCooperationTarget - this.vehicle.world.time,
        deltaTime,
      );
      const cooperativeSpeed = Math.max(0, (this.vehicle.z - CONST.MERGE_POINT_Z) / remaining);
      mergeCooperationLimited = cooperativeSpeed < targetSpeed;
      targetSpeed = Math.min(targetSpeed, cooperativeSpeed);
    }
    let requiredDecel = 0; // 衝突回避に物理的に必要な減速度
    if (ahead) {
      // 安全車間サーボ。苛立つほど車間を詰める(詰めた分だけ波に弱くなる)
      const effectiveHeadway = this.vehicle.absorber
        ? 1
        : this.vehicle.headwayFactor * (1 - 0.35 * frustration);
      const safeDistance =
        this.vehicle.length * 1.2 + 2.5 + this.vehicle.speed * 0.55 * effectiveHeadway;
      const emergencyGap = this.vehicle.length * 0.5 + 1.4;
      const relativeSpeed = this.vehicle.speed - ahead.vehicle.speed;
      if (relativeSpeed > 0) {
        requiredDecel =
          (relativeSpeed * relativeSpeed) / (2 * Math.max(0.5, ahead.gap - emergencyGap));
      }
      // 人間ドライバー: 前方車の速度変化に気づくまで知覚の遅れがある。
      // この遅れが車間サーボを通じて波を増幅する(渋滞波の標準的な発生機構)。
      // 物理的に強い減速が必要な場面は下の実値オーバーライドが即座に介入する
      let aheadSpeed = ahead.vehicle.speed;
      if (isHuman) {
        this.vehicle.perceptionTimer -= deltaTime;
        if (this.vehicle.perceptionTimer <= 0) {
          this.vehicle.perceptionTimer = this.vehicle.reactionTime;
          this.vehicle.perceivedSpeed = ahead.vehicle.speed;
        }
        aheadSpeed = this.vehicle.perceivedSpeed;
      }
      // ウインカーを出して車線変更中の車への反応: 自分と同等以上の速度で入って
      // くる車には減速は不要(車間は開いていく)。遅い車が目の前に割り込む場合
      // だけ実ブレーキを強いられる — 渋滞中の乗り換えが渋滞を悪化させる理由
      const predictable =
        ahead.vehicle.laneChange.state !== 'none' &&
        (ahead.vehicle.speed >= this.vehicle.speed - 0.5 ||
          ahead.gap > this.vehicle.speed * 0.5 + 4);
      const gain =
        this.vehicle.absorber || predictable
          ? 0.6
          : this.vehicle.followGain * (1 + 0.5 * frustration);
      if (ahead.gap < emergencyGap) {
        // 貫通防止: 緊急ブレーキ
        targetSpeed = 0;
        this.vehicle.emergency = true;
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
      if (!this.vehicle.emergency && requiredDecel > 3.5)
        targetSpeed = Math.min(targetSpeed, ahead.vehicle.speed);
      // ===== ブレーキランプ連鎖(実渋滞の主因) =====
      // 前のブレーキ灯を見たら、車間に余裕があっても身構えてアクセルを抜き、
      // 前車より少し下まで速度を落とす。この過剰反応が後ろへ行くほど波を増幅し、
      // 先頭では誰も悪くないのに後方は完全停止する「幽霊渋滞」になる。
      // ただし自分の方が既に遅い場合(譲りのカットイン等)は身構えるだけで踏まない
      if (
        isHuman &&
        !this.vehicle.emergency &&
        !predictable &&
        ahead.vehicle.brakeChainSignal &&
        relativeSpeed > -0.5 &&
        ahead.gap < this.vehicle.speed * this.vehicle.brakeChainFactor + 8
      ) {
        targetSpeed = Math.min(
          targetSpeed,
          Math.max(0, ahead.vehicle.speed - (0.5 + 2.5 * frustration)),
        );
      }
      // ===== 渋滞吸収運転: 下流の「平均ペース」で定速走行し、波に乗らない =====
      // 前方の振動(0⇔20km/h等)に追従せず平均速度で淡々と走る。広い車間が
      // 振動を吸収するバッファになり、後続には滑らかな速度だけが伝わる。
      if (this.vehicle.absorber) {
        // 非対称な平均化: 前方の減速にはすぐ乗らず(波を吸収)、回復には素早く追従する
        const timeConstant =
          ahead.vehicle.speed > this.vehicle.anticipatedSpeed
            ? CONST.ABSORBER_RECOVER
            : CONST.ABSORBER_ANTICIPATION;
        this.vehicle.anticipatedSpeed +=
          (ahead.vehicle.speed - this.vehicle.anticipatedSpeed) *
          Math.min(1, deltaTime / timeConstant);
        const desiredGap =
          this.vehicle.length * 1.2 + 2.5 + this.vehicle.speed * 0.55 * CONST.ABSORBER_HEADWAY;
        const paceBias = ahead.gap < desiredGap ? CONST.ABSORBER_PACE_BIAS : 0; // バッファ構築
        targetSpeed = Math.min(targetSpeed, Math.max(0, this.vehicle.anticipatedSpeed - paceBias));
      }
    } else if (this.vehicle.absorber) {
      this.vehicle.anticipatedSpeed +=
        (desire - this.vehicle.anticipatedSpeed) *
        Math.min(1, deltaTime / CONST.ABSORBER_ANTICIPATION);
    }
    this.vehicle.targetSpeed = targetSpeed;
    // ペダル揺らぎの適用(緊急時を除く)。自由走行では自然な速度の波打ちに、
    // 密な追従では後続が増幅する小さな乱れになる
    if (isHuman && !this.vehicle.emergency)
      targetSpeed = Math.max(0, targetSpeed + this.vehicle.noise);
    // よそ見ブレーキ(渋滞のきっかけ): 本人の意思とは無関係に減速する
    if (this.vehicle.perturbTimer > 0) {
      this.vehicle.perturbTimer -= deltaTime;
      targetSpeed = Math.min(targetSpeed, this.vehicle.desiredSpeed * CONST.PERTURB_FACTOR);
      this.vehicle.targetSpeed = targetSpeed;
    }
    const speedDiff = targetSpeed - this.vehicle.speed;
    if (speedDiff > 0) {
      this.vehicle.lampDeceleration = 0;
      if (isHuman && this.vehicle.accelDelayTimer < this.vehicle.accelLagDuration) {
        this.vehicle.accelDelayTimer += deltaTime; // 再加速の出遅れ: 前が動いてもすぐには踏まない(渋滞先頭の容量低下)
      } else {
        // 吸収運転は加速も滑らか(波を下流に作らない)
        const acceleration = this.vehicle.absorber
          ? this.vehicle.type.acceleration * 0.6
          : this.vehicle.type.acceleration;
        this.vehicle.speed = Math.min(targetSpeed, this.vehicle.speed + acceleration * deltaTime);
      }
    } else {
      if (isHuman && speedDiff < -1.0) this.vehicle.accelDelayTimer = 0; // 減速したら次の再加速はまた出遅れる
      // 必要減速度に応じてブレーキ強度を可変に。前方車要因がない自発的な減速
      // (譲りのための速度調整など)はエンジンブレーキ程度に緩やかにする
      const voluntaryDecel = isHuman ? 9 : 3.5; // 人間はアクセルオフも雑(波を増幅)
      const brakeAmp = isHuman ? CONST.HUMAN_BRAKE_AMP : 1.4; // ブレーキの踏みすぎ
      const minBrakeDecel = isHuman ? 12 : 9;
      let decel = this.vehicle.emergency
        ? 30
        : requiredDecel > 0.5
          ? clamp(requiredDecel * brakeAmp, minBrakeDecel, 30)
          : voluntaryDecel;
      if (mergeArrivalLimited && requiredDecel <= 0.5)
        decel =
          mergeArrivalDecel > 0 ? mergeArrivalDecel : Math.min(decel, CONST.MERGE_MAX_COOP_DECEL);
      if (mergeCooperationLimited && requiredDecel <= 0.5)
        decel = this.vehicle.mergeCooperationDecel;
      if (this.vehicle.perturbTimer > 0) decel = Math.max(decel, 9); // よそ見ブレーキは全員同じ強さ(公平)
      // 急ブレーキを踏んだら後続への警告にハザードを焚く
      if (decel >= 14 && this.vehicle.speed > 8) this.vehicle.hazardTimer = 2.5;
      this.vehicle.lampDeceleration = decel;
      this.vehicle.speed = Math.max(
        Math.max(0, targetSpeed),
        this.vehicle.speed - decel * deltaTime,
      );
    }
    // 連鎖反応(力学)用の瞬時信号は従来どおり
    this.vehicle.brakeChainSignal = speedDiff < -1.5 || this.vehicle.emergency;
    // ブレーキ灯(見た目): 実際にブレーキ相当の減速をしている時だけ点け、点いたら
    // 最低0.7秒は保持する。人間の踏み替えは秒オーダーで、チラつき(パカパカ)はしない
    const pressing =
      this.vehicle.emergency || (this.vehicle.lampDeceleration >= 5 && speedDiff < -1.0);
    this.vehicle.brakeLampHold = pressing
      ? 0.7
      : Math.max(0, this.vehicle.brakeLampHold - deltaTime);
    this.vehicle.braking = pressing || this.vehicle.brakeLampHold > 0;

    return ahead;
  }

  updateHazard(deltaTime: number): void {
    // --- ハザード: 急ブレーキ直後、および停止列の最後尾で後続に知らせる(日本の習慣)。
    //     後続が近くまで来て減速し終えたら消す ---
    this.vehicle.hazardTimer = Math.max(0, this.vehicle.hazardTimer - deltaTime);
    let queueTail = false;
    if (this.vehicle.speed < 2.5) {
      const behind = this.vehicle.findBehind(this.vehicle.lane);
      queueTail = !behind || behind.gap > 30 || behind.vehicle.speed > 6;
    }
    this.vehicle.hazard = queueTail || this.vehicle.hazardTimer > 0;
  }
}

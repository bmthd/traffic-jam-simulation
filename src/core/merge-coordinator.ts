import {
  CONST,
  FACILITY_SPACING,
  facilityWorldZ,
  nextFacilityWorldZ,
  toFacilityLocalZ,
} from './constants';
import {
  buildMergeDependencyClosure,
  mergeClosureTerminalSpeeds,
  mergeTransactionStepDuration,
  quantizeMergeDuration,
} from './merge-transaction';
import { clamp, lerp, wrapDelta } from './utils';
import type {
  MergeCertificate,
  MergeDirective,
  MergePlan,
  MergeSource,
  MergeState,
  ProjectedMergeSlot,
  SpeedEnvelope,
  Vehicle,
  VehicleSnapshot,
  WorldSnapshot,
} from './vehicle';

export function nextArrivalDistance(z: number, mergeZ: number): number {
  return (((z - mergeZ) % FACILITY_SPACING) + FACILITY_SPACING) % FACILITY_SPACING;
}

export function smoothstepRange(a: number, b: number, value: number): number {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function mergeCongestion(
  mainPace: number,
  mainDesiredPace: number,
  mainGap: number,
  safeGap: number,
): number {
  const speedRatio = mainPace / Math.max(mainDesiredPace, 1);
  const gapRatio = mainGap / Math.max(safeGap, 0.1);
  const speedCongestion = 1 - smoothstepRange(0.35, 0.75, speedRatio);
  const gapCongestion = 1 - smoothstepRange(0.8, 1.8, gapRatio);
  return clamp(0.65 * speedCongestion + 0.35 * gapCongestion, 0, 1);
}

export class MergeCoordinator {
  constructor(private readonly vehicle: Vehicle) {}

  mergeHeadways(congestion: number): { front: number; rear: number } {
    const ratio = clamp(congestion, 0, 1);
    const interpolate = (free: number): number =>
      Number((free + (CONST.MERGE_CONGESTED_HEADWAY - free) * ratio).toFixed(12));
    return {
      front: interpolate(CONST.MERGE_FREE_FRONT_HEADWAY),
      rear: interpolate(CONST.MERGE_FREE_REAR_HEADWAY),
    };
  }

  /**
   * 読み取り専用 snapshot から、入口待ちランプ車の入場可能性を証明する。
   * 直近の前後車だけを wrapped ETA で選ぶため、周回後の遠隔車は枠に混ぜない。
   */
  evaluateEntryCertificate(snapshot: WorldSnapshot, deltaTime = 1 / 20): MergeCertificate | null {
    const ramp = snapshot.vehicles.find((vehicle) => vehicle.order === this.vehicle.spawnOrder);
    if (!ramp || !ramp.waiting || ramp.lane !== 3) return null;

    const bodySafeCompletionZ = facilityWorldZ(
      CONST.GORE_Z_START + ramp.length / 2 + CONST.MERGE_BODY_CLEARANCE,
      ramp.z,
    );
    // 合流点は導流帯の手前にあり、ここで車線変更を完了できれば車体も安全側に残る。
    const completionZ = Math.max(facilityWorldZ(CONST.MERGE_POINT_Z, ramp.z), bodySafeCompletionZ);
    const distance = ramp.z - completionZ;
    if (distance <= 0) return null;

    const acceleration = Math.max(this.vehicle.type.acceleration, 0.1);
    const cruiseSpeed = Math.max(ramp.speed, ramp.desiredSpeed, 1);
    const accelerationTime = Math.max(0, (cruiseSpeed - ramp.speed) / acceleration);
    const accelerationDistance =
      ramp.speed * accelerationTime + 0.5 * acceleration * accelerationTime ** 2;
    const continuousEta =
      distance <= accelerationDistance
        ? (-ramp.speed + Math.sqrt(ramp.speed ** 2 + 2 * acceleration * distance)) / acceleration
        : accelerationTime + (distance - accelerationDistance) / cruiseSpeed;
    if (!Number.isFinite(continuousEta) || continuousEta < CONST.LANE_CHANGE_DURATION) return null;
    const eta = quantizeMergeDuration(continuousEta, deltaTime);

    const envelope: SpeedEnvelope = {
      min: Math.max(0, ramp.speed - CONST.MERGE_MAX_COOP_DECEL * eta),
      max: Math.min(ramp.desiredSpeed, ramp.speed + acceleration * eta),
    };
    if (envelope.min > envelope.max) return null;

    const occupiesLane2 = (vehicle: VehicleSnapshot): boolean =>
      vehicle.lane === 2 || (vehicle.laneChange.state !== 'none' && vehicle.laneChange.to === 2);
    const arrivals = snapshot.vehicles
      .filter(
        (vehicle) =>
          vehicle.order !== ramp.order &&
          !vehicle.waiting &&
          vehicle.section === ramp.section &&
          occupiesLane2(vehicle) &&
          Math.abs(
            wrapDelta(nextFacilityWorldZ(toFacilityLocalZ(completionZ), vehicle.z) - completionZ),
          ) < 1e-9,
      )
      .map((vehicle) => ({
        vehicle,
        eta: nextArrivalDistance(vehicle.z, completionZ) / Math.max(vehicle.speed, 1),
      }))
      .sort((a, b) => a.eta - b.eta || a.vehicle.order - b.vehicle.order);
    const rearIndex = arrivals.findIndex((arrival) => arrival.eta > eta);
    const front = rearIndex < 0 ? arrivals.at(-1) : arrivals[rearIndex - 1];
    const rear = rearIndex < 0 ? null : arrivals[rearIndex];
    const frontGap = front
      ? (eta - front.eta) * front.vehicle.speed - (front.vehicle.length + ramp.length) / 2
      : Infinity;
    const rearGap = rear
      ? (rear.eta - eta) * rear.vehicle.speed - (rear.vehicle.length + ramp.length) / 2
      : Infinity;
    const headways = this.vehicle.mergeHeadways(0);
    if (frontGap < headways.front * envelope.max) return null;

    let cooperation: MergeCertificate['cooperation'] = null;
    if (rear) {
      const requiredRearGap = headways.rear * rear.vehicle.speed;
      const gapDecel = (2 * Math.max(0, requiredRearGap - rearGap)) / Math.max(eta ** 2, 0.01);
      const ttcDecel = Math.max(
        0,
        (rear.vehicle.speed - envelope.max - rearGap / 4) / Math.max(eta + eta ** 2 / 8, 0.01),
      );
      const decel = Math.max(gapDecel, ttcDecel);
      const projectedRearGap = rearGap + 0.5 * decel * eta ** 2;
      const projectedRearSpeed = rear.vehicle.speed - decel * eta;
      const rearClosingTtc =
        projectedRearSpeed > envelope.max
          ? projectedRearGap / (projectedRearSpeed - envelope.max)
          : Infinity;
      if (
        decel > CONST.MERGE_MAX_COOP_DECEL ||
        projectedRearSpeed < 0 ||
        projectedRearGap < requiredRearGap ||
        rearClosingTtc < 4
      )
        return null;
      if (decel > 0) cooperation = { rearOrder: rear.vehicle.order, decel };
    }

    const roots = [front?.vehicle.order, rear?.vehicle.order, cooperation?.rearOrder].filter(
      (order, index, all): order is number => order !== undefined && all.indexOf(order) === index,
    );
    const closureResult = buildMergeDependencyClosure(
      snapshot,
      ramp.section,
      roots,
      snapshot.time + eta,
    );
    if (!closureResult.ok) return null;

    return {
      rampOrder: ramp.order,
      frontOrder: front?.vehicle.order ?? null,
      rearOrder: rear?.vehicle.order ?? null,
      targetPassTime: snapshot.time + eta,
      completionZ,
      envelope,
      cooperation,
      closure: closureResult.closure,
    };
  }

  /** 証明済み予約を snapshot 上で投影し、空でない速度回廊だけを返す。 */
  projectReservation(
    snapshot: WorldSnapshot,
    plan: MergePlan,
    deltaTime: number,
  ): MergeDirective | null {
    const certificate = plan.certificate;
    const ramp = snapshot.vehicles.find((vehicle) => vehicle.order === this.vehicle.spawnOrder);
    if (!certificate || !ramp || ramp.waiting || ramp.lane !== 3) return null;
    const remaining = certificate.targetPassTime - snapshot.time;
    const stepDuration = mergeTransactionStepDuration(
      snapshot.time,
      certificate.targetPassTime,
      deltaTime,
    );
    const bodySafeCompletionZ = facilityWorldZ(
      CONST.GORE_Z_START + ramp.length / 2 + CONST.MERGE_BODY_CLEARANCE,
      ramp.z,
    );
    if (stepDuration === null || certificate.completionZ < bodySafeCompletionZ) return null;
    const resolve = (order: number | null): VehicleSnapshot | null =>
      order === null
        ? null
        : (snapshot.vehicles.find((vehicle) => vehicle.order === order) ?? null);
    const front = resolve(certificate.frontOrder);
    const rear = resolve(certificate.rearOrder);
    const cooperator = resolve(certificate.cooperation?.rearOrder ?? null);
    if (
      (certificate.frontOrder !== null && !front) ||
      (certificate.rearOrder !== null && !rear) ||
      (certificate.cooperation !== null && !cooperator)
    )
      return null;
    const cooperation = certificate.cooperation;
    const terminalSpeeds = mergeClosureTerminalSpeeds(snapshot, certificate);
    const frontGap = front
      ? -(
          wrapDelta(front.z - certificate.completionZ) -
          0.5 * (front.speed + (terminalSpeeds.get(front.order) ?? front.speed)) * remaining
        ) -
        (front.length + ramp.length) / 2
      : Infinity;
    const rearGap = rear
      ? nextArrivalDistance(rear.z, certificate.completionZ) -
        0.5 * (rear.speed + (terminalSpeeds.get(rear.order) ?? rear.speed)) * remaining -
        (rear.length + ramp.length) / 2
      : Infinity;
    const rearSpeed = rear ? (terminalSpeeds.get(rear.order) ?? rear.speed) : 0;
    const rearTtc =
      rear && rearSpeed > certificate.envelope.max
        ? rearGap / (rearSpeed - certificate.envelope.max)
        : Infinity;
    const envelope: SpeedEnvelope = {
      min: Math.max(
        certificate.envelope.min,
        ramp.speed - CONST.MERGE_MAX_COOP_DECEL * stepDuration,
      ),
      max: Math.min(
        certificate.envelope.max,
        ramp.speed + this.vehicle.type.acceleration * stepDuration,
      ),
    };
    const headways = this.vehicle.mergeHeadways(0);
    if (
      envelope.min > envelope.max ||
      frontGap < CONST.MERGE_BODY_CLEARANCE ||
      rearGap < headways.rear * rearSpeed ||
      rearTtc < 4 ||
      rearSpeed < 0
    )
      return null;
    return {
      plan: { ...plan, envelope },
      envelope,
      startLaneChange:
        ramp.laneChange.state === 'none' &&
        ramp.z <=
          certificate.completionZ + ramp.speed * (CONST.LANE_CHANGE_DURATION + stepDuration),
      cooperation: cooperation
        ? { vehicleOrder: cooperation.rearOrder, decel: cooperation.decel }
        : null,
    };
  }

  projectMergeSlot(rampEta: number): ProjectedMergeSlot | null {
    const arrivals = this.vehicle.world.sectionVehicles[this.vehicle.section]
      .filter(
        (vehicle) =>
          vehicle !== this.vehicle &&
          vehicle.occupies(2) &&
          Math.abs(
            wrapDelta(
              nextFacilityWorldZ(CONST.MERGE_POINT_Z, vehicle.z) -
                facilityWorldZ(CONST.MERGE_POINT_Z, this.vehicle.z),
            ),
          ) < 1e-9,
      )
      .map((vehicle) => ({
        vehicle,
        eta:
          nextArrivalDistance(vehicle.z, facilityWorldZ(CONST.MERGE_POINT_Z, this.vehicle.z)) /
          Math.max(vehicle.speed, 1),
      }))
      .sort((a, b) => a.eta - b.eta || a.vehicle.spawnOrder - b.vehicle.spawnOrder);
    if (arrivals.length === 0) return null;
    const rearIndex = arrivals.findIndex((arrival) => arrival.eta > rampEta);
    const front = rearIndex < 0 ? arrivals.at(-1)! : arrivals[rearIndex - 1];
    const rear = rearIndex < 0 ? null : arrivals[rearIndex];
    const frontGap = front
      ? (rampEta - front.eta) * front.vehicle.speed -
        (front.vehicle.length + this.vehicle.length) / 2
      : Infinity;
    const rearGap = rear
      ? (rear.eta - rampEta) * rear.vehicle.speed - (rear.vehicle.length + this.vehicle.length) / 2
      : Infinity;
    const closingSpeed = rear ? rear.vehicle.speed - this.vehicle.speed : 0;
    return {
      front: front?.vehicle ?? null,
      rear: rear?.vehicle ?? null,
      frontGap,
      rearGap,
      rearClosingTtc: rear && closingSpeed > 0 ? rearGap / closingSpeed : Infinity,
      rampEta,
    };
  }

  projectReservedMergeSlot(plan: MergePlan): ProjectedMergeSlot | null {
    const vehicles = [plan.front, plan.rear].filter(
      (vehicle, index, all): vehicle is Vehicle =>
        vehicle !== null && all.indexOf(vehicle) === index,
    );
    if (vehicles.length === 0 || plan.targetPassTime <= this.vehicle.world.time) return null;
    const rampEta = plan.targetPassTime - this.vehicle.world.time;
    const projected = vehicles.map((vehicle) => ({
      vehicle,
      z: vehicle.z - vehicle.speed * rampEta,
    }));
    const mergeZ = facilityWorldZ(CONST.MERGE_POINT_Z, this.vehicle.z);
    // 予約時の rear が先に合流点を通る場合があるため、固定した車両参照を
    // targetPassTime の位置へ投影してから前後を分類し直す
    const front =
      projected
        .filter(({ z }) => wrapDelta(z - mergeZ) <= 0)
        .sort((a, b) => b.z - a.z || a.vehicle.spawnOrder - b.vehicle.spawnOrder)[0] ?? null;
    const rear =
      projected
        .filter(({ z }) => wrapDelta(z - mergeZ) > 0)
        .sort((a, b) => a.z - b.z || a.vehicle.spawnOrder - b.vehicle.spawnOrder)[0] ?? null;
    const frontGap = front
      ? -wrapDelta(front.z - mergeZ) - (front.vehicle.length + this.vehicle.length) / 2
      : Infinity;
    const rearGap = rear
      ? wrapDelta(rear.z - mergeZ) - (rear.vehicle.length + this.vehicle.length) / 2
      : Infinity;
    const closingSpeed = rear ? rear.vehicle.speed - this.vehicle.speed : 0;
    return {
      front: front?.vehicle ?? null,
      rear: rear?.vehicle ?? null,
      frontGap,
      rearGap,
      rearClosingTtc: rear && closingSpeed > 0 ? rearGap / closingSpeed : Infinity,
      rampEta,
    };
  }

  isProjectedSlotSafe(slot: ProjectedMergeSlot, congestion: number): boolean {
    const headways = this.vehicle.mergeHeadways(congestion);
    return (
      slot.frontGap >= headways.front * this.vehicle.speed &&
      slot.rearGap >= headways.rear * (slot.rear?.speed ?? 0) &&
      slot.rearClosingTtc >= 4
    );
  }

  projectMergeCongestionSample(slot: ProjectedMergeSlot | null): number {
    const localVehicles = [slot?.front, slot?.rear].filter(
      (vehicle): vehicle is Vehicle => vehicle !== null && vehicle !== undefined,
    );
    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    };
    const mainDesiredPace =
      localVehicles.length === 0
        ? Math.max(this.vehicle.desiredSpeed, 1)
        : median(localVehicles.map((vehicle) => vehicle.desiredSpeed));
    const mainPace =
      localVehicles.length === 0
        ? mainDesiredPace
        : median(localVehicles.map((vehicle) => vehicle.speed));
    const safeGap =
      localVehicles.length === 0
        ? 0.1
        : median(
            localVehicles.map(
              (vehicle) =>
                vehicle.length * 1.2 + 2.5 + vehicle.speed * 0.55 * vehicle.headwayFactor,
            ),
          );
    const mainGap =
      slot?.front && slot.rear ? slot.frontGap + this.vehicle.length + slot.rearGap : safeGap * 1.8;
    return mergeCongestion(mainPace, mainDesiredPace, mainGap, safeGap);
  }

  projectMergeCongestion(
    slot: ProjectedMergeSlot | null,
    deltaTime: number,
    sample = this.vehicle.projectMergeCongestionSample(slot),
  ): number {
    const smoothing = 1 - Math.exp(-Math.max(0, deltaTime) / CONST.MERGE_CONGESTION_TIME_CONSTANT);
    return lerp(this.vehicle.mergePlan.congestion, sample, smoothing);
  }

  estimateMergeEta(): number {
    const distance = Math.max(0, toFacilityLocalZ(this.vehicle.z) - CONST.MERGE_POINT_Z);
    if (distance === 0) return 0;
    const speed = Math.max(this.vehicle.speed, 1);
    const targetSpeed = Math.max(speed, this.vehicle.desiredSpeed);
    const acceleration = Math.max(this.vehicle.type.acceleration, 0.1);
    const accelerationTime = (targetSpeed - speed) / acceleration;
    const accelerationDistance =
      speed * accelerationTime + 0.5 * acceleration * accelerationTime ** 2;
    if (distance <= accelerationDistance)
      return (-speed + Math.sqrt(speed ** 2 + 2 * acceleration * distance)) / acceleration;
    return accelerationTime + (distance - accelerationDistance) / targetSpeed;
  }

  latestMergeCommitZ(): number {
    const completionDistance =
      Math.max(this.vehicle.speed, 1) * CONST.LANE_CHANGE_DURATION +
      this.vehicle.length +
      CONST.MERGE_BODY_CLEARANCE;
    return facilityWorldZ(CONST.GORE_Z_START + completionDistance, this.vehicle.z);
  }

  evaluateMergePlan(deltaTime: number, lastSource: MergeSource | null): MergePlan {
    if (this.vehicle.mergePlan.state === 'committed') return this.vehicle.mergePlan;
    const reservedRear = this.vehicle.mergePlan.rear;
    if (
      this.vehicle.mergePlan.state === 'coordinating' &&
      reservedRear &&
      reservedRear.laneChange.from === 2 &&
      reservedRear.laneChange.to === 1
    ) {
      if (
        reservedRear.laneChange.state === 'changing' ||
        reservedRear.laneChange.state === 'holding'
      )
        return this.vehicle.mergePlan;
      if (reservedRear.lane === 1 && reservedRear.laneChange.state === 'none')
        return { ...this.vehicle.mergePlan, state: 'committed' };
    }
    const reservedSlot = this.vehicle.projectReservedMergeSlot(this.vehicle.mergePlan);
    const keepsRampArrivalReservation =
      this.vehicle.mergePlan.state === 'coordinating' &&
      (this.vehicle.mergePlan.rear === null || this.vehicle.mergePlan.nextSource === 'main') &&
      reservedSlot !== null;
    if (keepsRampArrivalReservation) {
      // commit 判定は固定予約の投影条件で行い、現在位置の danger は apply 直前に別途判定する
      if (this.vehicle.isProjectedSlotSafe(reservedSlot, this.vehicle.mergePlan.congestion))
        return { ...this.vehicle.mergePlan, state: 'committed' };
      return this.vehicle.mergePlan;
    }
    const rampEta = this.vehicle.estimateMergeEta();
    const slot = this.vehicle.projectMergeSlot(rampEta);
    const rawCongestion = this.vehicle.projectMergeCongestionSample(slot);
    const congestion = this.vehicle.projectMergeCongestion(slot, deltaTime, rawCongestion);
    const headways = this.vehicle.mergeHeadways(congestion);
    const passHeadway = Math.max(headways.front, headways.rear);
    const mainVehicle = slot?.rear ?? slot?.front ?? null;
    const mainEta = mainVehicle
      ? nextArrivalDistance(mainVehicle.z, facilityWorldZ(CONST.MERGE_POINT_Z, this.vehicle.z)) /
        Math.max(mainVehicle.speed, 1)
      : rampEta;
    const nextSource: MergeSource =
      mainVehicle === null
        ? 'ramp'
        : Math.abs(rampEta - mainEta) <= passHeadway
          ? lastSource === 'main'
            ? 'ramp'
            : lastSource === 'ramp'
              ? 'main'
              : rampEta <= mainEta
                ? 'ramp'
                : 'main'
          : rampEta <= mainEta
            ? 'ramp'
            : 'main';
    const zipperPassTime =
      this.vehicle.world.time +
      (nextSource === 'ramp' ? Math.max(rampEta, mainEta + passHeadway) : mainEta + passHeadway);
    const rearClearanceTime = slot?.rear
      ? (headways.rear * slot.rear.speed + (this.vehicle.length + slot.rear.length) / 2) /
        Math.max(slot.rear.speed, 1)
      : 0;
    const frontClearanceTime = slot?.front
      ? passHeadway +
        (this.vehicle.length + slot.front.length) / (2 * Math.max(slot.front.speed, 1))
      : 0;
    const reservedPassTime =
      this.vehicle.world.time +
      (slot?.rear ? rampEta + rearClearanceTime : Math.max(rampEta, mainEta + frontClearanceTime));
    const blendedPassTime = lerp(reservedPassTime, zipperPassTime, congestion);
    const distanceToDeadline = Math.max(0, this.vehicle.z - this.vehicle.latestMergeCommitZ());
    const urgency = 1 - smoothstepRange(0, CONST.MERGE_DETECT_RANGE, distanceToDeadline);
    const urgencyBias = urgency * Math.max(0, blendedPassTime - reservedPassTime);
    const urgencyTargetPassTime = blendedPassTime - urgencyBias;
    const deadlineStepDistance = Math.max(this.vehicle.speed * deltaTime, 0.001);
    const safetyFloorUrgency = 1 - smoothstepRange(0, deadlineStepDistance, distanceToDeadline);
    const targetPassTime =
      nextSource === 'ramp'
        ? Math.max(
            urgencyTargetPassTime,
            lerp(urgencyTargetPassTime, reservedPassTime, safetyFloorUrgency),
          )
        : urgencyTargetPassTime;
    const lowSpeedZipper = rawCongestion >= 0.9;
    const keepsCooperationReservation =
      this.vehicle.mergePlan.state === 'coordinating' &&
      reservedRear !== null &&
      reservedRear.mergeCooperationTarget === this.vehicle.mergePlan.targetPassTime &&
      slot?.front === this.vehicle.mergePlan.front &&
      slot.rear === reservedRear;
    if (keepsCooperationReservation) {
      if (nextSource === 'main')
        return {
          ...this.vehicle.mergePlan,
          congestion,
          targetPassTime,
          nextSource,
          cooperationDecel: 0,
        };
      if (this.vehicle.isProjectedSlotSafe(slot, congestion))
        return { ...this.vehicle.mergePlan, state: 'committed', congestion, nextSource };
      const rearGapShortage = Math.max(0, headways.rear * reservedRear.speed - slot.rearGap);
      const timeToTarget = Math.max(
        this.vehicle.mergePlan.targetPassTime - this.vehicle.world.time,
        deltaTime,
      );
      const requiredDecel = (2 * rearGapShortage) / Math.max(timeToTarget ** 2, 0.01);
      const cooperationDecel = Math.max(CONST.MERGE_TARGET_COOP_DECEL, requiredDecel);
      if (
        this.vehicle.z <= this.vehicle.latestMergeCommitZ() &&
        cooperationDecel > CONST.MERGE_MAX_COOP_DECEL
      )
        return {
          ...this.vehicle.mergePlan,
          state: 'seeking',
          front: null,
          rear: null,
          congestion,
          targetPassTime: 0,
          nextSource: null,
        };
      if (this.vehicle.world.time < this.vehicle.mergePlan.targetPassTime)
        return {
          ...this.vehicle.mergePlan,
          congestion,
          nextSource,
          cooperationDecel:
            this.vehicle.z <= this.vehicle.latestMergeCommitZ()
              ? cooperationDecel
              : this.vehicle.mergePlan.cooperationDecel,
        };
    }
    const plan = (
      state: MergeState,
      targetPassTime: number,
      cooperationDecel?: number,
    ): MergePlan => ({
      ...this.vehicle.mergePlan,
      state,
      front: slot?.front ?? null,
      rear: slot?.rear ?? null,
      congestion,
      targetPassTime,
      nextSource,
      cooperationDecel,
    });
    if (nextSource === 'main') return plan('coordinating', targetPassTime, 0);
    if (!slot || this.vehicle.isProjectedSlotSafe(slot, congestion)) {
      const waitsForCurrentSafety = this.vehicle.checkLaneSafetyForChange(2) !== 'safe';
      return plan(
        waitsForCurrentSafety ? 'coordinating' : 'committed',
        targetPassTime,
        waitsForCurrentSafety ? 0 : undefined,
      );
    }
    if (!slot.rear) {
      return plan(lowSpeedZipper ? 'coordinating' : 'seeking', targetPassTime, 0);
    }
    if (!lowSpeedZipper && slot.rear.checkLaneSafetyForChange(1) === 'safe')
      return plan('coordinating', targetPassTime);
    let cooperationDecel = CONST.MERGE_TARGET_COOP_DECEL;
    if (this.vehicle.z <= this.vehicle.latestMergeCommitZ()) {
      const rearGapShortage = Math.max(0, headways.rear * slot.rear.speed - slot.rearGap);
      const timeToTarget = Math.max(targetPassTime - this.vehicle.world.time, deltaTime);
      const requiredDecel = (2 * rearGapShortage) / Math.max(timeToTarget ** 2, 0.01);
      cooperationDecel = Math.max(cooperationDecel, requiredDecel);
    }
    if (cooperationDecel <= CONST.MERGE_MAX_COOP_DECEL)
      return plan('coordinating', targetPassTime, cooperationDecel);
    return {
      ...this.vehicle.mergePlan,
      state: 'seeking',
      front: null,
      rear: null,
      congestion,
      targetPassTime: 0,
      nextSource: null,
    };
  }

  isMergeApplySafe(plan: MergePlan): boolean {
    if (plan.state !== 'committed') return false;
    const slot = this.vehicle.projectMergeSlot(this.vehicle.estimateMergeEta());
    return (
      (!slot || this.vehicle.isProjectedSlotSafe(slot, plan.congestion)) &&
      this.vehicle.checkLaneSafetyForChange(2) === 'safe'
    );
  }
}

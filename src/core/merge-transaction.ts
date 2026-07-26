import { CONST } from './constants';
import type { Section } from './constants';
import { clamp, lerp, smooth, WRAP_LENGTH } from './utils';
import type {
  MergeCertificate,
  MergeDirective,
  MergePlan,
  MergeTransaction,
  MergeClosureResult,
  MergeDependencyEdge,
  ReservedMotion,
  VehicleSnapshot,
  WorldSnapshot,
} from './vehicle';

const MIN_AHEAD_DISTANCE = 0.001;
const TIME_EPSILON = 1e-9;
const LANE_CHANGE_COMPLETE_EPSILON = 1e-9;

/**
 * 予約期限を越えない一回分の離散時間を返す。
 * 証明時と実行時で同じ最終 partial step を使い、remaining < deltaTime も矛盾なく扱う。
 */
export function mergeTransactionStepDuration(
  currentTime: number,
  targetPassTime: number,
  deltaTime: number,
): number | null {
  const remaining = targetPassTime - currentTime;
  if (!(deltaTime > 0) || !Number.isFinite(deltaTime) || remaining <= TIME_EPSILON) return null;
  return Math.min(deltaTime, remaining);
}

/** 連続時間の到着予測を、証明と実行が共有する次の tick 境界へ切り上げる。 */
export function quantizeMergeDuration(duration: number, deltaTime: number): number {
  if (!(duration > 0) || !(deltaTime > 0) || !Number.isFinite(duration + deltaTime))
    return duration;
  return Math.ceil(duration / deltaTime - TIME_EPSILON) * deltaTime;
}

function wrappedAheadDistance(follower: VehicleSnapshot, ahead: VehicleSnapshot): number {
  return (((follower.z - ahead.z) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
}

function nearestAhead(
  lane: readonly VehicleSnapshot[],
  follower: VehicleSnapshot,
): Readonly<{ vehicle: VehicleSnapshot; distance: number }> | null {
  const rawThreshold = follower.z - MIN_AHEAD_DISTANCE;
  let low = 0;
  let high = lane.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lane[middle].z < rawThreshold) low = middle + 1;
    else high = middle;
  }
  if (low > 0) {
    const nearestZ = lane[low - 1].z;
    let firstAtZ = low - 1;
    while (firstAtZ > 0 && lane[firstAtZ - 1].z === nearestZ) firstAtZ--;
    const candidate = lane[firstAtZ];
    return { vehicle: candidate, distance: wrappedAheadDistance(follower, candidate) };
  }

  const wrappedZ = lane.at(-1)?.z;
  if (wrappedZ === undefined || wrappedZ <= follower.z) return null;
  let firstAtZ = lane.length - 1;
  while (firstAtZ > 0 && lane[firstAtZ - 1].z === wrappedZ) firstAtZ--;
  const candidate = lane[firstAtZ];
  return candidate.order === follower.order
    ? null
    : { vehicle: candidate, distance: wrappedAheadDistance(follower, candidate) };
}

/**
 * 予約 role から、期限までの安全境界を証明できない直前車だけを再帰的に集める。
 * mutable な World / Vehicle を参照せず、同じ snapshot には常に同じ結果を返す。
 */
export function buildMergeDependencyClosure(
  snapshot: WorldSnapshot,
  section: Section,
  rootOrders: readonly number[],
  targetPassTime: number,
  limit = CONST.MERGE_TRANSACTION_CLOSURE_MAX,
): MergeClosureResult {
  const roots = [...new Set(rootOrders)].sort((left, right) => left - right);
  if (roots.length > limit) return { ok: false, reason: 'limit', order: null };

  for (const order of roots) {
    const root = snapshot.byOrder.get(order);
    if (root && root.laneChange.state !== 'none')
      return { ok: false, reason: 'lane-change-in-progress', order };
    if (!root || root.waiting || root.section !== section || root.lane !== 2)
      return { ok: false, reason: 'missing-root', order };
    if (root.speed <= 0) return { ok: false, reason: 'stationary-member', order };
  }

  const remaining = targetPassTime - snapshot.time;
  const orders = new Set<number>();
  const edges: MergeDependencyEdge[] = [];
  const state = new Map<number, 'visiting' | 'visited'>();
  const lane = snapshot.lane2BySection[section];
  let rejected: Exclude<MergeClosureResult, { ok: true }> | null = null;

  const visit = (member: VehicleSnapshot): boolean => {
    const currentState = state.get(member.order);
    if (currentState === 'visiting') {
      rejected = { ok: false, reason: 'cycle', order: member.order };
      return false;
    }
    if (currentState === 'visited') return true;
    if (member.laneChange.state !== 'none') {
      rejected = {
        ok: false,
        reason: 'lane-change-in-progress',
        order: member.order,
      };
      return false;
    }
    if (member.speed <= 0) {
      rejected = {
        ok: false,
        reason: 'stationary-member',
        order: member.order,
      };
      return false;
    }
    if (!orders.has(member.order)) {
      if (orders.size >= limit) {
        rejected = { ok: false, reason: 'limit', order: member.order };
        return false;
      }
      orders.add(member.order);
    }
    state.set(member.order, 'visiting');

    const ahead = nearestAhead(lane, member);
    if (ahead) {
      const bodyGap = ahead.distance - (member.length + ahead.vehicle.length) / 2;
      const boundarySafe = bodyGap >= member.speed * remaining + CONST.MERGE_BODY_CLEARANCE;
      if (!boundarySafe) {
        edges.push({ followerOrder: member.order, aheadOrder: ahead.vehicle.order });
        if (!visit(ahead.vehicle)) return false;
      }
    }

    state.set(member.order, 'visited');
    return true;
  };

  for (const order of roots) {
    const root = snapshot.byOrder.get(order);
    if (!root || !visit(root)) return rejected!;
  }

  return {
    ok: true,
    closure: {
      orders: [...orders].sort((left, right) => left - right),
      edges,
    },
  };
}

export class MergeTransactionPlanningError extends Error {
  constructor(
    readonly plan: MergePlan,
    readonly reason: string,
  ) {
    super(reason);
  }
}

function nextLongitudinalPosition(snapshot: VehicleSnapshot, nextSpeed: number, deltaTime: number) {
  let nextZ = snapshot.z - nextSpeed * deltaTime;
  if (nextZ < -CONST.ROAD_HALF - 8) nextZ += WRAP_LENGTH;
  return nextZ;
}

function sameMotion(left: ReservedMotion, right: ReservedMotion): boolean {
  return (
    left.nextSpeed === right.nextSpeed &&
    left.nextZ === right.nextZ &&
    left.nextX === right.nextX &&
    left.laneChangeProgress === right.laneChangeProgress
  );
}

/** 予約減速する前方車だけを後続へ伝播した、期限時の速度を返す。 */
export function mergeClosureTerminalSpeeds(
  snapshot: WorldSnapshot,
  certificate: MergeCertificate,
): ReadonlyMap<number, number> {
  const remaining = Math.max(0, certificate.targetPassTime - snapshot.time);
  const aheadByFollower = new Map<number, number[]>();
  for (const edge of certificate.closure.edges) {
    const ahead = aheadByFollower.get(edge.followerOrder);
    if (ahead) ahead.push(edge.aheadOrder);
    else aheadByFollower.set(edge.followerOrder, [edge.aheadOrder]);
  }
  const cooperationOrder = certificate.cooperation?.rearOrder ?? null;
  const terminalSpeeds = new Map<number, number>();
  const visiting = new Set<number>();
  const resolve = (order: number): number => {
    const known = terminalSpeeds.get(order);
    if (known !== undefined) return known;
    if (visiting.has(order)) throw new Error(`closure cycle:${order}`);
    const member = snapshot.byOrder.get(order);
    if (!member) throw new Error(`closure member消失:${order}`);
    visiting.add(order);
    let terminalSpeed =
      order === cooperationOrder
        ? Math.max(
            Math.min(member.speed, CONST.MERGE_TRANSACTION_MIN_SPEED),
            member.speed - (certificate.cooperation?.decel ?? 0) * remaining,
          )
        : member.speed;
    for (const aheadOrder of aheadByFollower.get(order) ?? []) {
      const ahead = snapshot.byOrder.get(aheadOrder);
      if (!ahead) throw new Error(`closure member消失:${aheadOrder}`);
      const aheadTerminalSpeed = resolve(aheadOrder);
      if (aheadTerminalSpeed + 1e-9 < ahead.speed)
        terminalSpeed = Math.min(terminalSpeed, aheadTerminalSpeed);
    }
    visiting.delete(order);
    terminalSpeeds.set(order, terminalSpeed);
    return terminalSpeed;
  };
  for (const order of certificate.closure.orders) resolve(order);
  return terminalSpeeds;
}

/** ramp と closure 全 member の次速度・位置を一つの snapshot から確定する。 */
export function planMergeTransaction(
  snapshot: WorldSnapshot,
  directives: readonly MergeDirective[],
  deltaTime: number,
): MergeTransaction {
  const motions = new Map<number, ReservedMotion>();

  const addMotion = (directive: MergeDirective, motion: ReservedMotion): void => {
    const existing = motions.get(motion.vehicleOrder);
    if (existing && !sameMotion(existing, motion))
      throw new MergeTransactionPlanningError(
        directive.plan,
        `role予約競合:${motion.vehicleOrder}`,
      );
    motions.set(motion.vehicleOrder, motion);
  };

  for (const directive of directives) {
    const certificate = directive.plan.certificate;
    if (!certificate) throw new MergeTransactionPlanningError(directive.plan, '証明書なし');
    const ramp = snapshot.byOrder.get(certificate.rampOrder);
    if (!ramp) throw new MergeTransactionPlanningError(directive.plan, 'ランプrole消失');
    const remaining = certificate.targetPassTime - snapshot.time;
    const stepDuration = mergeTransactionStepDuration(
      snapshot.time,
      certificate.targetPassTime,
      deltaTime,
    );
    if (stepDuration === null)
      throw new MergeTransactionPlanningError(directive.plan, '予約期限切れ');

    const cooperationOrder = certificate.cooperation?.rearOrder ?? null;
    const preferred = new Map<number, number>();
    const reachableMin = new Map<number, number>();
    for (const order of certificate.closure.orders) {
      const member = snapshot.byOrder.get(order);
      if (!member) throw new MergeTransactionPlanningError(directive.plan, `role消失:${order}`);
      const deceleration = order === cooperationOrder ? (certificate.cooperation?.decel ?? 0) : 0;
      preferred.set(order, member.speed - deceleration * stepDuration);
      const progressFloor = Math.min(member.speed, CONST.MERGE_TRANSACTION_MIN_SPEED);
      reachableMin.set(
        order,
        Math.max(progressFloor, member.speed - CONST.MERGE_MAX_COOP_DECEL * stepDuration),
      );
    }

    const aheadByFollower = new Map<number, number[]>();
    for (const edge of certificate.closure.edges) {
      const ahead = aheadByFollower.get(edge.followerOrder);
      if (ahead) ahead.push(edge.aheadOrder);
      else aheadByFollower.set(edge.followerOrder, [edge.aheadOrder]);
    }
    let terminalSpeeds: ReadonlyMap<number, number>;
    try {
      terminalSpeeds = mergeClosureTerminalSpeeds(snapshot, certificate);
    } catch (error) {
      throw new MergeTransactionPlanningError(
        directive.plan,
        error instanceof Error ? error.message : String(error),
      );
    }
    const resolveTerminalSpeed = (order: number): number => {
      const terminalSpeed = terminalSpeeds.get(order);
      if (terminalSpeed === undefined)
        throw new MergeTransactionPlanningError(directive.plan, `closure member消失:${order}`);
      return terminalSpeed;
    };

    const resolved = new Map<number, number>();
    const visiting = new Set<number>();
    const solve = (order: number): number => {
      const known = resolved.get(order);
      if (known !== undefined) return known;
      if (visiting.has(order))
        throw new MergeTransactionPlanningError(directive.plan, `closure cycle:${order}`);
      const member = snapshot.byOrder.get(order);
      const wanted = preferred.get(order);
      const minimum = reachableMin.get(order);
      if (!member || wanted === undefined || minimum === undefined)
        throw new MergeTransactionPlanningError(directive.plan, `closure member消失:${order}`);
      visiting.add(order);
      const terminalSpeed = resolveTerminalSpeed(order);
      const terminalTrajectoryMax =
        terminalSpeed +
        ((member.speed - terminalSpeed) * Math.max(0, remaining - stepDuration)) / remaining;
      let nextSpeed = Math.min(wanted, terminalTrajectoryMax);
      let limitingEdge = '';
      for (const aheadOrder of aheadByFollower.get(order) ?? []) {
        const ahead = snapshot.byOrder.get(aheadOrder);
        if (!ahead)
          throw new MergeTransactionPlanningError(
            directive.plan,
            `closure ahead消失:${aheadOrder}`,
          );
        const aheadNextSpeed = solve(aheadOrder);
        const bodyGap = wrappedAheadDistance(member, ahead) - (member.length + ahead.length) / 2;
        const availableGap = bodyGap - CONST.MERGE_BODY_CLEARANCE;
        const collisionMax = Math.min(
          aheadNextSpeed + availableGap / stepDuration,
          // 期限時に clearance だけでなく相対速度も 0 にして legacy へ戻す。
          aheadNextSpeed + (2 * availableGap) / remaining,
        );
        if (collisionMax < nextSpeed) {
          nextSpeed = collisionMax;
          limitingEdge = `,ahead=${aheadOrder},aheadSpeed=${aheadNextSpeed},bodyGap=${bodyGap}`;
        }
      }
      visiting.delete(order);
      if (!Number.isFinite(nextSpeed) || nextSpeed < 0 || nextSpeed + 1e-9 < minimum)
        throw new MergeTransactionPlanningError(
          directive.plan,
          `closure速度区間なし:${order},speed=${nextSpeed},min=${minimum}${limitingEdge}`,
        );
      nextSpeed = Math.max(minimum, nextSpeed);
      resolved.set(order, nextSpeed);
      return nextSpeed;
    };

    for (const order of certificate.closure.orders) solve(order);
    for (const order of certificate.closure.orders) {
      const member = snapshot.byOrder.get(order)!;
      const nextSpeed = resolved.get(order)!;
      addMotion(directive, {
        vehicleOrder: order,
        nextSpeed,
        nextZ: nextLongitudinalPosition(member, nextSpeed, stepDuration),
        nextX: member.x,
        laneChangeProgress: null,
      });
    }

    const progressFloor = Math.min(ramp.speed, CONST.MERGE_TRANSACTION_MIN_SPEED);
    const rampMinimum = Math.max(
      progressFloor,
      directive.envelope.min,
      ramp.speed - CONST.MERGE_MAX_COOP_DECEL * stepDuration,
    );
    const rampMaximum = Math.min(
      directive.envelope.max,
      ramp.speed + ramp.maxAcceleration * stepDuration,
    );
    if (rampMinimum > rampMaximum)
      throw new MergeTransactionPlanningError(directive.plan, 'ランプ速度包絡なし');
    const targetSpeed = (ramp.z - certificate.completionZ) / remaining;
    const nextSpeed = clamp(targetSpeed, rampMinimum, rampMaximum);
    if (!Number.isFinite(nextSpeed) || nextSpeed <= 0)
      throw new MergeTransactionPlanningError(directive.plan, 'ランプ正速度なし');

    const changing =
      directive.startLaneChange ||
      (ramp.laneChange.state === 'changing' &&
        ramp.laneChange.from === 3 &&
        ramp.laneChange.to === 2);
    const progress =
      directive.startLaneChange && ramp.laneChange.state === 'none' ? 0 : ramp.laneChange.progress;
    const laneChangeProgress = changing
      ? Math.min(1, progress + stepDuration / CONST.LANE_CHANGE_DURATION)
      : null;
    const nextX =
      laneChangeProgress === null
        ? ramp.x
        : lerp(
            CONST.LANE_X[ramp.section][3],
            CONST.LANE_X[ramp.section][2],
            smooth(laneChangeProgress),
          );
    addMotion(directive, {
      vehicleOrder: ramp.order,
      nextSpeed,
      nextZ: nextLongitudinalPosition(ramp, nextSpeed, stepDuration),
      nextX,
      laneChangeProgress,
    });
  }

  return {
    directives,
    motions: [...motions.values()].sort((left, right) => left.vehicleOrder - right.vehicleOrder),
  };
}

/**
 * broad-phase で車体交差の可能性が残った入場候補だけを、closure 内に限定して
 * 合流完了まで dry-run する。mutable な World / Vehicle は参照しない。
 */
export function validateMergeTransactionHorizon(
  snapshot: WorldSnapshot,
  directive: MergeDirective,
  deltaTime: number,
): void {
  const certificate = directive.plan.certificate;
  if (!certificate) throw new MergeTransactionPlanningError(directive.plan, '証明書なし');
  const memberOrders = new Set([certificate.rampOrder, ...certificate.closure.orders]);
  let vehicles = snapshot.vehicles
    .filter((vehicle) => memberOrders.has(vehicle.order))
    .map((vehicle) => ({
      ...vehicle,
      laneChange: { ...vehicle.laneChange },
    }));
  let time = snapshot.time;
  const stepLimit = Math.ceil((certificate.targetPassTime - snapshot.time) / deltaTime) + 2;

  const makeSnapshot = (): WorldSnapshot => {
    const ordered = [...vehicles].sort((left, right) => left.order - right.order);
    const byOrder = new Map(ordered.map((vehicle) => [vehicle.order, vehicle]));
    const lane2 = (section: Section) =>
      ordered
        .filter((vehicle) => vehicle.section === section && vehicle.lane === 2 && !vehicle.waiting)
        .sort((left, right) => left.z - right.z || left.order - right.order);
    return {
      time,
      vehicles: ordered,
      byOrder,
      lane2BySection: {
        L: lane2('L'),
        R: lane2('R'),
      },
    };
  };

  for (let step = 0; step < stepLimit; step++) {
    const current = makeSnapshot();
    const ramp = current.byOrder.get(certificate.rampOrder);
    if (!ramp) throw new MergeTransactionPlanningError(directive.plan, 'ランプrole消失');
    const stepDuration = mergeTransactionStepDuration(
      current.time,
      certificate.targetPassTime,
      deltaTime,
    );
    if (stepDuration === null) break;
    const envelope = {
      min: Math.max(
        certificate.envelope.min,
        ramp.speed - CONST.MERGE_MAX_COOP_DECEL * stepDuration,
      ),
      max: Math.min(certificate.envelope.max, ramp.speed + ramp.maxAcceleration * stepDuration),
    };
    const startLaneChange =
      ramp.laneChange.state === 'none' &&
      ramp.z <= certificate.completionZ + ramp.speed * (CONST.LANE_CHANGE_DURATION + stepDuration);
    const transaction = planMergeTransaction(
      current,
      [
        {
          ...directive,
          envelope,
          startLaneChange,
        },
      ],
      stepDuration,
    );
    const motions = new Map(transaction.motions.map((motion) => [motion.vehicleOrder, motion]));
    const rampMotion = motions.get(certificate.rampOrder);
    if (!rampMotion) throw new MergeTransactionPlanningError(directive.plan, 'ランプ運動なし');
    if (rampMotion.laneChangeProgress !== null) {
      for (const [role, order] of [
        ['front', certificate.frontOrder],
        ['rear', certificate.rearOrder],
      ] as const) {
        if (order === null) continue;
        const member = current.byOrder.get(order);
        const memberMotion = motions.get(order);
        if (!member || !memberMotion)
          throw new MergeTransactionPlanningError(directive.plan, `${role}運動なし`);
        const centerDistance =
          role === 'front'
            ? (((rampMotion.nextZ - memberMotion.nextZ) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH
            : (((memberMotion.nextZ - rampMotion.nextZ) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
        const bodyGap = centerDistance - (ramp.length + member.length) / 2;
        const lateralGap =
          Math.abs(rampMotion.nextX - memberMotion.nextX) - (ramp.width + member.width) / 2;
        if (bodyGap < 0 && lateralGap < 0)
          throw new MergeTransactionPlanningError(directive.plan, `${role}車体間隔=${bodyGap}`);
      }
    }

    vehicles = vehicles.map((vehicle) => {
      const motion = motions.get(vehicle.order);
      if (!motion) return vehicle;
      const isRamp = vehicle.order === certificate.rampOrder;
      const progress = isRamp ? motion.laneChangeProgress : null;
      return {
        ...vehicle,
        lane: progress !== null && progress >= 1 - LANE_CHANGE_COMPLETE_EPSILON ? 2 : vehicle.lane,
        z: motion.nextZ,
        x: motion.nextX,
        speed: motion.nextSpeed,
        laneChange:
          progress === null
            ? vehicle.laneChange
            : progress >= 1 - LANE_CHANGE_COMPLETE_EPSILON
              ? {
                  ...vehicle.laneChange,
                  state: 'none' as const,
                  progress: 1,
                }
              : {
                  state: 'changing' as const,
                  from: 3,
                  to: 2,
                  progress,
                  holdTime: 0,
                  checkTimer: 0,
                },
      };
    });
    time += stepDuration;
    if (
      rampMotion.laneChangeProgress !== null &&
      rampMotion.laneChangeProgress >= 1 - LANE_CHANGE_COMPLETE_EPSILON
    )
      return;
  }
  const ramp = vehicles.find((vehicle) => vehicle.order === certificate.rampOrder);
  throw new MergeTransactionPlanningError(
    directive.plan,
    `ランプ車線変更未完了:progress=${ramp?.laneChange.progress},z=${ramp?.z},` +
      `time=${time},target=${certificate.targetPassTime}`,
  );
}

/**
 * closure の期限速度と ramp の加速軌道から、横移動中の前後車交差を入場前に検査する。
 */
export function validateMergeTransactionCorridor(
  snapshot: WorldSnapshot,
  directive: MergeDirective,
  deltaTime: number,
): void {
  const certificate = directive.plan.certificate;
  if (!certificate) throw new MergeTransactionPlanningError(directive.plan, '証明書なし');
  const ramp = snapshot.byOrder.get(certificate.rampOrder);
  if (!ramp) throw new MergeTransactionPlanningError(directive.plan, 'ランプrole消失');
  planMergeTransaction(snapshot, [directive], deltaTime);

  const remaining = certificate.targetPassTime - snapshot.time;
  if (!(remaining > 0)) throw new MergeTransactionPlanningError(directive.plan, '予約期限切れ');
  let terminalSpeeds: ReadonlyMap<number, number>;
  try {
    terminalSpeeds = mergeClosureTerminalSpeeds(snapshot, certificate);
  } catch (error) {
    throw new MergeTransactionPlanningError(
      directive.plan,
      error instanceof Error ? error.message : String(error),
    );
  }
  const distanceToCompletion = (vehicle: VehicleSnapshot): number =>
    (((vehicle.z - certificate.completionZ) % WRAP_LENGTH) + WRAP_LENGTH) % WRAP_LENGTH;
  const projectedRoleGap = (role: 'front' | 'rear', order: number | null): number => {
    if (order === null) return Infinity;
    const member = snapshot.byOrder.get(order);
    const terminalSpeed = terminalSpeeds.get(order);
    if (!member || terminalSpeed === undefined)
      throw new MergeTransactionPlanningError(directive.plan, `${role}消失`);
    const memberDistance = 0.5 * (member.speed + terminalSpeed) * remaining;
    const memberRemaining = distanceToCompletion(member) - memberDistance;
    const centerDistance = role === 'front' ? -memberRemaining : memberRemaining;
    return centerDistance - (ramp.length + member.length) / 2;
  };
  const frontGap = projectedRoleGap('front', certificate.frontOrder);
  const rearGap = projectedRoleGap('rear', certificate.rearOrder);
  const rearTerminalSpeed =
    certificate.rearOrder === null ? 0 : (terminalSpeeds.get(certificate.rearOrder) ?? 0);
  const rearTtc =
    rearTerminalSpeed > certificate.envelope.max
      ? rearGap / (rearTerminalSpeed - certificate.envelope.max)
      : Infinity;
  if (
    frontGap < CONST.MERGE_FREE_FRONT_HEADWAY * certificate.envelope.max ||
    rearGap < CONST.MERGE_FREE_REAR_HEADWAY * rearTerminalSpeed ||
    (certificate.rearOrder !== null &&
      rearTerminalSpeed + CONST.MERGE_YIELD_SPEED_DIFF < certificate.envelope.min) ||
    rearTtc < 4
  )
    throw new MergeTransactionPlanningError(
      directive.plan,
      `期限時headway不足:front=${frontGap},rear=${rearGap},ttc=${rearTtc}`,
    );

  validateMergeTransactionHorizon(snapshot, directive, deltaTime);
}

/** 離散軌道を最後まで証明できる入場候補だけを採用可能とする。 */
export function isMergeTransactionAdmissible(
  snapshot: WorldSnapshot,
  directive: MergeDirective,
  deltaTime: number,
): boolean {
  try {
    validateMergeTransactionCorridor(snapshot, directive, deltaTime);
    return true;
  } catch (error) {
    if (error instanceof MergeTransactionPlanningError) return false;
    throw error;
  }
}

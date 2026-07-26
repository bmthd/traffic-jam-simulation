import { CONST } from './constants';
import type { Section } from './constants';
import { WRAP_LENGTH } from './utils';
import type {
  MergeClosureResult,
  MergeDependencyEdge,
  VehicleSnapshot,
  WorldSnapshot,
} from './vehicle';

const MIN_AHEAD_DISTANCE = 0.001;

function wrappedAheadDistance(follower: VehicleSnapshot, ahead: VehicleSnapshot): number {
  return ((follower.z - ahead.z) % WRAP_LENGTH + WRAP_LENGTH) % WRAP_LENGTH;
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
    if (!root || root.waiting || root.section !== section || root.lane !== 2)
      return { ok: false, reason: 'missing-root', order };
    if (root.laneChange.state !== 'none')
      return { ok: false, reason: 'lane-change-in-progress', order };
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
      const boundarySafe =
        bodyGap >= member.speed * remaining + CONST.MERGE_BODY_CLEARANCE;
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

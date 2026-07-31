/* ============================================================
   シミュレーションコアの公開API
   ここ以下 (src/core/) は DOM / THREE 非依存を保つこと。
   Node のテスト (traffic-simulation.test.ts) はこのモジュールを
   直接 import して実行する。描画コードをここに書かないこと。
   ============================================================ */
export {
  CONST,
  RAMP_GEOMETRY,
  rampBodyIntersectsGore,
  sectionTrackX,
  TYPES,
  TYPE_WEIGHTS,
} from './constants';
export type {
  GoreGeometry,
  Section,
  SimMode,
  NumericSimParam,
  VehicleTypeName,
  VehicleTypeSpec,
} from './constants';
export { clamp, lerp, smooth, createRng, WRAP_LENGTH, wrapDelta } from './utils';
export type { Rng } from './utils';
// 依存の初期化(DI)はこのモジュール経由で行う (Issue #120)
export { createVehicle, createVehicleDeps, createWorldDeps } from './factory';
export { LaneChangeController } from './lane-change-controller';
export { LongitudinalController } from './longitudinal-controller';
export {
  mergeCongestion,
  MergeCoordinator,
  nextArrivalDistance,
  smoothstepRange,
} from './merge-coordinator';
export { Vehicle } from './vehicle';
export {
  buildMergeDependencyClosure,
  isMergeTransactionAdmissible,
  mergeClosureTerminalSpeeds,
  mergeTransactionStepDuration,
  MergeTransactionPlanningError,
  planMergeTransaction,
  quantizeMergeDuration,
  validateMergeTransactionCorridor,
  validateMergeTransactionHorizon,
} from './merge-transaction';
export type {
  LaneChange,
  LaneChangeState,
  MergeCandidate,
  MergeCertificate,
  MergeClosureRejectReason,
  MergeClosureResult,
  MergeDependencyClosure,
  MergeDependencyEdge,
  MergeDirective,
  MergeTransaction,
  MergePlan,
  MergeSource,
  MergeState,
  NeighborInfo,
  ProjectedMergeSlot,
  SpeedEnvelope,
  ReservedMotion,
  VehicleDeps,
  VehicleFactory,
  VehicleSnapshot,
  WorldSnapshot,
} from './vehicle';
export { World } from './world';
export type { WorldDeps, WorldOptions, SectionStats, SmoothTime } from './world';

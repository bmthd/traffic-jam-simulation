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
export { Vehicle, mergeCongestion, nextArrivalDistance, smoothstepRange } from './vehicle';
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
  VehicleSnapshot,
  WorldSnapshot,
} from './vehicle';
export { World } from './world';
export type { WorldOptions, SectionStats, SmoothTime } from './world';

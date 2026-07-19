/* ============================================================
   シミュレーションコアの公開API
   ここ以下 (src/core/) は DOM / THREE 非依存を保つこと。
   Node のテスト (traffic-simulation.test.ts) はこのモジュールを
   直接 import して実行する。描画コードをここに書かないこと。
   ============================================================ */
export { CONST, TYPES, TYPE_WEIGHTS } from './constants';
export type {
  Section,
  SimMode,
  NumericSimParam,
  VehicleTypeName,
  VehicleTypeSpec,
} from './constants';
export { clamp, lerp, smooth, createRng, WRAP_LENGTH, wrapDelta } from './utils';
export type { Rng } from './utils';
export { Vehicle } from './vehicle';
export type { LaneChange, LaneChangeState, NeighborInfo } from './vehicle';
export { World } from './world';
export type { WorldOptions, SectionStats, SmoothTime } from './world';

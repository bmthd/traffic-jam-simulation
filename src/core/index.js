/* ============================================================
   シミュレーションコアの公開API
   ここ以下 (src/core/) は DOM / THREE 非依存を保つこと。
   Node のテスト (traffic-simulation.test.js) はこのモジュールを
   直接 import して実行する。描画コードをここに書かないこと。
   ============================================================ */
export { CONST, TYPES, TYPE_WEIGHTS } from './constants.js';
export { clamp, lerp, smooth, createRng, WRAP, wrapDelta } from './utils.js';
export { Vehicle } from './vehicle.js';
export { World } from './world.js';

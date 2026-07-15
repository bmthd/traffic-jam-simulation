/* ============================================================
   シミュレーションコア: ユーティリティ
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import { CONST } from './constants.js';

export function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

// 周回路(リング)の全長。道路の端まで来た車は反対側へ連続的に回り込む。
// 渋滞の波が境界を継ぎ目なく通過できるため、入口で波が滞留する人工現象が起きない
export const WRAP = CONST.ROAD_HALF * 2 + 16;
export function wrapDelta(d){ // 周回路上の符号付き最短距離 (-WRAP/2, WRAP/2]
  d = d % WRAP;
  if (d > WRAP / 2) d -= WRAP;
  if (d <= -WRAP / 2) d += WRAP;
  return d;
}
export function lerp(a, b, t){ return a + (b - a) * t; }
export function smooth(t){ return t * t * (3 - 2 * t); }
// 乱数 (mulberry32) — テストで再現性を持たせるためシード指定可能
export function createRng(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

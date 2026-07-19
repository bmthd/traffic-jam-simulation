/* ============================================================
   シミュレーションコア: ユーティリティ
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import { CONST } from './constants';

/** 一様乱数 [0, 1) を返す関数(シード付き・なしを問わない) */
export type Rng = () => number;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// 周回路(リング)の全長。道路の端まで来た車は反対側へ連続的に回り込む。
// 渋滞の波が境界を継ぎ目なく通過できるため、入口で波が滞留する人工現象が起きない
export const WRAP_LENGTH = CONST.ROAD_HALF * 2 + 16;
export function wrapDelta(delta: number): number {
  // 周回路上の符号付き最短距離 (-WRAP_LENGTH/2, WRAP_LENGTH/2]
  delta = delta % WRAP_LENGTH;
  if (delta > WRAP_LENGTH / 2) delta -= WRAP_LENGTH;
  if (delta <= -WRAP_LENGTH / 2) delta += WRAP_LENGTH;
  return delta;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
// 乱数 (mulberry32) — テストで再現性を持たせるためシード指定可能
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return function () {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let scrambled = Math.imul(state ^ (state >>> 15), 1 | state);
    scrambled = (scrambled + Math.imul(scrambled ^ (scrambled >>> 7), 61 | scrambled)) ^ scrambled;
    return ((scrambled ^ (scrambled >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================= 周回路の描画補助 =================
   シミュレーション上の周回境界の前後にも同じ静的設備を配置し、
   車両固定の視点で道路が途切れて見えるのを防ぐ。 */
import { WRAP_LENGTH } from '../core';

/** 基準位置と、その前後1周ぶんの複製位置を返す。 */
export function loopCopies(z: number): [number, number, number] {
  return [z - WRAP_LENGTH, z, z + WRAP_LENGTH];
}

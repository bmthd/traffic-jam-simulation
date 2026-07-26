/* ================= 逆走ドローンカメラの構図 ================= */
import { CONST, WRAP_LENGTH } from '../core';

export interface DronePose {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

const DRONE_SPEED = 24;

/**
 * 道路上空を +Z 方向へ自律移動し、進行方向を向く構図を作る。
 * 車両には一切追従せず、道路1周ぶんを越えたら周回の始点へ戻る。
 */
export function reverseDronePose(time: number, centerX: number): DronePose {
  const distance = (time * DRONE_SPEED) % WRAP_LENGTH;
  const z = -CONST.ROAD_HALF + distance;
  return {
    position: { x: centerX, y: 25, z },
    target: { x: centerX, y: 4, z: z + 48 },
  };
}

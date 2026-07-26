/* ================= 車両追尾カメラの構図 ================= */

export interface FollowTarget {
  x: number;
  z: number;
}

export interface FollowPose {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

/**
 * -Z へ進む車両の前方から後方を向く正面追尾の構図を作る。
 * 少し横に寄せて車体の正面だけでなく側面の動きも見せる。
 */
export function headOnFollowPose(vehicle: FollowTarget): FollowPose {
  return {
    position: { x: vehicle.x + 3.5, y: 3.3, z: vehicle.z - 13 },
    target: { x: vehicle.x, y: 1.25, z: vehicle.z + 4.5 },
  };
}

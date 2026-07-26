/* ================= カメラ構図の端末向き判定 ================= */

/**
 * 横幅が高さ以上なら、道路の進行方向を横に見せる俯瞰構図を選ぶ。
 * 正方形も構図の変化を付けるため横向きとして扱う。
 */
export function isLandscapeViewport(width: number, height: number): boolean {
  return width >= height;
}

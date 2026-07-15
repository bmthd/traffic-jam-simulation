/* ================= 共有マテリアル・テクスチャ =================
   昼夜テーマ (theme.js) が色を書き換えるマテリアルと、
   複数モジュール(車両メッシュ・夜景アセット)が共有するマテリアルを
   1箇所に集約する。モジュール間の循環importを避けるための土台 */
import * as THREE from 'three';

// 放射状グラデーションのテクスチャ(光だまり・ヘッドライト用)
export function makeGlowTexture(inner, outer){
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c2 = cv.getContext('2d');
  const grad = c2.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  c2.fillStyle = grad;
  c2.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

/* ---- 車両ボディ(色ごとに共有) ---- */
const matCache = {};
export function lambert(hex){
  if (!matCache[hex]) matCache[hex] = new THREE.MeshLambertMaterial({ color: hex });
  return matCache[hex];
}
export const glassMat = new THREE.MeshLambertMaterial({ color: 0x223a4d });
export const tireMat  = new THREE.MeshLambertMaterial({ color: 0x1a1a1f });
export const cargoMat = new THREE.MeshLambertMaterial({ color: 0xe8eaee });
export const headMat  = new THREE.MeshLambertMaterial({ color: 0xfff6d8, emissive: 0x6b6346 });

/* ---- 道路施設(昼夜で色が変わるもの) ---- */
export const delinMat = new THREE.MeshBasicMaterial({ color: 0x9aa3ad }); // 視線誘導標
export const lampHeadMat = new THREE.MeshLambertMaterial({ color: 0xd8d2b8, emissive: 0x000000 }); // 街灯灯具

/* ---- 夜景アセット(opacityをテーマがフェード) ---- */
// 星空
export const starMat = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2,
  sizeAttenuation: false, fog: false, transparent: true, opacity: 0, depthWrite: false });
// 月とハロー
export const moonMat = new THREE.MeshBasicMaterial({ color: 0xf4f1dc, fog: false, transparent: true, opacity: 0 });
export const haloMat = new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(214,226,255,0.30)', 'rgba(214,226,255,0)'),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0 });
// 街灯の路面光だまり・電球のにじみ
export const lampGlowMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,195,107,0.55)', 'rgba(255,195,107,0)'),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
export const bulbMat = new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(255,216,150,0.9)', 'rgba(255,170,80,0)'),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
// 標識ゲートの投光
export const signGlowMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,244,214,0.40)', 'rgba(255,244,214,0)'),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  side: THREE.DoubleSide, opacity: 0 });

/* ---- 車両の灯火エフェクト ---- */
// ブレーキ灯のにじみ(共有マテリアル)
export const brakeGlowMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,40,40,0.85)', 'rgba(255,40,40,0)'),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
export const brakeGlowGeo = new THREE.PlaneGeometry(2.0, 0.8);
// ヘッドライトの路面照射(夜のみ・車両ごとに1枚)
export const beamMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,240,190,0.50)', 'rgba(255,240,190,0)'),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
export const beamGeo = new THREE.PlaneGeometry(4.6, 9.5);

/* ================= Three.js セットアップ(シーン・カメラ・ライト) ================= */
import * as THREE from 'three';
import { CONST } from '../core';
import { makeGrassTexture } from './materials';

export const SKY_COLOR = 0xcfe2ee;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.Fog(SKY_COLOR, 140, 420); // 遠景処理: 遠方が背景に溶け込む

// 遠景と地面をカメラの進行位置へ追従させ、周回を重ねても相対位置を保つ。
export const backgroundAnchor = new THREE.Group();
scene.add(backgroundAnchor);

export function syncBackgroundAnchor(): void {
  backgroundAnchor.position.z = camera.position.z;
}

export const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 1200);

function createRenderer(): THREE.WebGLRenderer {
  try {
    return new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    throw new Error('WebGLの初期化に失敗しました。' + (e as Error).message);
  }
}
export const renderer = createRenderer();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('container')!.appendChild(renderer.domElement);

/* ---- ライティング ---- */
export const hemiLight = new THREE.HemisphereLight(0xeaf4ff, 0x55694f, 0.85);
scene.add(hemiLight);
export const sun = new THREE.DirectionalLight(0xfff3df, 0.95);
const sunDirection = new THREE.Vector3(70, 130, 50).normalize();
sun.position.copy(sunDirection).multiplyScalar(420);
sun.castShadow = true;
// three r128 の LightShadow.updateMatrices() は shadow.camera.lookAt() で光源から target を向く。
// そのため left/right はワールド X ではなくシャドウカメラのローカル X 軸に対応する。
// up を光軸とワールド Z の両方に直交する向きへ回し、ローカル X を道路長手方向 Z に揃える。
// バージョンアップで LightShadow の lookAt() 前提が変わると、この軸合わせも再確認が必要。
sun.shadow.camera.up
  .copy(sunDirection)
  .cross(new THREE.Vector3(0, 0, 1))
  .normalize();
const shadowAxisX = new THREE.Vector3()
  .crossVectors(sun.shadow.camera.up, sunDirection)
  .normalize();
const shadowAxisY = sun.shadow.camera.up.clone();
const shadowAxisZ = sunDirection.clone();
// 並木は scenery.ts で x = ±(22 + rand^1.6 * 70) なので最大 ±92m。
// 樹冠と端部の余裕を含め、道路全体を覆う直方体として扱う。
const shadowBoundsHalfSize = new THREE.Vector3(100, 14, CONST.ROAD_HALF + 24);
function shadowHalfExtent(axis: THREE.Vector3): number {
  return (
    Math.abs(axis.x) * shadowBoundsHalfSize.x +
    Math.abs(axis.y) * shadowBoundsHalfSize.y +
    Math.abs(axis.z) * shadowBoundsHalfSize.z
  );
}
const shadowHalfWidth = shadowHalfExtent(shadowAxisX);
const shadowHalfHeight = shadowHalfExtent(shadowAxisY);
const shadowHalfDepth = shadowHalfExtent(shadowAxisZ);
sun.shadow.mapSize.set(4096, 2048);
// 約841m×189mの範囲で縦約10.8px/mを確保し、太さ0.2mの支柱を約2テクセルで描く。
// 深度テクスチャは約32MBになるが、静的な設備中心で追加描画は数十 draw call に留まる。
// WebGL の MAX_TEXTURE_SIZE 保証値は 2048。上限が低い端末では three が 2048x2048 へ縮める。
sun.shadow.camera.left = -shadowHalfWidth;
sun.shadow.camera.right = shadowHalfWidth;
sun.shadow.camera.top = shadowHalfHeight;
sun.shadow.camera.bottom = -shadowHalfHeight;
sun.shadow.camera.near = Math.max(1, sun.position.length() - shadowHalfDepth);
sun.shadow.camera.far = sun.position.length() + shadowHalfDepth;
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = 0.025;
scene.add(sun);

/* ---- 地面（草地。背景の透け防止のため広く・低く配置） ---- */
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1600, 1600),
  new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeGrassTexture() }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.18;
ground.receiveShadow = true;
backgroundAnchor.add(ground);

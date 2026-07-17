/* ================= Three.js セットアップ(シーン・カメラ・ライト) ================= */
import * as THREE from 'three';
import { makeRicePaddyTexture } from './materials';

export const SKY = 0xcfe2ee;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 140, 420); // 遠景処理: 遠方が背景に溶け込む

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
export const hemi = new THREE.HemisphereLight(0xeaf4ff, 0x55694f, 0.85);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff3df, 0.95);
sun.position.set(70, 130, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -170;
sun.shadow.camera.right = 170;
sun.shadow.camera.top = 220;
sun.shadow.camera.bottom = -220;
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 500;
sun.shadow.bias = -0.0006;
scene.add(sun);

/* ---- 地面（田んぼ。背景の透け防止のため広く・低く配置） ---- */
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1600, 1600),
  new THREE.MeshLambertMaterial({ color: 0xffffff, map: makeRicePaddyTexture() }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.18;
ground.receiveShadow = true;
scene.add(ground);

/* ================= ナイトモード用アセット(空・星・月・街灯・投光) ================= */
import * as THREE from 'three';
import { CONST as C } from '../core';
import { scene } from './scene';
import {
  starMat,
  moonMat,
  haloMat,
  lampHeadMat,
  lampGlowMat,
  bulbMat,
  signGlowMat,
} from './materials';
import { GANTRY_Z } from './track';

const ROAD_HALF = C.ROAD_HALF;

// 夜だけ表示するものをまとめるグループ
export const nightGroup = new THREE.Group();
nightGroup.visible = false;
scene.add(nightGroup);

// 空: 縦グラデーションのドーム(昼ドームの内側に夜ドームを重ね、opacityでクロスフェード)
function makeSkyDome(
  stops: [number, string][],
  radius: number,
  order: number,
): THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> {
  const cv = document.createElement('canvas');
  cv.width = 2;
  cv.height = 512;
  const c2 = cv.getContext('2d')!;
  const grad = c2.createLinearGradient(0, 0, 0, 512);
  for (const [o, c] of stops) grad.addColorStop(o, c);
  c2.fillStyle = grad;
  c2.fillRect(0, 0, 2, 512);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 15, 0, Math.PI * 2, 0, Math.PI / 2 + 0.22),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(cv),
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  mesh.renderOrder = order;
  scene.add(mesh);
  return mesh;
}
makeSkyDome(
  [
    [0, '#9fc6e4'],
    [0.55, '#cfe2ee'],
    [1, '#eef4f6'],
  ],
  1005,
  -20,
); // 昼
export const nightDome = makeSkyDome(
  [
    [0, '#02040d'],
    [0.42, '#0a1226'],
    [0.76, '#1b2440'],
    [0.92, '#3a3046'],
    [1, '#4c3b41'],
  ],
  995,
  -19,
); // 夜: 天頂の濃紺 → 地平線の街明かり(暖色)
nightDome.material.opacity = 0;

// 星空(夜空ドーム上にランダム配置・天頂寄りに密集)
(function buildStars() {
  const N = 700,
    pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(0.15 + Math.random() * 0.85); // 地平線近くは疎に
    const r = 950;
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(geo, starMat);
  stars.renderOrder = -18;
  nightGroup.add(stars);
})();

// 月(ハロー付き)
(function buildMoon() {
  const moon = new THREE.Mesh(new THREE.CircleGeometry(26, 32), moonMat);
  moon.position.set(330, 520, 260);
  moon.lookAt(0, 0, 0);
  moon.renderOrder = -17;
  nightGroup.add(moon);
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(170, 170, 1);
  halo.position.copy(moon.position);
  halo.renderOrder = -17;
  nightGroup.add(halo);
})();

// 街灯(中央分離帯から両側へアームを伸ばすダブルアーム式・ナトリウム灯)
(function buildStreetLamps() {
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x6f7780 });
  const poleGeo = new THREE.BoxGeometry(0.2, 7.2, 0.2);
  const armGeo = new THREE.BoxGeometry(5.4, 0.16, 0.16);
  const headGeo = new THREE.BoxGeometry(0.9, 0.22, 0.42);
  const glowGeo = new THREE.PlaneGeometry(13, 13);
  for (let z = -ROAD_HALF + 14; z < ROAD_HALF; z += 42) {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(0, 3.6, z);
    pole.matrixAutoUpdate = false;
    pole.updateMatrix();
    scene.add(pole);
    const arm = new THREE.Mesh(armGeo, poleMat);
    arm.position.set(0, 7.1, z);
    arm.matrixAutoUpdate = false;
    arm.updateMatrix();
    scene.add(arm);
    for (const sx of [-1, 1]) {
      const head = new THREE.Mesh(headGeo, lampHeadMat);
      head.position.set(sx * 2.6, 7.0, z);
      head.matrixAutoUpdate = false;
      head.updateMatrix();
      scene.add(head);
      // 電球のにじみ(夜のみ): 灯具が光源として「光って見える」ように
      const bulb = new THREE.Sprite(bulbMat);
      bulb.scale.set(2.6, 2.6, 1);
      bulb.position.set(sx * 2.6, 6.92, z);
      nightGroup.add(bulb);
      // 路面の光だまり(夜のみ)
      const glow = new THREE.Mesh(glowGeo, lampGlowMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(sx * 3.2, 0.03, z);
      glow.matrixAutoUpdate = false;
      glow.updateMatrix();
      nightGroup.add(glow);
    }
  }
})();

// 標識ゲートの投光(夜は案内標識が照明で浮かび上がる)
for (const z of GANTRY_Z) {
  for (const cx of [-7, 7]) {
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(13.5, 5.6), signGlowMat);
    glow.position.set(cx, 8.3, z);
    nightGroup.add(glow);
  }
}

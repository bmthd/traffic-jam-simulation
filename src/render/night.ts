/* ================= ナイトモード用アセット(空・星・月・街灯・投光) ================= */
import * as THREE from 'three';
import { CONST } from '../core';
import { scene } from './scene';
import {
  starMaterial,
  moonMaterial,
  haloMaterial,
  lampHeadMaterial,
  lampGlowMaterial,
  bulbMaterial,
  signGlowMaterial,
} from './materials';
import { GANTRY_Z } from './track';
import { instancedAt, instancedWith } from './instancing';

const ROAD_HALF = CONST.ROAD_HALF;

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
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, 512);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 15, 0, Math.PI * 2, 0, Math.PI / 2 + 0.22),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas),
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
  const starCount = 700,
    positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(0.15 + Math.random() * 0.85); // 地平線近くは疎に
    const radius = 950;
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(geometry, starMaterial);
  stars.renderOrder = -18;
  nightGroup.add(stars);
})();

// 月(ハロー付き)
(function buildMoon() {
  const moon = new THREE.Mesh(new THREE.CircleGeometry(26, 32), moonMaterial);
  moon.position.set(330, 520, 260);
  moon.lookAt(0, 0, 0);
  moon.renderOrder = -17;
  nightGroup.add(moon);
  const halo = new THREE.Sprite(haloMaterial);
  halo.scale.set(170, 170, 1);
  halo.position.copy(moon.position);
  halo.renderOrder = -17;
  nightGroup.add(halo);
})();

// 街灯(中央分離帯から両側へアームを伸ばすダブルアーム式・ナトリウム灯)
(function buildStreetLamps() {
  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0x6f7780 });
  const poleGeometry = new THREE.BoxGeometry(0.2, 7.2, 0.2);
  const armGeometry = new THREE.BoxGeometry(5.4, 0.16, 0.16);
  const headGeometry = new THREE.BoxGeometry(0.9, 0.22, 0.42);
  const glowGeometry = new THREE.PlaneGeometry(13, 13);
  const polePositions: [number, number, number][] = [];
  const armPositions: [number, number, number][] = [];
  const headPositions: [number, number, number][] = [];
  const glowMatrices: THREE.Matrix4[] = [];
  const glowRotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  for (let z = -ROAD_HALF + 14; z < ROAD_HALF; z += 42) {
    polePositions.push([0, 3.6, z]);
    armPositions.push([0, 7.1, z]);
    for (const side of [-1, 1]) {
      headPositions.push([side * 2.6, 7.0, z]);
      // 電球のにじみ(夜のみ): 灯具が光源として「光って見える」ように
      const bulb = new THREE.Sprite(bulbMaterial);
      bulb.scale.set(2.6, 2.6, 1);
      bulb.position.set(side * 2.6, 6.92, z);
      nightGroup.add(bulb);
      // 路面の光だまり(夜のみ)
      glowMatrices.push(glowRotation.clone().setPosition(side * 3.2, 0.03, z));
    }
  }
  scene.add(instancedAt(poleGeometry, poleMaterial, polePositions));
  scene.add(instancedAt(armGeometry, poleMaterial, armPositions));
  scene.add(instancedAt(headGeometry, lampHeadMaterial, headPositions));
  nightGroup.add(instancedWith(glowGeometry, lampGlowMaterial, glowMatrices));
})();

// 標識ゲートの投光(夜は案内標識が照明で浮かび上がる)
{
  const signGlowPositions: [number, number, number][] = [];
  for (const z of GANTRY_Z)
    for (const centerX of [-7, 7]) signGlowPositions.push([centerX, 8.3, z]);
  nightGroup.add(
    instancedAt(new THREE.PlaneGeometry(13.5, 5.6), signGlowMaterial, signGlowPositions),
  );
}

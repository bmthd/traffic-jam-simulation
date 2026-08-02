/* ================= ナイトモード用アセット(空・星・月・街灯・投光) ================= */
import * as THREE from 'three';
import { WRAP_LENGTH } from '../core';
import { backgroundAnchor, scene } from './scene';
import {
  starMaterial,
  moonMaterial,
  haloMaterial,
  lampHeadMaterial,
  lampGlowMaterial,
  bulbMaterial,
  signGlowMaterial,
} from './materials';
import { SIGN_GLOW_SPECS } from './track';
import { instancedAt, instancedWith } from './instancing';
import { loopCopies } from './looping';

// 夜だけ表示するものをまとめるグループ
export const nightGroup = new THREE.Group();
nightGroup.visible = false;
scene.add(nightGroup);
export const nightSkyGroup = new THREE.Group();
nightSkyGroup.visible = false;
backgroundAnchor.add(nightSkyGroup);

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
  backgroundAnchor.add(mesh);
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
  nightSkyGroup.add(stars);
})();

// 月(ハロー付き)
(function buildMoon() {
  const moon = new THREE.Mesh(new THREE.CircleGeometry(26, 32), moonMaterial);
  moon.position.set(330, 520, 260);
  moon.lookAt(0, 0, 0);
  moon.renderOrder = -17;
  nightSkyGroup.add(moon);
  const halo = new THREE.Sprite(haloMaterial);
  halo.scale.set(170, 170, 1);
  halo.position.copy(moon.position);
  halo.renderOrder = -17;
  nightSkyGroup.add(halo);
})();

// 街灯(区間の仕切りの上から両側へアームを伸ばすダブルアーム式・ナトリウム灯)。
// #28 で2本の道路は同じ向きの平行配置になったため、その境目に1列だけ立て、
// 両区間を左右対称に照らす。
// 柱の位置は「両区間の車線中心の中点(x=1.6)」ではなく、区間の仕切り(ガードレール
// 基礎 x=-0.4〜0.4)の中心。中点はR区間の側道の舗装帯(x=0.4〜4.2)の中に入って
// しまい、柱が車道の中に立ってしまうため (Issue #87)
const LAMP_ROW_X = 0; // 区間の仕切り(ガードレール基礎)の中心 = 左右対称の軸
// 灯具の張り出し。L側は追い越し車線の中心(x=-3)、R側はその鏡像(x=+3)で側道の上に載る
const LAMP_HEAD_OFFSET_X = 3;
// 路面の光だまりの中心。灯具より少し外側に置き、両区間の舗装帯を等しく照らす
const LAMP_GLOW_OFFSET_X = 3.6;
(function buildStreetLamps() {
  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0x6f7780 });
  const poleGeometry = new THREE.BoxGeometry(0.2, 7.2, 0.2);
  // アームは両側の灯具(±3)を渡せる長さにする
  const armGeometry = new THREE.BoxGeometry(6.2, 0.16, 0.16);
  const headGeometry = new THREE.BoxGeometry(0.9, 0.22, 0.42);
  const glowGeometry = new THREE.PlaneGeometry(13, 13);
  const polePositions: [number, number, number][] = [];
  const armPositions: [number, number, number][] = [];
  const headPositions: [number, number, number][] = [];
  const glowMatrices: THREE.Matrix4[] = [];
  const glowRotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  // 総延長4倍と前後周回の複製で負荷が増えるため、延長前と同じ総数に制限する。
  const lampSpacing = WRAP_LENGTH / 24;
  for (let z = -WRAP_LENGTH / 2 + lampSpacing / 2; z < WRAP_LENGTH / 2; z += lampSpacing) {
    for (const copyZ of loopCopies(z)) {
      polePositions.push([LAMP_ROW_X, 3.6, copyZ]);
      armPositions.push([LAMP_ROW_X, 7.1, copyZ]);
      for (const side of [-1, 1]) {
        headPositions.push([LAMP_ROW_X + side * LAMP_HEAD_OFFSET_X, 7.0, copyZ]);
        // 電球のにじみ(夜のみ): 灯具が光源として「光って見える」ように
        // 発光表現が影を落とすと不自然なため castShadow は設定しない
        const bulb = new THREE.Sprite(bulbMaterial);
        bulb.scale.set(2.6, 2.6, 1);
        bulb.position.set(LAMP_ROW_X + side * LAMP_HEAD_OFFSET_X, 6.92, copyZ);
        nightGroup.add(bulb);
        // 路面の光だまり(夜のみ)
        glowMatrices.push(
          glowRotation.clone().setPosition(LAMP_ROW_X + side * LAMP_GLOW_OFFSET_X, 0.03, copyZ),
        );
      }
    }
  }
  const poles = instancedAt(poleGeometry, poleMaterial, polePositions);
  poles.castShadow = true;
  scene.add(poles);
  const arms = instancedAt(armGeometry, poleMaterial, armPositions);
  arms.castShadow = true;
  scene.add(arms);
  const heads = instancedAt(headGeometry, lampHeadMaterial, headPositions);
  heads.castShadow = true;
  scene.add(heads);
  // 夜のみ表示する発光表現が影を落とすと不自然なため castShadow は設定しない
  nightGroup.add(instancedWith(glowGeometry, lampGlowMaterial, glowMatrices));
})();

// 案内標識の投光(夜は標識が照明で浮かび上がる)
// 夜のみ表示する発光表現が影を落とすと不自然なため castShadow は設定しない
{
  for (const spec of SIGN_GLOW_SPECS)
    nightGroup.add(
      instancedAt(new THREE.PlaneGeometry(spec.width, spec.height), signGlowMaterial, [
        [spec.x, spec.y, spec.z],
      ]),
    );
}

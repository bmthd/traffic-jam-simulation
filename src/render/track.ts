/* ================= 道路・標識などの静的な情景 ================= */
import * as THREE from 'three';
import { CONST } from '../core';
import type { Section } from '../core';
import { scene } from './scene';
import { delineatorMaterial, asphaltTexture } from './materials';
import { instancedAt, instancedWith } from './instancing';

const ROAD_HALF = CONST.ROAD_HALF;

/* ---- 区間テーマカラー(どの角度から見ても区別できるように) ---- */
export interface SectionTheme {
  road: number;
  strip: number;
  signBackground: string;
  title: string;
  subtitle: string;
}
// road はアスファルトテクスチャ(平均約0.73)と乗算されるため明るめに設定
export const SECTION_THEME: Record<Section, SectionTheme> = {
  L: {
    road: 0x4d5c53,
    strip: 0x1fb46a,
    signBackground: '#0d8c4d',
    title: '義務あり',
    subtitle: 'ゆずりあい区間',
  },
  R: {
    road: 0x60564a,
    strip: 0xf2a32b,
    signBackground: '#c17a08',
    title: '義務なし',
    subtitle: 'マイペース区間',
  },
};

/* ---- 道路(アスファルト質感 + 区間ごとの色味) ---- */
for (const [section, centerX] of [
  ['L', -7],
  ['R', 7],
] as [Section, number][]) {
  const road = new THREE.Mesh(
    new THREE.BoxGeometry(13.2, 0.12, ROAD_HALF * 2),
    new THREE.MeshLambertMaterial({ color: SECTION_THEME[section].road, map: asphaltTexture }),
  );
  road.position.set(centerX, -0.06, 0);
  road.receiveShadow = true;
  scene.add(road);
  // 外側の路肩ライン(テーマカラー)
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.06, ROAD_HALF * 2),
    new THREE.MeshBasicMaterial({ color: SECTION_THEME[section].strip }),
  );
  strip.position.set(centerX < 0 ? -14.1 : 14.1, -0.03, 0);
  scene.add(strip);
}

/* ---- 車線マーキング ---- */
const whiteLineMaterial = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
function solidLine(x: number): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, ROAD_HALF * 2), whiteLineMaterial);
  mesh.position.set(x, 0.01, 0);
  scene.add(mesh);
}
// 車線境界の破線は全車線ぶんを1つのInstancedMeshに(draw call削減)
function dashedLines(xPositions: number[]): void {
  const geometry = new THREE.BoxGeometry(0.15, 0.02, 4);
  const positions: [number, number, number][] = [];
  for (const x of xPositions)
    for (let z = -ROAD_HALF + 2; z < ROAD_HALF; z += 12) positions.push([x, 0.01, z]);
  scene.add(instancedAt(geometry, whiteLineMaterial, positions));
}
[-1, -13, 1, 13].forEach(solidLine);
dashedLines([-5, -9, 5, 9]);

/* ---- 合流ランプ(加速車線) ---- */
for (const [section, side] of [
  ['L', -1],
  ['R', 1],
] as [Section, number][]) {
  const zTop = CONST.RAMP_Z_TOP + 14,
    zEnd = CONST.RAMP_Z_END - 16;
  const length = zTop - zEnd,
    zCenter = (zTop + zEnd) / 2;
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.12, length),
    new THREE.MeshLambertMaterial({ color: SECTION_THEME[section].road, map: asphaltTexture }),
  );
  ramp.position.set(15 * side, -0.055, zCenter);
  ramp.receiveShadow = true;
  scene.add(ramp);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, length), whiteLineMaterial);
  edge.position.set(16.7 * side, 0.012, zCenter);
  scene.add(edge);
  // 本線との境界は破線(合流可)
  const dashGeometry = new THREE.BoxGeometry(0.15, 0.02, 3);
  const dashPositions: [number, number, number][] = [];
  for (let z = zEnd + 12; z < zTop - 6; z += 9) dashPositions.push([13 * side, 0.012, z]);
  scene.add(instancedAt(dashGeometry, whiteLineMaterial, dashPositions));
  // 終端の導流帯(先細りのゼブラ)。単位ボックスをX方向スケールで先細りに
  const zebraGeometry = new THREE.BoxGeometry(1, 0.02, 1.3);
  const zebraMatrices: THREE.Matrix4[] = [];
  for (let i = 0; i < 5; i++) {
    const width = 3.0 * (1 - i / 5);
    zebraMatrices.push(
      new THREE.Matrix4()
        .makeScale(width, 1, 1)
        .setPosition((13.1 + width / 2) * side, 0.012, zEnd + 9 - i * 3.2),
    );
  }
  scene.add(instancedWith(zebraGeometry, whiteLineMaterial, zebraMatrices));
}

/* ---- 中央分離帯（ガードレール付き） ---- */
(function buildMedian() {
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.5, ROAD_HALF * 2),
    new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }),
  );
  base.position.set(0, 0.25, 0);
  base.castShadow = true;
  base.receiveShadow = true;
  scene.add(base);
  const railMaterial = new THREE.MeshLambertMaterial({ color: 0xe9edf0 });
  for (const railX of [-0.6, 0.6]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, ROAD_HALF * 2), railMaterial);
    rail.position.set(railX, 0.95, 0);
    scene.add(rail);
  }
  const postGeometry = new THREE.BoxGeometry(0.12, 0.55, 0.12);
  const delineatorGeometry = new THREE.BoxGeometry(0.16, 0.16, 0.06); // 視線誘導標(デリネーター)
  const postPositions: [number, number, number][] = [];
  const delineatorPositions: [number, number, number][] = [];
  for (let z = -ROAD_HALF + 6; z < ROAD_HALF; z += 18) {
    postPositions.push([0, 0.75, z]);
    // 両進行方向から見えるよう両面に
    for (const offsetZ of [-0.09, 0.09]) delineatorPositions.push([0, 1.12, z + offsetZ]);
  }
  scene.add(instancedAt(postGeometry, railMaterial, postPositions));
  scene.add(instancedAt(delineatorGeometry, delineatorMaterial, delineatorPositions));
})();

/* ---- 路面ペイント（区間ルールの表示・遊び心） ---- */
function roadText(text: string, x: number, z: number): void {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 640;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 640);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 118px sans-serif';
  ctx.textAlign = 'center';
  text.split('').forEach((char, i) => ctx.fillText(char, 128, 140 + i * 128));
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 12.5),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = 0;
  mesh.position.set(x, 0.015, z);
  scene.add(mesh);
}
roadText('義務あり', -7, -120);
roadText('義務なし', 7, -120);
roadText('ゆずりあい', -7, 60);
roadText('マイペース', 7, 60);

/* ---- 頭上標識ゲート(カメラをどう回しても区間が分かるように両面・両端に設置) ---- */
export const GANTRY_Z = [-300, -100, 100, 300];
function makeSignTexture(title: string, subtitle: string, background: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 512, 160);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 10;
  ctx.strokeRect(8, 8, 496, 144);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText(title, 256, 74);
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(subtitle, 256, 126);
  return new THREE.CanvasTexture(canvas);
}
function buildGantry(section: Section, z: number): void {
  const theme = SECTION_THEME[section];
  const centerX = section === 'L' ? -7 : 7;
  const group = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: 0x99a1aa });
  for (const postX of [centerX - 6.9, centerX + 6.9]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 6.6, 0.35), steel);
    post.position.set(postX, 3.3, z);
    post.castShadow = true;
    group.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(14.5, 0.4, 0.4), steel);
  beam.position.set(centerX, 6.4, z);
  beam.castShadow = true;
  group.add(beam);
  const texture = makeSignTexture(theme.title, theme.subtitle, theme.signBackground);
  const boardGeometry = new THREE.PlaneGeometry(10.5, 3.3);
  const boardMaterial = new THREE.MeshBasicMaterial({ map: texture });
  for (const dir of [1, -1]) {
    // 両面に設置(裏からも正しく読める)
    const board = new THREE.Mesh(boardGeometry, boardMaterial);
    board.position.set(centerX, 8.3, z + dir * 0.06);
    if (dir === -1) board.rotation.y = Math.PI;
    group.add(board);
  }
  scene.add(group);
}
for (const section of ['L', 'R'] as const) {
  for (const gantryZ of GANTRY_Z) buildGantry(section, gantryZ);
}

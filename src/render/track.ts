/* ================= 道路・標識などの静的な情景 ================= */
import * as THREE from 'three';
import { CONST as C } from '../core';
import type { Section } from '../core';
import { scene } from './scene';
import { delinMat, asphaltTex } from './materials';
import { instancedAt, instancedWith } from './instancing';

const ROAD_HALF = C.ROAD_HALF;

/* ---- 区間テーマカラー(どの角度から見ても区別できるように) ---- */
export interface SectionTheme {
  road: number;
  strip: number;
  signBg: string;
  title: string;
  sub: string;
}
// road はアスファルトテクスチャ(平均約0.73)と乗算されるため明るめに設定
export const SECTION_THEME: Record<Section, SectionTheme> = {
  L: {
    road: 0x4d5c53,
    strip: 0x1fb46a,
    signBg: '#0d8c4d',
    title: '義務あり',
    sub: 'ゆずりあい区間',
  },
  R: {
    road: 0x60564a,
    strip: 0xf2a32b,
    signBg: '#c17a08',
    title: '義務なし',
    sub: 'マイペース区間',
  },
};

/* ---- 道路(アスファルト質感 + 区間ごとの色味) ---- */
for (const [sec, cx] of [
  ['L', -7],
  ['R', 7],
] as [Section, number][]) {
  const road = new THREE.Mesh(
    new THREE.BoxGeometry(13.2, 0.12, ROAD_HALF * 2),
    new THREE.MeshLambertMaterial({ color: SECTION_THEME[sec].road, map: asphaltTex }),
  );
  road.position.set(cx, -0.06, 0);
  road.receiveShadow = true;
  scene.add(road);
  // 外側の路肩ライン(テーマカラー)
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.06, ROAD_HALF * 2),
    new THREE.MeshBasicMaterial({ color: SECTION_THEME[sec].strip }),
  );
  strip.position.set(cx < 0 ? -14.1 : 14.1, -0.03, 0);
  scene.add(strip);
}

/* ---- 車線マーキング ---- */
const lineMatW = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
function solidLine(x: number): void {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, ROAD_HALF * 2), lineMatW);
  m.position.set(x, 0.01, 0);
  scene.add(m);
}
// 車線境界の破線は全車線ぶんを1つのInstancedMeshに(draw call削減)
function dashedLines(xs: number[]): void {
  const geo = new THREE.BoxGeometry(0.15, 0.02, 4);
  const at: [number, number, number][] = [];
  for (const x of xs) for (let z = -ROAD_HALF + 2; z < ROAD_HALF; z += 12) at.push([x, 0.01, z]);
  scene.add(instancedAt(geo, lineMatW, at));
}
[-1, -13, 1, 13].forEach(solidLine);
dashedLines([-5, -9, 5, 9]);

/* ---- 合流ランプ(加速車線) ---- */
for (const [sec, sx] of [
  ['L', -1],
  ['R', 1],
] as [Section, number][]) {
  const zTop = C.RAMP_Z_TOP + 14,
    zEnd = C.RAMP_Z_END - 16;
  const len = zTop - zEnd,
    zc = (zTop + zEnd) / 2;
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.12, len),
    new THREE.MeshLambertMaterial({ color: SECTION_THEME[sec].road, map: asphaltTex }),
  );
  ramp.position.set(15 * sx, -0.055, zc);
  ramp.receiveShadow = true;
  scene.add(ramp);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, len), lineMatW);
  edge.position.set(16.7 * sx, 0.012, zc);
  scene.add(edge);
  // 本線との境界は破線(合流可)
  const dGeo = new THREE.BoxGeometry(0.15, 0.02, 3);
  const dashAt: [number, number, number][] = [];
  for (let z = zEnd + 12; z < zTop - 6; z += 9) dashAt.push([13 * sx, 0.012, z]);
  scene.add(instancedAt(dGeo, lineMatW, dashAt));
  // 終端の導流帯(先細りのゼブラ)。単位ボックスをX方向スケールで先細りに
  const zebraGeo = new THREE.BoxGeometry(1, 0.02, 1.3);
  const zebraMs: THREE.Matrix4[] = [];
  for (let i = 0; i < 5; i++) {
    const w = 3.0 * (1 - i / 5);
    zebraMs.push(
      new THREE.Matrix4()
        .makeScale(w, 1, 1)
        .setPosition((13.1 + w / 2) * sx, 0.012, zEnd + 9 - i * 3.2),
    );
  }
  scene.add(instancedWith(zebraGeo, lineMatW, zebraMs));
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
  const railMat = new THREE.MeshLambertMaterial({ color: 0xe9edf0 });
  for (const rx of [-0.6, 0.6]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, ROAD_HALF * 2), railMat);
    rail.position.set(rx, 0.95, 0);
    scene.add(rail);
  }
  const postGeo = new THREE.BoxGeometry(0.12, 0.55, 0.12);
  const delinGeo = new THREE.BoxGeometry(0.16, 0.16, 0.06); // 視線誘導標(デリネーター)
  const postAt: [number, number, number][] = [];
  const delinAt: [number, number, number][] = [];
  for (let z = -ROAD_HALF + 6; z < ROAD_HALF; z += 18) {
    postAt.push([0, 0.75, z]);
    // 両進行方向から見えるよう両面に
    for (const dz of [-0.09, 0.09]) delinAt.push([0, 1.12, z + dz]);
  }
  scene.add(instancedAt(postGeo, railMat, postAt));
  scene.add(instancedAt(delinGeo, delinMat, delinAt));
})();

/* ---- 路面ペイント（区間ルールの表示・遊び心） ---- */
function roadText(text: string, x: number, z: number): void {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 640;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 640);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 118px sans-serif';
  ctx.textAlign = 'center';
  text.split('').forEach((c, i) => ctx.fillText(c, 128, 140 + i * 128));
  const tex = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 12.5),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = 0;
  m.position.set(x, 0.015, z);
  scene.add(m);
}
roadText('義務あり', -7, -120);
roadText('義務なし', 7, -120);
roadText('ゆずりあい', -7, 60);
roadText('マイペース', 7, 60);

/* ---- 頭上標識ゲート(カメラをどう回しても区間が分かるように両面・両端に設置) ---- */
export const GANTRY_Z = [-300, -100, 100, 300];
function makeSignTexture(title: string, sub: string, bg: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 160;
  const c2 = cv.getContext('2d')!;
  c2.fillStyle = bg;
  c2.fillRect(0, 0, 512, 160);
  c2.strokeStyle = '#ffffff';
  c2.lineWidth = 10;
  c2.strokeRect(8, 8, 496, 144);
  c2.fillStyle = '#ffffff';
  c2.textAlign = 'center';
  c2.font = 'bold 64px sans-serif';
  c2.fillText(title, 256, 74);
  c2.font = 'bold 34px sans-serif';
  c2.fillText(sub, 256, 126);
  return new THREE.CanvasTexture(cv);
}
function buildGantry(sec: Section, z: number): void {
  const th = SECTION_THEME[sec];
  const cx = sec === 'L' ? -7 : 7;
  const g = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: 0x99a1aa });
  for (const px of [cx - 6.9, cx + 6.9]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 6.6, 0.35), steel);
    post.position.set(px, 3.3, z);
    post.castShadow = true;
    g.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(14.5, 0.4, 0.4), steel);
  beam.position.set(cx, 6.4, z);
  beam.castShadow = true;
  g.add(beam);
  const tex = makeSignTexture(th.title, th.sub, th.signBg);
  const boardGeo = new THREE.PlaneGeometry(10.5, 3.3);
  const boardMat = new THREE.MeshBasicMaterial({ map: tex });
  for (const dir of [1, -1]) {
    // 両面に設置(裏からも正しく読める)
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.position.set(cx, 8.3, z + dir * 0.06);
    if (dir === -1) board.rotation.y = Math.PI;
    g.add(board);
  }
  scene.add(g);
}
for (const sec of ['L', 'R'] as const) {
  for (const gz of GANTRY_Z) buildGantry(sec, gz);
}

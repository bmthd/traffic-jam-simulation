/* ================= 道路・標識などの静的な情景 ================= */
import * as THREE from 'three';
import { CONST, RAMP_GEOMETRY, WRAP_LENGTH } from '../core';
import type { Section } from '../core';
import { scene } from './scene';
import { delineatorMaterial, asphaltTexture } from './materials';
import { instancedAt, instancedWith } from './instancing';
import { loopCopies } from './looping';

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

/* ---- 区間の座標系 ----
   道路の形は左右で同一。R区間は鏡像ではなくL区間の平行移動コピーなので、
   位置はすべて「L区間の座標系」で書き、区間ごとのオフセットを足して実座標にする。
   これで両区間とも 追い越し車線 = 右端 / 加速車線 = 左外側 に揃う (Issue #28) */
export const SECTIONS = ['L', 'R'] as const;
export function sectionX(section: Section, xInSectionFrame: number): number {
  return xInSectionFrame + CONST.SECTION_OFFSET_X[section];
}

/* ---- 側道と加速車線の連続性 ----
   側道(本線に並走する道)は本線の外側を全周にわたって走り、合流部だけ分離帯が切れて
   そのまま加速車線になる。「合流開放区間」= 分離帯を置かない = 加速車線として本線に開く区間 */
const MERGE_OPEN_START_Z = RAMP_GEOMETRY.gore.endZ; // 下流端(導流帯の終わり = 合流完了地点)
const MERGE_OPEN_END_Z = RAMP_GEOMETRY.entryZ + 14; // 上流端(加速車線の始まり)
// 側道が加速車線へ自然につながるよう、開放区間の前後12mで分離帯を先細りさせる。
const SEPARATOR_TAPER_LENGTH = 12;
const SEPARATOR_FULL_END_Z = MERGE_OPEN_START_Z - SEPARATOR_TAPER_LENGTH;
const SEPARATOR_FULL_START_Z = MERGE_OPEN_END_Z + SEPARATOR_TAPER_LENGTH;
// 分離帯の中心X・幅。本線の左端(-13)と側道の走行部の間に置き、区間テーマカラーで塗る
const SEPARATOR_X = -14.1;
const SEPARATOR_WIDTH = 0.7;
const SEPARATOR_POLE_SPACING = 9;
// 路肩の見上げ視点を遮らないよう、ポールは帯の外側寄りに立てる。
const SEPARATOR_POLE_X = -14.4;
// 分離帯の上面に高さ0.8mのポールの底面を揃える。
const SEPARATOR_POLE_CENTER_Y = 0.411;

/* ---- 道路(アスファルト質感 + 区間ごとの色味) ---- */
const roadGeometry = new THREE.BoxGeometry(13.2, 0.12, WRAP_LENGTH);
const frontageRoadGeometry = new THREE.BoxGeometry(3.6, 0.12, WRAP_LENGTH);
for (const section of SECTIONS) {
  const roadMaterial = new THREE.MeshLambertMaterial({
    color: SECTION_THEME[section].road,
    map: asphaltTexture,
  });
  const road = instancedAt(
    roadGeometry,
    roadMaterial,
    loopCopies(0).map((z): [number, number, number] => [sectionX(section, -7), -0.06, z]),
  );
  // 周回前後の複製をまとめているが、r128のカリングはインスタンス行列を見ず原点基準の球で判定するため、全周に及ぶ実体が丸ごと消えないよう無効化する。
  road.frustumCulled = false;
  road.receiveShadow = true;
  scene.add(road);

  // 合流部と同じ舗装帯を全周へ延ばし、側道がそのまま加速車線になる形にする。
  const frontageRoad = instancedAt(
    frontageRoadGeometry,
    roadMaterial,
    loopCopies(0).map((z): [number, number, number] => [sectionX(section, -15), -0.055, z]),
  );
  frontageRoad.frustumCulled = false;
  frontageRoad.receiveShadow = true;
  scene.add(frontageRoad);
}

/* ---- 車線マーキング ---- */
const whiteLineMaterial = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
function solidLines(
  xPositions: number[],
  startZ = -WRAP_LENGTH / 2,
  endZ = WRAP_LENGTH / 2,
  y = 0.01,
): void {
  const length = endZ - startZ;
  const centerZ = (startZ + endZ) / 2;
  const positions = xPositions.flatMap((x) =>
    loopCopies(centerZ).map((z): [number, number, number] => [x, y, z]),
  );
  const lines = instancedAt(
    new THREE.BoxGeometry(0.16, 0.02, length),
    whiteLineMaterial,
    positions,
  );
  lines.frustumCulled = false;
  scene.add(lines);
}
// 車線境界の破線は全車線ぶんを1つのInstancedMeshに(draw call削減)
function dashedLines(xPositions: number[]): void {
  const geometry = new THREE.BoxGeometry(0.15, 0.02, 4);
  const positions: [number, number, number][] = [];
  for (const x of xPositions)
    for (const offset of loopCopies(0))
      for (let z = -WRAP_LENGTH / 2 + 2; z < WRAP_LENGTH / 2; z += 12)
        positions.push([x, 0.01, z + offset]);
  scene.add(instancedAt(geometry, whiteLineMaterial, positions));
}
solidLines(SECTIONS.map((section) => sectionX(section, -1)));
// 合流開放区間は実線を切り、既存の破線だけで本線と加速車線を区切る。
const mainOuterEdgeXs = SECTIONS.map((section) => sectionX(section, -13));
solidLines(mainOuterEdgeXs, -WRAP_LENGTH / 2, MERGE_OPEN_START_Z);
solidLines(mainOuterEdgeXs, MERGE_OPEN_END_Z, WRAP_LENGTH / 2);
solidLines(
  SECTIONS.map((section) => sectionX(section, RAMP_GEOMETRY.gore.outerX)),
  -WRAP_LENGTH / 2,
  WRAP_LENGTH / 2,
  0.012,
);
dashedLines(SECTIONS.flatMap((section) => [-5, -9].map((x) => sectionX(section, x))));

/* ---- 本線と側道の分離帯(合流区間以外) ---- */
(function buildFrontageRoadSeparators() {
  const taperGeometry = new THREE.BoxGeometry(1, 0.006, SEPARATOR_TAPER_LENGTH / 6);
  const poleGeometry = new THREE.BoxGeometry(0.1, 0.8, 0.1);
  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0xe9edf0 });
  const polePositions: [number, number, number][] = [];

  for (const section of SECTIONS) {
    const stripMaterial = new THREE.MeshBasicMaterial({ color: SECTION_THEME[section].strip });
    // 周回境界をまたいで等幅部分が連続するよう、基準周回内を2区間に分ける。
    for (const [startZ, endZ] of [
      [-WRAP_LENGTH / 2, SEPARATOR_FULL_END_Z],
      [SEPARATOR_FULL_START_Z, WRAP_LENGTH / 2],
    ] as const) {
      const length = endZ - startZ;
      const centerZ = (startZ + endZ) / 2;
      const positions = loopCopies(centerZ).map((z): [number, number, number] => [
        sectionX(section, SEPARATOR_X),
        0.008,
        z,
      ]);
      const strip = instancedAt(
        new THREE.BoxGeometry(SEPARATOR_WIDTH, 0.006, length),
        stripMaterial,
        positions,
      );
      strip.frustumCulled = false;
      scene.add(strip);
    }

    const taperMatrices: THREE.Matrix4[] = [];
    for (const offset of loopCopies(0)) {
      for (let i = 0; i < 6; i++) {
        const progress = (i + 0.5) / 6;
        const width = SEPARATOR_WIDTH * progress;
        const upstreamZ = MERGE_OPEN_END_Z + progress * SEPARATOR_TAPER_LENGTH + offset;
        const downstreamZ = MERGE_OPEN_START_Z - progress * SEPARATOR_TAPER_LENGTH + offset;
        for (const z of [upstreamZ, downstreamZ])
          taperMatrices.push(
            new THREE.Matrix4()
              .makeScale(width, 1, 1)
              .setPosition(sectionX(section, SEPARATOR_X), 0.008, z),
          );
      }
    }
    const tapers = instancedWith(taperGeometry, stripMaterial, taperMatrices);
    tapers.frustumCulled = false;
    scene.add(tapers);

    // 周回境界を展開してから戻すことで、境界をまたいでも正確な9m間隔を保つ。
    const unwrappedFullEndZ = SEPARATOR_FULL_END_Z + WRAP_LENGTH;
    for (
      let unwrappedZ = SEPARATOR_FULL_START_Z + SEPARATOR_POLE_SPACING / 2;
      unwrappedZ < unwrappedFullEndZ;
      unwrappedZ += SEPARATOR_POLE_SPACING
    ) {
      const z = unwrappedZ - WRAP_LENGTH;
      for (const offset of loopCopies(0))
        polePositions.push([
          sectionX(section, SEPARATOR_POLE_X),
          SEPARATOR_POLE_CENTER_Y,
          z + offset,
        ]);
    }
  }

  const poles = instancedAt(poleGeometry, poleMaterial, polePositions);
  poles.frustumCulled = false;
  scene.add(poles);
})();

/* ---- 合流部マーキング ---- */
for (const section of SECTIONS) {
  const { gore } = RAMP_GEOMETRY;
  const zTop = MERGE_OPEN_END_Z;
  // 本線との境界は破線(合流可)
  const dashGeometry = new THREE.BoxGeometry(0.15, 0.02, 3);
  const dashPositions: [number, number, number][] = [];
  for (let z = gore.startZ + 6; z < zTop - 6; z += 9)
    dashPositions.push([sectionX(section, gore.mainX), 0.012, z]);
  scene.add(instancedAt(dashGeometry, whiteLineMaterial, dashPositions));
  // 終端の導流帯(先細りのゼブラ)。三角形の辺を補間して配置する。
  const zebraGeometry = new THREE.BoxGeometry(1, 0.02, 1.3);
  const zebraMatrices: THREE.Matrix4[] = [];
  const zebraCount = 5;
  for (let i = 0; i < zebraCount; i++) {
    const progress = (i + 0.5) / zebraCount;
    const z = gore.startZ + (gore.endZ - gore.startZ) * progress;
    const outerX = gore.outerX + (gore.mainX - gore.outerX) * progress;
    const width = gore.mainX - outerX;
    zebraMatrices.push(
      new THREE.Matrix4()
        .makeScale(width, 1, 1)
        .setPosition(sectionX(section, outerX + width / 2), 0.012, z),
    );
  }
  scene.add(instancedWith(zebraGeometry, whiteLineMaterial, zebraMatrices));
}

/* ---- 区間の仕切り（ガードレール付き） ----
   両区間は同じ向きに走る独立した道路なので「中央分離帯」ではなく、
   L区間の右路肩と R区間の加速車線の間に立つ仕切りの防護柵 */
(function buildDivider() {
  const baseGeometry = new THREE.BoxGeometry(0.8, 0.5, WRAP_LENGTH);
  const baseMaterial = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
  const railMaterial = new THREE.MeshLambertMaterial({ color: 0xe9edf0 });
  for (const z of loopCopies(0)) {
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    base.position.set(0, 0.25, z);
    base.castShadow = true;
    base.receiveShadow = true;
    scene.add(base);
    for (const railX of [-0.3, 0.3]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, WRAP_LENGTH), railMaterial);
      rail.position.set(railX, 0.95, z);
      scene.add(rail);
    }
  }
  const postGeometry = new THREE.BoxGeometry(0.12, 0.55, 0.12);
  const delineatorGeometry = new THREE.BoxGeometry(0.16, 0.16, 0.06); // 視線誘導標(デリネーター)
  const postPositions: [number, number, number][] = [];
  const delineatorPositions: [number, number, number][] = [];
  for (const offset of loopCopies(0))
    for (let z = -WRAP_LENGTH / 2 + 6; z < WRAP_LENGTH / 2; z += 18) {
      postPositions.push([0, 0.75, z + offset]);
      // 両進行方向から見えるよう両面に
      for (const offsetZ of [-0.09, 0.09])
        delineatorPositions.push([0, 1.12, z + offset + offsetZ]);
    }
  scene.add(instancedAt(postGeometry, railMaterial, postPositions));
  scene.add(instancedAt(delineatorGeometry, delineatorMaterial, delineatorPositions));
})();

/* ---- 路面ペイント（区間ルールの表示・遊び心） ---- */
// 縦書きでは横倒しのままだと不自然な約物。90度回転させて描く(長音符・波ダッシュ・括弧類)
const VERTICAL_ROTATED_CHARS = new Set([
  'ー',
  '～',
  '〜',
  '（',
  '）',
  '(',
  ')',
  '「',
  '」',
  '『',
  '』',
]);
const ROAD_TEXT_CANVAS_WIDTH = 256;
const ROAD_TEXT_CANVAS_HEIGHT = 640;
const ROAD_TEXT_FONT_SIZE = 118;
const ROAD_TEXT_LINE_HEIGHT = 128;

function roadText(text: string, x: number, z: number): void {
  const canvas = document.createElement('canvas');
  canvas.width = ROAD_TEXT_CANVAS_WIDTH;
  canvas.height = ROAD_TEXT_CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, ROAD_TEXT_CANVAS_WIDTH, ROAD_TEXT_CANVAS_HEIGHT);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `bold ${ROAD_TEXT_FONT_SIZE}px sans-serif`;
  ctx.textAlign = 'center';
  // 文字の中心を基準に配置し、文字列全体を上下中央に収める(はみ出し防止)
  ctx.textBaseline = 'middle';
  const characters = text.split('');
  const centerX = ROAD_TEXT_CANVAS_WIDTH / 2;
  const topOffset = (ROAD_TEXT_CANVAS_HEIGHT - characters.length * ROAD_TEXT_LINE_HEIGHT) / 2;
  characters.forEach((char, i) => {
    const centerY = topOffset + (i + 0.5) * ROAD_TEXT_LINE_HEIGHT;
    if (!VERTICAL_ROTATED_CHARS.has(char)) {
      ctx.fillText(char, centerX, centerY);
      return;
    }
    // 縦書き字形は横書き字形を時計回りに90度回転したもの
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(char, 0, 0);
    ctx.restore();
  });
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
roadText('義務あり', sectionX('L', -7), -120);
roadText('義務なし', sectionX('R', -7), -120);
roadText('ゆずりあい', sectionX('L', -7), 60);
roadText('マイペース', sectionX('R', -7), 60);

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
  const centerX = sectionX(section, -7);
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
for (const section of SECTIONS) {
  for (const gantryZ of GANTRY_Z) buildGantry(section, gantryZ);
}

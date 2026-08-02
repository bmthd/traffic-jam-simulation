/* ================= 道路・標識などの静的な情景 ================= */
import * as THREE from 'three';
import { CONST, FACILITIES, FACILITY_SPACING, RAMP_GEOMETRY, WRAP_LENGTH } from '../core';
import type { FacilityKind } from '../core';
import type { Section } from '../core';
import { scene } from './scene';
import { asphaltTexture, delineatorMaterial, frontageAsphaltTexture } from './materials';
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
const EXIT_OPEN_START_Z = CONST.EXIT_BRANCH_Z; // 下流端(分岐)
const EXIT_OPEN_END_Z = CONST.EXIT_LANE_START_Z; // 上流端(減速車線の始まり)
// 側道(=加速車線)の舗装帯。外側の端(-16.8)はR区間では区間の仕切りの基礎に接するため
// これ以上外へは広げられない。代わりに内側を本線の外側線(-13)まで伸ばし、あわせて
// 分離帯を本線寄りに移して側道の走行部を広げた (Issue #87)
const FRONTAGE_WIDTH = 3.8;
const FRONTAGE_CENTER_X = -14.9;
// 加速車線の外側線。舗装の外端(-16.8)のすぐ内側に引き、路側帯との境界を示す。
// これが無いと加速車線と路側帯の区別がつかず、路肩を走れるように見えてしまう。
const FRONTAGE_EDGE_LINE_X = -16.45;
// 区間テーマカラーの帯は外側線のさらに外、舗装の外端に沿って全長に走らせる。
const SECTION_STRIP_X = -16.72;

/* ---- 道路(アスファルト質感 + 区間ごとの色味) ---- */
const roadGeometry = new THREE.BoxGeometry(13.2, 0.12, WRAP_LENGTH);
const frontageRoadGeometry = new THREE.BoxGeometry(FRONTAGE_WIDTH, 0.12, WRAP_LENGTH);
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
  road.receiveShadow = true;
  scene.add(road);

  // 側道には車列を描かないので、轍を省いた専用テクスチャを使う。
  const frontageRoadMaterial = new THREE.MeshLambertMaterial({
    color: SECTION_THEME[section].road,
    map: frontageAsphaltTexture,
  });
  // 合流部と同じ舗装帯を全周へ延ばし、側道がそのまま加速車線になる形にする。
  const frontageRoad = instancedAt(
    frontageRoadGeometry,
    frontageRoadMaterial,
    loopCopies(0).map((z): [number, number, number] => [
      sectionX(section, FRONTAGE_CENTER_X),
      -0.055,
      z,
    ]),
  );
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
// 合流・分流の開放区間は実線を切り、破線で本線と加減速車線を区切る。
const mainOuterEdgeXs = SECTIONS.map((section) => sectionX(section, -13));
// 施設ローカルの閉鎖区間を2本に分け、入口と出口の両方で外側線を開放する。
for (const facility of FACILITIES) {
  solidLines(
    mainOuterEdgeXs,
    MERGE_OPEN_END_Z - FACILITY_SPACING + facility.offsetZ,
    EXIT_OPEN_START_Z + facility.offsetZ,
  );
  solidLines(
    mainOuterEdgeXs,
    EXIT_OPEN_END_Z + facility.offsetZ,
    MERGE_OPEN_START_Z + facility.offsetZ,
  );
}
// 加速車線と路側帯の境界(外側線)は全長にわたって実線
solidLines(SECTIONS.map((section) => sectionX(section, FRONTAGE_EDGE_LINE_X)));
for (const section of SECTIONS) {
  const stripMaterial = new THREE.MeshBasicMaterial({ color: SECTION_THEME[section].strip });
  scene.add(
    instancedAt(
      new THREE.BoxGeometry(0.16, 0.02, WRAP_LENGTH),
      stripMaterial,
      loopCopies(0).map((z): [number, number, number] => [
        sectionX(section, SECTION_STRIP_X),
        0.012,
        z,
      ]),
    ),
  );
}
dashedLines(SECTIONS.flatMap((section) => [-5, -9].map((x) => sectionX(section, x))));

/* ---- 合流レーンのテーパー(斜めの白線) ----
   加速車線の終わりで外側の縁が本線の外側線へ寄っていく斜めの実線。
   この1本が「ここまでが合流レーン」という形を描く。路側帯には何も引かない。 */
(function buildMergeTaperLine() {
  const { gore } = RAMP_GEOMETRY;
  const dx = gore.mainX - gore.outerX; // 本線側へ寄る量
  const dz = gore.endZ - gore.startZ; // 進行方向(-Z)への長さ
  const length = Math.hypot(dx, dz);
  const angle = Math.atan2(-dz, dx); // +X 方向の棒をテーパーの向きへ倒す角
  const geometry = new THREE.BoxGeometry(length, 0.02, 0.16);
  const matrices = FACILITIES.flatMap((facility) =>
    SECTIONS.flatMap((section) =>
      loopCopies((gore.startZ + gore.endZ) / 2 + facility.offsetZ).map((z) =>
        new THREE.Matrix4()
          .makeRotationY(angle)
          .setPosition(sectionX(section, (gore.outerX + gore.mainX) / 2), 0.012, z),
      ),
    ),
  );
  scene.add(instancedWith(geometry, whiteLineMaterial, matrices));
})();

/* ---- 合流・分流部マーキング ---- */
{
  const { gore } = RAMP_GEOMETRY;
  // 本線との境界は破線(車線変更可)。施設0のローカル座標で1セットだけ定義する。
  const dashGeometry = new THREE.BoxGeometry(0.15, 0.02, 3);
  const localDashZ: number[] = [];
  for (let z = gore.startZ + 6; z < MERGE_OPEN_END_Z - 6; z += 9) localDashZ.push(z);
  for (let z = EXIT_OPEN_START_Z + 22; z < EXIT_OPEN_END_Z - 6; z += 9) localDashZ.push(z);
  const dashPositions = FACILITIES.flatMap((facility) =>
    SECTIONS.flatMap((section) =>
      localDashZ.flatMap((localZ) =>
        loopCopies(localZ + facility.offsetZ).map((z): [number, number, number] => [
          sectionX(section, gore.mainX),
          0.012,
          z,
        ]),
      ),
    ),
  );
  scene.add(instancedAt(dashGeometry, whiteLineMaterial, dashPositions));
}

/* ---- 導流帯(入口は収束、出口は進行方向へ拡幅) ---- */
(function buildGoreTriangles() {
  const { gore } = RAMP_GEOMETRY;
  const exitGoreTipZ = EXIT_OPEN_START_Z + (gore.startZ - gore.endZ);
  const localTriangles = [
    [
      [gore.outerX, gore.startZ],
      [gore.mainX, gore.startZ],
      [gore.mainX, gore.endZ],
    ],
    [
      [gore.mainX, exitGoreTipZ],
      [gore.mainX, EXIT_OPEN_START_Z],
      [gore.outerX, EXIT_OPEN_START_Z],
    ],
  ] as const;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      localTriangles.flatMap((triangle) => triangle.flatMap(([x, z]) => [x, 0.013, z])),
      3,
    ),
  );
  const material = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, side: THREE.DoubleSide });
  for (const facility of FACILITIES)
    for (const section of SECTIONS)
      for (const offset of loopCopies(facility.offsetZ)) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(CONST.SECTION_OFFSET_X[section], 0, offset);
        scene.add(mesh);
      }
})();

/* ---- 減速車線始点のテーパー(本線側から外側へ拡幅) ---- */
(function buildExitTaperLine() {
  const { gore } = RAMP_GEOMETRY;
  const taperEndZ = EXIT_OPEN_END_Z - (gore.startZ - gore.endZ);
  const dx = gore.outerX - gore.mainX;
  const dz = taperEndZ - EXIT_OPEN_END_Z;
  const length = Math.hypot(dx, dz);
  const angle = Math.atan2(-dz, dx);
  const geometry = new THREE.BoxGeometry(length, 0.02, 0.16);
  const matrices = FACILITIES.flatMap((facility) =>
    SECTIONS.flatMap((section) =>
      loopCopies((EXIT_OPEN_END_Z + taperEndZ) / 2 + facility.offsetZ).map((z) =>
        new THREE.Matrix4()
          .makeRotationY(angle)
          .setPosition(sectionX(section, (gore.mainX + gore.outerX) / 2), 0.012, z),
      ),
    ),
  );
  scene.add(instancedWith(geometry, whiteLineMaterial, matrices));
})();

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
      rail.castShadow = true;
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
  const posts = instancedAt(postGeometry, railMaterial, postPositions);
  posts.castShadow = true;
  scene.add(posts);
  // 1テクセル未満で影を視認できない極小装飾のため castShadow は設定しない
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

/* ---- 施設案内標識 ---- */
const EXIT_SIGN_LOCAL_Z = CONST.EXIT_BRANCH_Z + 35;
const ADVANCE_SIGN_DISTANCES = [500, 250] as const;
const FACILITY_SIGN: Record<FacilityKind, { background: string; subtitle: string }> = {
  IC: { background: '#168447', subtitle: '出口' },
  PA: { background: '#168447', subtitle: 'P' },
};
const FACILITY_NAMES = ['青葉IC', 'みどりPA', '朝日IC', 'こもれびPA'] as const;
export const SIGN_GLOW_SPECS: { x: number; y: number; z: number; width: number; height: number }[] =
  [];
function makeSignTexture(
  title: string,
  subtitle: string,
  background: string,
  arrow = false,
): THREE.CanvasTexture {
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
  ctx.font = 'bold 58px sans-serif';
  ctx.fillText(title, 256, 68);
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(arrow ? `${subtitle}  ↓` : subtitle, 256, 124);
  return new THREE.CanvasTexture(canvas);
}
function addDoubleSidedBoard(
  group: THREE.Group,
  texture: THREE.CanvasTexture,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): void {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  for (const dir of [1, -1]) {
    const board = new THREE.Mesh(geometry, material);
    board.position.set(x, y, z + dir * 0.06);
    if (dir === -1) board.rotation.y = Math.PI;
    if (dir === 1) board.castShadow = true;
    group.add(board);
  }
  SIGN_GLOW_SPECS.push({ x, y, z, width: width + 1, height: height + 1 });
}
function buildExitSign(section: Section, facilityIndex: number, z: number): void {
  const facility = FACILITIES[facilityIndex];
  const sign = FACILITY_SIGN[facility.kind];
  const laneX = sectionX(section, -15);
  const postX = sectionX(section, -17.25);
  const group = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: 0x99a1aa });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6.4, 0.3), steel);
  post.position.set(postX, 3.2, z);
  post.castShadow = true;
  group.add(post);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(laneX - postX, 0.3, 0.3), steel);
  arm.position.set((postX + laneX) / 2, 6.25, z);
  arm.castShadow = true;
  group.add(arm);
  addDoubleSidedBoard(
    group,
    makeSignTexture(FACILITY_NAMES[facilityIndex], sign.subtitle, sign.background, true),
    laneX,
    7.6,
    z,
    4.2,
    2.7,
  );
  scene.add(group);
}
function buildAdvanceSign(
  section: Section,
  facilityIndex: number,
  distance: number,
  z: number,
): void {
  const group = new THREE.Group();
  const postX = sectionX(section, -17.25);
  const steel = new THREE.MeshLambertMaterial({ color: 0x99a1aa });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 3.8, 0.24), steel);
  post.position.set(postX, 1.9, z);
  post.castShadow = true;
  group.add(post);
  addDoubleSidedBoard(
    group,
    makeSignTexture(FACILITY_NAMES[facilityIndex], `${distance} m`, '#168447'),
    postX,
    4.8,
    z,
    4.4,
    2.15,
  );
  scene.add(group);
}
for (const facility of FACILITIES) {
  for (const section of SECTIONS) {
    for (const z of loopCopies(EXIT_SIGN_LOCAL_Z + facility.offsetZ))
      buildExitSign(section, facility.index, z);
    for (const distance of ADVANCE_SIGN_DISTANCES)
      for (const z of loopCopies(CONST.EXIT_BRANCH_Z + distance + facility.offsetZ))
        buildAdvanceSign(section, facility.index, distance, z);
  }
}

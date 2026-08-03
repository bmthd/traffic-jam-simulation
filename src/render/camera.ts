/* ================= カメラ操作（回転・ズーム・カメラモード） ================= */
import * as THREE from 'three';
import { CONST, FACILITIES, WRAP_LENGTH, clamp, smooth } from '../core';
import type { Section, Vehicle, World } from '../core';
import { isLandscapeViewport } from './camera-layout';
import { flybyPose } from './flyby';
import { camera, renderer, syncBackgroundAnchor, syncShadowCamera } from './scene';
import { cameraWrapOffset } from './looping';

export interface CameraController {
  theta: number;
  phi: number;
  radius: number;
  target: THREE.Vector3;
}
export const cameraController: CameraController = {
  theta: 0,
  phi: 1.06,
  radius: 105,
  target: new THREE.Vector3(0, 0, 0),
};

/* ---- オートモードで使う参照点（core の座標定数から算出。挙動は変えない） ----
   両区間の中心X、各区間の走行中心X、合流ランプ帯の位置を基準にする */
const L_CENTER_X = CONST.LANE_X.L[1]; // 義務あり区間の中心
const R_CENTER_X = CONST.LANE_X.R[1]; // 義務なし区間の中心
const CENTER_X = (L_CENTER_X + R_CENTER_X) / 2; // 全体の中心
const L_SHOULDER_X = CONST.LANE_X.L[2] - 2.9; // 義務あり区間の左路肩(見上げ視点の立ち位置)
const R_SHOULDER_X = CONST.LANE_X.R[2] - 2.9; // 義務なし区間の左路肩
const RAMP_LOCAL_Z_MID = (CONST.RAMP_Z_TOP + CONST.RAMP_Z_END) / 2; // 合流帯の施設ローカル中央

/* ================= マニュアルモードの視点操作（従来どおりの軌道カメラ） ================= */
function applyOrbit(): void {
  const controller = cameraController;
  camera.position.set(
    controller.target.x + controller.radius * Math.sin(controller.phi) * Math.sin(controller.theta),
    controller.target.y + controller.radius * Math.cos(controller.phi),
    controller.target.z + controller.radius * Math.sin(controller.phi) * Math.cos(controller.theta),
  );
  camera.lookAt(controller.target);
}

/* ================= オートモード（カメラプリセットの自動切り替え） =================
   一定間隔で視点が切り替わり、いろいろな角度から眺められるモード。
   切り替えの瞬間だけ前の姿勢から目標姿勢へ補間し、補間が終われば目標に
   ぴったり一致させる。こうすると車に固定する視点(追尾・ドライバー)でも
   カメラが車から取り残されず、視点の移動だけが滑らかになる。
   状態管理はこのモジュールに閉じ、app.ts のループから毎フレーム更新する。 */

export type SpectatorPresetId =
  | 'drone'
  | 'overhead'
  | 'lookup'
  | 'follow'
  | 'flyby'
  | 'driver'
  | 'ramp';

export type CameraModeId = 'auto' | 'fixed' | 'drone' | 'tracking';

export interface CameraVariation {
  id: string;
  label: string;
  icon: string;
  presetId: SpectatorPresetId;
}

export interface CameraModeDef {
  id: CameraModeId;
  label: string;
  icon: string;
  variations: CameraVariation[];
  showSectionToggle: boolean;
  showNextVehicle: boolean;
}

export const CAMERA_MODES: CameraModeDef[] = [
  {
    id: 'auto',
    label: 'オート',
    icon: 'repeat',
    variations: [],
    showSectionToggle: false,
    showNextVehicle: false,
  },
  {
    id: 'fixed',
    label: '定点',
    icon: 'map',
    variations: [
      { id: 'overhead', label: '俯瞰', icon: 'map', presetId: 'overhead' },
      { id: 'lookup', label: '見上げ', icon: 'move-up', presetId: 'lookup' },
      { id: 'ramp', label: '合流', icon: 'merge', presetId: 'ramp' },
    ],
    showSectionToggle: true,
    showNextVehicle: false,
  },
  {
    id: 'drone',
    label: 'ドローン',
    icon: 'send',
    variations: [
      { id: 'drone', label: 'サークル', icon: 'send', presetId: 'drone' },
      { id: 'flyby', label: 'フライバイ', icon: 'send', presetId: 'flyby' },
    ],
    showSectionToggle: false,
    showNextVehicle: false,
  },
  {
    id: 'tracking',
    label: '追跡',
    icon: 'car-front',
    variations: [
      { id: 'follow', label: '三人称', icon: 'car-front', presetId: 'follow' },
      { id: 'driver', label: '一人称', icon: 'eye', presetId: 'driver' },
    ],
    showSectionToggle: true,
    showNextVehicle: true,
  },
];

interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}
interface PresetContext {
  time: number; // プリセットに切り替わってからの経過秒
  world: World;
}
export interface SpectatorPreset {
  id: SpectatorPresetId;
  label: string;
  icon: string;
  mode: CameraModeId;
  variationId: string;
  compute: (pose: Pose, ctx: PresetContext) => void;
}

/* ---- 車に固定する視点(追尾・ドライバー)が追う車 ----
   区間内から1台選び、退場するか止まるまで同じ車を追い続ける */
let followVehicle: Vehicle | null = null;
let followChanged = false; // 追う車が入れ替わったフレームを知らせる(視点を繋ぎ直すため)
let previousFollowZ: number | null = null;
let pendingCameraWrap = 0;
let followSection: Section = 'L';
let skipFollowVehicle: Vehicle | null = null;
function pickFollowVehicle(world: World): Vehicle | null {
  if (
    followVehicle &&
    followVehicle.section === followSection &&
    !followVehicle.waiting &&
    world.vehicles.includes(followVehicle)
  ) {
    pendingCameraWrap = cameraWrapOffset(previousFollowZ ?? followVehicle.z, followVehicle.z);
    previousFollowZ = followVehicle.z;
    return followVehicle;
  }
  // 画面中央付近(z≈0)を走行中の車を選ぶ。見失ったら選び直す
  const candidates = world.vehicles.filter(
    (vehicle) =>
      vehicle.section === followSection && !vehicle.waiting && vehicle !== skipFollowVehicle,
  );
  const best = candidates[Math.floor(Math.random() * candidates.length)] ?? null;
  skipFollowVehicle = null;
  if (followVehicle && best !== followVehicle) resetCameraAdjustment();
  followVehicle = best;
  followChanged = true;
  previousFollowZ = best?.z ?? null;
  pendingCameraWrap = 0;
  return best;
}
// 追う車がいないときの逃げ場(生成直後など)。俯瞰気味に全体を映す
function fallbackPose(pose: Pose): void {
  pose.position.set(CENTER_X, 60, 40);
  pose.target.set(CENTER_X, 0, 0);
}

export const SPECTATOR_PRESETS: SpectatorPreset[] = [
  {
    id: 'drone',
    label: 'ドローン',
    icon: 'send',
    mode: 'drone',
    variationId: 'drone',
    // ゆっくり旋回しながら前後にも漂う空撮風の動的視点
    compute(pose, { time }) {
      const angle = time * 0.12;
      const radius = 88;
      const driftZ = Math.sin(time * 0.05) * 150;
      pose.position.set(
        CENTER_X + Math.sin(angle) * radius,
        46 + Math.sin(time * 0.07) * 12,
        driftZ + Math.cos(angle) * radius,
      );
      pose.target.set(CENTER_X, 3, driftZ);
    },
  },
  {
    id: 'overhead',
    label: '俯瞰',
    icon: 'map',
    mode: 'fixed',
    variationId: 'overhead',
    // 端末の長辺に道路の進行方向を合わせる。横長(正方形を含む)では横から、
    // 縦長では従来どおり奥側から見下ろし、両区間の流れを比較しやすくする
    compute(pose) {
      if (isLandscapeViewport(innerWidth, innerHeight)) {
        pose.position.set(CENTER_X + 52, 150, -6);
      } else {
        pose.position.set(CENTER_X, 150, 34);
      }
      pose.target.set(CENTER_X, 0, -6);
    },
  },
  {
    id: 'lookup',
    label: '見上げ',
    icon: 'move-up',
    mode: 'fixed',
    variationId: 'lookup',
    // 路肩の地面すれすれから、向かってくる車列を見上げる視点。
    // 車は -Z へ進むので +Z 側(奥)から迫ってきて、目の前を大きく通り過ぎる
    compute(pose) {
      const centerX = followSection === 'L' ? L_CENTER_X : R_CENTER_X;
      pose.position.set(followSection === 'L' ? L_SHOULDER_X : R_SHOULDER_X, 0.3, -20);
      pose.target.set(centerX, 4.6, 46);
    },
  },
  {
    id: 'follow',
    label: '追尾',
    icon: 'car-front',
    mode: 'tracking',
    variationId: 'follow',
    // 特定の車を後方やや上から追う視点(車の全体像が見える)
    compute(pose, { world }) {
      const vehicle = pickFollowVehicle(world);
      if (!vehicle) return fallbackPose(pose);
      // 車は -Z 方向へ進むので、後方 = +Z 側。少し横にずらして車体を見せる
      pose.position.set(vehicle.x - 5.5, 4.2, vehicle.z + 13);
      pose.target.set(vehicle.x, 1.3, vehicle.z - 6);
    },
  },
  {
    id: 'flyby',
    label: 'フライバイ',
    icon: 'send',
    mode: 'drone',
    variationId: 'flyby',
    // 車両とは逆の +Z へ進み、車列と正面からすれ違いながら両区間を映す
    compute(pose, { time }) {
      const flyby = flybyPose(time, CENTER_X);
      pose.position.set(flyby.position.x, flyby.position.y, flyby.position.z);
      pose.target.set(flyby.target.x, flyby.target.y, flyby.target.z);
    },
  },
  {
    id: 'driver',
    label: 'ドライバー',
    icon: 'eye',
    mode: 'tracking',
    variationId: 'driver',
    // 運転席から前方を見る一人称視点。
    // 目線の高さは車種の車高に比例させ(トラックは高く、スポーツカーは低く)、
    // 着座位置は車体中央のわずかに後ろ・右寄り(日本の右ハンドル)に置く。
    // 車体マテリアルは表面のみ描画するため、車内からは自車のボディが視界を塞がない
    compute(pose, { world }) {
      const vehicle = pickFollowVehicle(world);
      if (!vehicle) return fallbackPose(pose);
      const eyeY = Math.max(0.95, vehicle.type.height * 0.72);
      const seatX = vehicle.x + 0.34;
      pose.position.set(seatX, eyeY, vehicle.z + vehicle.type.length * 0.06);
      // 視線はやや先の路面へ。前走車と車線の流れが同時に入る画になる
      pose.target.set(seatX, eyeY - 1.1, vehicle.z - 42);
    },
  },
  {
    id: 'ramp',
    label: '合流',
    icon: 'merge',
    mode: 'fixed',
    variationId: 'ramp',
    // 合流ランプ(加速車線)付近を斜め上から捉え、本線への合流を眺める
    compute(pose) {
      const centerX = followSection === 'L' ? L_CENTER_X : R_CENTER_X;
      let rampZ = RAMP_LOCAL_Z_MID + FACILITIES[spectator.facilityIndex].offsetZ;
      // 周回境界外に定義された施設は、車両がいる正規周回側へ写す。
      if (rampZ < -CONST.ROAD_HALF) rampZ += WRAP_LENGTH;
      pose.position.set(centerX - 30, 17, rampZ + 55);
      pose.target.set(centerX - 9, 1.5, rampZ);
    },
  },
];

/* ---- モード一覧 ----
    4 モード（オート／定点／ドローン／追跡）の定義。
    プリセットは CAMERA_MODES に属する variation 経由で参照される。 */
export interface SpectatorMode {
  id: CameraModeId;
  label: string;
  icon: string;
}
export const SPECTATOR_MODES: SpectatorMode[] = CAMERA_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  icon: mode.icon,
}));
const AUTO_MODE_INDEX = 0;

const AUTO_CYCLE_INTERVAL = 9; // オートモードでプリセットを切り替える間隔 (s)
const AUTO_RESUME_DELAY = 3; // 操作終了後に巡回を再開するまでの待機時間 (s)
const TRANSITION_DURATION = 1.2; // 視点の切り替えにかける時間 (s)

interface SpectatorState {
  modeIndex: number; // CAMERA_MODES の添字
  variationIndex: number; // 現在のモードのバリエーション添字
  presetIndex: number; // オートモード中の現在のプリセット
  presetTime: number; // 現プリセットに切り替わってからの経過秒
  cycleTimer: number; // オートモードのプリセット切り替えタイマー
  transitionTime: number; // 視点切り替えの補間経過秒
  facilityIndex: number; // 合流プリセットで表示する施設
  yawOffset: number;
  pitchOffset: number;
  zoom: number;
  panOffsetZ: number;
  interacting: boolean;
  resumeDelay: number;
}
// 起動直後はオートモード。まず自動で動く画を見せ、画面に触れた時点で
// マニュアルモードへ移る(モードの存在に気づいてもらうため) (Issue #43)
const spectator: SpectatorState = {
  modeIndex: AUTO_MODE_INDEX,
  variationIndex: 0,
  presetIndex: 0,
  presetTime: 0,
  cycleTimer: 0,
  transitionTime: TRANSITION_DURATION,
  facilityIndex: 0,
  yawOffset: 0,
  pitchOffset: 0,
  zoom: 1,
  panOffsetZ: 0,
  interacting: false,
  resumeDelay: 0,
};

// 補間の開始姿勢・現在姿勢・各プリセットが書き込む目標姿勢
const fromPose: Pose = { position: new THREE.Vector3(), target: new THREE.Vector3() };
const currentPose: Pose = { position: new THREE.Vector3(), target: new THREE.Vector3() };
const goalPose: Pose = { position: new THREE.Vector3(), target: new THREE.Vector3() };

export interface SpectatorStatus {
  enabled: boolean; // カメラが自動で動いている(マニュアルモード以外)
  auto: boolean;
  mode: SpectatorMode; // トグルボタンが示す現在のモード
  variation: CameraVariation | null; // 選択中のバリエーション(オート時は null)
  adjusted: boolean;
  section: Section;
  facilityIndex: number;
}
export function getSpectatorStatus(): SpectatorStatus {
  const mode = CAMERA_MODES[spectator.modeIndex];
  const variation = mode.variations[spectator.variationIndex] ?? null;
  return {
    enabled: true,
    auto: spectator.modeIndex === AUTO_MODE_INDEX,
    mode,
    variation,
    adjusted:
      spectator.yawOffset !== 0 ||
      spectator.pitchOffset !== 0 ||
      spectator.zoom !== 1 ||
      spectator.panOffsetZ !== 0,
    section: followSection,
    facilityIndex: spectator.facilityIndex,
  };
}

type SpectatorListener = (status: SpectatorStatus) => void;
let changeListener: SpectatorListener | null = null;
export function onSpectatorChange(listener: SpectatorListener): void {
  changeListener = listener;
}
function notify(): void {
  changeListener?.(getSpectatorStatus());
}

type SpectatorProgressListener = (progress: number) => void;
let progressListener: SpectatorProgressListener | null = null;
/** 自動巡回の次の視点切替までの進捗を 0〜1 で通知する */
export function onSpectatorProgress(listener: SpectatorProgressListener): void {
  progressListener = listener;
  listener(
    spectator.modeIndex === AUTO_MODE_INDEX
      ? clamp(spectator.cycleTimer / AUTO_CYCLE_INTERVAL, 0, 1)
      : 0,
  );
}

// 今の姿勢を起点にして、目標姿勢への補間をやり直す
function beginTransition(): void {
  spectator.transitionTime = 0;
  fromPose.position.copy(currentPose.position);
  fromPose.target.copy(currentPose.target);
}

/** 現在のプリセットに加えた首振りと距離調整を初期値へ戻す */
export function resetCameraAdjustment(): void {
  spectator.yawOffset = 0;
  spectator.pitchOffset = 0;
  spectator.zoom = 1;
  spectator.panOffsetZ = 0;
  notify();
}

/** 現在のモードが定点（パン操作対象）か */
function isFixedMode(): boolean {
  return CAMERA_MODES[spectator.modeIndex].id === 'fixed';
}

/** 固定視点を道路沿いに移動する。追尾・動的視点では安全に無視する */
function panFixedCamera(deltaZ: number): void {
  if (!isFixedMode()) return;
  spectator.panOffsetZ = clamp(spectator.panOffsetZ + deltaZ, -180, 180);
  notify();
}

/** キーボード操作から現在の視点を少しだけ首振りする */
export function adjustCamera(yaw: number, pitch: number): void {
  spectator.yawOffset += yaw;
  spectator.pitchOffset = clamp(spectator.pitchOffset + pitch, -1.2, 1.2);
  notify();
}

/** カメラが表示する区間を選ぶ（シミュレーションの車両挙動には影響しない） */
export function selectCameraSection(section: Section): void {
  if (followSection === section) return;
  followSection = section;
  followVehicle = null;
  beginTransition();
  resetCameraAdjustment();
}

/** 同じ区間内の別の車両へ追尾対象を切り替える */
export function selectNextFollowVehicle(): void {
  skipFollowVehicle = followVehicle;
  followVehicle = null;
  resetCameraAdjustment();
}

/** 合流の定点視点で表示する施設を選ぶ */
export function selectCameraFacility(index: number): void {
  const nextIndex = (index + FACILITIES.length) % FACILITIES.length;
  if (spectator.facilityIndex === nextIndex) return;
  spectator.facilityIndex = nextIndex;
  beginTransition();
  resetCameraAdjustment();
}

// 指定したモードに切り替える。バリエーションは先頭にリセットし、
// オートモードならプリセット 0 から始める
function setMode(index: number): void {
  spectator.modeIndex = (index + CAMERA_MODES.length) % CAMERA_MODES.length;
  spectator.variationIndex = 0;
  if (spectator.modeIndex === AUTO_MODE_INDEX) {
    switchPreset(0);
  } else {
    activateVariation(0);
  }
  notify();
}

// 現在モードの指定したバリエーションを活性化する。
// 切り替えの手順はプリセット切り替えと同じなので switchPreset に委ねる
// (追尾対象を引き継ぐかどうかの判断も1箇所にまとまる)
function activateVariation(variationIndex: number): void {
  const mode = CAMERA_MODES[spectator.modeIndex];
  const variation = mode.variations[variationIndex];
  if (!variation) return;
  const presetIndex = SPECTATOR_PRESETS.findIndex((preset) => preset.id === variation.presetId);
  if (presetIndex < 0) return;
  spectator.variationIndex = variationIndex;
  switchPreset(presetIndex);
}

// 車に固定する視点(三人称の追尾と一人称のドライバー)
function isVehiclePreset(id: SpectatorPresetId): boolean {
  return id === 'follow' || id === 'driver';
}

// 表示するプリセットを切り替える。今の姿勢から新しい姿勢へ補間を始める
function switchPreset(index: number): void {
  const previousId = SPECTATOR_PRESETS[spectator.presetIndex].id;
  spectator.presetIndex = (index + SPECTATOR_PRESETS.length) % SPECTATOR_PRESETS.length;
  const nextId = SPECTATOR_PRESETS[spectator.presetIndex].id;
  spectator.presetTime = 0;
  spectator.cycleTimer = 0;
  progressListener?.(0);
  beginTransition();
  resetCameraAdjustment();
  // 追尾↔ドライバーの行き来では同じ車を見続ける。
  // 「同じ車を三人称と一人称で見比べる」のが自然な操作で、
  // ここで選び直すと視点だけでなく対象車まで変わってしまう
  if (!(isVehiclePreset(previousId) && isVehiclePreset(nextId))) {
    followVehicle = null; // それ以外はプリセットが変わったら追尾対象を選び直す
  }
  followChanged = false;
}

/** トグルボタン: マニュアル → オート → 各モード → マニュアル… と1つ進める */
export function cycleSpectatorMode(): void {
  setMode(spectator.modeIndex + 1);
}

/** メニューやショートカットから目的のモードへ直接切り替える */
export function selectSpectatorMode(id: CameraModeId): void {
  const index = CAMERA_MODES.findIndex((mode) => mode.id === id);
  if (index >= 0) setMode(index);
}

/** 現在モードのバリエーションを切り替える */
export function selectVariation(index: number): void {
  const mode = CAMERA_MODES[spectator.modeIndex];
  if (mode.variations.length === 0) return;
  activateVariation((index + mode.variations.length) % mode.variations.length);
  notify(); // 操作バーの選択表示を更新する
}

// 現在のカメラ位置と注視点から軌道パラメータ(theta/phi/radius)を逆算する。
// マニュアルモードへ戻すときに、今の見え方をそのまま引き継ぐため
function syncOrbitFromCamera(): void {
  const relative = camera.position.clone().sub(cameraController.target);
  const radius = clamp(relative.length(), 30, 240);
  cameraController.radius = radius;
  cameraController.phi = clamp(Math.acos(clamp(relative.y / radius, -1, 1)), 0.25, 1.45);
  cameraController.theta = Math.atan2(relative.x, relative.z);
}

/** マニュアルモードへ戻す(画面のタップ・ドラッグ・ホイール操作から呼ばれる) */
export function enterManualMode(): void {
  syncOrbitFromCamera();
}

function updateSpectator(world: World, deltaTime: number): void {
  spectator.presetTime += deltaTime;
  if (spectator.modeIndex === AUTO_MODE_INDEX) {
    spectator.resumeDelay = Math.max(0, spectator.resumeDelay - deltaTime);
    if (!spectator.interacting && spectator.resumeDelay === 0) spectator.cycleTimer += deltaTime;
    if (spectator.cycleTimer >= AUTO_CYCLE_INTERVAL) {
      // モードは「オートモード」のままなので UI へは通知しない。
      // プリセットごとに表示が入れ替わるとうるさいため (Issue #43)
      switchPreset(spectator.presetIndex + 1);
    }
    progressListener?.(clamp(spectator.cycleTimer / AUTO_CYCLE_INTERVAL, 0, 1));
  }
  SPECTATOR_PRESETS[spectator.presetIndex].compute(goalPose, {
    time: spectator.presetTime,
    world,
  });
  if (isFixedMode()) {
    goalPose.position.z += spectator.panOffsetZ;
    goalPose.target.z += spectator.panOffsetZ;
  }
  const relative = goalPose.position.clone().sub(goalPose.target);
  const spherical = new THREE.Spherical().setFromVector3(relative);
  spherical.theta += spectator.yawOffset;
  spherical.phi = clamp(spherical.phi + spectator.pitchOffset, 0.08, Math.PI - 0.08);
  spherical.radius *= spectator.zoom;
  goalPose.position.copy(goalPose.target).add(new THREE.Vector3().setFromSpherical(spherical));
  if (pendingCameraWrap !== 0) {
    // 車両と同時に同じ周回複製へ移し、補間が816mを横切らないようにする。
    currentPose.position.z += pendingCameraWrap;
    currentPose.target.z += pendingCameraWrap;
    fromPose.position.z += pendingCameraWrap;
    fromPose.target.z += pendingCameraWrap;
    pendingCameraWrap = 0;
  }
  // 追う車が入れ替わった時も繋ぎ直す(視点が瞬間移動せず、別の車へ寄っていく)
  if (followChanged) {
    followChanged = false;
    if (spectator.transitionTime >= TRANSITION_DURATION) beginTransition();
  }
  // 切り替え直後だけ補間し、補間が終われば目標姿勢に一致させる。
  // 車に固定する視点でもカメラが置いていかれない
  spectator.transitionTime += deltaTime;
  const progress = clamp(spectator.transitionTime / TRANSITION_DURATION, 0, 1);
  if (progress >= 1) {
    currentPose.position.copy(goalPose.position);
    currentPose.target.copy(goalPose.target);
  } else {
    const eased = smooth(progress);
    currentPose.position.lerpVectors(fromPose.position, goalPose.position, eased);
    currentPose.target.lerpVectors(fromPose.target, goalPose.target, eased);
  }
  camera.position.copy(currentPose.position);
  camera.lookAt(currentPose.target);
}

/* ---- 毎フレーム呼ばれるカメラ更新の入口 ----
   マニュアルモードなら従来の軌道カメラ、それ以外はプリセットで描く。
   world/deltaTime はプリセット描画のときだけ使う(初期化時の引数なし呼び出しも許容) */
export function updateCamera(world?: World, deltaTime = 0): void {
  let shadowTarget = cameraController.target;
  if (world) {
    updateSpectator(world, deltaTime);
    shadowTarget = currentPose.target;
  } else {
    applyOrbit();
  }
  syncBackgroundAnchor();
  syncShadowCamera(shadowTarget);
}

export function setupCameraControls(): void {
  const dom = renderer.domElement;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  dom.addEventListener('pointerdown', function (e) {
    spectator.interacting = true;
    // 画面に触れた時点でマニュアルモードへ。ドラッグを待たずに切り替えるので
    // 「タップすれば自分で操作できる」ことが伝わる (Issue #43)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dom.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const points = Array.from(pointers.values());
      pinchDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }
  });
  dom.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    const previous = pointers.get(e.pointerId)!;
    const previousPoints = Array.from(pointers.values());
    const deltaX = e.clientX - previous.x,
      deltaY = e.clientY - previous.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // ドラッグでもマニュアルモードへ戻す(タップを伴わないペン等の操作に備える)。
    // enterManualMode() の中で今の見え方が軌道パラメータへ引き継がれる
    if (pointers.size === 1) {
      if (e.shiftKey && isFixedMode()) {
        panFixedCamera(deltaY * 0.7);
      } else {
        spectator.yawOffset -= deltaX * 0.005;
        spectator.pitchOffset = clamp(spectator.pitchOffset - deltaY * 0.004, -1.2, 1.2);
        notify();
      }
    } else if (pointers.size === 2) {
      const points = Array.from(pointers.values());
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (pinchDistance > 0)
        spectator.zoom = clamp(spectator.zoom * (pinchDistance / distance), 0.35, 3);
      const previousMidY = (previousPoints[0].y + previousPoints[1].y) / 2;
      const currentMidY = (points[0].y + points[1].y) / 2;
      panFixedCamera((currentMidY - previousMidY) * 0.7);
      notify();
      pinchDistance = distance;
    }
  });
  function release(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    pinchDistance = 0;
    if (pointers.size === 0) {
      spectator.interacting = false;
      spectator.resumeDelay = AUTO_RESUME_DELAY;
    }
  }
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);
  dom.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      spectator.resumeDelay = AUTO_RESUME_DELAY;
      spectator.zoom = clamp(spectator.zoom * (1 + e.deltaY * 0.0011), 0.35, 3);
      notify();
    },
    { passive: false },
  );
}

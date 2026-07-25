/* ================= カメラ操作（回転・ズーム・カメラモード） ================= */
import * as THREE from 'three';
import { CONST, clamp, smooth } from '../core';
import type { Vehicle, World } from '../core';
import { camera, renderer } from './scene';

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
const RAMP_Z_MID = (CONST.RAMP_Z_TOP + CONST.RAMP_Z_END) / 2; // 合流帯の中央

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

export type SpectatorPresetId = 'drone' | 'overhead' | 'lookup' | 'follow' | 'driver' | 'ramp';

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
  icon: string; // lucide アイコン名
  compute: (pose: Pose, ctx: PresetContext) => void; // pose を書き換える（確保を避ける）
}

/* ---- 車に固定する視点(追尾・ドライバー)が追う車 ----
   区間内から1台選び、退場するか止まるまで同じ車を追い続ける */
let followVehicle: Vehicle | null = null;
let followChanged = false; // 追う車が入れ替わったフレームを知らせる(視点を繋ぎ直すため)
function pickFollowVehicle(world: World): Vehicle | null {
  if (followVehicle && !followVehicle.waiting && world.vehicles.includes(followVehicle)) {
    return followVehicle;
  }
  // 画面中央付近(z≈0)を走行中の車を選ぶ。見失ったら選び直す
  let best: Vehicle | null = null;
  let bestScore = Infinity;
  for (const vehicle of world.vehicles) {
    if (vehicle.waiting || vehicle.speed < 6) continue;
    const score = Math.abs(vehicle.z);
    if (score < bestScore) {
      bestScore = score;
      best = vehicle;
    }
  }
  followVehicle = best;
  followChanged = true;
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
    // 高所からほぼ真上に見下ろす固定俯瞰。両区間の流れを俯瞰で比較できる
    compute(pose) {
      pose.position.set(CENTER_X, 150, 34);
      pose.target.set(CENTER_X, 0, -6);
    },
  },
  {
    id: 'lookup',
    label: '見上げ',
    icon: 'move-up',
    // 路肩の地面すれすれから、向かってくる車列を見上げる視点。
    // 車は -Z へ進むので +Z 側(奥)から迫ってきて、目の前を大きく通り過ぎる
    compute(pose) {
      pose.position.set(L_SHOULDER_X, 0.3, -20);
      pose.target.set(L_CENTER_X, 4.6, 46);
    },
  },
  {
    id: 'follow',
    label: '追尾',
    icon: 'car-front',
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
    id: 'driver',
    label: 'ドライバー',
    icon: 'eye',
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
    // 合流ランプ(加速車線)付近を斜め上から捉え、本線への合流を眺める
    compute(pose) {
      pose.position.set(L_CENTER_X - 30, 17, RAMP_Z_MID + 55);
      pose.target.set(L_CENTER_X - 9, 1.5, RAMP_Z_MID);
    },
  },
];

/* ---- モード一覧 ----
   トグルボタンを押すたびにこの順で切り替わる。
   先頭は「マニュアルモード(自分で視点を操作する)」、次が「オートモード」、
   以降は各プリセットの手動固定。オートモードも1つのモードとして循環に含める */
export interface SpectatorMode {
  id: 'manual' | 'auto' | SpectatorPresetId;
  label: string;
  icon: string;
}
export const SPECTATOR_MODES: SpectatorMode[] = [
  { id: 'manual', label: 'マニュアルモード', icon: 'mouse' },
  { id: 'auto', label: 'オートモード', icon: 'repeat' },
  ...SPECTATOR_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    icon: preset.icon,
  })),
];
const MANUAL_MODE_INDEX = 0;
const AUTO_MODE_INDEX = 1;
const FIRST_PRESET_MODE_INDEX = 2;

const AUTO_CYCLE_INTERVAL = 9; // オートモードでプリセットを切り替える間隔 (s)
const TRANSITION_DURATION = 1.2; // 視点の切り替えにかける時間 (s)

interface SpectatorState {
  modeIndex: number; // SPECTATOR_MODES の添字
  presetIndex: number; // 現在表示中のプリセット(オートモード中は時間で進む)
  presetTime: number; // 現プリセットに切り替わってからの経過秒
  cycleTimer: number; // オートモードのプリセット切り替えタイマー
  transitionTime: number; // 視点切り替えの補間経過秒
}
// 起動直後はオートモード。まず自動で動く画を見せ、画面に触れた時点で
// マニュアルモードへ移る(モードの存在に気づいてもらうため) (Issue #43)
const spectator: SpectatorState = {
  modeIndex: AUTO_MODE_INDEX,
  presetIndex: 0,
  presetTime: 0,
  cycleTimer: 0,
  transitionTime: TRANSITION_DURATION,
};

// 補間の開始姿勢・現在姿勢・各プリセットが書き込む目標姿勢
const fromPose: Pose = { position: new THREE.Vector3(), target: new THREE.Vector3() };
const currentPose: Pose = { position: new THREE.Vector3(), target: new THREE.Vector3() };
const goalPose: Pose = { position: new THREE.Vector3(), target: new THREE.Vector3() };

export interface SpectatorStatus {
  enabled: boolean; // カメラが自動で動いている(マニュアルモード以外)
  auto: boolean;
  mode: SpectatorMode; // トグルボタンが示す現在のモード
}
export function getSpectatorStatus(): SpectatorStatus {
  return {
    enabled: spectator.modeIndex !== MANUAL_MODE_INDEX,
    auto: spectator.modeIndex === AUTO_MODE_INDEX,
    mode: SPECTATOR_MODES[spectator.modeIndex],
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

// 表示するプリセットを切り替える。今の姿勢から新しい姿勢へ補間を始める
function switchPreset(index: number): void {
  spectator.presetIndex = (index + SPECTATOR_PRESETS.length) % SPECTATOR_PRESETS.length;
  spectator.presetTime = 0;
  spectator.cycleTimer = 0;
  progressListener?.(0);
  beginTransition();
  followVehicle = null; // プリセットが変わったら追尾対象は選び直す
  followChanged = false;
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

function setMode(index: number): void {
  const previous = spectator.modeIndex;
  spectator.modeIndex = (index + SPECTATOR_MODES.length) % SPECTATOR_MODES.length;
  if (previous === MANUAL_MODE_INDEX && spectator.modeIndex !== MANUAL_MODE_INDEX) {
    // マニュアルモードから入る: 今のカメラ位置から飛び始める(いきなり瞬間移動しない)
    currentPose.position.copy(camera.position);
    currentPose.target.copy(cameraController.target);
  }
  if (spectator.modeIndex === MANUAL_MODE_INDEX) {
    // マニュアルモードへ戻す。今の見え方をそのまま軌道パラメータへ引き継ぐ
    syncOrbitFromCamera();
    followVehicle = null;
    progressListener?.(0);
  } else if (spectator.modeIndex === AUTO_MODE_INDEX) {
    // オートモードは先頭のプリセットから始める
    switchPreset(0);
  } else {
    switchPreset(spectator.modeIndex - FIRST_PRESET_MODE_INDEX);
  }
  notify();
}

/** トグルボタン: マニュアル → オート → 各プリセット → マニュアル… と1つ進める */
export function cycleSpectatorMode(): void {
  setMode(spectator.modeIndex + 1);
}

/** マニュアルモードへ戻す(画面のタップ・ドラッグ・ホイール操作から呼ばれる) */
export function enterManualMode(): void {
  if (spectator.modeIndex !== MANUAL_MODE_INDEX) setMode(MANUAL_MODE_INDEX);
}

function updateSpectator(world: World, deltaTime: number): void {
  spectator.presetTime += deltaTime;
  if (spectator.modeIndex === AUTO_MODE_INDEX) {
    spectator.cycleTimer += deltaTime;
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
  if (spectator.modeIndex !== MANUAL_MODE_INDEX && world) {
    updateSpectator(world, deltaTime);
  } else {
    applyOrbit();
  }
}

export function setupCameraControls(): void {
  const dom = renderer.domElement;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  dom.addEventListener('pointerdown', function (e) {
    // 画面に触れた時点でマニュアルモードへ。ドラッグを待たずに切り替えるので
    // 「タップすれば自分で操作できる」ことが伝わる (Issue #43)
    enterManualMode();
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
    const deltaX = e.clientX - previous.x,
      deltaY = e.clientY - previous.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // ドラッグでもマニュアルモードへ戻す(タップを伴わないペン等の操作に備える)。
    // enterManualMode() の中で今の見え方が軌道パラメータへ引き継がれる
    enterManualMode();
    if (pointers.size === 1) {
      cameraController.theta -= deltaX * 0.005;
      cameraController.phi = clamp(cameraController.phi - deltaY * 0.004, 0.25, 1.45);
    } else if (pointers.size === 2) {
      const points = Array.from(pointers.values());
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (pinchDistance > 0)
        cameraController.radius = clamp(
          cameraController.radius * (pinchDistance / distance),
          30,
          240,
        );
      pinchDistance = distance;
    }
  });
  function release(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    pinchDistance = 0;
  }
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);
  dom.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      enterManualMode(); // ホイール操作もマニュアルモードへの復帰扱い
      cameraController.radius = clamp(cameraController.radius * (1 + e.deltaY * 0.0011), 30, 240);
    },
    { passive: false },
  );
}

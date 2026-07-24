/* ================= カメラ操作（回転・ズーム・観賞モード） ================= */
import * as THREE from 'three';
import { CONST, clamp } from '../core';
import type { Vehicle, World } from '../core';
import { camera, renderer } from './scene';
import { GANTRY_Z } from './track';

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

/* ---- 観賞モードで使う参照点（core の座標定数から算出。挙動は変えない） ----
   両区間の中心X、各区間の走行中心X、合流ランプ帯・頭上標識の位置を基準にする */
const L_CENTER_X = CONST.LANE_X.L[1]; // 義務あり区間の中心
const R_CENTER_X = CONST.LANE_X.R[1]; // 義務なし区間の中心
const CENTER_X = (L_CENTER_X + R_CENTER_X) / 2; // 全体の中心
const RAMP_Z_MID = (CONST.RAMP_Z_TOP + CONST.RAMP_Z_END) / 2; // 合流帯の中央
const SIGN_GANTRY_Z = GANTRY_Z[1]; // 看板プリセットで寄る頭上標識ゲート

/* ================= 通常の視点操作（従来どおりの軌道カメラ） ================= */
function applyOrbit(): void {
  const controller = cameraController;
  camera.position.set(
    controller.target.x + controller.radius * Math.sin(controller.phi) * Math.sin(controller.theta),
    controller.target.y + controller.radius * Math.cos(controller.phi),
    controller.target.z + controller.radius * Math.sin(controller.phi) * Math.cos(controller.theta),
  );
  camera.lookAt(controller.target);
}

/* ================= 観賞モード（プリセット巡回） =================
   一定間隔で視点が切り替わり、いろいろな角度から眺められるモード。
   現在のカメラ姿勢(位置・注視点)を毎フレーム目標へ滑らかに寄せることで、
   プリセット間はスムーズに、追尾中は少し遅れて追う自然な動きになる。
   状態管理はこのモジュールに閉じ、app.ts のループから毎フレーム更新する。 */

export type SpectatorPresetId = 'drone' | 'overhead' | 'lookup' | 'follow' | 'ramp' | 'gantry';

interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}
interface PresetContext {
  time: number; // モード開始からの経過秒
  world: World;
}
export interface SpectatorPreset {
  id: SpectatorPresetId;
  label: string;
  icon: string; // lucide アイコン名
  compute: (pose: Pose, ctx: PresetContext) => void; // pose を書き換える（確保を避ける）
}

// 追尾プリセットが追う車。区間内から1台選び、退場するまで同じ車を追い続ける
let followVehicle: Vehicle | null = null;
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
  return best;
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
    icon: 'square',
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
    // 路肩の低い位置から、通り過ぎる車と頭上標識を見上げる視点
    compute(pose) {
      pose.position.set(L_CENTER_X - 15, 1.2, SIGN_GANTRY_Z + 46);
      pose.target.set(CENTER_X, 6.5, SIGN_GANTRY_Z);
    },
  },
  {
    id: 'follow',
    label: '追尾',
    icon: 'car-front',
    // 特定の車を後方やや上から追う車載風の追尾視点
    compute(pose, { world }) {
      const vehicle = pickFollowVehicle(world);
      if (!vehicle) {
        // 追える車がいなければ俯瞰的な位置へ逃がす
        pose.position.set(CENTER_X, 60, 40);
        pose.target.set(CENTER_X, 0, 0);
        return;
      }
      // 車は -Z 方向へ進むので、後方 = +Z 側。少し横にずらして車体を見せる
      pose.position.set(vehicle.x - 5.5, 4.2, vehicle.z + 13);
      pose.target.set(vehicle.x, 1.3, vehicle.z - 6);
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
  {
    id: 'gantry',
    label: '看板',
    icon: 'panel-top',
    // 頭上標識ゲートの正面に寄り、看板がよく読める視点
    compute(pose) {
      pose.position.set(L_CENTER_X + 1, 6.6, SIGN_GANTRY_Z + 26);
      pose.target.set(L_CENTER_X, 8.3, SIGN_GANTRY_Z);
    },
  },
];

const AUTO_CYCLE_INTERVAL = 8; // 自動巡回でプリセットを切り替える間隔 (s)
const SMOOTH_RATE = 2.4; // 目標姿勢へ寄せる速さ(大きいほど機敏)

interface SpectatorState {
  enabled: boolean;
  auto: boolean;
  presetIndex: number;
  presetTime: number; // 現プリセットに切り替わってからの経過秒
  cycleTimer: number; // 自動巡回タイマー
}
const spectator: SpectatorState = {
  enabled: false,
  auto: true,
  presetIndex: 0,
  presetTime: 0,
  cycleTimer: 0,
};

// 現在のカメラ姿勢(滑らかに目標へ寄せていく実体)と、各プリセットが書き込む目標姿勢
const currentPose: Pose = {
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
};
const goalPose: Pose = {
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
};

type SpectatorListener = (state: {
  enabled: boolean;
  auto: boolean;
  presetId: SpectatorPresetId;
}) => void;
let changeListener: SpectatorListener | null = null;
export function onSpectatorChange(listener: SpectatorListener): void {
  changeListener = listener;
}
function notify(): void {
  changeListener?.({
    enabled: spectator.enabled,
    auto: spectator.auto,
    presetId: SPECTATOR_PRESETS[spectator.presetIndex].id,
  });
}

export function getSpectatorState(): {
  enabled: boolean;
  auto: boolean;
  presetId: SpectatorPresetId;
} {
  return {
    enabled: spectator.enabled,
    auto: spectator.auto,
    presetId: SPECTATOR_PRESETS[spectator.presetIndex].id,
  };
}

function switchPreset(index: number): void {
  spectator.presetIndex =
    ((index % SPECTATOR_PRESETS.length) + SPECTATOR_PRESETS.length) % SPECTATOR_PRESETS.length;
  spectator.presetTime = 0;
  spectator.cycleTimer = 0;
  followVehicle = null; // プリセットが変わったら追尾対象は選び直す
  notify();
}

export function setSpectatorEnabled(on: boolean): void {
  if (spectator.enabled === on) return;
  spectator.enabled = on;
  if (on) {
    // 現在の軌道カメラ位置から飛び始める(いきなり瞬間移動しない)
    currentPose.position.copy(camera.position);
    currentPose.target.copy(cameraController.target);
    spectator.presetTime = 0;
    spectator.cycleTimer = 0;
    followVehicle = null;
  } else {
    // 通常操作へ戻す際、今の見え方をそのまま軌道パラメータへ引き継ぐ
    syncOrbitFromCamera();
  }
  notify();
}

export function setSpectatorAuto(on: boolean): void {
  spectator.auto = on;
  spectator.cycleTimer = 0;
  notify();
}

// 手動でプリセットを選ぶ。観賞モードを有効化し、自動巡回は止める(ユーザーが主導)
export function selectSpectatorPreset(id: SpectatorPresetId): void {
  const index = SPECTATOR_PRESETS.findIndex((preset) => preset.id === id);
  if (index < 0) return;
  spectator.auto = false;
  if (!spectator.enabled) {
    setSpectatorEnabled(true);
  }
  switchPreset(index);
}

// 現在のカメラ位置と注視点から軌道パラメータ(theta/phi/radius)を逆算する。
// 観賞モード終了時に、通常操作へ滑らかに引き継ぐため
function syncOrbitFromCamera(): void {
  const relative = camera.position.clone().sub(cameraController.target);
  const radius = clamp(relative.length(), 30, 240);
  cameraController.radius = radius;
  cameraController.phi = clamp(Math.acos(clamp(relative.y / radius, -1, 1)), 0.25, 1.45);
  cameraController.theta = Math.atan2(relative.x, relative.z);
}

function updateSpectator(world: World, deltaTime: number): void {
  spectator.presetTime += deltaTime;
  if (spectator.auto) {
    spectator.cycleTimer += deltaTime;
    if (spectator.cycleTimer >= AUTO_CYCLE_INTERVAL) {
      switchPreset(spectator.presetIndex + 1);
    }
  }
  SPECTATOR_PRESETS[spectator.presetIndex].compute(goalPose, {
    time: spectator.presetTime,
    world,
  });
  // 目標姿勢へ指数関数的に寄せる(フレームレート非依存)
  const factor = 1 - Math.exp(-deltaTime * SMOOTH_RATE);
  currentPose.position.lerp(goalPose.position, factor);
  currentPose.target.lerp(goalPose.target, factor);
  camera.position.copy(currentPose.position);
  camera.lookAt(currentPose.target);
}

/* ---- 毎フレーム呼ばれるカメラ更新の入口 ----
   観賞モードが無効なら従来の軌道カメラ、有効ならプリセット巡回で描く。
   world/deltaTime は観賞モードのときだけ使う(初期化時の引数なし呼び出しも許容) */
export function updateCamera(world?: World, deltaTime = 0): void {
  if (spectator.enabled && world) {
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
    // 観賞モード中は手動ドラッグでモードを抜けて通常操作へ(直感的に「触れば戻る」)
    // setSpectatorEnabled(false) 内で今の見え方が軌道パラメータへ引き継がれる
    if (spectator.enabled) setSpectatorEnabled(false);
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
      cameraController.radius = clamp(cameraController.radius * (1 + e.deltaY * 0.0011), 30, 240);
    },
    { passive: false },
  );
}

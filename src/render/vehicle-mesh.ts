/* ================= 車両メッシュ(生成とワールドとの同期) =================
   パフォーマンス: 車両1台を約30個のメッシュで組むとdraw callが車両数×30に
   膨らみ、GPU/CPUの発熱源になる。そこで車種ごとに「マテリアル単位で結合した
   ジオメトリ(ブループリント)」を一度だけ作ってキャッシュし、1台あたりの
   メッシュ数を約1/3に抑える(見た目は結合前と同一)。 */
import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils';
import { CONST, TYPES, clamp } from '../core';
import type { Vehicle, VehicleTypeName, World } from '../core';
import { scene } from './scene';
import {
  paint,
  glassMaterial,
  tireMaterial,
  hubMaterial,
  cargoMaterial,
  trimMaterial,
  plateMaterial,
  headlightMaterial,
  brakeGlowMaterial,
  brakeGlowGeometry,
  beamMaterial,
  beamGeometry,
} from './materials';
import { themeState } from './theme';

// ドライバーの「手癖」(描画上の個性)。実際の車は車線の中央ぴったりを走らない。
// 車線内の定位置(左寄り/右寄り)、無意識の蛇行の周期・振幅、修正舵の細かさは
// ドライバーごとに違う
interface DriverHabit {
  bias: number; // 好みの定位置(車線中央からのオフセット)
  swayAmplitude: number; // 蛇行の振幅
  swayFreq: number; // ゆったりした蛇行 (rad/s)
  driftFreq: number; // さらに長周期のドリフト
  jitterFreq: number; // 細かい修正舵
  swayPhase: number;
  driftPhase: number;
  shaky: boolean; // 修正舵が忙しいタイプ
  time: number;
}

export interface VehicleMesh {
  group: THREE.Group;
  brakeMaterial: THREE.MeshBasicMaterial;
  blinkLeft: THREE.MeshBasicMaterial;
  blinkRight: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  beamDistance: number;
  brakeGlow: THREE.Mesh;
  previousX: number;
  previousSpeed: number;
  pitch: number;
  habit: DriverHabit;
}

// 車体の側面プロファイルを幅方向へ押し出し、実車らしいシルエットを作る。
// プロファイルの +x が車体前方(ワールドの -z)、y が高さに対応する
function profileGeometry(
  points: [number, number][],
  width: number,
  bevel: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.1, width - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
  });
  geometry.translate(0, 0, -(width - bevel * 2) / 2);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}
function wheelGeometry(radius: number, width: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, width, 14);
  geometry.rotateZ(Math.PI / 2); // 車軸をX方向へ
  return geometry;
}
const plateGeometry = new THREE.BoxGeometry(0.34, 0.16, 0.04);
const mirrorGeometry = new THREE.BoxGeometry(0.1, 0.11, 0.2);
const taxiSignGeometry = new THREE.BoxGeometry(0.5, 0.22, 0.3);
const taxiSignMaterial = paint(0xffa400);

/* ---- 車種ブループリント(マテリアル単位で結合済みのジオメトリ) ---- */
// スロット = 共有マテリアル1つに対応する結合ジオメトリ。
// body(車体色)・brake/blink(車両ごとに個別マテリアル)以外は全車で共有される
type PartSlot =
  | 'body'
  | 'glass'
  | 'trim'
  | 'tire'
  | 'hub'
  | 'cargo'
  | 'plate'
  | 'head'
  | 'brake'
  | 'blinkLeft'
  | 'blinkRight';

interface Blueprint {
  parts: Partial<Record<PartSlot, THREE.BufferGeometry>>;
  lightY: number;
}

const blueprintCache: Partial<Record<VehicleTypeName, Blueprint>> = {};

function buildBlueprint(typeName: VehicleTypeName): Blueprint {
  const spec = TYPES[typeName],
    bodyLength = spec.length,
    bodyWidth = spec.width,
    bodyHeight = spec.height,
    halfLength = bodyLength / 2;
  const slotGeometries: Partial<Record<PartSlot, THREE.BufferGeometry[]>> = {};
  // ジオメトリをローカル変換(回転→平行移動)込みでスロットへ蓄積する。
  // 結合にはindexの有無を揃える必要があるため、indexed形状は展開する
  function put(
    slot: PartSlot,
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rotationX?: number,
  ): void {
    const prepared = geometry.index ? geometry.toNonIndexed() : geometry;
    if (rotationX) prepared.rotateX(rotationX);
    prepared.translate(x, y, z);
    (slotGeometries[slot] ||= []).push(prepared);
  }
  function wheels(radius: number, wheelZs: number[]): void {
    const wheelX = bodyWidth / 2 - 0.14;
    const tireGeometry = wheelGeometry(radius, 0.3),
      hubGeometry = wheelGeometry(radius * 0.55, 0.34);
    for (const wheelZ of wheelZs)
      for (const side of [-1, 1]) {
        put('tire', tireGeometry, side * wheelX, radius, wheelZ);
        put('hub', hubGeometry, side * wheelX, radius, wheelZ);
      }
  }
  function mirrors(slot: PartSlot, y: number, z: number): void {
    put(slot, mirrorGeometry, -(bodyWidth / 2 + 0.06), y, z);
    put(slot, mirrorGeometry, bodyWidth / 2 + 0.06, y, z);
  }

  switch (typeName) {
    case 'Sedan': {
      // 3ボックス(ボンネット・キャビン・トランク)の下半身
      put(
        'body',
        profileGeometry(
          [
            [-halfLength, 0.32],
            [-halfLength, bodyHeight * 0.62],
            [-halfLength * 0.93, bodyHeight * 0.68],
            [halfLength * 0.55, bodyHeight * 0.68],
            [halfLength * 0.82, bodyHeight * 0.55],
            [halfLength, 0.62],
            [halfLength, 0.34],
            [halfLength * 0.9, 0.25],
            [-halfLength * 0.9, 0.25],
          ],
          bodyWidth,
          0.06,
        ),
        0,
        0,
        0,
      );
      // キャビン(スモークガラスのキャノピー)
      put(
        'glass',
        profileGeometry(
          [
            [-halfLength * 0.62, bodyHeight * 0.64],
            [-halfLength * 0.4, bodyHeight * 0.97],
            [halfLength * 0.06, bodyHeight * 0.97],
            [halfLength * 0.34, bodyHeight * 0.64],
          ],
          bodyWidth * 0.84,
          0.05,
        ),
        0,
        0,
        0,
      );
      put('body', new THREE.BoxGeometry(0.1, 0.08, 0.26), 0, bodyHeight * 0.99, halfLength * 0.4); // シャークフィン
      mirrors('body', bodyHeight * 0.66, -halfLength * 0.3);
      wheels(0.33, [-(halfLength - 0.85), halfLength - 0.85]);
      break;
    }
    case 'SportsCar': {
      // 低く長いウェッジシェイプ
      put(
        'body',
        profileGeometry(
          [
            [-halfLength, 0.3],
            [-halfLength, bodyHeight * 0.6],
            [-halfLength * 0.88, bodyHeight * 0.72],
            [-halfLength * 0.15, bodyHeight * 0.74],
            [halfLength * 0.55, bodyHeight * 0.52],
            [halfLength, 0.44],
            [halfLength, 0.3],
            [halfLength * 0.9, 0.22],
            [-halfLength * 0.9, 0.22],
          ],
          bodyWidth,
          0.06,
        ),
        0,
        0,
        0,
      );
      put(
        'glass',
        profileGeometry(
          [
            [-halfLength * 0.52, bodyHeight * 0.66],
            [-halfLength * 0.26, bodyHeight * 0.98],
            [halfLength * 0.04, bodyHeight * 0.98],
            [halfLength * 0.3, bodyHeight * 0.6],
          ],
          bodyWidth * 0.78,
          0.04,
        ),
        0,
        0,
        0,
      );
      // リアウイング
      put(
        'body',
        new THREE.BoxGeometry(bodyWidth * 0.92, 0.05, 0.36),
        0,
        bodyHeight * 0.92,
        halfLength * 0.88,
      );
      put(
        'body',
        new THREE.BoxGeometry(0.07, 0.2, 0.16),
        -bodyWidth * 0.32,
        bodyHeight * 0.79,
        halfLength * 0.9,
      );
      put(
        'body',
        new THREE.BoxGeometry(0.07, 0.2, 0.16),
        bodyWidth * 0.32,
        bodyHeight * 0.79,
        halfLength * 0.9,
      );
      mirrors('body', bodyHeight * 0.68, -halfLength * 0.28);
      wheels(0.33, [-(halfLength - 0.8), halfLength - 0.8]);
      break;
    }
    case 'Truck': {
      const cabLength = 2.2,
        cabHeight = 1.85,
        cabFloorY = 0.85,
        cabRoofY = cabFloorY + cabHeight, // キャブ屋根の高さ
        cargoGap = 0.35, // キャブと荷箱の間の隙間
        cargoLength = bodyLength - cabLength - cargoGap,
        cargoHeight = bodyHeight - 0.65,
        cargoFloorY = 0.62,
        cargoTopY = cargoFloorY + cargoHeight, // 荷箱の上端
        cargoFrontZ = -(halfLength - cabLength - cargoGap); // 荷箱の前面
      // キャブ
      put(
        'body',
        new THREE.BoxGeometry(bodyWidth, cabHeight, cabLength),
        0,
        cabFloorY + cabHeight / 2,
        -(halfLength - cabLength / 2),
      );
      // フロントガラスをわずかに寝かせる
      put(
        'glass',
        new THREE.BoxGeometry(bodyWidth * 0.9, 0.85, 0.07),
        0,
        2.3,
        -(halfLength + 0.01),
        0.1,
      );
      put(
        'glass',
        new THREE.BoxGeometry(bodyWidth + 0.02, 0.6, 1.0),
        0,
        2.25,
        -(halfLength - cabLength / 2) + 0.1,
      );
      put(
        'trim',
        new THREE.BoxGeometry(bodyWidth * 0.9, 0.55, 0.08),
        0,
        1.35,
        -(halfLength + 0.02),
      ); // グリル
      put('hub', new THREE.BoxGeometry(bodyWidth, 0.3, 0.14), 0, 0.45, -(halfLength + 0.03)); // 金属バンパー
      // 導風板(キャブ屋根から荷箱の上端へ斜めに立ち上がる)。傾いた板1枚だと
      // 側面が開いたままで、左右から屋根の裏の空洞が見えてしまう。キャブ屋根・
      // 荷箱前面・斜面で囲んだ三角形の側面プロファイルを幅方向へ押し出し、
      // 左右を塞いだ中実のフェアリングとして作る
      put(
        'body',
        profileGeometry(
          [
            // プロファイルの +x は車体前方(= ワールドの -z)
            [halfLength - 0.9, cabRoofY - 0.02], // 前下: キャブ屋根に少し埋める
            [-cargoFrontZ, cabRoofY - 0.02], // 後下: 荷箱前面
            [-cargoFrontZ, cargoTopY - 0.05], // 後上: 荷箱の上端に合わせる
          ],
          bodyWidth,
          0.05,
        ),
        0,
        0,
        0,
      );
      // 荷箱
      put(
        'cargo',
        new THREE.BoxGeometry(bodyWidth, cargoHeight, cargoLength),
        0,
        cargoFloorY + cargoHeight / 2,
        cargoFrontZ + cargoLength / 2,
      );
      put('trim', new THREE.BoxGeometry(bodyWidth * 0.94, 0.5, bodyLength * 0.3), 0, 0.5, 0.1); // サイドスカート
      put('trim', new THREE.BoxGeometry(bodyWidth * 0.9, 0.45, 0.05), 0, 0.32, halfLength - 0.15); // 泥除け
      put('hub', new THREE.BoxGeometry(bodyWidth * 0.9, 0.12, 0.1), 0, 0.55, halfLength + 0.02); // 突入防止装置
      mirrors('trim', 2.35, -(halfLength - 0.25));
      wheels(0.48, [-(halfLength - 1.15), halfLength - 1.35, halfLength - 2.45]);
      break;
    }
    case 'Van': {
      // ワンボックス
      put(
        'body',
        profileGeometry(
          [
            [-halfLength, 0.34],
            [-halfLength, bodyHeight * 0.84],
            [-halfLength * 0.9, bodyHeight * 0.96],
            [halfLength * 0.72, bodyHeight * 0.96],
            [halfLength * 0.96, bodyHeight * 0.82],
            [halfLength, 0.58],
            [halfLength, 0.32],
            [halfLength * 0.9, 0.25],
            [-halfLength * 0.9, 0.25],
          ],
          bodyWidth,
          0.06,
        ),
        0,
        0,
        0,
      );
      // キャブオーバーらしく、前面のすぐ上に立ったフロントガラス
      put(
        'glass',
        new THREE.BoxGeometry(bodyWidth * 0.86, bodyHeight * 0.3, 0.06),
        0,
        bodyHeight * 0.76,
        -(halfLength + 0.02),
        0.08,
      );
      // ボンネットの代わりの低いグリル
      put(
        'trim',
        new THREE.BoxGeometry(bodyWidth * 0.8, bodyHeight * 0.16, 0.06),
        0,
        bodyHeight * 0.5,
        -(halfLength + 0.03),
      );
      // サイドウィンドウ帯・リアガラス
      put(
        'glass',
        new THREE.BoxGeometry(bodyWidth + 0.02, bodyHeight * 0.22, bodyLength * 0.58),
        0,
        bodyHeight * 0.78,
        halfLength * 0.12,
      );
      put(
        'glass',
        new THREE.BoxGeometry(bodyWidth * 0.8, bodyHeight * 0.22, 0.05),
        0,
        bodyHeight * 0.72,
        halfLength + 0.01,
      );
      mirrors('body', bodyHeight * 0.68, -(halfLength - 0.22));
      wheels(0.35, [-(halfLength - 0.75), halfLength - 1.1]);
      break;
    }
  }
  // 樹脂バンパー・グリル・ナンバープレート(トラック以外の共通装備)
  if (typeName !== 'Truck') {
    put('trim', new THREE.BoxGeometry(bodyWidth * 0.98, 0.17, 0.12), 0, 0.38, -(halfLength + 0.01));
    put('trim', new THREE.BoxGeometry(bodyWidth * 0.98, 0.17, 0.12), 0, 0.38, halfLength + 0.01);
    put('trim', new THREE.BoxGeometry(bodyWidth * 0.5, 0.13, 0.05), 0, 0.55, -(halfLength + 0.04));
  }
  put('plate', plateGeometry, 0, 0.4, -(halfLength + 0.1));
  put('plate', plateGeometry, 0, 0.4, halfLength + 0.1);
  // ヘッドライト（前方 = -Z）。マテリアルは全車共有で昼夜一括切替
  const lightY = typeName === 'Truck' ? 1.05 : 0.66;
  const headlightGeometry = new THREE.BoxGeometry(0.34, 0.16, 0.1);
  put('head', headlightGeometry, -(bodyWidth / 2 - 0.34), lightY, -bodyLength / 2 - 0.06);
  put('head', headlightGeometry, bodyWidth / 2 - 0.34, lightY, -bodyLength / 2 - 0.06);
  // ブレーキランプ（後方 = +Z）
  const brakeGeometry = new THREE.BoxGeometry(0.52, 0.22, 0.1);
  put('brake', brakeGeometry, -(bodyWidth / 2 - 0.34), lightY + 0.06, bodyLength / 2 + 0.04);
  put('brake', brakeGeometry, bodyWidth / 2 - 0.34, lightY + 0.06, bodyLength / 2 + 0.04);
  // ウインカー（車線変更時に点滅）
  const blinkerGeometry = new THREE.BoxGeometry(0.22, 0.2, 0.22);
  put('blinkLeft', blinkerGeometry, -(bodyWidth / 2 + 0.02), lightY, bodyLength / 2 - 0.12);
  put('blinkLeft', blinkerGeometry, -(bodyWidth / 2 + 0.02), lightY, -(bodyLength / 2 - 0.12));
  put('blinkRight', blinkerGeometry, bodyWidth / 2 + 0.02, lightY, bodyLength / 2 - 0.12);
  put('blinkRight', blinkerGeometry, bodyWidth / 2 + 0.02, lightY, -(bodyLength / 2 - 0.12));

  const parts: Blueprint['parts'] = {};
  for (const slot of Object.keys(slotGeometries) as PartSlot[]) {
    parts[slot] = BufferGeometryUtils.mergeBufferGeometries(slotGeometries[slot]!);
  }
  return { parts, lightY };
}

function blueprint(typeName: VehicleTypeName): Blueprint {
  return (blueprintCache[typeName] ||= buildBlueprint(typeName));
}

function buildVehicleMesh(vehicle: Vehicle): VehicleMesh {
  const vehicleBlueprint = blueprint(vehicle.typeName);
  const bodyLength = vehicle.type.length;
  const group = new THREE.Group();
  // 各パーツはブループリント側で位置決め済み(ローカル変換は恒等)なので、
  // 毎フレームの行列再計算を止めて描画コストを下げる
  function addPart(slot: PartSlot, material: THREE.Material, castShadow?: boolean): void {
    const geometry = vehicleBlueprint.parts[slot];
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, material);
    if (castShadow) mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  addPart('body', paint(vehicle.color), true);
  addPart('glass', glassMaterial, true);
  addPart('trim', trimMaterial);
  addPart('tire', tireMaterial, true);
  addPart('hub', hubMaterial);
  addPart('cargo', cargoMaterial, true);
  addPart('plate', plateMaterial);
  addPart('head', headlightMaterial);
  if (vehicle.isTaxi) {
    const sign = new THREE.Mesh(taxiSignGeometry, taxiSignMaterial);
    sign.position.set(0, vehicle.type.height * 0.97 + 0.14, (bodyLength / 2) * 0.15);
    sign.matrixAutoUpdate = false;
    sign.updateMatrix();
    group.add(sign);
  }
  // 灯火類は照明の影響を受けない発光体として描く(昼でもはっきり光って見える)。
  // 色を車両ごとに切り替えるため、マテリアルだけ個別に持つ
  const brakeMaterial = new THREE.MeshBasicMaterial({ color: 0x4a0b0b });
  const blinkLeft = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  const blinkRight = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  addPart('brake', brakeMaterial);
  addPart('blinkLeft', blinkLeft);
  addPart('blinkRight', blinkRight);
  // ヘッドライトの路面照射(夜のみ表示)。車体グループの子にすると加減速の
  // ピッチや操舵ロール(毎フレーム細かく揺れる)で光だまりの平面が路面下に
  // 潜り、深度テストで見え隠れしてチラつくため、シーン直下に置いて常に
  // 路面と平行を保つ(位置とヨーだけ syncMeshes で追従させる)
  const beamDistance = bodyLength / 2 + 4.2;
  const beam = new THREE.Mesh(beamGeometry, beamMaterial);
  beam.rotation.order = 'YXZ'; // 平面を伏せた後にヨーを世界のY軸まわりで適用する
  beam.rotation.set(-Math.PI / 2, 0, 0);
  beam.visible = themeState.mix > 0.04;
  scene.add(beam);
  // ブレーキ時に背面へにじむ赤いグロー(視認性アップ)
  const brakeGlow = new THREE.Mesh(brakeGlowGeometry, brakeGlowMaterial);
  brakeGlow.position.set(0, vehicleBlueprint.lightY + 0.04, bodyLength / 2 + 0.18);
  brakeGlow.matrixAutoUpdate = false;
  brakeGlow.updateMatrix();
  brakeGlow.visible = false;
  group.add(brakeGlow);
  const bodyWidth = vehicle.type.width;
  const margin = Math.max(0, (3.7 - bodyWidth) / 2 - 0.42); // 車線内で安全に振れる余白
  const habit: DriverHabit = {
    bias: (Math.random() * 2 - 1) * margin * 0.9,
    swayAmplitude: (0.05 + Math.random() * 0.13) * Math.min(1, margin / 0.5 + 0.35),
    swayFreq: 0.55 + Math.random() * 0.55,
    driftFreq: 0.16 + Math.random() * 0.22,
    jitterFreq: 2.2 + Math.random() * 1.6,
    swayPhase: Math.random() * 6.283,
    driftPhase: Math.random() * 6.283,
    shaky: Math.random() < 0.22,
    time: Math.random() * 100,
  };
  return {
    group,
    brakeMaterial,
    blinkLeft,
    blinkRight,
    beam,
    beamDistance,
    brakeGlow,
    previousX: vehicle.x + habit.bias,
    previousSpeed: vehicle.speed,
    pitch: 0,
    habit,
  };
}

/* ---- ワールドとメッシュの同期 ---- */
const meshMap = new Map<Vehicle, VehicleMesh>();

export function syncMeshes(world: World, deltaTime: number): void {
  for (const vehicle of world.vehicles) {
    let mesh = meshMap.get(vehicle);
    if (!mesh) {
      mesh = buildVehicleMesh(vehicle);
      meshMap.set(vehicle, mesh);
      scene.add(mesh.group);
    }
    mesh.group.visible = !vehicle.waiting;
    if (vehicle.waiting) {
      mesh.beam.visible = false;
      continue;
    }
    // ---- ハンドル操作の個性: 定位置のズレ + 無意識の蛇行(速度が低いほど収まる) ----
    const habit = mesh.habit;
    habit.time += deltaTime;
    const sway =
      Math.sin(habit.time * habit.swayFreq + habit.swayPhase) * 0.62 +
      Math.sin(habit.time * habit.driftFreq + habit.driftPhase) * 0.38 +
      (habit.shaky ? Math.sin(habit.time * habit.jitterFreq + habit.swayPhase * 2) * 0.22 : 0);
    const amplitude = habit.swayAmplitude * (0.25 + 0.75 * clamp(vehicle.speed / 25, 0, 1));
    const x = vehicle.x + habit.bias + sway * amplitude;
    mesh.group.position.set(x, 0, vehicle.z);
    const lateralVelocity = deltaTime > 0 ? (x - mesh.previousX) / deltaTime : 0;
    mesh.previousX = x;
    // 操舵ヨー + 車体ロール + 加減速のピッチ(ノーズダイブ/スクワット)
    mesh.group.rotation.y = clamp(-lateralVelocity / (vehicle.speed + 6), -0.16, 0.16) * 1.5;
    mesh.group.rotation.z = mesh.group.rotation.y * 0.3;
    const acceleration = deltaTime > 0 ? (vehicle.speed - mesh.previousSpeed) / deltaTime : 0;
    mesh.previousSpeed = vehicle.speed;
    mesh.pitch +=
      (clamp(acceleration * 0.0075, -0.05, 0.03) - mesh.pitch) * Math.min(1, deltaTime * 6);
    mesh.group.rotation.x = mesh.pitch;
    // ヘッドライトの光だまり: 車体の揺れに追従させず、常に路面上へ平置きする
    mesh.beam.visible = themeState.mix > 0.04;
    const yaw = mesh.group.rotation.y;
    mesh.beam.position.set(
      x - Math.sin(yaw) * mesh.beamDistance,
      0.04,
      vehicle.z - Math.cos(yaw) * mesh.beamDistance,
    );
    mesh.beam.rotation.y = yaw;
    mesh.brakeMaterial.color.setHex(vehicle.braking ? 0xff2a2a : themeState.tailIdleHex);
    mesh.brakeGlow.visible = vehicle.braking;
    if (vehicle.braking) brakeGlowMaterial.opacity = 0.45 + 0.45 * themeState.mix;
    const laneChange = vehicle.laneChange;
    const blinkOn = laneChange.state !== 'none' && Math.floor(performance.now() / 350) % 2 === 0;
    const turningRight =
      laneChange.state !== 'none' &&
      CONST.LANE_X[vehicle.section][laneChange.to] > CONST.LANE_X[vehicle.section][laneChange.from];
    // ハザード(両側同時点滅)は車線変更ウインカーより優先して見せる
    const hazardOn = vehicle.hazard && Math.floor(performance.now() / 380) % 2 === 0;
    mesh.blinkLeft.color.setHex(hazardOn || (blinkOn && !turningRight) ? 0xffb31a : 0x6b4a10);
    mesh.blinkRight.color.setHex(hazardOn || (blinkOn && turningRight) ? 0xffb31a : 0x6b4a10);
  }
  if (meshMap.size !== world.vehicles.length) {
    const alive = new Set(world.vehicles);
    for (const [vehicle, mesh] of meshMap) {
      if (!alive.has(vehicle)) {
        scene.remove(mesh.group);
        scene.remove(mesh.beam); // 光だまりはシーン直下にあるため個別に外す
        // ジオメトリはブループリント共有なので破棄しない(マテリアルのみ個別)
        mesh.brakeMaterial.dispose();
        mesh.blinkLeft.dispose();
        mesh.blinkRight.dispose();
        meshMap.delete(vehicle);
      }
    }
  }
}

/* ================= 車両メッシュ(生成とワールドとの同期) ================= */
import * as THREE from 'three';
import { CONST as C, clamp } from '../core';
import type { Vehicle, World } from '../core';
import { scene } from './scene';
import {
  paint,
  glassMat,
  tireMat,
  hubMat,
  cargoMat,
  trimMat,
  plateMat,
  headMat,
  brakeGlowMat,
  brakeGlowGeo,
  beamMat,
  beamGeo,
} from './materials';
import { themeState } from './theme';

// ドライバーの「手癖」(描画上の個性)。実際の車は車線の中央ぴったりを走らない。
// 車線内の定位置(左寄り/右寄り)、無意識の蛇行の周期・振幅、修正舵の細かさは
// ドライバーごとに違う
interface DriverHabit {
  bias: number; // 好みの定位置(車線中央からのオフセット)
  swayA: number; // 蛇行の振幅
  f1: number; // ゆったりした蛇行 (rad/s)
  f2: number; // さらに長周期のドリフト
  f3: number; // 細かい修正舵
  p1: number;
  p2: number;
  shaky: boolean; // 修正舵が忙しいタイプ
  t: number;
}

export interface VehicleMesh {
  group: THREE.Group;
  brakeMat: THREE.MeshBasicMaterial;
  blinkL: THREE.MeshBasicMaterial;
  blinkR: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  beamDist: number;
  bglow: THREE.Mesh;
  prevX: number;
  prevSpeed: number;
  pitch: number;
  drv: DriverHabit;
}

// 車体の側面プロファイルを幅方向へ押し出し、実車らしいシルエットを作る。
// プロファイルの +x が車体前方(ワールドの -z)、y が高さに対応する
function profileGeo(pts: [number, number][], width: number, bevel: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.1, width - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
  });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(Math.PI / 2);
  return geo;
}
const wheelGeoCache: Record<string, THREE.CylinderGeometry> = {};
function wheelGeo(r: number, w: number): THREE.CylinderGeometry {
  const key = r + '_' + w;
  if (!wheelGeoCache[key]) {
    const geo = new THREE.CylinderGeometry(r, r, w, 14);
    geo.rotateZ(Math.PI / 2); // 車軸をX方向へ
    wheelGeoCache[key] = geo;
  }
  return wheelGeoCache[key];
}
const plateGeo = new THREE.BoxGeometry(0.34, 0.16, 0.04);
const mirrorGeo = new THREE.BoxGeometry(0.1, 0.11, 0.2);

function buildVehicleMesh(v: Vehicle): VehicleMesh {
  const t = v.type,
    L = t.len,
    W = t.w,
    H = t.h,
    l = L / 2;
  const g = new THREE.Group();
  function add(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    cast?: boolean,
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (cast) m.castShadow = true;
    g.add(m);
    return m;
  }
  function wheels(r: number, wzs: number[]): void {
    const wx = W / 2 - 0.14;
    for (const wz of wzs)
      for (const s of [-1, 1]) {
        add(wheelGeo(r, 0.3), tireMat, s * wx, r, wz, true);
        add(wheelGeo(r * 0.55, 0.34), hubMat, s * wx, r, wz);
      }
  }
  function mirrors(mat: THREE.Material, y: number, z: number): void {
    add(mirrorGeo, mat, -(W / 2 + 0.06), y, z);
    add(mirrorGeo, mat, W / 2 + 0.06, y, z);
  }
  const body = paint(v.color);

  switch (v.typeName) {
    case 'Sedan': {
      // 3ボックス(ボンネット・キャビン・トランク)の下半身
      add(
        profileGeo(
          [
            [-l, 0.32],
            [-l, H * 0.62],
            [-l * 0.93, H * 0.68],
            [l * 0.55, H * 0.68],
            [l * 0.82, H * 0.55],
            [l, 0.62],
            [l, 0.34],
            [l * 0.9, 0.25],
            [-l * 0.9, 0.25],
          ],
          W,
          0.06,
        ),
        body,
        0,
        0,
        0,
        true,
      );
      // キャビン(スモークガラスのキャノピー)
      add(
        profileGeo(
          [
            [-l * 0.62, H * 0.64],
            [-l * 0.4, H * 0.97],
            [l * 0.06, H * 0.97],
            [l * 0.34, H * 0.64],
          ],
          W * 0.84,
          0.05,
        ),
        glassMat,
        0,
        0,
        0,
        true,
      );
      add(new THREE.BoxGeometry(0.1, 0.08, 0.26), body, 0, H * 0.99, l * 0.4); // シャークフィン
      mirrors(body, H * 0.66, -l * 0.3);
      wheels(0.33, [-(l - 0.85), l - 0.85]);
      if (v.isTaxi)
        add(new THREE.BoxGeometry(0.5, 0.22, 0.3), paint(0xffa400), 0, H * 0.97 + 0.14, l * 0.15);
      break;
    }
    case 'SportsCar': {
      // 低く長いウェッジシェイプ
      add(
        profileGeo(
          [
            [-l, 0.3],
            [-l, H * 0.6],
            [-l * 0.88, H * 0.72],
            [-l * 0.15, H * 0.74],
            [l * 0.55, H * 0.52],
            [l, 0.44],
            [l, 0.3],
            [l * 0.9, 0.22],
            [-l * 0.9, 0.22],
          ],
          W,
          0.06,
        ),
        body,
        0,
        0,
        0,
        true,
      );
      add(
        profileGeo(
          [
            [-l * 0.52, H * 0.66],
            [-l * 0.26, H * 0.98],
            [l * 0.04, H * 0.98],
            [l * 0.3, H * 0.6],
          ],
          W * 0.78,
          0.04,
        ),
        glassMat,
        0,
        0,
        0,
        true,
      );
      // リアウイング
      add(new THREE.BoxGeometry(W * 0.92, 0.05, 0.36), body, 0, H * 0.92, l * 0.88, true);
      add(new THREE.BoxGeometry(0.07, 0.2, 0.16), body, -W * 0.32, H * 0.79, l * 0.9);
      add(new THREE.BoxGeometry(0.07, 0.2, 0.16), body, W * 0.32, H * 0.79, l * 0.9);
      mirrors(body, H * 0.68, -l * 0.28);
      wheels(0.33, [-(l - 0.8), l - 0.8]);
      break;
    }
    case 'Truck': {
      const cabL = 2.2;
      // キャブ
      add(new THREE.BoxGeometry(W, 1.85, cabL), body, 0, 1.775, -(l - cabL / 2), true);
      const tw = add(new THREE.BoxGeometry(W * 0.9, 0.85, 0.07), glassMat, 0, 2.3, -(l + 0.01));
      tw.rotation.x = 0.1; // フロントガラスをわずかに寝かせる
      add(new THREE.BoxGeometry(W + 0.02, 0.6, 1.0), glassMat, 0, 2.25, -(l - cabL / 2) + 0.1);
      add(new THREE.BoxGeometry(W * 0.9, 0.55, 0.08), trimMat, 0, 1.35, -(l + 0.02)); // グリル
      add(new THREE.BoxGeometry(W, 0.3, 0.14), hubMat, 0, 0.45, -(l + 0.03)); // 金属バンパー
      // 導風板(キャブ屋根から荷箱の高さへつなぐ)
      const defl = add(new THREE.BoxGeometry(W * 0.9, 1.45, 0.06), body, 0, 3.07, -(l - 1.55));
      defl.rotation.x = 1.05;
      // 荷箱
      add(
        new THREE.BoxGeometry(W, H - 0.65, L - cabL - 0.35),
        cargoMat,
        0,
        0.62 + (H - 0.65) / 2,
        (cabL + 0.35) / 2,
        true,
      );
      add(new THREE.BoxGeometry(W * 0.94, 0.5, L * 0.3), trimMat, 0, 0.5, 0.1); // サイドスカート
      add(new THREE.BoxGeometry(W * 0.9, 0.45, 0.05), trimMat, 0, 0.32, l - 0.15); // 泥除け
      add(new THREE.BoxGeometry(W * 0.9, 0.12, 0.1), hubMat, 0, 0.55, l + 0.02); // 突入防止装置
      mirrors(trimMat, 2.35, -(l - 0.25));
      wheels(0.48, [-(l - 1.15), l - 1.35, l - 2.45]);
      break;
    }
    case 'Van': {
      // ワンボックス
      add(
        profileGeo(
          [
            [-l, 0.34],
            [-l, H * 0.92],
            [-l * 0.86, H * 0.97],
            [l * 0.26, H * 0.97],
            [l * 0.6, H * 0.6],
            [l, 0.42],
            [l, 0.32],
            [l * 0.9, 0.25],
            [-l * 0.9, 0.25],
          ],
          W,
          0.06,
        ),
        body,
        0,
        0,
        0,
        true,
      );
      // 傾斜したフロントガラス
      const ws = add(
        new THREE.BoxGeometry(W * 0.86, 1.15, 0.06),
        glassMat,
        0,
        H * 0.785,
        -l * 0.43,
      );
      ws.rotation.x = 0.86;
      // サイドウィンドウ帯・リアガラス
      add(new THREE.BoxGeometry(W + 0.02, H * 0.2, L * 0.55), glassMat, 0, H * 0.76, l * 0.18);
      add(new THREE.BoxGeometry(W * 0.8, H * 0.22, 0.05), glassMat, 0, H * 0.72, l + 0.01);
      mirrors(body, H * 0.62, -l * 0.42);
      wheels(0.35, [-(l - 1.0), l - 1.1]);
      break;
    }
  }
  // 樹脂バンパー・グリル・ナンバープレート(トラック以外の共通装備)
  if (v.typeName !== 'Truck') {
    add(new THREE.BoxGeometry(W * 0.98, 0.17, 0.12), trimMat, 0, 0.38, -(l + 0.01));
    add(new THREE.BoxGeometry(W * 0.98, 0.17, 0.12), trimMat, 0, 0.38, l + 0.01);
    add(new THREE.BoxGeometry(W * 0.5, 0.13, 0.05), trimMat, 0, 0.55, -(l + 0.04));
  }
  add(plateGeo, plateMat, 0, 0.4, -(l + 0.1));
  add(plateGeo, plateMat, 0, 0.4, l + 0.1);
  // ヘッドライト（前方 = -Z）。マテリアルは全車共有で昼夜一括切替
  const lightY = v.typeName === 'Truck' ? 1.05 : 0.66;
  const hGeo = new THREE.BoxGeometry(0.34, 0.16, 0.1);
  add(hGeo, headMat, -(W / 2 - 0.34), lightY, -L / 2 - 0.06);
  add(hGeo, headMat, W / 2 - 0.34, lightY, -L / 2 - 0.06);
  // ヘッドライトの路面照射(夜のみ表示)。車体グループの子にすると加減速の
  // ピッチや操舵ロール(毎フレーム細かく揺れる)で光だまりの平面が路面下に
  // 潜り、深度テストで見え隠れしてチラつくため、シーン直下に置いて常に
  // 路面と平行を保つ(位置とヨーだけ syncMeshes で追従させる)
  const beamDist = L / 2 + 4.2;
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.rotation.order = 'YXZ'; // 平面を伏せた後にヨーを世界のY軸まわりで適用する
  beam.rotation.set(-Math.PI / 2, 0, 0);
  beam.visible = themeState.mix > 0.04;
  scene.add(beam);
  // ブレーキランプ（後方 = +Z）
  // 灯火類は照明の影響を受けない発光体として描く(昼でもはっきり光って見える)
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x4a0b0b });
  const bGeo = new THREE.BoxGeometry(0.52, 0.22, 0.1);
  add(bGeo, brakeMat, -(W / 2 - 0.34), lightY + 0.06, L / 2 + 0.04);
  add(bGeo, brakeMat, W / 2 - 0.34, lightY + 0.06, L / 2 + 0.04);
  // ウインカー（車線変更時に点滅）
  const blinkL = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  const blinkR = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  const kGeo = new THREE.BoxGeometry(0.22, 0.2, 0.22);
  add(kGeo, blinkL, -(W / 2 + 0.02), lightY, L / 2 - 0.12);
  add(kGeo, blinkL, -(W / 2 + 0.02), lightY, -(L / 2 - 0.12));
  add(kGeo, blinkR, W / 2 + 0.02, lightY, L / 2 - 0.12);
  add(kGeo, blinkR, W / 2 + 0.02, lightY, -(L / 2 - 0.12));
  // ブレーキ時に背面へにじむ赤いグロー(視認性アップ)
  const bglow = new THREE.Mesh(brakeGlowGeo, brakeGlowMat);
  bglow.position.set(0, lightY + 0.04, L / 2 + 0.18);
  bglow.visible = false;
  g.add(bglow);
  const margin = Math.max(0, (3.7 - W) / 2 - 0.42); // 車線内で安全に振れる余白
  const drv: DriverHabit = {
    bias: (Math.random() * 2 - 1) * margin * 0.9,
    swayA: (0.05 + Math.random() * 0.13) * Math.min(1, margin / 0.5 + 0.35),
    f1: 0.55 + Math.random() * 0.55,
    f2: 0.16 + Math.random() * 0.22,
    f3: 2.2 + Math.random() * 1.6,
    p1: Math.random() * 6.283,
    p2: Math.random() * 6.283,
    shaky: Math.random() < 0.22,
    t: Math.random() * 100,
  };
  return {
    group: g,
    brakeMat,
    blinkL,
    blinkR,
    beam,
    beamDist,
    bglow,
    prevX: v.x + drv.bias,
    prevSpeed: v.speed,
    pitch: 0,
    drv,
  };
}

/* ---- ワールドとメッシュの同期 ---- */
const meshMap = new Map<Vehicle, VehicleMesh>();

export function syncMeshes(world: World, dt: number): void {
  for (const v of world.vehicles) {
    let m = meshMap.get(v);
    if (!m) {
      m = buildVehicleMesh(v);
      meshMap.set(v, m);
      scene.add(m.group);
    }
    m.group.visible = !v.waiting;
    if (v.waiting) {
      m.beam.visible = false;
      continue;
    }
    // ---- ハンドル操作の個性: 定位置のズレ + 無意識の蛇行(速度が低いほど収まる) ----
    const d = m.drv;
    d.t += dt;
    const sway =
      Math.sin(d.t * d.f1 + d.p1) * 0.62 +
      Math.sin(d.t * d.f2 + d.p2) * 0.38 +
      (d.shaky ? Math.sin(d.t * d.f3 + d.p1 * 2) * 0.22 : 0);
    const amp = d.swayA * (0.25 + 0.75 * clamp(v.speed / 25, 0, 1));
    const x = v.x + d.bias + sway * amp;
    m.group.position.set(x, 0, v.z);
    const latv = dt > 0 ? (x - m.prevX) / dt : 0;
    m.prevX = x;
    // 操舵ヨー + 車体ロール + 加減速のピッチ(ノーズダイブ/スクワット)
    m.group.rotation.y = clamp(-latv / (v.speed + 6), -0.16, 0.16) * 1.5;
    m.group.rotation.z = m.group.rotation.y * 0.3;
    const acc = dt > 0 ? (v.speed - m.prevSpeed) / dt : 0;
    m.prevSpeed = v.speed;
    m.pitch += (clamp(acc * 0.0075, -0.05, 0.03) - m.pitch) * Math.min(1, dt * 6);
    m.group.rotation.x = m.pitch;
    // ヘッドライトの光だまり: 車体の揺れに追従させず、常に路面上へ平置きする
    m.beam.visible = themeState.mix > 0.04;
    const yaw = m.group.rotation.y;
    m.beam.position.set(x - Math.sin(yaw) * m.beamDist, 0.04, v.z - Math.cos(yaw) * m.beamDist);
    m.beam.rotation.y = yaw;
    m.brakeMat.color.setHex(v.braking ? 0xff2a2a : themeState.tailIdleHex);
    m.bglow.visible = v.braking;
    if (v.braking) brakeGlowMat.opacity = 0.45 + 0.45 * themeState.mix;
    const lc = v.lc;
    const on = lc.state !== 'none' && Math.floor(performance.now() / 350) % 2 === 0;
    const dirRight =
      lc.state !== 'none' && C.LANE_X[v.section][lc.to] > C.LANE_X[v.section][lc.from];
    // ハザード(両側同時点滅)は車線変更ウインカーより優先して見せる
    const hz = v.hazard && Math.floor(performance.now() / 380) % 2 === 0;
    m.blinkL.color.setHex(hz || (on && !dirRight) ? 0xffb31a : 0x6b4a10);
    m.blinkR.color.setHex(hz || (on && dirRight) ? 0xffb31a : 0x6b4a10);
  }
  if (meshMap.size !== world.vehicles.length) {
    const alive = new Set(world.vehicles);
    for (const [v, m] of meshMap) {
      if (!alive.has(v)) {
        scene.remove(m.group);
        scene.remove(m.beam); // 光だまりはシーン直下にあるため個別に外す
        meshMap.delete(v);
      }
    }
  }
}

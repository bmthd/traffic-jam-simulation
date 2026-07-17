/* ================= 車両メッシュ(生成とワールドとの同期) ================= */
import * as THREE from 'three';
import { CONST as C, clamp } from '../core';
import type { Vehicle, World } from '../core';
import { scene } from './scene';
import {
  lambert,
  glassMat,
  tireMat,
  cargoMat,
  headMat,
  brakeGlowMat,
  brakeGlowGeo,
  beamMat,
  beamGeo,
} from './materials';
import { themeState } from './theme';

export interface VehicleMesh {
  group: THREE.Group;
  brakeMat: THREE.MeshBasicMaterial;
  blinkL: THREE.MeshBasicMaterial;
  blinkR: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  bglow: THREE.Mesh;
  prevX: number;
}

function buildVehicleMesh(v: Vehicle): VehicleMesh {
  const t = v.type,
    L = t.len,
    W = t.w,
    H = t.h;
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
  const wx = W / 2 - 0.16,
    wz = L / 2 - 0.95;
  const wheelGeo = new THREE.BoxGeometry(0.32, 0.72, 0.8);
  add(wheelGeo, tireMat, -wx, 0.36, -wz);
  add(wheelGeo, tireMat, wx, 0.36, -wz);
  add(wheelGeo, tireMat, -wx, 0.36, wz);
  add(wheelGeo, tireMat, wx, 0.36, wz);

  const body = lambert(v.color);
  switch (v.typeName) {
    case 'Sedan': {
      add(new THREE.BoxGeometry(W, H * 0.46, L), body, 0, 0.32 + H * 0.23, 0, true);
      add(
        new THREE.BoxGeometry(W * 0.86, H * 0.42, L * 0.5),
        glassMat,
        0,
        0.32 + H * 0.66,
        L * 0.05,
        true,
      );
      if (v.isTaxi)
        add(
          new THREE.BoxGeometry(0.52, 0.24, 0.32),
          lambert(0xffa400),
          0,
          0.32 + H * 0.9 + 0.12,
          L * 0.05,
        );
      break;
    }
    case 'SportsCar': {
      add(new THREE.BoxGeometry(W, H * 0.55, L), body, 0, 0.28 + H * 0.275, 0, true);
      add(
        new THREE.BoxGeometry(W * 0.8, H * 0.46, L * 0.42),
        glassMat,
        0,
        0.28 + H * 0.77,
        L * 0.04,
        true,
      );
      add(new THREE.BoxGeometry(W * 0.95, 0.09, 0.5), body, 0, 0.28 + H * 0.86, L / 2 - 0.3, true);
      break;
    }
    case 'Truck': {
      const cabL = 2.3;
      add(new THREE.BoxGeometry(W, 2.4, cabL), body, 0, 0.4 + 1.2, -(L / 2 - cabL / 2), true);
      add(new THREE.BoxGeometry(W * 0.9, 0.9, 0.1), glassMat, 0, 1.95, -(L / 2 - 0.08));
      add(
        new THREE.BoxGeometry(W, H - 0.6, L - cabL - 0.35),
        cargoMat,
        0,
        0.55 + (H - 0.6) / 2,
        (cabL + 0.35) / 2,
        true,
      );
      break;
    }
    case 'Van': {
      add(new THREE.BoxGeometry(W, H * 0.8, L), body, 0, 0.32 + H * 0.4, 0, true);
      add(
        new THREE.BoxGeometry(W * 0.9, H * 0.34, 0.12),
        glassMat,
        0,
        0.32 + H * 0.62,
        -(L / 2 - 0.25),
      );
      break;
    }
  }
  // ヘッドライト（前方 = -Z）。マテリアルは全車共有で昼夜一括切替
  const hGeo = new THREE.BoxGeometry(0.34, 0.16, 0.1);
  add(hGeo, headMat, -(W / 2 - 0.34), 0.72, -L / 2 - 0.02);
  add(hGeo, headMat, W / 2 - 0.34, 0.72, -L / 2 - 0.02);
  // ヘッドライトの路面照射(夜のみ表示)
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.rotation.x = -Math.PI / 2;
  beam.position.set(0, 0.04, -(L / 2 + 4.2));
  beam.visible = themeState.mix > 0.04;
  g.add(beam);
  // ブレーキランプ（後方 = +Z）
  // 灯火類は照明の影響を受けない発光体として描く(昼でもはっきり光って見える)
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x4a0b0b });
  const bGeo = new THREE.BoxGeometry(0.52, 0.22, 0.1);
  add(bGeo, brakeMat, -(W / 2 - 0.34), 0.74, L / 2 + 0.02);
  add(bGeo, brakeMat, W / 2 - 0.34, 0.74, L / 2 + 0.02);
  // ウインカー（車線変更時に点滅）
  const blinkL = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  const blinkR = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  const kGeo = new THREE.BoxGeometry(0.22, 0.2, 0.22);
  add(kGeo, blinkL, -(W / 2 + 0.02), 0.74, L / 2 - 0.12);
  add(kGeo, blinkL, -(W / 2 + 0.02), 0.74, -(L / 2 - 0.12));
  add(kGeo, blinkR, W / 2 + 0.02, 0.74, L / 2 - 0.12);
  add(kGeo, blinkR, W / 2 + 0.02, 0.74, -(L / 2 - 0.12));
  // ブレーキ時に背面へにじむ赤いグロー(視認性アップ)
  const bglow = new THREE.Mesh(brakeGlowGeo, brakeGlowMat);
  bglow.position.set(0, 0.72, L / 2 + 0.18);
  bglow.visible = false;
  g.add(bglow);
  return { group: g, brakeMat, blinkL, blinkR, beam, bglow, prevX: v.x };
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
    if (v.waiting) continue;
    m.group.position.set(v.x, 0, v.z);
    const latv = dt > 0 ? (v.x - m.prevX) / dt : 0;
    m.prevX = v.x;
    m.group.rotation.y = clamp(-latv / (v.speed + 6), -0.16, 0.16) * 1.5;
    m.beam.visible = themeState.mix > 0.04;
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
        meshMap.delete(v);
      }
    }
  }
}

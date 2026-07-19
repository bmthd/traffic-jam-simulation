/* ================= 車両メッシュ(生成とワールドとの同期) =================
   パフォーマンス: 車両1台を約30個のメッシュで組むとdraw callが車両数×30に
   膨らみ、GPU/CPUの発熱源になる。そこで車種ごとに「マテリアル単位で結合した
   ジオメトリ(ブループリント)」を一度だけ作ってキャッシュし、1台あたりの
   メッシュ数を約1/3に抑える(見た目は結合前と同一)。 */
import * as THREE from 'three';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils';
import { CONST as C, TYPES, clamp } from '../core';
import type { Vehicle, VehicleTypeName, World } from '../core';
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
function wheelGeo(r: number, w: number): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(r, r, w, 14);
  geo.rotateZ(Math.PI / 2); // 車軸をX方向へ
  return geo;
}
const plateGeo = new THREE.BoxGeometry(0.34, 0.16, 0.04);
const mirrorGeo = new THREE.BoxGeometry(0.1, 0.11, 0.2);
const taxiGeo = new THREE.BoxGeometry(0.5, 0.22, 0.3);
const taxiMat = paint(0xffa400);

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
  | 'blinkL'
  | 'blinkR';

interface Blueprint {
  parts: Partial<Record<PartSlot, THREE.BufferGeometry>>;
  lightY: number;
}

const blueprintCache: Partial<Record<VehicleTypeName, Blueprint>> = {};

function buildBlueprint(typeName: VehicleTypeName): Blueprint {
  const t = TYPES[typeName],
    L = t.len,
    W = t.w,
    H = t.h,
    l = L / 2;
  const acc: Partial<Record<PartSlot, THREE.BufferGeometry[]>> = {};
  // ジオメトリをローカル変換(回転→平行移動)込みでスロットへ蓄積する。
  // 結合にはindexの有無を揃える必要があるため、indexed形状は展開する
  function put(
    slot: PartSlot,
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rx?: number,
  ): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    (acc[slot] ||= []).push(g);
  }
  function wheels(r: number, wzs: number[]): void {
    const wx = W / 2 - 0.14;
    const tGeo = wheelGeo(r, 0.3),
      hGeo = wheelGeo(r * 0.55, 0.34);
    for (const wz of wzs)
      for (const s of [-1, 1]) {
        put('tire', tGeo, s * wx, r, wz);
        put('hub', hGeo, s * wx, r, wz);
      }
  }
  function mirrors(slot: PartSlot, y: number, z: number): void {
    put(slot, mirrorGeo, -(W / 2 + 0.06), y, z);
    put(slot, mirrorGeo, W / 2 + 0.06, y, z);
  }

  switch (typeName) {
    case 'Sedan': {
      // 3ボックス(ボンネット・キャビン・トランク)の下半身
      put(
        'body',
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
        0,
        0,
        0,
      );
      // キャビン(スモークガラスのキャノピー)
      put(
        'glass',
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
        0,
        0,
        0,
      );
      put('body', new THREE.BoxGeometry(0.1, 0.08, 0.26), 0, H * 0.99, l * 0.4); // シャークフィン
      mirrors('body', H * 0.66, -l * 0.3);
      wheels(0.33, [-(l - 0.85), l - 0.85]);
      break;
    }
    case 'SportsCar': {
      // 低く長いウェッジシェイプ
      put(
        'body',
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
        0,
        0,
        0,
      );
      put(
        'glass',
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
        0,
        0,
        0,
      );
      // リアウイング
      put('body', new THREE.BoxGeometry(W * 0.92, 0.05, 0.36), 0, H * 0.92, l * 0.88);
      put('body', new THREE.BoxGeometry(0.07, 0.2, 0.16), -W * 0.32, H * 0.79, l * 0.9);
      put('body', new THREE.BoxGeometry(0.07, 0.2, 0.16), W * 0.32, H * 0.79, l * 0.9);
      mirrors('body', H * 0.68, -l * 0.28);
      wheels(0.33, [-(l - 0.8), l - 0.8]);
      break;
    }
    case 'Truck': {
      const cabL = 2.2;
      // キャブ
      put('body', new THREE.BoxGeometry(W, 1.85, cabL), 0, 1.775, -(l - cabL / 2));
      // フロントガラスをわずかに寝かせる
      put('glass', new THREE.BoxGeometry(W * 0.9, 0.85, 0.07), 0, 2.3, -(l + 0.01), 0.1);
      put('glass', new THREE.BoxGeometry(W + 0.02, 0.6, 1.0), 0, 2.25, -(l - cabL / 2) + 0.1);
      put('trim', new THREE.BoxGeometry(W * 0.9, 0.55, 0.08), 0, 1.35, -(l + 0.02)); // グリル
      put('hub', new THREE.BoxGeometry(W, 0.3, 0.14), 0, 0.45, -(l + 0.03)); // 金属バンパー
      // 導風板(キャブ屋根から荷箱の高さへつなぐ)
      put('body', new THREE.BoxGeometry(W * 0.9, 1.45, 0.06), 0, 3.07, -(l - 1.55), 1.05);
      // 荷箱
      put(
        'cargo',
        new THREE.BoxGeometry(W, H - 0.65, L - cabL - 0.35),
        0,
        0.62 + (H - 0.65) / 2,
        (cabL + 0.35) / 2,
      );
      put('trim', new THREE.BoxGeometry(W * 0.94, 0.5, L * 0.3), 0, 0.5, 0.1); // サイドスカート
      put('trim', new THREE.BoxGeometry(W * 0.9, 0.45, 0.05), 0, 0.32, l - 0.15); // 泥除け
      put('hub', new THREE.BoxGeometry(W * 0.9, 0.12, 0.1), 0, 0.55, l + 0.02); // 突入防止装置
      mirrors('trim', 2.35, -(l - 0.25));
      wheels(0.48, [-(l - 1.15), l - 1.35, l - 2.45]);
      break;
    }
    case 'Van': {
      // ワンボックス
      put(
        'body',
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
        0,
        0,
        0,
      );
      // 傾斜したフロントガラス
      put('glass', new THREE.BoxGeometry(W * 0.86, 1.15, 0.06), 0, H * 0.785, -l * 0.43, 0.86);
      // サイドウィンドウ帯・リアガラス
      put('glass', new THREE.BoxGeometry(W + 0.02, H * 0.2, L * 0.55), 0, H * 0.76, l * 0.18);
      put('glass', new THREE.BoxGeometry(W * 0.8, H * 0.22, 0.05), 0, H * 0.72, l + 0.01);
      mirrors('body', H * 0.62, -l * 0.42);
      wheels(0.35, [-(l - 1.0), l - 1.1]);
      break;
    }
  }
  // 樹脂バンパー・グリル・ナンバープレート(トラック以外の共通装備)
  if (typeName !== 'Truck') {
    put('trim', new THREE.BoxGeometry(W * 0.98, 0.17, 0.12), 0, 0.38, -(l + 0.01));
    put('trim', new THREE.BoxGeometry(W * 0.98, 0.17, 0.12), 0, 0.38, l + 0.01);
    put('trim', new THREE.BoxGeometry(W * 0.5, 0.13, 0.05), 0, 0.55, -(l + 0.04));
  }
  put('plate', plateGeo, 0, 0.4, -(l + 0.1));
  put('plate', plateGeo, 0, 0.4, l + 0.1);
  // ヘッドライト（前方 = -Z）。マテリアルは全車共有で昼夜一括切替
  const lightY = typeName === 'Truck' ? 1.05 : 0.66;
  const hGeo = new THREE.BoxGeometry(0.34, 0.16, 0.1);
  put('head', hGeo, -(W / 2 - 0.34), lightY, -L / 2 - 0.06);
  put('head', hGeo, W / 2 - 0.34, lightY, -L / 2 - 0.06);
  // ブレーキランプ（後方 = +Z）
  const bGeo = new THREE.BoxGeometry(0.52, 0.22, 0.1);
  put('brake', bGeo, -(W / 2 - 0.34), lightY + 0.06, L / 2 + 0.04);
  put('brake', bGeo, W / 2 - 0.34, lightY + 0.06, L / 2 + 0.04);
  // ウインカー（車線変更時に点滅）
  const kGeo = new THREE.BoxGeometry(0.22, 0.2, 0.22);
  put('blinkL', kGeo, -(W / 2 + 0.02), lightY, L / 2 - 0.12);
  put('blinkL', kGeo, -(W / 2 + 0.02), lightY, -(L / 2 - 0.12));
  put('blinkR', kGeo, W / 2 + 0.02, lightY, L / 2 - 0.12);
  put('blinkR', kGeo, W / 2 + 0.02, lightY, -(L / 2 - 0.12));

  const parts: Blueprint['parts'] = {};
  for (const slot of Object.keys(acc) as PartSlot[]) {
    parts[slot] = BufferGeometryUtils.mergeBufferGeometries(acc[slot]!);
  }
  return { parts, lightY };
}

function blueprint(typeName: VehicleTypeName): Blueprint {
  return (blueprintCache[typeName] ||= buildBlueprint(typeName));
}

function buildVehicleMesh(v: Vehicle): VehicleMesh {
  const bp = blueprint(v.typeName);
  const L = v.type.len;
  const g = new THREE.Group();
  // 各パーツはブループリント側で位置決め済み(ローカル変換は恒等)なので、
  // 毎フレームの行列再計算を止めて描画コストを下げる
  function addPart(slot: PartSlot, mat: THREE.Material, cast?: boolean): void {
    const geo = bp.parts[slot];
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    if (cast) m.castShadow = true;
    m.matrixAutoUpdate = false;
    g.add(m);
  }
  addPart('body', paint(v.color), true);
  addPart('glass', glassMat, true);
  addPart('trim', trimMat);
  addPart('tire', tireMat, true);
  addPart('hub', hubMat);
  addPart('cargo', cargoMat, true);
  addPart('plate', plateMat);
  addPart('head', headMat);
  if (v.isTaxi) {
    const sign = new THREE.Mesh(taxiGeo, taxiMat);
    sign.position.set(0, v.type.h * 0.97 + 0.14, (L / 2) * 0.15);
    sign.matrixAutoUpdate = false;
    sign.updateMatrix();
    g.add(sign);
  }
  // 灯火類は照明の影響を受けない発光体として描く(昼でもはっきり光って見える)。
  // 色を車両ごとに切り替えるため、マテリアルだけ個別に持つ
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x4a0b0b });
  const blinkL = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  const blinkR = new THREE.MeshBasicMaterial({ color: 0x6b4a10 });
  addPart('brake', brakeMat);
  addPart('blinkL', blinkL);
  addPart('blinkR', blinkR);
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
  // ブレーキ時に背面へにじむ赤いグロー(視認性アップ)
  const bglow = new THREE.Mesh(brakeGlowGeo, brakeGlowMat);
  bglow.position.set(0, bp.lightY + 0.04, L / 2 + 0.18);
  bglow.matrixAutoUpdate = false;
  bglow.updateMatrix();
  bglow.visible = false;
  g.add(bglow);
  const W = v.type.w;
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
        // ジオメトリはブループリント共有なので破棄しない(マテリアルのみ個別)
        m.brakeMat.dispose();
        m.blinkL.dispose();
        m.blinkR.dispose();
        meshMap.delete(v);
      }
    }
  }
}

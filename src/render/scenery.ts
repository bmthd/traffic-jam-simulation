/* ================= 背景美術(路側・遠景) =================
   道路施設(track.js)とは別の「風景」を担当する。
   道路の外は scene.js の地面(田んぼテクスチャ)が広がる。
   山・雲のマテリアルは materials.js にあり、昼夜の色は theme.js が補間する */
import * as THREE from 'three';
import { CONST as C } from '../core';
import { scene } from './scene';
import { mtnFarMat, mtnNearMat, cloudMat } from './materials';

const ROAD_HALF = C.ROAD_HALF;

/* ---- 路側の防護柵(ガードレール) ---- */
(function buildRoadside() {
  const railMat = new THREE.MeshPhongMaterial({ color: 0xdfe4e8, shininess: 60 });
  const postMat = new THREE.MeshLambertMaterial({ color: 0xb8bfc6 });
  const postGeo = new THREE.BoxGeometry(0.12, 0.8, 0.12);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, ROAD_HALF * 2), railMat);
    rail.position.set(18.2 * sx, 0.62, 0);
    scene.add(rail);
    for (let z = -ROAD_HALF + 4; z < ROAD_HALF; z += 12) {
      const p = new THREE.Mesh(postGeo, postMat);
      p.position.set(18.2 * sx, 0.4, z);
      p.matrixAutoUpdate = false;
      p.updateMatrix();
      scene.add(p);
    }
  }
  // 遮音壁: 下段コンクリート + 上段の半透明パネル(高速道路らしさ)
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xb4b9bd });
  const panelMat = new THREE.MeshLambertMaterial({
    color: 0x9fd3c8,
    transparent: true,
    opacity: 0.38,
  });
  const wpostMat = new THREE.MeshLambertMaterial({ color: 0x7c858d });
  const wpostGeo = new THREE.BoxGeometry(0.22, 3.2, 0.22);
  for (const sx of [-1, 1]) {
    const z0 = -380,
      z1 = -130,
      len = z1 - z0,
      zc = (z0 + z1) / 2;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, len), wallMat);
    base.position.set(19.2 * sx, 0.75, zc);
    base.castShadow = true;
    scene.add(base);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.7, len), panelMat);
    panel.position.set(19.2 * sx, 2.35, zc);
    scene.add(panel);
    for (let z = z0; z <= z1; z += 10) {
      const p = new THREE.Mesh(wpostGeo, wpostMat);
      p.position.set(19.2 * sx, 1.6, z);
      p.matrixAutoUpdate = false;
      p.updateMatrix();
      scene.add(p);
    }
  }
})();

/* ---- 遠景: 山並み(霧の外に置く書割り) ---- */
(function buildMountains() {
  const far = new THREE.Mesh(new THREE.CylinderGeometry(860, 860, 180, 72, 1, true), mtnFarMat);
  far.position.y = 66;
  far.renderOrder = -16;
  scene.add(far);
  const near = new THREE.Mesh(new THREE.CylinderGeometry(760, 760, 130, 72, 1, true), mtnNearMat);
  near.position.y = 40;
  near.rotation.y = 2.1;
  near.renderOrder = -15;
  scene.add(near);
})();

/* ---- 雲 ---- */
(function buildClouds() {
  for (let i = 0; i < 9; i++) {
    const th = Math.random() * Math.PI * 2,
      R = 380 + Math.random() * 320;
    const cx = Math.cos(th) * R,
      cz = Math.sin(th) * R,
      cy = 150 + Math.random() * 110;
    for (let k = 0; k < 3; k++) {
      // ひと塊を3枚のスプライトでもこもこに
      const s = new THREE.Sprite(cloudMat);
      const w = 90 + Math.random() * 120;
      s.scale.set(w, w * (0.28 + Math.random() * 0.14), 1);
      s.position.set(
        cx + (Math.random() - 0.5) * 70,
        cy + (Math.random() - 0.5) * 18,
        cz + (Math.random() - 0.5) * 70,
      );
      s.renderOrder = -14;
      scene.add(s);
    }
  }
})();

/* ================= 背景美術(路側・並木・遠景) =================
   道路施設(track.js)とは別の「風景」を担当する。
   山・雲のマテリアルは materials.js にあり、昼夜の色は theme.js が補間する */
import * as THREE from 'three';
import { CONST } from '../core';
import { scene } from './scene';
import { mountainFarMaterial, mountainNearMaterial, cloudMaterial } from './materials';
import { instancedAt } from './instancing';

const ROAD_HALF = CONST.ROAD_HALF;

/* ---- 路側の防護柵(ガードレール) ---- */
(function buildRoadside() {
  const railMaterial = new THREE.MeshPhongMaterial({ color: 0xdfe4e8, shininess: 60 });
  const postMaterial = new THREE.MeshLambertMaterial({ color: 0xb8bfc6 });
  const postGeometry = new THREE.BoxGeometry(0.12, 0.8, 0.12);
  const postPositions: [number, number, number][] = [];
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, ROAD_HALF * 2), railMaterial);
    rail.position.set(18.2 * side, 0.62, 0);
    scene.add(rail);
    for (let z = -ROAD_HALF + 4; z < ROAD_HALF; z += 12) postPositions.push([18.2 * side, 0.4, z]);
  }
  scene.add(instancedAt(postGeometry, postMaterial, postPositions));
  // 遮音壁: 下段コンクリート + 上段の半透明パネル(高速道路らしさ)
  const wallMaterial = new THREE.MeshLambertMaterial({ color: 0xb4b9bd });
  const panelMaterial = new THREE.MeshLambertMaterial({
    color: 0x9fd3c8,
    transparent: true,
    opacity: 0.38,
  });
  const wallPostMaterial = new THREE.MeshLambertMaterial({ color: 0x7c858d });
  const wallPostGeometry = new THREE.BoxGeometry(0.22, 3.2, 0.22);
  const wallPostPositions: [number, number, number][] = [];
  for (const side of [-1, 1]) {
    const zStart = -380,
      zEnd = -130,
      length = zEnd - zStart,
      zCenter = (zStart + zEnd) / 2;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, length), wallMaterial);
    base.position.set(19.2 * side, 0.75, zCenter);
    base.castShadow = true;
    scene.add(base);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.7, length), panelMaterial);
    panel.position.set(19.2 * side, 2.35, zCenter);
    scene.add(panel);
    for (let z = zStart; z <= zEnd; z += 10) wallPostPositions.push([19.2 * side, 1.6, z]);
  }
  scene.add(instancedAt(wallPostGeometry, wallPostMaterial, wallPostPositions));
})();

/* ---- 並木・雑木林(InstancedMeshで軽量に大量配置) ---- */
(function buildTrees() {
  const treeCount = 130;
  const trunkGeometry = new THREE.CylinderGeometry(0.1, 0.18, 1, 5);
  trunkGeometry.translate(0, 0.5, 0);
  const canopyGeometry = new THREE.IcosahedronGeometry(1, 0);
  const trunks = new THREE.InstancedMesh(
    trunkGeometry,
    new THREE.MeshLambertMaterial({ color: 0x6b4e35 }),
    treeCount,
  );
  const canopies = new THREE.InstancedMesh(
    canopyGeometry,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    treeCount,
  );
  canopies.castShadow = true;
  const matrix = new THREE.Matrix4(),
    color = new THREE.Color();
  for (let i = 0; i < treeCount; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (22 + Math.pow(Math.random(), 1.6) * 70);
    const z = -ROAD_HALF + Math.random() * ROAD_HALF * 2;
    const height = 2.4 + Math.random() * 3.6; // 幹の高さ
    const radius = height * (0.42 + Math.random() * 0.22); // 樹冠の半径
    matrix.makeScale(1 + radius * 0.3, height, 1 + radius * 0.3).setPosition(x, 0, z);
    trunks.setMatrixAt(i, matrix);
    matrix
      .makeScale(radius, radius * (0.9 + Math.random() * 0.5), radius)
      .setPosition(x, height + radius * 0.5, z);
    canopies.setMatrixAt(i, matrix);
    color.setHSL(
      0.26 + Math.random() * 0.09,
      0.35 + Math.random() * 0.25,
      0.26 + Math.random() * 0.14,
    );
    canopies.setColorAt(i, color);
  }
  scene.add(trunks, canopies);
})();

/* ---- 遠景: 山並み(霧の外に置く書割り) ---- */
(function buildMountains() {
  const far = new THREE.Mesh(
    new THREE.CylinderGeometry(860, 860, 180, 72, 1, true),
    mountainFarMaterial,
  );
  far.position.y = 66;
  far.renderOrder = -16;
  scene.add(far);
  const near = new THREE.Mesh(
    new THREE.CylinderGeometry(760, 760, 130, 72, 1, true),
    mountainNearMaterial,
  );
  near.position.y = 40;
  near.rotation.y = 2.1;
  near.renderOrder = -15;
  scene.add(near);
})();

/* ---- 雲 ---- */
(function buildClouds() {
  for (let i = 0; i < 9; i++) {
    const theta = Math.random() * Math.PI * 2,
      radius = 380 + Math.random() * 320;
    const centerX = Math.cos(theta) * radius,
      centerZ = Math.sin(theta) * radius,
      centerY = 150 + Math.random() * 110;
    for (let k = 0; k < 3; k++) {
      // ひと塊を3枚のスプライトでもこもこに
      const sprite = new THREE.Sprite(cloudMaterial);
      const width = 90 + Math.random() * 120;
      sprite.scale.set(width, width * (0.28 + Math.random() * 0.14), 1);
      sprite.position.set(
        centerX + (Math.random() - 0.5) * 70,
        centerY + (Math.random() - 0.5) * 18,
        centerZ + (Math.random() - 0.5) * 70,
      );
      sprite.renderOrder = -14;
      scene.add(sprite);
    }
  }
})();

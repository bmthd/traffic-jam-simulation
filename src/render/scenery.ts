/* ================= 背景美術(路側・並木・遠景) =================
   道路施設(track.js)とは別の「風景」を担当する。
   山・雲のマテリアルは materials.js にあり、昼夜の色は theme.js が補間する */
import * as THREE from 'three';
import { CONST, FACILITIES, WRAP_LENGTH } from '../core';
import { backgroundAnchor, scene } from './scene';
import { mountainFarMaterial, mountainNearMaterial, cloudMaterial } from './materials';
import { instancedAt } from './instancing';
import { loopCopies } from './looping';

/* ---- 路側の防護柵(ガードレール) ---- */
(function buildRoadside() {
  const railMaterial = new THREE.MeshPhongMaterial({ color: 0xdfe4e8, shininess: 60 });
  const postMaterial = new THREE.MeshLambertMaterial({ color: 0xb8bfc6 });
  const postGeometry = new THREE.BoxGeometry(0.12, 0.8, 0.12);
  const postPositions: [number, number, number][] = [];
  for (const side of [-1, 1]) {
    for (const offset of loopCopies(0)) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, WRAP_LENGTH), railMaterial);
      rail.position.set(18.2 * side, 0.62, offset);
      rail.castShadow = true;
      scene.add(rail);
      for (let z = -WRAP_LENGTH / 2 + 4; z < WRAP_LENGTH / 2; z += 12)
        postPositions.push([18.2 * side, 0.4, z + offset]);
    }
  }
  const posts = instancedAt(postGeometry, postMaterial, postPositions);
  posts.castShadow = true;
  scene.add(posts);
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
    for (const offset of loopCopies(0)) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, length), wallMaterial);
      base.position.set(19.2 * side, 0.75, zCenter + offset);
      base.castShadow = true;
      scene.add(base);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.7, length), panelMaterial);
      panel.position.set(19.2 * side, 2.35, zCenter + offset);
      // three r128 では半透明の影は不透明になるが、下段の影が途中で切れる違和感を避ける
      panel.castShadow = true;
      scene.add(panel);
      for (let z = zStart; z <= zEnd; z += 10)
        wallPostPositions.push([19.2 * side, 1.6, z + offset]);
    }
  }
  const wallPosts = instancedAt(wallPostGeometry, wallPostMaterial, wallPostPositions);
  wallPosts.castShadow = true;
  scene.add(wallPosts);
})();

/* ---- 並木・雑木林(InstancedMeshで軽量に大量配置) ---- */
(function buildTrees() {
  // 総延長4倍と前後周回の複製で負荷が増えるため、延長前と同じ総数に制限する。
  const treeCount = 130;
  const trunkGeometry = new THREE.CylinderGeometry(0.1, 0.18, 1, 5);
  trunkGeometry.translate(0, 0.5, 0);
  const canopyGeometry = new THREE.IcosahedronGeometry(1, 0);
  const trunks = new THREE.InstancedMesh(
    trunkGeometry,
    new THREE.MeshLambertMaterial({ color: 0x6b4e35 }),
    treeCount * 3,
  );
  const canopies = new THREE.InstancedMesh(
    canopyGeometry,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    treeCount * 3,
  );
  trunks.castShadow = true;
  canopies.castShadow = true;
  // 道路全長に散らすためヘルパー(instancing.ts)と同じ理由で視錐台カリングを切る (Issue #89)
  trunks.frustumCulled = false;
  canopies.frustumCulled = false;
  const matrix = new THREE.Matrix4(),
    color = new THREE.Color();
  for (let i = 0; i < treeCount; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (22 + Math.pow(Math.random(), 1.6) * 70);
    const z = -WRAP_LENGTH / 2 + Math.random() * WRAP_LENGTH;
    const height = 2.4 + Math.random() * 3.6; // 幹の高さ
    const radius = height * (0.42 + Math.random() * 0.22); // 樹冠の半径
    const canopyHeight = radius * (0.9 + Math.random() * 0.5);
    color.setHSL(
      0.26 + Math.random() * 0.09,
      0.35 + Math.random() * 0.25,
      0.26 + Math.random() * 0.14,
    );
    loopCopies(z).forEach((copyZ, copyIndex) => {
      const index = i * 3 + copyIndex;
      matrix.makeScale(1 + radius * 0.3, height, 1 + radius * 0.3).setPosition(x, 0, copyZ);
      trunks.setMatrixAt(index, matrix);
      matrix.makeScale(radius, canopyHeight, radius).setPosition(x, height + radius * 0.5, copyZ);
      canopies.setMatrixAt(index, matrix);
      canopies.setColorAt(index, color);
    });
  }
  scene.add(trunks, canopies);
})();

/* ---- PAの付帯景観(車両は進入しない描画専用の外景) ---- */
(function buildParkingAreas() {
  const paFacilities = FACILITIES.filter((facility) => facility.kind === 'PA');
  const paLocalZ = (CONST.RAMP_Z_TOP + CONST.RAMP_Z_END) / 2;
  const parkingGeometry = new THREE.BoxGeometry(24, 0.1, 28);
  const parkingMaterial = new THREE.MeshLambertMaterial({ color: 0x596064 });
  const buildingGeometry = new THREE.BoxGeometry(20, 5.5, 12);
  const buildingMaterial = new THREE.MeshLambertMaterial({ color: 0xe8e1d2 });
  const roofGeometry = new THREE.BoxGeometry(21, 0.8, 13);
  const roofMaterial = new THREE.MeshLambertMaterial({ color: 0x4d6f78 });
  const parkingLineGeometry = new THREE.BoxGeometry(0.12, 0.02, 5.4);
  const parkingLineMaterial = new THREE.MeshBasicMaterial({ color: 0xf4f4f0 });
  const lightPoleGeometry = new THREE.CylinderGeometry(0.08, 0.1, 5.5, 6);
  const lightPoleMaterial = new THREE.MeshLambertMaterial({ color: 0x89939c });
  const lightHeadGeometry = new THREE.BoxGeometry(1.2, 0.18, 0.5);
  const lightHeadMaterial = new THREE.MeshBasicMaterial({ color: 0xffefb0 });
  const parkingLines: [number, number, number][] = [];
  const lightPoles: [number, number, number][] = [];
  const lightHeads: [number, number, number][] = [];

  for (const facility of paFacilities) {
    for (const facilityZ of loopCopies(paLocalZ + facility.offsetZ)) {
      // 両道路のさらに外側へ同じPA景観を置き、走行空間には重ねない。
      for (const side of [-1, 1]) {
        const centerX = side * 52;
        const parking = new THREE.Mesh(parkingGeometry, parkingMaterial);
        parking.position.set(centerX, -0.08, facilityZ - 2);
        parking.receiveShadow = true;
        scene.add(parking);
        const building = new THREE.Mesh(buildingGeometry, buildingMaterial);
        building.position.set(centerX, 2.75, facilityZ + 18);
        building.castShadow = true;
        building.receiveShadow = true;
        scene.add(building);
        const roof = new THREE.Mesh(roofGeometry, roofMaterial);
        roof.position.set(centerX, 5.8, facilityZ + 18);
        roof.castShadow = true;
        scene.add(roof);
        for (let space = -4; space <= 4; space++)
          parkingLines.push([centerX + space * 2.2, 0.015, facilityZ - 3]);
        for (const zOffset of [-10, 6]) {
          lightPoles.push([centerX, 2.75, facilityZ + zOffset]);
          lightHeads.push([centerX, 5.55, facilityZ + zOffset]);
        }
      }
    }
  }
  scene.add(instancedAt(parkingLineGeometry, parkingLineMaterial, parkingLines));
  const lights = instancedAt(lightPoleGeometry, lightPoleMaterial, lightPoles);
  lights.castShadow = true;
  scene.add(lights);
  scene.add(instancedAt(lightHeadGeometry, lightHeadMaterial, lightHeads));
})();

/* ---- 遠景: 山並み(霧の外に置く書割り) ---- */
// 影マップ範囲外の書割りで、影がシーン全体を覆うため castShadow は設定しない
(function buildMountains() {
  const far = new THREE.Mesh(
    new THREE.CylinderGeometry(860, 860, 180, 72, 1, true),
    mountainFarMaterial,
  );
  far.position.y = 66;
  far.renderOrder = -16;
  backgroundAnchor.add(far);
  const near = new THREE.Mesh(
    new THREE.CylinderGeometry(760, 760, 130, 72, 1, true),
    mountainNearMaterial,
  );
  near.position.y = 40;
  near.rotation.y = 2.1;
  near.renderOrder = -15;
  backgroundAnchor.add(near);
})();

/* ---- 雲 ---- */
// 霧の外に置く書割りで影マップ範囲外のため castShadow は設定しない
(function buildClouds() {
  for (let i = 0; i < 9; i++) {
    const theta = Math.random() * Math.PI * 2,
      radius = 380 + Math.random() * 320;
    const centerX = Math.cos(theta) * radius,
      centerZ = Math.sin(theta) * radius,
      centerY = 150 + Math.random() * 110;
    let width = 0,
      aspect = 0;
    for (let k = 0; k < 3; k++) {
      // 後続の星・車両外観の乱数列を変えないよう、旧3枚構成と同じ順序・回数で消費する。
      const widthRandom = Math.random(),
        aspectRandom = Math.random();
      Math.random(); // 房ごとのXずれ
      Math.random(); // 房ごとのYずれ
      Math.random(); // 房ごとのZずれ
      if (k === 0) {
        width = 130 + widthRandom * 130;
        aspect = 0.32 + aspectRandom * 0.08;
      }
    }
    const sprite = new THREE.Sprite(cloudMaterial);
    sprite.scale.set(width, width * aspect, 1);
    sprite.position.set(centerX, centerY, centerZ);
    sprite.renderOrder = -14;
    backgroundAnchor.add(sprite);
  }
})();

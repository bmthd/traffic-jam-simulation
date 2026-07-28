/* ================= InstancedMesh ヘルパー =================
   ガードレール支柱・破線・街灯など「同一ジオメトリ+同一マテリアル」の
   静的な繰り返し配置を1回のdraw callにまとめる(発熱・負荷対策)。
   見た目は個別メッシュで並べた場合と同一 */
import * as THREE from 'three';

const _matrix = new THREE.Matrix4();

/** ここで作るInstancedMeshは視錐台カリングを必ず切る (Issue #89)。
    three の視錐台カリングは `geometry.boundingSphere` を `matrixWorld` で変換した球だけで
    判定し、各インスタンスの行列を見ない。これらのヘルパーが返すメッシュは matrix が
    単位行列のままなので、判定球は「原点にあるジオメトリ1個ぶん」の小さな球にしかならない。
    実体は loopCopies() により z 方向へ周回3本ぶん広がっているため、カリングが効くと
    原点付近が画面外に出ただけで破線や支柱が丸ごと消える。判定そのものが誤りなので切る。
    r128 の InstancedMesh はコンストラクタで frustumCulled=false にしており既定でも切れて
    いるが、three の更新でこの既定が変わると上記の誤判定が復活するため明示しておく。
    draw call は元々1個にまとめてあり、切っても増えるコストは小さい。 */
function withoutFrustumCulling(mesh: THREE.InstancedMesh): THREE.InstancedMesh {
  mesh.frustumCulled = false;
  return mesh;
}

/** 平行移動のみの静的な繰り返し配置を1つのInstancedMeshにまとめる */
export function instancedAt(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  positions: [number, number, number][],
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  positions.forEach(([x, y, z], i) => {
    _matrix.makeTranslation(x, y, z);
    mesh.setMatrixAt(i, _matrix);
  });
  mesh.matrixAutoUpdate = false;
  return withoutFrustumCulling(mesh);
}

/** 任意の変換行列で配置する版(回転・スケールが必要な場合) */
export function instancedWith(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.matrixAutoUpdate = false;
  return withoutFrustumCulling(mesh);
}

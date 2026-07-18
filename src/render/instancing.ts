/* ================= InstancedMesh ヘルパー =================
   ガードレール支柱・破線・街灯など「同一ジオメトリ+同一マテリアル」の
   静的な繰り返し配置を1回のdraw callにまとめる(発熱・負荷対策)。
   見た目は個別メッシュで並べた場合と同一 */
import * as THREE from 'three';

const _m = new THREE.Matrix4();

/** 平行移動のみの静的な繰り返し配置を1つのInstancedMeshにまとめる */
export function instancedAt(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  positions: [number, number, number][],
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, positions.length);
  positions.forEach(([x, y, z], i) => {
    _m.makeTranslation(x, y, z);
    mesh.setMatrixAt(i, _m);
  });
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** 任意の変換行列で配置する版(回転・スケールが必要な場合) */
export function instancedWith(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  matrices: THREE.Matrix4[],
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

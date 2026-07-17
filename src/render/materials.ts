/* ================= 共有マテリアル・テクスチャ =================
   昼夜テーマ (theme.js) が色を書き換えるマテリアルと、
   複数モジュール(車両メッシュ・夜景アセット)が共有するマテリアルを
   1箇所に集約する。モジュール間の循環importを避けるための土台 */
import * as THREE from 'three';

// 放射状グラデーションのテクスチャ(光だまり・ヘッドライト用)
export function makeGlowTexture(inner: string, outer: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c2 = cv.getContext('2d')!;
  const grad = c2.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  c2.fillStyle = grad;
  c2.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

/* ---- 車両ボディ(色ごとに共有) ---- */
// 車体塗装: 光沢のあるPhongで金属塗装の照り返しを出す
const matCache: Record<number, THREE.MeshPhongMaterial> = {};
export function paint(hex: number): THREE.MeshPhongMaterial {
  if (!matCache[hex])
    matCache[hex] = new THREE.MeshPhongMaterial({ color: hex, shininess: 80, specular: 0x8a8a8a });
  return matCache[hex];
}
export const glassMat = new THREE.MeshPhongMaterial({
  color: 0x18242e,
  shininess: 130,
  specular: 0xa8c8e0,
});
export const tireMat = new THREE.MeshLambertMaterial({ color: 0x141419 });
export const hubMat = new THREE.MeshPhongMaterial({
  color: 0x9ba3ae,
  shininess: 100,
  specular: 0xe0e0e0,
});
export const cargoMat = new THREE.MeshLambertMaterial({ color: 0xe8eaee });
export const trimMat = new THREE.MeshLambertMaterial({ color: 0x23272c }); // バンパー等の樹脂部品
export const plateMat = new THREE.MeshLambertMaterial({ color: 0xf2f4ea }); // ナンバープレート
export const headMat = new THREE.MeshPhongMaterial({
  color: 0xfff6d8,
  emissive: 0x6b6346,
  shininess: 120,
});

/* ---- 道路施設(昼夜で色が変わるもの) ---- */
export const delinMat = new THREE.MeshBasicMaterial({ color: 0x9aa3ad }); // 視線誘導標
export const lampHeadMat = new THREE.MeshLambertMaterial({ color: 0xd8d2b8, emissive: 0x000000 }); // 街灯灯具

/* ---- 背景テクスチャ(田んぼ・アスファルト) ---- */
export function makeRicePaddyTexture(): THREE.CanvasTexture {
  // 2x2区画をひとつのタイルに描き、繰り返しても均一に見えないようにする
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c2 = cv.getContext('2d')!;
  const CELL = 256;
  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const x0 = px * CELL,
        y0 = py * CELL;
      // 下地: 水と土がのぞく田面。区画ごとに明度を変え、田ごとの生育差を出す
      const base = 92 + Math.random() * 30;
      c2.fillStyle =
        'rgb(' +
        Math.round(base * 0.68) +
        ',' +
        Math.round(base) +
        ',' +
        Math.round(base * 0.6) +
        ')';
      c2.fillRect(x0, y0, CELL, CELL);
      // 稲の条(すじ): 等間隔の植え付け列を粒で描く
      for (let ry = 8; ry < CELL - 6; ry += 9) {
        for (let rx = 5; rx < CELL - 5; rx += 6) {
          const g = 115 + Math.random() * 70;
          c2.fillStyle =
            'rgba(' +
            Math.round(g * 0.52) +
            ',' +
            Math.round(g) +
            ',' +
            Math.round(g * 0.4) +
            ',' +
            (0.55 + Math.random() * 0.35).toFixed(2) +
            ')';
          c2.fillRect(
            x0 + rx + (Math.random() - 0.5) * 2,
            y0 + ry + (Math.random() - 0.5) * 2,
            3,
            3,
          );
        }
      }
      // 畦(あぜ): 区画の縁を土色の帯で囲う(目立ちすぎないよう彩度低めに)
      c2.fillStyle = 'rgba(140,130,95,0.8)';
      c2.fillRect(x0, y0, CELL, 4);
      c2.fillRect(x0, y0, 4, CELL);
      c2.fillRect(x0, y0 + CELL - 4, CELL, 4);
      c2.fillRect(x0 + CELL - 4, y0, 4, CELL);
      // 畦の上の雑草
      for (let i = 0; i < 90; i++) {
        const onH = Math.random() < 0.5;
        const t = Math.random() * CELL;
        const edge = Math.random() < 0.5 ? 0 : CELL - 5;
        c2.fillStyle = 'rgba(96,120,60,' + (0.2 + Math.random() * 0.3).toFixed(2) + ')';
        if (onH) c2.fillRect(x0 + t, y0 + edge + Math.random() * 4, 2, 2);
        else c2.fillRect(x0 + edge + Math.random() * 4, y0 + t, 2, 2);
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(28, 28); // 1区画 ≒ 28.6m四方
  return tex;
}
export function makeAsphaltTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 512;
  const c2 = cv.getContext('2d')!;
  c2.fillStyle = '#b9babd'; // Lambertのcolorと乗算されるため明るめに描く
  c2.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 5200; i++) {
    // 骨材の粒
    const gr = Math.round(130 + Math.random() * 120);
    c2.fillStyle =
      'rgba(' +
      gr +
      ',' +
      gr +
      ',' +
      (gr + 6) +
      ',' +
      (0.05 + Math.random() * 0.12).toFixed(2) +
      ')';
    c2.fillRect(
      Math.random() * 256,
      Math.random() * 512,
      1 + Math.random() * 2,
      1 + Math.random() * 2,
    );
  }
  // 轍(わだち): タイヤが通る位置はゴムと油で黒ずむ。3車線ぶん左右2本ずつ
  for (const u of [0.197, 0.5, 0.803]) {
    // 路面幅13.2mに対する各車線中心
    for (const d of [-1, 1]) {
      const x = (u + d * 0.062) * 256;
      const grad = c2.createLinearGradient(x - 15, 0, x + 15, 0);
      grad.addColorStop(0, 'rgba(40,40,44,0)');
      grad.addColorStop(0.5, 'rgba(40,40,44,0.22)');
      grad.addColorStop(1, 'rgba(40,40,44,0)');
      c2.fillStyle = grad;
      c2.fillRect(x - 15, 0, 30, 512);
    }
  }
  // 補修痕・シミ
  for (let i = 0; i < 26; i++) {
    c2.fillStyle = 'rgba(52,52,58,' + (0.05 + Math.random() * 0.09).toFixed(2) + ')';
    c2.fillRect(
      Math.random() * 256,
      Math.random() * 512,
      6 + Math.random() * 40,
      3 + Math.random() * 14,
    );
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 34);
  return tex;
}
export const asphaltTex = makeAsphaltTexture();

/* ---- 遠景の山並み(白で描き、themeがcolorで昼夜の色を乗せる) ---- */
function makeRidgeTexture(jag: number, base: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 256;
  const c2 = cv.getContext('2d')!;
  c2.fillStyle = '#ffffff';
  c2.beginPath();
  c2.moveTo(0, 256);
  let y = base;
  c2.lineTo(0, y);
  for (let x = 16; x <= 1024; x += 16) {
    // ランダムウォークで稜線を描く
    y = Math.min(200, Math.max(40, y + (Math.random() - 0.5) * jag));
    c2.lineTo(x, y);
  }
  c2.lineTo(1024, 256);
  c2.closePath();
  c2.fill();
  // 裾野をフェードさせて霧・地面と馴染ませる
  c2.globalCompositeOperation = 'destination-out';
  const g = c2.createLinearGradient(0, 150, 0, 256);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  c2.fillStyle = g;
  c2.fillRect(0, 150, 1024, 106);
  return new THREE.CanvasTexture(cv);
}
export const mtnFarMat = new THREE.MeshBasicMaterial({
  map: makeRidgeTexture(46, 120),
  transparent: true,
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
  color: 0xb9cbd9,
});
export const mtnNearMat = new THREE.MeshBasicMaterial({
  map: makeRidgeTexture(85, 165),
  transparent: true,
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
  color: 0x93aabf,
});

/* ---- 雲(昼のみ。夜はthemeがフェードアウト) ---- */
export const cloudMat = new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(255,255,255,0.85)', 'rgba(255,255,255,0)'),
  transparent: true,
  depthWrite: false,
  fog: false,
  opacity: 0.9,
});

/* ---- 夜景アセット(opacityをテーマがフェード) ---- */
// 星空
export const starMat = new THREE.PointsMaterial({
  color: 0xdfe8ff,
  size: 2.2,
  sizeAttenuation: false,
  fog: false,
  transparent: true,
  opacity: 0,
  depthWrite: false,
});
// 月とハロー
export const moonMat = new THREE.MeshBasicMaterial({
  color: 0xf4f1dc,
  fog: false,
  transparent: true,
  opacity: 0,
});
export const haloMat = new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(214,226,255,0.30)', 'rgba(214,226,255,0)'),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  fog: false,
  opacity: 0,
});
// 街灯の路面光だまり・電球のにじみ
export const lampGlowMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,195,107,0.55)', 'rgba(255,195,107,0)'),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  opacity: 0,
});
export const bulbMat = new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(255,216,150,0.9)', 'rgba(255,170,80,0)'),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  opacity: 0,
});
// 標識ゲートの投光
export const signGlowMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,244,214,0.40)', 'rgba(255,244,214,0)'),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  opacity: 0,
});

/* ---- 車両の灯火エフェクト ---- */
// ブレーキ灯のにじみ(共有マテリアル)
export const brakeGlowMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,40,40,0.85)', 'rgba(255,40,40,0)'),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
export const brakeGlowGeo = new THREE.PlaneGeometry(2.0, 0.8);
// ヘッドライトの路面照射(夜のみ・車両ごとに1枚)
export const beamMat = new THREE.MeshBasicMaterial({
  map: makeGlowTexture('rgba(255,240,190,0.50)', 'rgba(255,240,190,0)'),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  opacity: 0,
});
export const beamGeo = new THREE.PlaneGeometry(4.6, 9.5);

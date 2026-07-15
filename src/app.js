/* ============================================================
   アプリ組み立て: コア(World)と描画・UIを配線しメインループを回す
   ============================================================ */
import * as THREE from 'three';
import { World } from './core/index.js';
import { scene, camera, renderer } from './render/scene.js';
import './render/track.js';
import { applyEnv, tickTheme } from './render/theme.js';
import { syncMeshes } from './render/vehicle-mesh.js';
import { updateCamera, setupCameraControls } from './render/camera.js';
import { icon, renderIcons } from './ui/icons.js';
import { showMessage } from './ui/notify.js';
import { els, updateHUD } from './ui/hud.js';
import { setupPanels } from './ui/panels.js';
import { setupParams } from './ui/params.js';
import { setupNightToggle } from './ui/night-toggle.js';

export function start(){
  const world = new World({ rng: Math.random, spawnInterval: 800 });

  /* ---- コントロールパネル ---- */
  els.slider.addEventListener('input', function(){
    world.spawnInterval = parseInt(this.value, 10);
    els.intervalLabel.textContent = world.spawnInterval;
  });
  function resetWorld(){
    world.reset();
    showMessage(icon('rotate-ccw') + 'シミュレーションをリセットしました');
  }
  document.getElementById('resetBtn').addEventListener('click', resetWorld);

  setupPanels();
  setupParams(resetWorld);
  setupNightToggle();
  setupCameraControls();

  /* ---- メインループ ---- */
  const clock = new THREE.Clock();
  let hudAccum = 0;

  function animate(){
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    tickTheme(dt); // 夕暮れ/夜明けのクロスフェード
    world.step(dt);
    syncMeshes(world, dt);
    hudAccum += dt;
    if (hudAccum >= 0.25) { hudAccum = 0; updateHUD(world); }
    updateCamera();
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', function(){
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  /* ---- 開始 ---- */
  world.populateInitial();
  els.intervalLabel.textContent = world.spawnInterval;
  applyEnv();
  renderIcons(); // 静的な data-lucide プレースホルダを一括で SVG 化
  updateHUD(world);
  updateCamera();
  animate();
  showMessage(icon('circle', 'dot dot-green') + '緑 = 義務あり(ゆずる) ／ ' +
              icon('circle', 'dot dot-amber') + 'オレンジ = 義務なし — 標識と路肩の色が目印');
}

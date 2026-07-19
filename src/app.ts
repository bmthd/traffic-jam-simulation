/* ============================================================
   アプリ組み立て: コア(World)と描画・UIを配線しメインループを回す
   ============================================================ */
import * as THREE from 'three';
import { World } from './core';
import { scene, camera, renderer } from './render/scene';
import './render/track';
import './render/scenery';
import { applyEnv, tickTheme } from './render/theme';
import { syncMeshes } from './render/vehicle-mesh';
import { updateCamera, setupCameraControls } from './render/camera';
import { icon, renderIcons } from './ui/icons';
import { showMessage } from './ui/notify';
import { elements, updateHUD } from './ui/hud';
import { setupPanels } from './ui/panels';
import { setupParams } from './ui/params';
import { setupNightToggle } from './ui/night-toggle';

export function start(): void {
  const world = new World({ rng: Math.random, spawnInterval: 800 });

  /* ---- コントロールパネル ---- */
  elements.slider.addEventListener('input', () => {
    world.spawnInterval = parseInt(elements.slider.value, 10);
    elements.intervalLabel.textContent = String(world.spawnInterval);
  });
  function resetWorld(): void {
    world.reset();
    showMessage(icon('rotate-ccw') + 'シミュレーションをリセットしました');
  }
  document.getElementById('resetBtn')!.addEventListener('click', resetWorld);

  setupPanels();
  setupParams(resetWorld);
  setupNightToggle();
  setupCameraControls();

  /* ---- メインループ ---- */
  const clock = new THREE.Clock();
  let hudAccumulator = 0;
  // 高リフレッシュレート端末(120Hz等)ではrequestAnimationFrameが毎秒120回以上
  // 呼ばれ、消費電力と発熱が倍増する。描画は約60fpsまでに間引く
  // (60Hz環境では1フレーム≈16.7ms > 14msなので従来どおり毎フレーム描画される)
  const MIN_FRAME_TIME = 0.014;
  let frameAccumulator = 0;

  function animate(): void {
    requestAnimationFrame(animate);
    frameAccumulator += clock.getDelta();
    if (frameAccumulator < MIN_FRAME_TIME) return; // このリフレッシュ周期は描画を休む
    const deltaTime = Math.min(frameAccumulator, 0.05);
    frameAccumulator = 0;
    tickTheme(deltaTime); // 夕暮れ/夜明けのクロスフェード
    world.step(deltaTime);
    syncMeshes(world, deltaTime);
    hudAccumulator += deltaTime;
    if (hudAccumulator >= 0.25) {
      hudAccumulator = 0;
      updateHUD(world);
    }
    updateCamera();
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', function () {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  /* ---- 開始 ---- */
  world.populateInitial();
  elements.intervalLabel.textContent = String(world.spawnInterval);
  applyEnv();
  renderIcons(); // 静的な data-lucide プレースホルダを一括で SVG 化
  updateHUD(world);
  updateCamera();
  animate();
  showMessage(
    icon('circle', 'dot dot-green') +
      '緑 = 義務あり(ゆずる) ／ ' +
      icon('circle', 'dot dot-amber') +
      'オレンジ = 義務なし — 標識と路肩の色が目印',
  );
}

/* ================= 観賞モード操作パネル(右上) =================
   カメラのプリセット巡回(観賞モード)の ON/OFF・自動巡回・手動選択を担うUI。
   カメラ状態そのものは render/camera.ts が持ち、ここは操作と表示だけを行う。 */
import {
  SPECTATOR_PRESETS,
  getSpectatorState,
  onSpectatorChange,
  selectSpectatorPreset,
  setSpectatorAuto,
  setSpectatorEnabled,
} from '../render/camera';
import type { SpectatorPresetId } from '../render/camera';
import { icon, renderIcons } from './icons';
import { showMessage } from './notify';

export function setupSpectator(): void {
  const panel = document.getElementById('spectatorPanel')!;
  const toggleBtn = document.getElementById('spectatorToggle')!;
  const autoInput = document.getElementById('spectatorAuto') as HTMLInputElement;
  const presetList = document.getElementById('spectatorPresets')!;

  /* ---- プリセットのボタンを生成(手動選択) ---- */
  const presetButtons = new Map<SpectatorPresetId, HTMLButtonElement>();
  for (const preset of SPECTATOR_PRESETS) {
    const button = document.createElement('button');
    button.className = 'spec-preset';
    button.dataset.id = preset.id;
    button.innerHTML = icon(preset.icon) + '<span>' + preset.label + '</span>';
    button.addEventListener('click', function () {
      selectSpectatorPreset(preset.id);
    });
    presetList.appendChild(button);
    presetButtons.set(preset.id, button);
  }

  /* ---- 観賞モードの ON/OFF ---- */
  toggleBtn.addEventListener('click', function () {
    setSpectatorEnabled(!getSpectatorState().enabled);
  });

  /* ---- 自動巡回の ON/OFF ---- */
  autoInput.addEventListener('change', function () {
    setSpectatorAuto(autoInput.checked);
  });

  /* ---- カメラ側の状態変化を UI に反映(自動巡回での切替も拾う) ---- */
  function render(state: { enabled: boolean; auto: boolean; presetId: SpectatorPresetId }): void {
    panel.classList.toggle('spec-on', state.enabled);
    toggleBtn.innerHTML =
      icon('clapperboard') + (state.enabled ? '観賞モードを終了' : '観賞モードを開始');
    autoInput.checked = state.auto;
    for (const [id, button] of presetButtons) {
      button.classList.toggle('active', state.enabled && id === state.presetId);
    }
    renderIcons();
  }

  let wasEnabled = getSpectatorState().enabled;
  onSpectatorChange(function (state) {
    render(state);
    if (state.enabled && !wasEnabled) {
      showMessage(icon('clapperboard') + '観賞モード: いろいろな視点で眺められます');
    }
    wasEnabled = state.enabled;
  });

  render(getSpectatorState());
}

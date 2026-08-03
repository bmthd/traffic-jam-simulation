/* ================= カメラモード切替(右上の丸ボタン) =================
    4 モード（オート／定点／ドローン／追跡）のメニューと、
    選択中モードのバリエーション・区間を操作バーで切り替える。
    カメラ状態そのものは render/camera.ts が持ち、ここは操作と表示だけを行う。 */
import {
  CAMERA_MODES,
  adjustCamera,
  getSpectatorStatus,
  onSpectatorChange,
  onSpectatorProgress,
  resetCameraAdjustment,
  selectCameraFacility,
  selectCameraSection,
  selectNextFollowVehicle,
  selectSpectatorMode,
  selectVariation,
} from '../render/camera';
import type { SpectatorStatus } from '../render/camera';
import { FACILITIES } from '../core';
import { icon, renderIcons } from './icons';

const MODE_LABEL_DURATION_MS = 3000;

function isFixedMode(modeId: string): boolean {
  return modeId === 'fixed';
}

export function setupSpectator(): void {
  const button = document.getElementById('spectatorBtn')!;
  const label = document.getElementById('spectatorLabel')!;
  const menu = document.getElementById('spectatorMenu')!;
  const resetButton = document.getElementById('cameraResetBtn')!;
  const panHint = document.getElementById('cameraPanHint')!;
  const vehicleBar = document.getElementById('vehicleCameraBar')!;
  const facilityBar = document.getElementById('facilityCameraBar')!;
  const variationContainer = document.getElementById('variationBar')!;
  let labelTimer: ReturnType<typeof setTimeout> | undefined;

  function render(status: SpectatorStatus, showLabel: boolean): void {
    button.innerHTML = icon(status.mode.icon);
    button.classList.toggle('on', status.enabled);
    button.classList.toggle('auto', status.auto);
    const showsFacility = status.mode.id === 'fixed' && status.variation?.id === 'ramp';
    const facility = FACILITIES[status.facilityIndex];
    const facilityLabel = showsFacility
      ? ` 施設${status.facilityIndex + 1}/${FACILITIES.length} (${facility.kind})`
      : '';
    label.textContent = status.mode.label + facilityLabel;
    label.classList.toggle('show', showLabel);
    clearTimeout(labelTimer);
    if (showLabel) {
      labelTimer = setTimeout(function () {
        label.classList.remove('show');
      }, MODE_LABEL_DURATION_MS);
    }
    const detail = showsFacility ? ` 施設${status.facilityIndex + 1} (${facility.kind})` : '';
    const title = 'カメラ: ' + status.mode.label + detail + '(押して切替)';
    button.title = title;
    button.setAttribute('aria-label', title);
    menu.querySelectorAll<HTMLButtonElement>('[data-camera-mode]').forEach((item) => {
      item.classList.toggle('selected', item.dataset.cameraMode === status.mode.id);
    });
    resetButton.hidden = !status.adjusted;
    panHint.hidden = !isFixedMode(status.mode.id);
    vehicleBar.hidden = !isFixedMode(status.mode.id) && status.mode.id !== 'tracking';
    document.getElementById('nextVehicleBtn')!.hidden = status.mode.id !== 'tracking';
    facilityBar.hidden = !showsFacility;
    facilityBar.querySelectorAll<HTMLButtonElement>('[data-facility]').forEach((item) => {
      item.classList.toggle('selected', Number(item.dataset.facility) === status.facilityIndex);
    });
    vehicleBar.querySelectorAll<HTMLButtonElement>('[data-section]').forEach((item) => {
      item.classList.toggle('selected', item.dataset.section === status.section);
    });
    renderVariations(status);
    // アイコンの SVG 化は、バリエーションの差し替えまで終えてからまとめて行う
    // (先に呼ぶと後から挿入したプレースホルダが変換されずアイコンが消える)
    renderIcons();
  }

  function renderVariations(status: SpectatorStatus): void {
    const mode = CAMERA_MODES.find((m) => m.id === status.mode.id);
    if (!mode || mode.variations.length === 0) {
      variationContainer.innerHTML = '';
      variationContainer.hidden = true;
      return;
    }
    variationContainer.hidden = false;
    const currentId = status.variation?.id ?? '';
    variationContainer.innerHTML = mode.variations
      .map(
        (v) =>
          `<button type="button" data-variation="${v.id}" class="${v.id === currentId ? 'selected' : ''}">${icon(v.icon)}<span>${v.label}</span></button>`,
      )
      .join('');
  }

  menu.innerHTML = CAMERA_MODES.map(
    (mode) =>
      `<button type="button" data-camera-mode="${mode.id}">${icon(mode.icon)}<span>${mode.label}</span></button>`,
  ).join('');
  facilityBar.innerHTML = FACILITIES.map(
    (facility, index) =>
      `<button type="button" data-facility="${index}">施設${index + 1} ${facility.kind}</button>`,
  ).join('');

  button.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-camera-mode]');
    if (!item) return;
    selectSpectatorMode(item.dataset.cameraMode as Parameters<typeof selectSpectatorMode>[0]);
    menu.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
  });
  variationContainer.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-variation]');
    if (!item) return;
    const mode = CAMERA_MODES.find((m) => m.id === getSpectatorStatus().mode.id);
    if (!mode) return;
    const index = mode.variations.findIndex((v) => v.id === item.dataset.variation);
    if (index >= 0) selectVariation(index);
    menu.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
  });
  resetButton.addEventListener('click', resetCameraAdjustment);
  facilityBar.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-facility]');
    if (item) selectCameraFacility(Number(item.dataset.facility));
  });
  vehicleBar.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const sectionButton = target.closest<HTMLButtonElement>('[data-section]');
    if (sectionButton) selectCameraSection(sectionButton.dataset.section as 'L' | 'R');
    if (target.closest('#nextVehicleBtn')) selectNextFollowVehicle();
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('input, textarea, select, button') || target.isContentEditable) return;
    const status = getSpectatorStatus();
    const adjustment = 0.08;
    if (event.key === 'ArrowLeft') adjustCamera(adjustment, 0);
    else if (event.key === 'ArrowRight') adjustCamera(-adjustment, 0);
    else if (event.key === 'ArrowUp') adjustCamera(0, -adjustment);
    else if (event.key === 'ArrowDown') adjustCamera(0, adjustment);
    else if (event.key.toLowerCase() === 'n' && status.mode.id === 'tracking')
      selectNextFollowVehicle();
    else if (isFixedMode(status.mode.id) || status.mode.id === 'tracking') {
      if (['l', 'r'].includes(event.key.toLowerCase()))
        selectCameraSection(event.key.toUpperCase() as 'L' | 'R');
    } else if (/^[1-8]$/.test(event.key)) {
      const flat = CAMERA_MODES.flatMap((m) =>
        m.variations.map((v) => ({ modeId: m.id, presetId: v.presetId })),
      );
      const entry = flat[Number(event.key) - 1];
      if (entry) {
        selectSpectatorMode(entry.modeId);
        const mode = CAMERA_MODES.find((m) => m.id === entry.modeId);
        if (mode) {
          const vi = mode.variations.findIndex((v) => v.presetId === entry.presetId);
          if (vi >= 0) selectVariation(vi);
        }
      }
    } else return;
    event.preventDefault();
  });
  onSpectatorChange((status) => render(status, true));
  onSpectatorProgress((progress) => {
    button.style.setProperty('--auto-cycle-progress', String(progress));
  });
  render(getSpectatorStatus(), false);
}

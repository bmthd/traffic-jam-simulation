/* ================= カメラモード切替(右上の丸ボタン) =================
   専用パネルを置くと画面が狭いときに他のパネルと干渉し、項目も増えて煩雑になる。
   そこでカラーモード切替と同じ「押すたびに切り替わる丸ボタン」1つに集約し、
   マニュアル → オート → 各プリセット → マニュアル… と循環させる。
   カメラ状態そのものは render/camera.ts が持ち、ここは操作と表示だけを行う。 */
import {
  SPECTATOR_MODES,
  getSpectatorStatus,
  onSpectatorChange,
  onSpectatorProgress,
  resetCameraAdjustment,
  selectCameraSection,
  selectNextFollowVehicle,
  selectSpectatorMode,
} from '../render/camera';
import type { SpectatorStatus } from '../render/camera';
import { icon, renderIcons } from './icons';

const MODE_LABEL_DURATION_MS = 3000;

export function setupSpectator(): void {
  const button = document.getElementById('spectatorBtn')!;
  const label = document.getElementById('spectatorLabel')!;
  const menu = document.getElementById('spectatorMenu')!;
  const resetButton = document.getElementById('cameraResetBtn')!;
  const panHint = document.getElementById('cameraPanHint')!;
  const vehicleBar = document.getElementById('vehicleCameraBar')!;
  let labelTimer: ReturnType<typeof setTimeout> | undefined;

  function render(status: SpectatorStatus, showLabel: boolean): void {
    // アイコンは「今どのモードか」を表す
    button.innerHTML = icon(status.mode.icon);
    button.classList.toggle('on', status.enabled);
    button.classList.toggle('auto', status.auto);
    label.textContent = status.mode.label;
    label.classList.toggle('show', showLabel);
    clearTimeout(labelTimer);
    if (showLabel) {
      labelTimer = setTimeout(function () {
        label.classList.remove('show');
      }, MODE_LABEL_DURATION_MS);
    }
    const title = 'カメラ: ' + status.mode.label + '(押して切替)';
    button.title = title;
    button.setAttribute('aria-label', title);
    renderIcons();
    menu.querySelectorAll<HTMLButtonElement>('[data-camera-mode]').forEach((item) => {
      item.classList.toggle('selected', item.dataset.cameraMode === status.mode.id);
    });
    resetButton.hidden = !status.adjusted;
    panHint.hidden = !['overhead', 'lookup', 'ramp'].includes(status.mode.id);
    vehicleBar.hidden = !['follow', 'driver', 'lookup', 'ramp'].includes(status.mode.id);
    document.getElementById('nextVehicleBtn')!.hidden = !['follow', 'driver'].includes(
      status.mode.id,
    );
    vehicleBar.querySelectorAll<HTMLButtonElement>('[data-section]').forEach((item) => {
      item.classList.toggle('selected', item.dataset.section === status.section);
    });
  }

  const groups = [
    ['オート', SPECTATOR_MODES.filter((mode) => mode.id === 'auto')],
    [
      '全体を見る',
      SPECTATOR_MODES.filter((mode) =>
        ['drone', 'overhead', 'lookup', 'flyby', 'ramp'].includes(mode.id),
      ),
    ],
    ['車から見る', SPECTATOR_MODES.filter((mode) => ['follow', 'driver'].includes(mode.id))],
  ] as const;
  menu.innerHTML = groups
    .map(
      ([name, modes]) =>
        `<div class="camera-menu-group"><div class="camera-menu-heading">${name}</div>${modes.map((mode) => `<button type="button" data-camera-mode="${mode.id}">${icon(mode.icon)}<span>${mode.label}</span></button>`).join('')}</div>`,
    )
    .join('');
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
  resetButton.addEventListener('click', resetCameraAdjustment);
  vehicleBar.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const sectionButton = target.closest<HTMLButtonElement>('[data-section]');
    if (sectionButton) selectCameraSection(sectionButton.dataset.section as 'L' | 'R');
    if (target.closest('#nextVehicleBtn')) selectNextFollowVehicle();
  });
  onSpectatorChange((status) => render(status, true));
  onSpectatorProgress((progress) => {
    button.style.setProperty('--auto-cycle-progress', String(progress));
  });
  render(getSpectatorStatus(), false);
}

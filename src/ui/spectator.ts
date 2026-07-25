/* ================= カメラモード切替(右上の丸ボタン) =================
   専用パネルを置くと画面が狭いときに他のパネルと干渉し、項目も増えて煩雑になる。
   そこでカラーモード切替と同じ「押すたびに切り替わる丸ボタン」1つに集約し、
   マニュアル → オート → 各プリセット → マニュアル… と循環させる。
   カメラ状態そのものは render/camera.ts が持ち、ここは操作と表示だけを行う。 */
import { cycleSpectatorMode, getSpectatorStatus, onSpectatorChange } from '../render/camera';
import type { SpectatorStatus } from '../render/camera';
import { icon, renderIcons } from './icons';

const MODE_LABEL_DURATION_MS = 3000;

export function setupSpectator(): void {
  const button = document.getElementById('spectatorBtn')!;
  const label = document.getElementById('spectatorLabel')!;
  let labelTimer: ReturnType<typeof setTimeout> | undefined;

  function render(status: SpectatorStatus, showLabel: boolean): void {
    // アイコンは「今どのモードか」を表す
    button.innerHTML = icon(status.mode.icon);
    button.classList.toggle('on', status.enabled);
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
  }

  button.addEventListener('click', cycleSpectatorMode);
  onSpectatorChange((status) => render(status, true));
  render(getSpectatorStatus(), false);
}

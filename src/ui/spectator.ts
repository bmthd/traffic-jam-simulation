/* ================= 観賞モード切替(右上の丸ボタン) =================
   専用パネルを置くと画面が狭いときに他のパネルと干渉し、項目も増えて煩雑になる。
   そこでカラーモード切替と同じ「押すたびに切り替わる丸ボタン」1つに集約し、
   通常操作 → 自動巡回 → 各プリセット → 通常操作… と循環させる。
   カメラ状態そのものは render/camera.ts が持ち、ここは操作と表示だけを行う。 */
import { cycleSpectatorMode, getSpectatorStatus, onSpectatorChange } from '../render/camera';
import type { SpectatorStatus } from '../render/camera';
import { icon, renderIcons } from './icons';

export function setupSpectator(): void {
  const button = document.getElementById('spectatorBtn')!;
  const label = document.getElementById('spectatorLabel')!;

  function render(status: SpectatorStatus): void {
    // アイコンは「今どのモードか」を表す(通常操作のときは観賞モードへの入口)
    button.innerHTML = icon(status.mode.icon);
    button.classList.toggle('on', status.enabled);
    // 自動巡回中は、巡回中であることと今映しているプリセットの両方を出す
    const text =
      status.auto && status.preset
        ? status.mode.label + '・' + status.preset.label
        : status.mode.label;
    label.textContent = text;
    label.classList.toggle('show', status.enabled);
    const title = status.enabled ? '観賞モード: ' + text + '(押して切替)' : '観賞モードを開始';
    button.title = title;
    button.setAttribute('aria-label', title);
    renderIcons();
  }

  button.addEventListener('click', cycleSpectatorMode);
  onSpectatorChange(render);
  render(getSpectatorStatus());
}

/* ================= 通知(エラー・トースト) ================= */
import { icon, renderIcons } from './icons';

const errorBox = document.getElementById('errorBox')!;
const messageBox = document.getElementById('messageBox')!;

export function showError(message: string): void {
  console.error('[Simulation Error]', message);
  errorBox.innerHTML = icon('triangle-alert');
  errorBox.append('エラーが発生しました: ' + message);
  errorBox.style.display = 'block';
  renderIcons();
}

let messageTimer: ReturnType<typeof setTimeout> | undefined;
export function showMessage(text: string): void {
  messageBox.innerHTML = text;
  messageBox.classList.add('show');
  renderIcons();
  clearTimeout(messageTimer);
  messageTimer = setTimeout(function () {
    messageBox.classList.remove('show');
  }, 2400);
}

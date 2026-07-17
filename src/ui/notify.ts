/* ================= 通知(エラー・トースト) ================= */
import { icon, renderIcons } from './icons';

const errorBox = document.getElementById('errorBox')!;
const messageBox = document.getElementById('messageBox')!;

export function showError(msg: string): void {
  console.error('[Simulation Error]', msg);
  errorBox.innerHTML = icon('triangle-alert');
  errorBox.append('エラーが発生しました: ' + msg);
  errorBox.style.display = 'block';
  renderIcons();
}

let msgTimer: ReturnType<typeof setTimeout> | undefined;
export function showMessage(text: string): void {
  messageBox.innerHTML = text;
  messageBox.classList.add('show');
  renderIcons();
  clearTimeout(msgTimer);
  msgTimer = setTimeout(function () {
    messageBox.classList.remove('show');
  }, 2400);
}

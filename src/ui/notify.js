/* ================= 通知(エラー・トースト) ================= */
import { icon, renderIcons } from './icons.js';

const errorBox = document.getElementById('errorBox');
const messageBox = document.getElementById('messageBox');

export function showError(msg){
  console.error('[Simulation Error]', msg);
  errorBox.innerHTML = icon('triangle-alert');
  errorBox.append('エラーが発生しました: ' + msg);
  errorBox.style.display = 'block';
  renderIcons();
}

let msgTimer = null;
export function showMessage(text){
  messageBox.innerHTML = text;
  messageBox.classList.add('show');
  renderIcons();
  clearTimeout(msgTimer);
  msgTimer = setTimeout(function(){ messageBox.classList.remove('show'); }, 2400);
}

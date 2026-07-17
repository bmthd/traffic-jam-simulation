/* ============================================================
   エントリポイント
   アプリ本体 (app.js) を動的importにすることで、WebGL初期化などの
   モジュール読み込み時エラーも画面上のエラーボックスに表示できる
   ============================================================ */
import './style.css';
import { showError } from './ui/notify';

window.addEventListener('error', function (e) {
  showError(e.message);
});

try {
  const { start } = await import('./app');
  start();
} catch (e) {
  showError((e as Error).message);
  throw e;
}

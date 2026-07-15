/* ================= カラーモード切替(右上の丸ボタン) ================= */
import { setNightTarget } from '../render/theme.js';
import { icon, renderIcons } from './icons.js';

let isNight = false;

function setNight(on){
  isNight = on;
  // 動きを減らす設定ではクロスフェードを省いて即時切替
  setNightTarget(on, matchMedia('(prefers-reduced-motion: reduce)').matches);
  const nightBtn = document.getElementById('nightBtn');
  document.body.classList.toggle('night', on);
  nightBtn.innerHTML = on ? icon('moon') : icon('sun'); // アイコンは現在のモードを表す
  nightBtn.title = on ? 'デイモードに切り替え' : 'ナイトモードに切り替え';
  nightBtn.setAttribute('aria-label', nightBtn.title);
  renderIcons();
}

export function setupNightToggle(){
  document.getElementById('nightBtn').addEventListener('click', function(){
    setNight(!isNight);
  });
}

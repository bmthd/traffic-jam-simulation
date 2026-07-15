/* ================= HUD(スコア比較パネル・カウンタ) ================= */
import { icon, renderIcons } from './icons.js';

export const els = {
  count: document.getElementById('vehicleCount'),
  intervalLabel: document.getElementById('intervalLabel'),
  slider: document.getElementById('intervalSlider'),
  countLeft: document.getElementById('countLeft'),
  countRight: document.getElementById('countRight'),
  avgLeft: document.getElementById('avgLeft'),
  avgRight: document.getElementById('avgRight'),
  scoreLeft: document.getElementById('scoreLeft'),
  scoreRight: document.getElementById('scoreRight'),
  barLeft: document.getElementById('barLeft'),
  barRight: document.getElementById('barRight'),
  statusLeft: document.getElementById('statusLeft'),
  statusRight: document.getElementById('statusRight'),
  crownLeft: document.getElementById('crownLeft'),
  crownRight: document.getElementById('crownRight'),
  miniLeft: document.getElementById('miniLeft'),
  miniRight: document.getElementById('miniRight')
};

// 渋滞スコアに応じた状態(段階が変わった時だけ DOM を書き換えてアイコンを再生成)
function statusTier(score){
  if (score < 20) return { icon: 'gauge', label: 'スイスイ' };
  if (score < 40) return { icon: 'smile', label: '順調' };
  if (score < 60) return { icon: 'meh', label: 'やや混雑' };
  if (score < 80) return { icon: 'frown', label: '渋滞' };
  return { icon: 'angry', label: '大渋滞' };
}
function setStatus(el, score){
  const t = statusTier(score);
  if (el._statusIcon === t.icon) return; // 段階が同じなら何もしない(毎フレームの再生成を回避)
  el._statusIcon = t.icon;
  el.innerHTML = icon(t.icon);
  el.append(t.label);
  renderIcons();
}
function scoreColor(score){
  if (score < 30) return '#7CFC9A';
  if (score < 55) return '#ffd54a';
  if (score < 75) return '#ff9a3d';
  return '#ff5c5c';
}

export function updateHUD(world){
  els.count.textContent = world.vehicles.length;
  const L = world.computeSection('L'), R = world.computeSection('R');
  els.countLeft.textContent = L.n;
  els.countRight.textContent = R.n;
  els.avgLeft.textContent = Math.round(L.avg * 3.6);
  els.avgRight.textContent = Math.round(R.avg * 3.6);
  els.scoreLeft.textContent = L.score.toFixed(1);
  els.scoreRight.textContent = R.score.toFixed(1);
  els.barLeft.style.width = L.score + '%';
  els.barRight.style.width = R.score + '%';
  els.barLeft.style.backgroundColor = scoreColor(L.score);
  els.barRight.style.backgroundColor = scoreColor(R.score);
  setStatus(els.statusLeft, L.score);
  setStatus(els.statusRight, R.score);
  const diff = L.score - R.score;
  els.crownLeft.classList.toggle('show', diff < -5 && L.n > 5);
  els.crownRight.classList.toggle('show', diff > 5 && R.n > 5);
  els.miniLeft.textContent = L.score.toFixed(1);
  els.miniRight.textContent = R.score.toFixed(1);
  els.miniLeft.classList.toggle('win', diff < -5 && L.n > 5);
  els.miniRight.classList.toggle('win', diff > 5 && R.n > 5);
}

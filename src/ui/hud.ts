/* ================= HUD(スコア比較パネル・カウンタ) ================= */
import type { World } from '../core';
import { icon, renderIcons } from './icons';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export const els = {
  count: byId('vehicleCount'),
  intervalLabel: byId('intervalLabel'),
  slider: byId<HTMLInputElement>('intervalSlider'),
  countLeft: byId('countLeft'),
  countRight: byId('countRight'),
  avgLeft: byId('avgLeft'),
  avgRight: byId('avgRight'),
  scoreLeft: byId('scoreLeft'),
  scoreRight: byId('scoreRight'),
  barLeft: byId('barLeft'),
  barRight: byId('barRight'),
  statusLeft: byId('statusLeft'),
  statusRight: byId('statusRight'),
  crownLeft: byId('crownLeft'),
  crownRight: byId('crownRight'),
  miniLeft: byId('miniLeft'),
  miniRight: byId('miniRight'),
};

// 渋滞スコアに応じた状態(段階が変わった時だけ DOM を書き換えてアイコンを再生成)
function statusTier(score: number): { icon: string; label: string } {
  if (score < 20) return { icon: 'gauge', label: 'スイスイ' };
  if (score < 40) return { icon: 'smile', label: '順調' };
  if (score < 60) return { icon: 'meh', label: 'やや混雑' };
  if (score < 80) return { icon: 'frown', label: '渋滞' };
  return { icon: 'angry', label: '大渋滞' };
}
const statusIconOf = new WeakMap<HTMLElement, string>();
function setStatus(el: HTMLElement, score: number): void {
  const t = statusTier(score);
  if (statusIconOf.get(el) === t.icon) return; // 段階が同じなら何もしない(毎フレームの再生成を回避)
  statusIconOf.set(el, t.icon);
  el.innerHTML = icon(t.icon);
  el.append(t.label);
  renderIcons();
}
function scoreColor(score: number): string {
  if (score < 30) return '#7CFC9A';
  if (score < 55) return '#ffd54a';
  if (score < 75) return '#ff9a3d';
  return '#ff5c5c';
}

export function updateHUD(world: World): void {
  els.count.textContent = String(world.vehicles.length);
  const L = world.computeSection('L'),
    R = world.computeSection('R');
  els.countLeft.textContent = String(L.n);
  els.countRight.textContent = String(R.n);
  els.avgLeft.textContent = String(Math.round(L.avg * 3.6));
  els.avgRight.textContent = String(Math.round(R.avg * 3.6));
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

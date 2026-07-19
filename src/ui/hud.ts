/* ================= HUD(スコア比較パネル・カウンタ) ================= */
import type { World } from '../core';
import { icon, renderIcons } from './icons';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export const elements = {
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
function setStatus(element: HTMLElement, score: number): void {
  const tier = statusTier(score);
  if (statusIconOf.get(element) === tier.icon) return; // 段階が同じなら何もしない(毎フレームの再生成を回避)
  statusIconOf.set(element, tier.icon);
  element.innerHTML = icon(tier.icon);
  element.append(tier.label);
  renderIcons();
}
function scoreColor(score: number): string {
  if (score < 30) return '#7CFC9A';
  if (score < 55) return '#ffd54a';
  if (score < 75) return '#ff9a3d';
  return '#ff5c5c';
}

export function updateHUD(world: World): void {
  elements.count.textContent = String(world.vehicles.length);
  const left = world.computeSection('L'),
    right = world.computeSection('R');
  elements.countLeft.textContent = String(left.count);
  elements.countRight.textContent = String(right.count);
  elements.avgLeft.textContent = String(Math.round(left.averageSpeed * 3.6));
  elements.avgRight.textContent = String(Math.round(right.averageSpeed * 3.6));
  elements.scoreLeft.textContent = left.score.toFixed(1);
  elements.scoreRight.textContent = right.score.toFixed(1);
  elements.barLeft.style.width = left.score + '%';
  elements.barRight.style.width = right.score + '%';
  elements.barLeft.style.backgroundColor = scoreColor(left.score);
  elements.barRight.style.backgroundColor = scoreColor(right.score);
  setStatus(elements.statusLeft, left.score);
  setStatus(elements.statusRight, right.score);
  const diff = left.score - right.score;
  elements.crownLeft.classList.toggle('show', diff < -5 && left.count > 5);
  elements.crownRight.classList.toggle('show', diff > 5 && right.count > 5);
  elements.miniLeft.textContent = left.score.toFixed(1);
  elements.miniRight.textContent = right.score.toFixed(1);
  elements.miniLeft.classList.toggle('win', diff < -5 && left.count > 5);
  elements.miniRight.classList.toggle('win', diff > 5 && right.count > 5);
}

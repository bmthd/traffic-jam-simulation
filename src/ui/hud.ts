/* ================= HUD(スコア比較パネル・カウンタ) ================= */
import { CONST } from '../core';
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
  smoothTimeLeft: byId('smoothTimeLeft'),
  smoothTimeRight: byId('smoothTimeRight'),
  smoothBarLeft: byId('smoothBarLeft'),
  smoothLead: byId('smoothLead'),
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

// 累積秒を m:ss(1時間以上なら h:mm:ss)に整形する
function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const s = total % 60,
    m = Math.floor(total / 60) % 60,
    h = Math.floor(total / 3600);
  const mm = h > 0 && m < 10 ? '0' + m : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : String(s));
}

// 開始からの累積「優勢だった時間」(Issue #26)。
// 一時的にどちらが空いていても、時間の積み重ねでどちらが混みやすい道路かが分かる。
// 1本のバーを L/R の割合で塗り分ける(左=義務あり緑 / 右=義務なし橙)
function updateSmoothTime(world: World): void {
  const { L, R } = world.smoothTime;
  elements.smoothTimeLeft.textContent = formatDuration(L);
  elements.smoothTimeRight.textContent = formatDuration(R);
  const total = L + R;
  // 左セグメント幅 = L/(L+R)。開始直後(合計0)は0除算を避けて五分五分で表示
  const leftPercent = total > 0 ? (L / total) * 100 : 50;
  elements.smoothBarLeft.style.width = leftPercent + '%';
  const diff = L - R;
  const leading = Math.abs(diff) < 1 ? null : diff > 0 ? 'L' : 'R';
  elements.smoothLead.textContent = leading
    ? (leading === 'L' ? '義務あり' : '義務なし') + 'が ' + formatDuration(Math.abs(diff)) + ' 優勢'
    : '互角';
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
  // 王冠の閾値は累積時間の判定(World.smootherSection)と共有する。
  // 王冠が出ている側の累積時間が伸びる、という見た目の一致を保つため
  const diff = left.score - right.score;
  const winsLeft = diff < -CONST.SMOOTH_SCORE_DEADZONE && left.count > CONST.SMOOTH_MIN_COUNT;
  const winsRight = diff > CONST.SMOOTH_SCORE_DEADZONE && right.count > CONST.SMOOTH_MIN_COUNT;
  elements.crownLeft.classList.toggle('show', winsLeft);
  elements.crownRight.classList.toggle('show', winsRight);
  elements.miniLeft.textContent = left.score.toFixed(1);
  elements.miniRight.textContent = right.score.toFixed(1);
  elements.miniLeft.classList.toggle('win', winsLeft);
  elements.miniRight.classList.toggle('win', winsRight);
  updateSmoothTime(world);
}

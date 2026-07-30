/* ================= HUD(スコア比較パネル・カウンタ) ================= */
import { CONST } from '../core';
import type { World } from '../core';
import { icon, renderIcons } from './icons';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export const elements = {
  count: byId('vehicleCount'),
  maxCount: byId('maxVehicleCount'),
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
  smoothTimeLeft: byId('smoothTimeLeft'),
  smoothTimeRight: byId('smoothTimeRight'),
  smoothBarLeft: byId('smoothBarLeft'),
  verdict: byId('verdict'),
  verdictMain: byId('verdictMain'),
  verdictSub: byId('verdictSub'),
  miniLead: byId('miniLead'),
  criteriaList: byId('criteriaList'),
};

elements.maxCount.textContent = String(CONST.MAX_VEHICLES);

// 判定基準(アコーディオン)は定数から組み立てる。
// 閾値を調整したときに説明文だけ古くなることがないようにするため
elements.criteriaList.innerHTML = [
  `<b>渋滞スコア</b>: 平均速度 ${CONST.SCORE_WEIGHT_SPEED * 100}% + 混雑度 ${CONST.SCORE_WEIGHT_DENSITY * 100}% を 0〜100 に換算。小さいほどスムーズ。`,
  `<b>平均速度</b>: 基準 ${Math.round(CONST.REF_SPEED * 3.6)} km/h からの落ち込みで採点。入口待ちの車も 0 km/h として数える。`,
  `<b>混雑度</b>: 区間あたり ${CONST.MAX_PER_SECTION} 台を上限とした割合。`,
  `<b>勝ち</b>: その瞬間スコアが低い(スムーズな)側へ時間を積む。`,
  `<b>引き分け</b>: スコア差が ${CONST.SMOOTH_SCORE_DEADZONE} 以下、または片側が ${CONST.SMOOTH_MIN_COUNT} 台以下のときはどちらにも積まない。`,
  `<b>リード</b>: 積み上げた時間が長い側。差が 1 秒未満なら互角。`,
]
  .map((text) => '<li>' + text + '</li>')
  .join('');

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

// 開始からの累積「スムーズだった時間」で、今どちらが勝っているか(Issue #26, #113)。
// 一時的にどちらが空いていても、時間の積み重ねでどちらが混みやすい道路かが分かるので
// これをパネルの主役として大きく出す。
// 1本のバーを L/R の割合で塗り分ける(左=義務あり緑 / 右=義務なし橙)
let shownLeading: 'L' | 'R' | null | undefined;
function updateVerdict(world: World): void {
  const { L, R } = world.smoothTime;
  elements.smoothTimeLeft.textContent = formatDuration(L);
  elements.smoothTimeRight.textContent = formatDuration(R);
  const total = L + R;
  // 左セグメント幅 = L/(L+R)。開始直後(合計0)は0除算を避けて五分五分で表示
  const leftPercent = total > 0 ? (L / total) * 100 : 50;
  elements.smoothBarLeft.style.width = leftPercent + '%';
  const diff = L - R;
  const leading = Math.abs(diff) < 1 ? null : diff > 0 ? 'L' : 'R';
  const label = leading === 'L' ? '義務あり' : '義務なし';
  // 見出しは王冠アイコンを含むので、リードが入れ替わった時だけ書き換える
  if (shownLeading !== leading) {
    shownLeading = leading;
    elements.verdictMain.innerHTML = leading ? icon('crown') : '';
    elements.verdictMain.append(leading ? label + ' がリード' : '互角');
    elements.verdict.classList.toggle('lead-left', leading === 'L');
    elements.verdict.classList.toggle('lead-right', leading === 'R');
    elements.miniLead.classList.toggle('lead-left', leading === 'L');
    elements.miniLead.classList.toggle('lead-right', leading === 'R');
    renderIcons();
  }
  elements.verdictSub.textContent = leading
    ? 'スムーズだった時間の差 ' + formatDuration(Math.abs(diff))
    : 'スムーズだった時間はほぼ互角';
  elements.miniLead.textContent = leading ? label + ' +' + formatDuration(Math.abs(diff)) : '互角';
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
  // 「今スムーズ」の閾値は累積時間の判定(World.smootherSection)と共有する。
  // 王冠が出ている側の累積時間が伸びる、という見た目の一致を保つため
  const diff = left.score - right.score;
  const winsLeft = diff < -CONST.SMOOTH_SCORE_DEADZONE && left.count > CONST.SMOOTH_MIN_COUNT;
  const winsRight = diff > CONST.SMOOTH_SCORE_DEADZONE && right.count > CONST.SMOOTH_MIN_COUNT;
  elements.crownLeft.classList.toggle('show', winsLeft);
  elements.crownRight.classList.toggle('show', winsRight);
  updateVerdict(world);
}

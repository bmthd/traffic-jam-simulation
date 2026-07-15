/* ================= パラメータ調整室(モーダル) ================= */
import { CONST } from '../core';
import type { NumericSimParam } from '../core';
import { showMessage } from './notify';

interface ParamGroup {
  group: string;
}
interface ParamDef {
  key: NumericSimParam;
  label: string;
  min: number;
  max: number;
  step: number;
  desc: string;
  unit?: string;
  pct?: boolean;
}
type ParamEntry = ParamGroup | ParamDef;

const PARAM_DEFS: ParamEntry[] = [
  { group: 'ルール(比較の核心)' },
  {
    key: 'VOLUNTARY_YIELD_RATIO',
    label: '自発的に譲る人の割合',
    min: 0,
    max: 1,
    step: 0.05,
    pct: true,
    desc: '義務なし区間でも自主的に譲る人。1.0にすると両区間は実質同じルールになる',
  },
  {
    key: 'CAMPER_RATIO',
    label: 'マイペース派の割合',
    min: 0,
    max: 1,
    step: 0.05,
    pct: true,
    desc: '譲らない人のうち、追い越し車線を定位置にして巡航する人',
  },
  {
    key: 'OVERTAKE_LANE_RETURN_TIME',
    label: '義務あり: 戻るまでの時間',
    min: 0.5,
    max: 12,
    step: 0.5,
    unit: '秒',
    desc: '義務あり区間で追い越し後に走行車線へ戻るまで',
  },
  {
    key: 'CAMPER_RETURN_TIME_MAX',
    label: 'マイペース派の居座り(最大)',
    min: 10,
    max: 90,
    step: 5,
    unit: '秒',
    desc: '追い越し車線に留まり続ける時間の上限',
  },
  { group: '人間ドライバー(両区間共通)' },
  {
    key: 'HUMAN_REACTION',
    label: '知覚の遅れ',
    min: 0.05,
    max: 1.5,
    step: 0.05,
    unit: '秒',
    desc: '前の車の速度変化に気づくまでの時間。渋滞波の主因',
  },
  {
    key: 'HUMAN_BRAKE_AMP',
    label: 'ブレーキの踏みすぎ',
    min: 1.0,
    max: 4.0,
    step: 0.1,
    unit: '倍',
    desc: '必要量よりどれだけ強く踏むか。波を後ろへ増幅させる',
  },
  {
    key: 'HUMAN_ACCEL_LAG',
    label: '再加速の出遅れ',
    min: 0,
    max: 3,
    step: 0.1,
    unit: '秒',
    desc: '前が動いてから踏み直すまで。渋滞先頭の流出を減らす',
  },
  {
    key: 'HUMAN_GAIN',
    label: '車間調整の強さ',
    min: 0.3,
    max: 2.0,
    step: 0.05,
    unit: '',
    desc: '車間のズレへの反応の強さ。強いほど波が育ちやすい',
  },
  { group: '交通量・スコア' },
  {
    key: 'DEMAND_FACTOR',
    label: '交通需要',
    min: 40000,
    max: 220000,
    step: 5000,
    unit: '',
    desc: '同じ生成間隔での目標台数。上げるほど混む(即時反映)',
  },
  {
    key: 'REF_SPEED',
    label: 'スコア基準速度',
    min: 15,
    max: 35,
    step: 1,
    unit: 'm/s',
    desc: '渋滞スコアの基準。25 ≒ 90km/h',
  },
];

const PARAM_DEFAULTS = {} as Record<NumericSimParam, number>;
for (const d of PARAM_DEFS) if ('key' in d) PARAM_DEFAULTS[d.key] = CONST[d.key];

function fmtParam(d: ParamDef, v: number): string {
  if (d.pct) return Math.round(v * 100) + '%';
  return (
    (d.step >= 1 ? Math.round(v).toLocaleString() : v.toFixed(2)) + (d.unit ? ' ' + d.unit : '')
  );
}

// onApply: 「リセットして適用」時に呼ばれる(全車両を作り直して完全反映)
export function setupParams(onApply: () => void): void {
  const list = document.getElementById('paramList')!;
  for (const d of PARAM_DEFS) {
    if ('group' in d) {
      const g = document.createElement('div');
      g.className = 'pgroup';
      g.textContent = '── ' + d.group;
      list.appendChild(g);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'prow';
    row.innerHTML =
      '<div class="plabel"><span>' +
      d.label +
      '</span>' +
      '<span class="pval" id="pv_' +
      d.key +
      '"></span></div>' +
      '<input type="range" id="pr_' +
      d.key +
      '" min="' +
      d.min +
      '" max="' +
      d.max +
      '" step="' +
      d.step +
      '">' +
      '<div class="pdesc">' +
      d.desc +
      '</div>';
    list.appendChild(row);
    const input = row.querySelector('input')!;
    const val = row.querySelector('.pval')!;
    input.value = String(CONST[d.key]);
    val.textContent = fmtParam(d, CONST[d.key]);
    input.addEventListener('input', function () {
      const v = parseFloat(input.value);
      CONST[d.key] = v;
      val.textContent = fmtParam(d, v);
    });
  }

  const paramOverlay = document.getElementById('paramOverlay')!;
  document.getElementById('paramsBtn')!.addEventListener('click', function () {
    paramOverlay.classList.add('open');
  });
  function closeParams(): void {
    paramOverlay.classList.remove('open');
  }
  document.getElementById('paramClose')!.addEventListener('click', closeParams);
  paramOverlay.addEventListener('click', function (e) {
    if (e.target === paramOverlay) closeParams();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeParams();
  });
  document.getElementById('paramApply')!.addEventListener('click', function () {
    closeParams();
    onApply();
  });
  document.getElementById('paramDefaults')!.addEventListener('click', function () {
    for (const d of PARAM_DEFS) {
      if (!('key' in d)) continue;
      CONST[d.key] = PARAM_DEFAULTS[d.key];
      (document.getElementById('pr_' + d.key) as HTMLInputElement).value = String(
        PARAM_DEFAULTS[d.key],
      );
      document.getElementById('pv_' + d.key)!.textContent = fmtParam(d, PARAM_DEFAULTS[d.key]);
    }
    showMessage('パラメータを既定値に戻しました');
  });
}

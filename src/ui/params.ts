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
  description: string;
  unit?: string;
  isPercent?: boolean;
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
    isPercent: true,
    description: '義務なし区間でも自主的に譲る人。1.0にすると両区間は実質同じルールになる',
  },
  {
    key: 'CAMPER_RATIO',
    label: 'マイペース派の割合',
    min: 0,
    max: 1,
    step: 0.05,
    isPercent: true,
    description: '譲らない人のうち、追い越し車線を定位置にして巡航する人',
  },
  {
    key: 'OVERTAKE_LANE_RETURN_TIME',
    label: '義務あり: 戻るまでの時間',
    min: 0.5,
    max: 12,
    step: 0.5,
    unit: '秒',
    description: '義務あり区間で追い越し後に走行車線へ戻るまで',
  },
  {
    key: 'CAMPER_RETURN_TIME_MAX',
    label: 'マイペース派の居座り(最大)',
    min: 10,
    max: 90,
    step: 5,
    unit: '秒',
    description: '追い越し車線に留まり続ける時間の上限',
  },
  { group: '人間ドライバー(両区間共通)' },
  {
    key: 'HUMAN_REACTION',
    label: '知覚の遅れ',
    min: 0.05,
    max: 1.5,
    step: 0.05,
    unit: '秒',
    description: '前の車の速度変化に気づくまでの時間。渋滞波の主因',
  },
  {
    key: 'HUMAN_BRAKE_AMP',
    label: 'ブレーキの踏みすぎ',
    min: 1.0,
    max: 4.0,
    step: 0.1,
    unit: '倍',
    description: '必要量よりどれだけ強く踏むか。波を後ろへ増幅させる',
  },
  {
    key: 'HUMAN_ACCEL_LAG',
    label: '再加速の出遅れ',
    min: 0,
    max: 3,
    step: 0.1,
    unit: '秒',
    description: '前が動いてから踏み直すまで。渋滞先頭の流出を減らす',
  },
  {
    key: 'HUMAN_GAIN',
    label: '車間調整の強さ',
    min: 0.3,
    max: 2.0,
    step: 0.05,
    unit: '',
    description: '車間のズレへの反応の強さ。強いほど波が育ちやすい',
  },
  { group: '交通量・スコア' },
  {
    key: 'DEMAND_FACTOR',
    label: '交通需要',
    min: 40000,
    max: 220000,
    step: 5000,
    unit: '',
    description: '同じ生成間隔での目標台数。上げるほど混む(即時反映)',
  },
  {
    key: 'REF_SPEED',
    label: 'スコア基準速度',
    min: 15,
    max: 35,
    step: 1,
    unit: 'm/s',
    description: '渋滞スコアの基準。25 ≒ 90km/h',
  },
];

const PARAM_DEFAULTS = {} as Record<NumericSimParam, number>;
for (const def of PARAM_DEFS) if ('key' in def) PARAM_DEFAULTS[def.key] = CONST[def.key];

function formatParam(def: ParamDef, value: number): string {
  if (def.isPercent) return Math.round(value * 100) + '%';
  return (
    (def.step >= 1 ? Math.round(value).toLocaleString() : value.toFixed(2)) +
    (def.unit ? ' ' + def.unit : '')
  );
}

// onApply: 「リセットして適用」時に呼ばれる(全車両を作り直して完全反映)
export function setupParams(onApply: () => void): void {
  const list = document.getElementById('paramList')!;
  for (const def of PARAM_DEFS) {
    if ('group' in def) {
      const groupEl = document.createElement('div');
      groupEl.className = 'pgroup';
      groupEl.textContent = '── ' + def.group;
      list.appendChild(groupEl);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'prow';
    row.innerHTML =
      '<div class="plabel"><span>' +
      def.label +
      '</span>' +
      '<span class="pval" id="pv_' +
      def.key +
      '"></span></div>' +
      '<input type="range" id="pr_' +
      def.key +
      '" min="' +
      def.min +
      '" max="' +
      def.max +
      '" step="' +
      def.step +
      '">' +
      '<div class="pdesc">' +
      def.description +
      '</div>';
    list.appendChild(row);
    const input = row.querySelector('input')!;
    const valueEl = row.querySelector('.pval')!;
    input.value = String(CONST[def.key]);
    valueEl.textContent = formatParam(def, CONST[def.key]);
    input.addEventListener('input', function () {
      const value = parseFloat(input.value);
      CONST[def.key] = value;
      valueEl.textContent = formatParam(def, value);
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
    for (const def of PARAM_DEFS) {
      if (!('key' in def)) continue;
      CONST[def.key] = PARAM_DEFAULTS[def.key];
      (document.getElementById('pr_' + def.key) as HTMLInputElement).value = String(
        PARAM_DEFAULTS[def.key],
      );
      document.getElementById('pv_' + def.key)!.textContent = formatParam(
        def,
        PARAM_DEFAULTS[def.key],
      );
    }
    showMessage('パラメータを既定値に戻しました');
  });
}

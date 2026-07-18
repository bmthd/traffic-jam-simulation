/* ============================================================
   シミュレーションコア: 定数・車両タイプ
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */

/** 比較する2区間。'L' = 義務あり / 'R' = 義務なし */
export type Section = 'L' | 'R';

/** シミュレーションモード。'rules' = ルール比較 / 'absorb' = 渋滞吸収運転 */
export type SimMode = 'rules' | 'absorb';

/* ---------------- 定数 ---------------- */
export const CONST = {
  ROAD_HALF: 400, // 道路は Z = -400 ～ +400
  RAMP_Z_TOP: 380, // 合流ランプ(加速車線)の始点
  RAMP_Z_END: 250, // 加速車線の終端(ここまでに本線へ合流)
  DEMAND_FACTOR: 115000, // 交通需要(生成間隔あたりの基準台数係数)
  MAX_VEHICLES: 280,
  RAMP_QUEUE_MAX: 4, // 入口で流入待ちできる台数の上限(片側)
  RAMP_SHARE: 0.1, // 流入需要のうち合流ランプ経由の割合(残りは上流本線から)
  EXIT_RATIO: 0.08, // 終端の出口で流出する車の割合(残りは環状線のように周回)
  INFLOW_PACE: 10.4, // 生成間隔→流入間隔の換算係数(流出率とつり合う需要に換算)
  MAX_PER_SECTION: 140,
  LANE_X: { L: [-3, -7, -11, -15], R: [3, 7, 11, 15] }, // index 0 = 追い越し(中央寄り), 3 = 加速車線
  LANE_CHANGE_DURATION: 1.4, // 車線変更所要時間 (s)
  LANE_CHANGE_WAIT_MAX_DURATION: 2.6, // 変更待機の上限 (s)
  LANE_CHANGE_RETRY_COOLDOWN: 2.2, // キャンセル後の再試行クールダウン (s)
  OVERTAKE_LANE_RETURN_TIME: 1.8, // 義務あり区間: 追い越し車線からの復帰判定時間 (s)
  NO_DUTY_RETURN_TIME_MIN: 9, // 義務なし区間(一般): 復帰が遅い
  NO_DUTY_RETURN_TIME_MAX: 16,
  CAMPER_RETURN_TIME_MIN: 25, // 義務なし区間(マイペース派): ほぼ戻らない
  CAMPER_RETURN_TIME_MAX: 35,
  CAMPER_RATIO: 0.7, // 義務なし区間: 譲らない人のうちマイペース派の割合
  VOLUNTARY_YIELD_RATIO: 0.15, // 義務なし区間でも自発的に譲る人の割合
  // ---- 加速復帰: 復帰先が並走車に塞がれている時、加速して前に出て戻る ----
  RETURN_BOOST_MAX_SPEED_DIFF: 2.5, // 並走車との速度差がこれ未満なら「加速すれば抜ける」と判断 (m/s)
  RETURN_BOOST_TARGET_CLEARANCE: 35, // 並走車の前方にこれ以上の空きがあれば「前に出れば戻れる」見込みあり (m)
  RETURN_BOOST_AHEAD_CLEARANCE: 30, // 自車線前方にこれ以上の空きがなければ加速しない (m)
  RETURN_BOOST_SPEED_DELTA: 2.5, // 加速復帰中に希望速度へ上乗せする加速量の上限 (m/s)
  RETURN_BOOST_DURATION: 6.0, // 加速して前に出ることを試みる時間 (s)
  RETURN_BOOST_RETRY_COOLDOWN: 8.0, // 加速しても抜けなかった後、再挑戦するまでの間 (s)
  REF_SPEED: 25, // スコア算出の基準速度 (m/s ≒ 90km/h)
  SCORE_W_SPEED: 0.75,
  SCORE_W_DENSITY: 0.25,
  // ---- 渋滞吸収運転モード (mode: 'absorb') ----
  ABSORBER_RATIO: 0.3, // 吸収側区間で渋滞吸収運転をするドライバーの割合
  ABSORBER_HEADWAY: 3.0, // 吸収運転が維持したい車間倍率(波を吸うバッファ)
  ABSORBER_ANTICIPATION: 6.0, // 下流ペース推定: 減速方向の時定数 (s) — 波に乗らない
  ABSORBER_RECOVER: 2.0, // 下流ペース推定: 回復方向の時定数 (s) — 流れ出したら素早く付いていく
  ABSORBER_PACE_BIAS: 1.0, // バッファ構築中はペースより少し遅く走る (m/s)
  HUMAN_GAIN: 0.95, // 通常ドライバーの追従ゲイン(強く反応)
  HUMAN_REACTION: 0.7, // 通常ドライバーの知覚遅れ (s) — 渋滞の波の増幅源
  HUMAN_BRAKE_AMP: 2.6, // 通常ドライバーはブレーキを踏みすぎる(波を増幅)
  HUMAN_ACCEL_LAG: 1.5, // 通常ドライバーの再加速の出遅れ (s) — 渋滞先頭の容量低下源
  SAG_Z_MIN: -10, // サグ部(上り坂)の範囲: 無意識の減速で渋滞の種を作る
  SAG_Z_MAX: 60,
  SAG_SLOWDOWN: 0.82, // サグ部での無意識の減速率(通常ドライバー)
  SAG_SLOWDOWN_ABSORBER: 0.95, // 吸収運転は意識して速度を維持する
  PERTURB_INTERVAL: 45, // 渋滞のきっかけ(よそ見ブレーキ)の発生間隔 (s)
  PERTURB_DURATION: 2.5, // きっかけブレーキの長さ (s)
  PERTURB_FACTOR: 0.3, // きっかけブレーキの強さ(希望速度比) — 左右ミラーで同時注入
  ABSORB_DENSITY_FACTOR: 62400, // absorbモードは準安定領域(約13台/車線)に合わせる
};

/** CONST のうち数値のキー(パラメータ調整室が書き換えてよい対象) */
export type NumericSimParam = {
  [K in keyof typeof CONST]: (typeof CONST)[K] extends number ? K : never;
}[keyof typeof CONST];

/* ---------------- 車両タイプ ---------------- */
export interface VehicleTypeSpec {
  len: number;
  w: number;
  h: number;
  vmin: number;
  vmax: number;
  acc: number;
  colors: number[];
}
export type VehicleTypeName = 'Sedan' | 'Truck' | 'SportsCar' | 'Van';

export const TYPES: Record<VehicleTypeName, VehicleTypeSpec> = {
  Sedan: {
    len: 4.6,
    w: 1.8,
    h: 1.42,
    vmin: 22,
    vmax: 30,
    acc: 6.0,
    colors: [0x3b6fd4, 0xb8bec9, 0x27313f, 0x8c1d2c, 0xe8e6e0],
  },
  Truck: {
    len: 9.2,
    w: 2.5,
    h: 3.5,
    vmin: 15,
    vmax: 21,
    acc: 3.2,
    colors: [0x2e8b57, 0x4a5568, 0x9aa5b1, 0x7c4a1e],
  },
  SportsCar: {
    len: 4.2,
    w: 1.9,
    h: 1.12,
    vmin: 28,
    vmax: 38,
    acc: 9.0,
    colors: [0xd6452c, 0xf2c200, 0x1450c8, 0xff7a00, 0x111418],
  },
  Van: {
    len: 5.4,
    w: 2.0,
    h: 2.15,
    vmin: 18,
    vmax: 25,
    acc: 4.5,
    colors: [0xeeeeee, 0x88a0b8, 0x445566, 0x99c2a2],
  },
};
export const TYPE_WEIGHTS: [VehicleTypeName, number][] = [
  ['Sedan', 0.46],
  ['Van', 0.25],
  ['Truck', 0.11],
  ['SportsCar', 0.18],
];

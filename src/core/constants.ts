/* ============================================================
   シミュレーションコア: 定数・車両タイプ
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */

/** 比較する2区間。'L' = 義務あり / 'R' = 義務なし */
export type Section = 'L' | 'R';

/** シミュレーションモード。'rules' = ルール比較 / 'absorb' = 渋滞吸収運転 */
export type SimMode = 'rules' | 'absorb';

/* ---------------- 区間の横方向レイアウト ----------------
   両区間とも進行方向は -Z(前方 = z が小さい側)なので、進行方向を向いた時の
   「右」は +X 側になる。R区間をL区間の鏡像にすると R の追い越し車線だけが
   左側に来てしまうため、R区間は鏡像ではなく「L区間の平行移動コピー」にする。
   これで両区間とも 追い越し車線 = 右端 / 加速車線 = 左外側 に揃い、
   合流の条件も鏡像ではなく完全に同一になる。 */

/** L区間 → R区間 の平行移動量(この分だけ +X 側にずらす) */
const SECTION_OFFSET_R_X = 17.2;
/** L区間の車線中心X。index 0 = 追い越し(右端) 〜 2 = 走行車線(左端), 3 = 加速車線(左外側) */
const LANE_X_L = [-3, -7, -11, -15];

/* 片側の物理収容台数を、平均的な停止車列として見積もる。
   平均車長 = 4.6×0.46 + 5.4×0.25 + 9.2×0.11 + 4.2×0.18 = 5.234 m
   停止時の車頭間隔 = 車長 + (車長×1.2 + 2.5) = 14.0148 m
   本線 = floor((3264 m×3車線) / 14.0148 m) = 698台
   加速車線 = 8台×4施設 = 32台
   入口待ち = 4台×(本線1入口・ランプ4入口) = 20台
   合計 698 + 32 + 20 = 750台を片側上限とする。 */
const MAX_VEHICLES_PER_SECTION = 750;

/* ---------------- 定数 ---------------- */
export const CONST = {
  ROAD_HALF: 1624, // 道路は Z = -1624 ～ +1624
  RAMP_Z_TOP: 380, // 合流ランプ(加速車線)の始点
  RAMP_Z_END: 250, // 加速車線の終端(ここまでに本線へ合流)
  // 施設上流の出口。進行方向(-Z)に減速車線→分岐→空き→次施設入口と並ぶ。
  EXIT_DECISION_Z: -40, // 分岐200m手前で次施設から退出するか一度だけ決める
  EXIT_LANE_START_Z: -60, // lane 2から共用lane 3へ移り始める減速車線の始点
  EXIT_BRANCH_Z: -240, // lane 3に入れた車だけが退出する分岐
  DEMAND_FACTOR: 115000, // 交通需要(生成間隔あたりの基準台数係数)
  MAX_VEHICLES_PER_SECTION,
  // HUD が表示する両区間の総上限。生成の上限判定には使わない。
  MAX_VEHICLES: MAX_VEHICLES_PER_SECTION * 2,
  RAMP_QUEUE_MAX: 4, // 入口で流入待ちできる台数の上限(片側)
  RAMP_SHARE: 0.1, // 流入需要のうち合流ランプ経由の割合(残りは上流本線から)
  EXIT_RATIO: 0.08, // 施設ごとに次の出口から流出する意思を決める確率
  INFLOW_PACE: 10.4, // 生成間隔→流入間隔の換算係数(流出率とつり合う需要に換算)
  MAX_PER_SECTION: 140, // 車両上限ではなく、渋滞スコアの密度項を正規化・飽和させる基準台数
  // 区間の横方向オフセット(R区間はL区間の鏡像ではなく平行移動コピー)
  SECTION_OFFSET_X: { L: 0, R: SECTION_OFFSET_R_X },
  // 車線の中心X。index 0 = 追い越し(進行方向の右端), 2 = 走行車線(左端), 3 = 加速車線(左外側)
  LANE_X: { L: LANE_X_L, R: LANE_X_L.map((x) => x + SECTION_OFFSET_R_X) },
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
  // ---- 合流(加速車線 lane 3 ⇄ 本線 lane 2)の協調 (Issue #33) ----
  // 加速車線は「止まって待つ」車線ではなく、本線の流れに乗るための車線。
  // 合流車は原則として本線流速まで加速し、本線車は接近する合流車を認識して
  // 可能なら追い越し車線側へ退避し枠を空け、退避できず速度差が小さければ譲る。
  MERGE_STOP_MARGIN: 30, // ランプ終端までこの距離を切った時だけ(未合流なら)終端で止まれる速度に制限する。それより手前では加速車線として本線流速まで加速させ、止まらせない (m)
  MERGE_DETECT_RANGE: 40, // 本線車(lane 2)が加速車線の合流車を認識する縦方向の範囲 (m)。車間サーボの安全距離(≒ speed×0.55)と同オーダーで「視認できる前方」に相当
  MERGE_YIELD_SPEED_DIFF: 5.0, // 合流車と本線車の速度差がこれ未満なら「速度差が小さい」= 合流車を優先して本線車が譲る (m/s ≒ 18km/h)。加速車線1本ぶんの加速で埋められる差であり、車線変更安全判定が前方車を「+1で速い」とみなす幅より広く取った実用値
  MERGE_POINT_Z: 278,
  GORE_Z_START: 258,
  GORE_Z_END: 242,
  GORE_OUTER_X: -16.7,
  GORE_MAIN_X: -13,
  MERGE_CONGESTION_TIME_CONSTANT: 1,
  MERGE_FREE_FRONT_HEADWAY: 1.4,
  MERGE_FREE_REAR_HEADWAY: 1.6,
  MERGE_CONGESTED_HEADWAY: 0.8,
  MERGE_TARGET_COOP_DECEL: 1.2,
  MERGE_MAX_COOP_DECEL: 3,
  MERGE_BODY_CLEARANCE: 2,
  MERGE_TRANSACTION_CLOSURE_MAX: 24,
  MERGE_TRANSACTION_MIN_SPEED: 1,
  REF_SPEED: 25, // スコア算出の基準速度 (m/s ≒ 90km/h)
  SCORE_WEIGHT_SPEED: 0.75,
  SCORE_WEIGHT_DENSITY: 0.25,
  // ---- 「こちらがスムーズ」判定 (Issue #26) ----
  // スコア差がこれ以下なら引き分け扱いにするデッドゾーン。
  // 車線変更や1台のブレーキで左右のスコアは数ポイント揺れるため、
  // 素の大小比較だと毎フレーム優勢側が入れ替わり累積時間が意味を成さない。
  // HUD の王冠(こちらがスムーズ)が元から使っていた閾値 5 に揃え、
  // 「王冠が出ている側 = 累積時間が伸びる側」を一致させる
  SMOOTH_SCORE_DEADZONE: 5,
  SMOOTH_MIN_COUNT: 5, // 判定に必要な最低台数(片側)。立ち上がり直後のスコアは不安定なため
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
  ABSORB_DENSITY_FACTOR: 249600, // 4倍の周長でも準安定領域(約13台/車線)の密度を保つ
};

// 周回路(リング)の全長。車両の終端判定にある前後8mを含む。
// 施設間隔などの定数から参照するため、循環を避けてこのモジュールを定義元にする。
export const WRAP_LENGTH = CONST.ROAD_HALF * 2 + 16;
export const FACILITY_SPACING = WRAP_LENGTH / 4;
export type FacilityKind = 'IC' | 'PA';
export const FACILITIES: ReadonlyArray<{
  readonly index: number;
  readonly kind: FacilityKind;
  readonly offsetZ: number;
}> = Object.freeze(
  [0, 1, 2, 3].map((index) =>
    Object.freeze({
      index,
      kind: index % 2 === 0 ? ('IC' as const) : ('PA' as const),
      offsetZ: index === 0 ? 0 : -index * FACILITY_SPACING,
    }),
  ),
);

/** 周回上のzを、直前の施設を基準にした施設0互換のローカルzへ写す。 */
export function toFacilityLocalZ(z: number): number {
  const distanceFromEntry = CONST.RAMP_Z_TOP - z;
  return (
    CONST.RAMP_Z_TOP -
    (((distanceFromEntry % FACILITY_SPACING) + FACILITY_SPACING) % FACILITY_SPACING)
  );
}

/** 参照位置と同じ施設にあるローカルzを、周回上の実zへ戻す。 */
export function facilityWorldZ(localZ: number, referenceZ: number): number {
  return referenceZ - toFacilityLocalZ(referenceZ) + localZ;
}

/** 進行方向(-Z)で次に到達する施設のローカルzを、周回上の実zで返す。 */
export function nextFacilityWorldZ(localZ: number, z: number): number {
  const currentFacilityZ = facilityWorldZ(localZ, z);
  return currentFacilityZ < z ? currentFacilityZ : currentFacilityZ - FACILITY_SPACING;
}

/** 周回上の位置が属する施設番号を返す。 */
export function facilityIndexForZ(z: number): number {
  const offset = z - toFacilityLocalZ(z);
  const rawIndex = Math.round(-offset / FACILITY_SPACING);
  return ((rawIndex % FACILITIES.length) + FACILITIES.length) % FACILITIES.length;
}

/** 加速車線終端の導流帯。座標はL区間を基準にする。 */
export interface GoreGeometry {
  readonly startZ: number;
  readonly endZ: number;
  readonly outerX: number;
  readonly mainX: number;
}

/** コアの安全判定と描画で共有する合流ランプの不変座標。 */
export const RAMP_GEOMETRY: Readonly<{ entryZ: number; gore: GoreGeometry }> = Object.freeze({
  entryZ: CONST.RAMP_Z_TOP,
  gore: Object.freeze({
    startZ: CONST.GORE_Z_START,
    endZ: CONST.GORE_Z_END,
    outerX: CONST.GORE_OUTER_X,
    mainX: CONST.GORE_MAIN_X,
  }),
});

/** 区間の実座標を、共有するL区間基準のトラック座標へ戻す。 */
export function sectionTrackX(section: Section, worldX: number): number {
  return worldX - CONST.SECTION_OFFSET_X[section];
}

interface TrackPoint {
  x: number;
  z: number;
}

function polygonsOverlap(first: readonly TrackPoint[], second: readonly TrackPoint[]): boolean {
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index++) {
      const current = polygon[index];
      const next = polygon[(index + 1) % polygon.length];
      const axisX = -(next.z - current.z);
      const axisZ = next.x - current.x;
      let firstMin = Infinity,
        firstMax = -Infinity,
        secondMin = Infinity,
        secondMax = -Infinity;
      for (const point of first) {
        const projection = point.x * axisX + point.z * axisZ;
        firstMin = Math.min(firstMin, projection);
        firstMax = Math.max(firstMax, projection);
      }
      for (const point of second) {
        const projection = point.x * axisX + point.z * axisZ;
        secondMin = Math.min(secondMin, projection);
        secondMax = Math.max(secondMax, projection);
      }
      if (firstMax < secondMin || secondMax < firstMin) return false;
    }
  }
  return true;
}

/** 加速車線上の車体矩形が、導流帯三角形と接するかを判定する。 */
export function rampBodyIntersectsGore(
  centerXInTrack: number,
  centerZ: number,
  width: number,
  length: number,
): boolean {
  const { gore } = RAMP_GEOMETRY;
  centerZ = toFacilityLocalZ(centerZ);
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const body = [
    { x: centerXInTrack - halfWidth, z: centerZ - halfLength },
    { x: centerXInTrack + halfWidth, z: centerZ - halfLength },
    { x: centerXInTrack + halfWidth, z: centerZ + halfLength },
    { x: centerXInTrack - halfWidth, z: centerZ + halfLength },
  ];
  const goreTriangle = [
    { x: gore.outerX, z: gore.startZ },
    { x: gore.mainX, z: gore.startZ },
    { x: gore.mainX, z: gore.endZ },
  ];
  return polygonsOverlap(body, goreTriangle);
}

/** CONST のうち数値のキー(パラメータ調整室が書き換えてよい対象) */
export type NumericSimParam = {
  [K in keyof typeof CONST]: (typeof CONST)[K] extends number ? K : never;
}[keyof typeof CONST];

/* ---------------- 車両タイプ ---------------- */
export interface VehicleTypeSpec {
  length: number;
  width: number;
  height: number;
  minSpeed: number;
  maxSpeed: number;
  acceleration: number;
  colors: number[];
}
export type VehicleTypeName = 'Sedan' | 'Truck' | 'SportsCar' | 'Van';

export const TYPES: Record<VehicleTypeName, VehicleTypeSpec> = {
  Sedan: {
    length: 4.6,
    width: 1.8,
    height: 1.42,
    minSpeed: 22,
    maxSpeed: 30,
    acceleration: 6.0,
    colors: [0x3b6fd4, 0xb8bec9, 0x27313f, 0x8c1d2c, 0xe8e6e0],
  },
  Truck: {
    length: 9.2,
    width: 2.5,
    height: 3.5,
    minSpeed: 15,
    maxSpeed: 21,
    acceleration: 3.2,
    colors: [0x2e8b57, 0x4a5568, 0x9aa5b1, 0x7c4a1e],
  },
  SportsCar: {
    length: 4.2,
    width: 1.9,
    height: 1.12,
    minSpeed: 28,
    maxSpeed: 38,
    acceleration: 9.0,
    colors: [0xd6452c, 0xf2c200, 0x1450c8, 0xff7a00, 0x111418],
  },
  Van: {
    length: 5.4,
    width: 2.0,
    height: 2.15,
    minSpeed: 18,
    maxSpeed: 25,
    acceleration: 4.5,
    colors: [0xeeeeee, 0x88a0b8, 0x445566, 0x99c2a2],
  },
};
export const TYPE_WEIGHTS: [VehicleTypeName, number][] = [
  ['Sedan', 0.46],
  ['Van', 0.25],
  ['Truck', 0.11],
  ['SportsCar', 0.18],
];

/* ============================================================
   シミュレーションコア: ワールド（車両生成・時間発展・スコア）
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import { CONST, TYPES, TYPE_WEIGHTS } from './constants.js';
import { clamp, wrapDelta, WRAP } from './utils.js';
import { Vehicle } from './vehicle.js';

export class World {
  constructor(opts){
    opts = opts || {};
    this.rng = opts.rng || Math.random;
    this.mode = opts.mode || 'rules';   // 'rules' = ルール比較 / 'absorb' = 渋滞吸収運転
    this.spawnInterval = opts.spawnInterval != null ? opts.spawnInterval : 800;
    this.vehicles = [];
    this.spawnAccum = 0;
    this.time = 0;
    this._sec = { L: [], R: [] };
    this.stats = { changes: { L: 0, R: 0 }, yields: { L: 0, R: 0 }, cancels: { L: 0, R: 0 } };
  }

  pickType(){
    // absorbモード: 車種を統一(円周実験と同条件)。車長の違いが車線ごとの
    // 実効密度を準安定帯域から外し、波の比較を濁すのを防ぐ
    if (this.mode === 'absorb') return 'Sedan';
    let r = this.rng();
    for (const [name, w] of TYPE_WEIGHTS) { if ((r -= w) <= 0) return name; }
    return 'Sedan';
  }

  // 生成間隔から目標車両数を導出する。
  // 道路はループ構造で車両が退出しないため、無条件に流入を続けると
  // どんな間隔でも最終的に飽和渋滞になり左右のルール差が消えてしまう。
  // そこで「間隔が短い = 交通需要が多い」と解釈し、間隔に応じた密度を維持する。
  targetCount(){
    const factor = this.mode === 'absorb' ? CONST.ABSORB_DENSITY_FACTOR : CONST.DEMAND_FACTOR;
    return clamp(Math.round(factor / this.spawnInterval / 2) * 2, 24, CONST.MAX_VEHICLES);
  }

  isSpawnClear(section, lane, z, exclude){
    for (const v of this.vehicles) {
      if (v === exclude || v.waiting || v.section !== section || !v.occupies(lane)) continue;
      if (Math.abs(wrapDelta(v.z - z)) < 15 + v.length) return false;
    }
    return true;
  }

  // 指定地点から見た直近前方車の車間と速度(スポーン時の安全速度算出用・周回対応)
  aheadInfo(section, lane, z, len, exclude){
    let best = null, bestD = Infinity;
    for (const v of this.vehicles) {
      if (v === exclude || v.waiting || v.section !== section || !v.occupies(lane)) continue;
      let d = z - v.z; // 前方 = z が小さい側。周回を考慮して正の最短距離に
      d = ((d % WRAP) + WRAP) % WRAP;
      if (d < 0.001) continue;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (!best) return null;
    return { gap: bestD - (len + best.length) / 2, speed: best.speed };
  }

  // 車間内で物理的に止まれる速度に丸める(渋滞の列がスポーン地点まで伸びた場合の追突防止)
  safeSpawnSpeed(section, lane, z, len, wantSpeed, exclude){
    const info = this.aheadInfo(section, lane, z, len, exclude);
    if (!info) return wantSpeed;
    const vmax = info.speed + Math.sqrt(Math.max(0, 2 * 7 * (info.gap - 4)));
    return clamp(Math.min(wantSpeed, vmax), 0, wantSpeed);
  }

  // 車両は左右に1台ずつ、同タイプ・同初期速度のペアで生成される
  spawnPair(){
    if (this.vehicles.length >= Math.min(CONST.MAX_VEHICLES, this.targetCount()) - 1) return false;
    const typeName = this.pickType();
    const t = TYPES[typeName];
    let speed = t.vmin + this.rng() * (t.vmax - t.vmin);
    // 飛ばし屋: ごく一部、流れより明確に速い車がいる(両区間に同条件で出現)
    if ((typeName === 'Sedan' || typeName === 'SportsCar') && this.rng() < 0.05) {
      speed = Math.max(speed, 32 + this.rng() * 4); // 希望速度 ≒ 115〜130km/h
    }
    // absorbモードでは左右のレーン配置をミラー、かつラウンドロビンで均等にする
    // (車線変更がないため、各車線を準安定密度の帯域に揃える)
    // rulesモードは加速車線(レーン3)の始点から流入し、本線へ合流して入る
    const laneL = this.mode === 'absorb'
      ? (this._laneRR = ((this._laneRR || 0) + 1) % 3)
      : 3;
    const laneR = this.mode === 'absorb' ? laneL : 3;
    const z = this.mode === 'absorb' ? CONST.ROAD_HALF + t.len : CONST.RAMP_Z_TOP;
    if (!this.isSpawnClear('L', laneL, z, null) || !this.isSpawnClear('R', laneR, z, null)) return false;
    const vL = new Vehicle(this, 'L', laneL, z, typeName, speed);
    const vR = new Vehicle(this, 'R', laneR, z, typeName, speed);
    vL.speed = this.safeSpawnSpeed('L', laneL, z, vL.length, vL.speed, null);
    vR.speed = this.safeSpawnSpeed('R', laneR, z, vR.length, vR.speed, null);
    this.vehicles.push(vL, vR);
    return true;
  }

  // 最大車両数の約12%をペアでランダム配置
  populateInitial(){
    // 目標台数の7割を最初から本線に配置する(流入は残りをランプから)。
    // こうしないと混雑側のランプ詰まりが両側の流入を絞り、比較が成立しない
    const pairs = Math.round(this.targetCount() * 0.7 / 2);
    for (let i = 0; i < pairs; i++) {
      for (let tries = 0; tries < 50; tries++) {
        const typeName = this.pickType();
        const t = TYPES[typeName];
        let speed = t.vmin + this.rng() * (t.vmax - t.vmin);
        if ((typeName === 'Sedan' || typeName === 'SportsCar') && this.rng() < 0.05) {
          speed = Math.max(speed, 32 + this.rng() * 4); // 飛ばし屋
        }
        const z = -CONST.ROAD_HALF + 25 + this.rng() * (CONST.ROAD_HALF * 2 - 40);
        const laneL = this.mode === 'absorb'
          ? (this._laneRR = ((this._laneRR || 0) + 1) % 3)
          : Math.floor(this.rng() * 3);
        const laneR = this.mode === 'absorb' ? laneL : Math.floor(this.rng() * 3);
        if (this.isSpawnClear('L', laneL, z, null) && this.isSpawnClear('R', laneR, z, null)) {
          this.vehicles.push(new Vehicle(this, 'L', laneL, z, typeName, speed));
          this.vehicles.push(new Vehicle(this, 'R', laneR, z, typeName, speed));
          break;
        }
      }
    }
  }

  reset(){
    this.vehicles.length = 0;
    this.spawnAccum = 0;
    this.time = 0;
    this.populateInitial();
  }

  _rebuildIndex(){
    const L = [], R = [];
    for (const v of this.vehicles) if (!v.waiting) (v.section === 'L' ? L : R).push(v);
    L.sort((a, b) => a.z - b.z);
    R.sort((a, b) => a.z - b.z);
    for (let i = 0; i < L.length; i++) L[i]._idx = i;
    for (let i = 0; i < R.length; i++) R[i]._idx = i;
    this._sec.L = L;
    this._sec.R = R;
  }

  step(dt){
    this.time += dt;
    this.spawnAccum += dt * 1000;
    if (this.spawnAccum >= this.spawnInterval) {
      if (this.spawnPair()) this.spawnAccum = 0;
      else this.spawnAccum = Math.max(0, this.spawnInterval - 200); // 塞がっていれば少し待つ
    }
    // absorbモード: 渋滞のきっかけ(よそ見ブレーキ)を左右のミラーペアに同時注入。
    // 同じきっかけが、通常側では波に育ち、吸収側では吸収されて消えるのを比較する
    if (this.mode === 'absorb') {
      if (this.perturbT == null) this.perturbT = 15;
      this.perturbT -= dt;
      if (this.perturbT <= 0) {
        this.perturbT = CONST.PERTURB_INTERVAL;
        const pairs = [];
        for (let i = 0; i + 1 < this.vehicles.length; i += 2) {
          const a = this.vehicles[i], b = this.vehicles[i + 1];
          if (a.section === 'L' && b.section === 'R' && !a.waiting && !b.waiting) pairs.push([a, b]);
        }
        if (pairs.length) {
          const [a, b] = pairs[Math.floor(this.rng() * pairs.length)];
          a.perturbT = CONST.PERTURB_DURATION;
          b.perturbT = CONST.PERTURB_DURATION;
        }
      }
    }
    this._rebuildIndex();
    for (const v of this.vehicles) v.update(dt);
  }

  // 渋滞スコア: 平均速度(重み75%) + 密度(重み25%) → 0～100
  computeSection(section){
    let n = 0, sum = 0;
    for (const v of this.vehicles) {
      if (v.section !== section) continue;
      n++;
      // 待機車 = 入口まで伸びた渋滞最後尾の見えない延長。速度0として計上しないと
      // 「渋滞がひどい区間ほど待機に逃げてスコアが良くなる」という嘘になる
      sum += v.waiting ? 0 : v.speed;
    }
    if (n === 0) return { n: 0, avg: 0, score: 0 };
    const avg = sum / n;
    const speedFactor = clamp(1 - avg / CONST.REF_SPEED, 0, 1);
    const densityFactor = clamp(n / CONST.MAX_PER_SECTION, 0, 1);
    return { n, avg, score: (CONST.SCORE_W_SPEED * speedFactor + CONST.SCORE_W_DENSITY * densityFactor) * 100 };
  }
}

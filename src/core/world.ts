/* ============================================================
   シミュレーションコア: ワールド（車両生成・時間発展・スコア）
   （DOM / THREE 非依存・テスト対象）
   ============================================================ */
import { CONST, TYPES, TYPE_WEIGHTS } from './constants';
import type { Section, SimMode, VehicleTypeName } from './constants';
import { clamp, wrapDelta, WRAP } from './utils';
import type { Rng } from './utils';
import { Vehicle } from './vehicle';

export interface WorldOptions {
  rng?: Rng;
  mode?: SimMode;
  spawnInterval?: number;
}

export interface SectionStats {
  n: number;
  avg: number;
  score: number;
}

export class World {
  rng: Rng;
  mode: SimMode;
  spawnInterval: number;
  vehicles: Vehicle[];
  spawnAccum: number;
  time: number;
  _sec: Record<Section, Vehicle[]>;
  stats: {
    changes: Record<Section, number>;
    yields: Record<Section, number>;
    cancels: Record<Section, number>;
    inflow: Record<Section, number>; // 流入した台数(入口待ち含む)
    outflow: Record<Section, number>; // 出口から捌けた台数
  };
  _absRR: number[] | null = null; // absorbモード: 吸収運転車を等間隔に混ぜるカウンタ
  _laneRR = 0; // absorbモード: レーン割当のラウンドロビン
  perturbT: number | null = null; // absorbモード: 次のよそ見ブレーキまでの残り時間

  constructor(opts: WorldOptions = {}) {
    this.rng = opts.rng || Math.random;
    this.mode = opts.mode || 'rules'; // 'rules' = ルール比較 / 'absorb' = 渋滞吸収運転
    this.spawnInterval = opts.spawnInterval != null ? opts.spawnInterval : 800;
    this.vehicles = [];
    this.spawnAccum = 0;
    this.time = 0;
    this._sec = { L: [], R: [] };
    this.stats = {
      changes: { L: 0, R: 0 },
      yields: { L: 0, R: 0 },
      cancels: { L: 0, R: 0 },
      inflow: { L: 0, R: 0 },
      outflow: { L: 0, R: 0 },
    };
  }

  pickType(): VehicleTypeName {
    // absorbモード: 車種を統一(円周実験と同条件)。車長の違いが車線ごとの
    // 実効密度を準安定帯域から外し、波の比較を濁すのを防ぐ
    if (this.mode === 'absorb') return 'Sedan';
    let r = this.rng();
    for (const [name, w] of TYPE_WEIGHTS) {
      if ((r -= w) <= 0) return name;
    }
    return 'Sedan';
  }

  // 生成間隔から基準車両数を導出する(「間隔が短い = 交通需要が多い」)。
  // rulesモード: 都市高速の流入調整(ランプメータリング)と同じく、本線上の
  // 台数がこの値(片側はこの半分)を超えないよう入口で流入を待たせる。
  // 待たされた車は入口待ち(waiting)として台数・スコアに計上される。
  // absorbモード: 円周実験(車両は退出しない)なので、この値を上限として
  // 間隔に応じた密度を維持する。
  targetCount(): number {
    const factor = this.mode === 'absorb' ? CONST.ABSORB_DENSITY_FACTOR : CONST.DEMAND_FACTOR;
    return clamp(Math.round(factor / this.spawnInterval / 2) * 2, 24, CONST.MAX_VEHICLES);
  }

  isSpawnClear(section: Section, lane: number, z: number, exclude: Vehicle | null): boolean {
    for (const v of this.vehicles) {
      if (v === exclude || v.waiting || v.section !== section || !v.occupies(lane)) continue;
      if (Math.abs(wrapDelta(v.z - z)) < 15 + v.length) return false;
    }
    return true;
  }

  // 指定地点から見た直近前方車の車間と速度(スポーン時の安全速度算出用・周回対応)
  aheadInfo(
    section: Section,
    lane: number,
    z: number,
    len: number,
    exclude: Vehicle | null,
  ): { gap: number; speed: number } | null {
    let best: Vehicle | null = null,
      bestD = Infinity;
    for (const v of this.vehicles) {
      if (v === exclude || v.waiting || v.section !== section || !v.occupies(lane)) continue;
      let d = z - v.z; // 前方 = z が小さい側。周回を考慮して正の最短距離に
      d = ((d % WRAP) + WRAP) % WRAP;
      if (d < 0.001) continue;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (!best) return null;
    return { gap: bestD - (len + best.length) / 2, speed: best.speed };
  }

  // 車間内で物理的に止まれる速度に丸める(渋滞の列がスポーン地点まで伸びた場合の追突防止)
  safeSpawnSpeed(
    section: Section,
    lane: number,
    z: number,
    len: number,
    wantSpeed: number,
    exclude: Vehicle | null,
  ): number {
    const info = this.aheadInfo(section, lane, z, len, exclude);
    if (!info) return wantSpeed;
    const vmax = info.speed + Math.sqrt(Math.max(0, 2 * 7 * (info.gap - 4)));
    return clamp(Math.min(wantSpeed, vmax), 0, wantSpeed);
  }

  // 本線上(入口待ちを除く)の台数
  roadCount(section: Section): number {
    let n = 0;
    for (const v of this.vehicles) if (!v.waiting && v.section === section) n++;
    return n;
  }

  // その側の入口が今受け入れ可能か(流入調整の枠内 かつ 入口が物理的に空いている)
  // 空いているレーンを返す。受け入れ不可なら null
  admissibleLane(section: Section, lanes: number[], z: number): number | null {
    if (this.roadCount(section) >= this.targetCount() / 2) return null; // 流入調整
    const lane = lanes.find((l) => this.isSpawnClear(section, l, z, null));
    return lane != null ? lane : null;
  }

  // 車両は左右に1台ずつ、同タイプ・同初期速度のペアで「流入しようと」する。
  // 流入需要(追加ペース)は左右で完全に同一だが、実際に道路へ入れるか・
  // いつ捌けるかは各道路の交通状況に従う — ここが Issue #12 の核心。
  // 混んでいる側は出口まで到達する車が少なく流出が遅れるため、入口で
  // 受け入れられず滞留し、道路全体(入口待ち含む)の台数が自然に増える。
  //
  // rulesモード: 各側は独立に流入する。受け入れ可能ならそのまま流入し、
  // 塞がっていれば入口待ち(waiting)の列に並ぶ。
  // 待機列まで溢れている側だけ、その1台の流入を諦める(入口渋滞の敬遠)。
  // absorbモード(円周実験): 従来通り、両側同時に置ける時だけミラー配置する。
  spawnPair(): boolean {
    if (this.mode === 'absorb') {
      if (this.vehicles.length >= Math.min(CONST.MAX_VEHICLES, this.targetCount()) - 1)
        return false;
      const typeName = this.pickType();
      const t = TYPES[typeName];
      const speed = t.vmin + this.rng() * (t.vmax - t.vmin);
      // 左右のレーン配置をミラー、かつラウンドロビンで均等にする
      // (車線変更がないため、各車線を準安定密度の帯域に揃える)
      const lane = (this._laneRR = (this._laneRR + 1) % 3);
      const z = CONST.ROAD_HALF + t.len;
      if (!this.isSpawnClear('L', lane, z, null) || !this.isSpawnClear('R', lane, z, null))
        return false;
      const vL = new Vehicle(this, 'L', lane, z, typeName, speed);
      const vR = new Vehicle(this, 'R', lane, z, typeName, speed);
      vL.speed = this.safeSpawnSpeed('L', lane, z, vL.length, vL.speed, null);
      vR.speed = this.safeSpawnSpeed('R', lane, z, vR.length, vR.speed, null);
      this.vehicles.push(vL, vR);
      this.stats.inflow.L++;
      this.stats.inflow.R++;
      return true;
    }
    // rulesモード: 需要の大半は上流本線(レーン0〜2の始端)から、残りは
    // 合流ランプ(レーン3)から入る。入口条件は左右で完全に同一にする
    if (this.vehicles.length >= CONST.MAX_VEHICLES - 1) return false;
    const typeName = this.pickType();
    const t = TYPES[typeName];
    let speed = t.vmin + this.rng() * (t.vmax - t.vmin);
    // 飛ばし屋: ごく一部、流れより明確に速い車がいる(両区間に同条件で出現)
    if ((typeName === 'Sedan' || typeName === 'SportsCar') && this.rng() < 0.05) {
      speed = Math.max(speed, 32 + this.rng() * 4); // 希望速度 ≒ 115〜130km/h
    }
    const viaRamp = this.rng() < CONST.RAMP_SHARE;
    const pref = viaRamp ? 3 : Math.floor(this.rng() * 3);
    // 本線流入は空いているレーンを選んで入る(上流から来る車は自然に分散する)。
    // 候補の優先順は左右で同一にし、どのレーンに入れるかだけ各道路の状況に従う
    const lanes = viaRamp ? [3] : [pref, (pref + 1) % 3, (pref + 2) % 3];
    const z = viaRamp ? CONST.RAMP_Z_TOP : CONST.ROAD_HALF + t.len;
    let added = false;
    for (const section of ['L', 'R'] as const) {
      if (this.waitingCount(section) >= CONST.RAMP_QUEUE_MAX) continue;
      const lane = this.admissibleLane(section, lanes, z);
      const v = new Vehicle(this, section, lane != null ? lane : pref, z, typeName, speed);
      if (lane != null) {
        v.speed = this.safeSpawnSpeed(section, lane, z, v.length, v.speed, null);
      } else {
        v.waiting = true; // 入口が塞がっている → 手前で待つ(見えない上流の滞留)
      }
      this.vehicles.push(v);
      this.stats.inflow[section]++;
      added = true;
    }
    return added;
  }

  waitingCount(section: Section): number {
    let n = 0;
    for (const v of this.vehicles) if (v.waiting && v.section === section) n++;
    return n;
  }

  // 入口待ちの車を、受け入れ可能になり次第(各側1台/ステップ)流入させる。
  // ランプ待ちはランプへ、本線待ちは空いている本線レーンへ入る。
  // 待ち行列からの発進なので、初速は控えめ + 前方に対して安全な速度に丸める
  admitWaiting(): void {
    for (const section of ['L', 'R'] as const) {
      const v = this.vehicles.find((v) => v.waiting && v.section === section); // 挿入順 = FIFO
      if (!v) continue;
      const lanes = v.lane === 3 ? [3] : [v.lane, 0, 1, 2].filter((l, i, a) => a.indexOf(l) === i);
      const lane = this.admissibleLane(section, lanes, v.z);
      if (lane == null) continue;
      v.waiting = false;
      v.lane = lane;
      v.x = CONST.LANE_X[section][lane];
      v.speed = this.safeSpawnSpeed(
        section,
        lane,
        v.z,
        v.length,
        Math.min(v.desiredSpeed * 0.6, 14),
        v,
      );
    }
  }

  // 出口まで走り切った車を流出させる(rulesモードのみ。absorbは周回で退出しない)
  collectExited(): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (v.exited) {
        this.stats.outflow[v.section]++;
        this.vehicles.splice(i, 1);
      }
    }
  }

  populateInitial(): void {
    // 基準台数ぶんを最初から本線に配置する(ウォームスタート)。
    // 以降の台数は「同じペースの流入」と「各道路の交通状況に応じた流出」の
    // つり合いで決まり、混んでいる側は捌けずに自然に台数が増えていく
    const pairs = Math.round(this.targetCount() / 2);
    for (let i = 0; i < pairs; i++) {
      for (let tries = 0; tries < 50; tries++) {
        const typeName = this.pickType();
        const t = TYPES[typeName];
        let speed = t.vmin + this.rng() * (t.vmax - t.vmin);
        if ((typeName === 'Sedan' || typeName === 'SportsCar') && this.rng() < 0.05) {
          speed = Math.max(speed, 32 + this.rng() * 4); // 飛ばし屋
        }
        const z = -CONST.ROAD_HALF + 25 + this.rng() * (CONST.ROAD_HALF * 2 - 40);
        const laneL =
          this.mode === 'absorb'
            ? (this._laneRR = (this._laneRR + 1) % 3)
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

  reset(): void {
    this.vehicles.length = 0;
    this.spawnAccum = 0;
    this.time = 0;
    this.populateInitial();
  }

  _rebuildIndex(): void {
    const L: Vehicle[] = [],
      R: Vehicle[] = [];
    for (const v of this.vehicles) if (!v.waiting) (v.section === 'L' ? L : R).push(v);
    L.sort((a, b) => a.z - b.z);
    R.sort((a, b) => a.z - b.z);
    for (let i = 0; i < L.length; i++) L[i]._idx = i;
    for (let i = 0; i < R.length; i++) R[i]._idx = i;
    this._sec.L = L;
    this._sec.R = R;
  }

  step(dt: number): void {
    this.time += dt;
    this.spawnAccum += dt * 1000;
    // rulesモードの流入間隔は、終端で流出する分(EXIT_RATIO)とつり合う需要に換算する。
    // 「間隔が短い = 交通需要が多い」の意味は従来通り(密度は間隔に反比例)
    const pace =
      this.mode === 'absorb' ? this.spawnInterval : this.spawnInterval * CONST.INFLOW_PACE;
    if (this.spawnAccum >= pace) {
      if (this.spawnPair()) this.spawnAccum = 0;
      else this.spawnAccum = Math.max(0, pace - 200); // 塞がっていれば少し待つ
    }
    // absorbモード: 渋滞のきっかけ(よそ見ブレーキ)を左右のミラーペアに同時注入。
    // 同じきっかけが、通常側では波に育ち、吸収側では吸収されて消えるのを比較する
    if (this.mode === 'absorb') {
      if (this.perturbT == null) this.perturbT = 15;
      this.perturbT -= dt;
      if (this.perturbT <= 0) {
        this.perturbT = CONST.PERTURB_INTERVAL;
        const pairs: [Vehicle, Vehicle][] = [];
        for (let i = 0; i + 1 < this.vehicles.length; i += 2) {
          const a = this.vehicles[i],
            b = this.vehicles[i + 1];
          if (a.section === 'L' && b.section === 'R' && !a.waiting && !b.waiting)
            pairs.push([a, b]);
        }
        if (pairs.length) {
          const [a, b] = pairs[Math.floor(this.rng() * pairs.length)];
          a.perturbT = CONST.PERTURB_DURATION;
          b.perturbT = CONST.PERTURB_DURATION;
        }
      }
    }
    // rulesモード: 入口待ちの車を、入口が空き次第流入させる
    if (this.mode !== 'absorb') this.admitWaiting();
    this._rebuildIndex();
    for (const v of this.vehicles) if (!v.waiting) v.update(dt);
    // rulesモード: 出口まで走り切った車は流出する(捌けた分だけ出る)
    if (this.mode !== 'absorb') this.collectExited();
  }

  // 渋滞スコア: 平均速度(重み75%) + 密度(重み25%) → 0～100
  // 台数 n は入口待ちも含む。流入ペースが同じでも、混んでいる側は捌けずに
  // 台数が増える(滞留する)ため、密度項がその滞留をスコアに反映する
  computeSection(section: Section): SectionStats {
    let n = 0,
      sum = 0;
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
    return {
      n,
      avg,
      score: (CONST.SCORE_W_SPEED * speedFactor + CONST.SCORE_W_DENSITY * densityFactor) * 100,
    };
  }
}

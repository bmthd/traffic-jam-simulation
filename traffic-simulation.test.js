#!/usr/bin/env node
/**
 * 6車線比較 渋滞シミュレーション テスト
 *
 * index.html 内の <script id="sim-core"> ブロック
 * （DOM / THREE 非依存のシミュレーションロジック）を抽出して検証する。
 *
 * 実行方法:  node traffic-simulation.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- sim-core の読み込み ---------- */
const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/<script id="sim-core">([\s\S]*?)<\/script>/);
if (!m) { console.error('sim-core ブロックが見つかりません'); process.exit(1); }
const ctx = vm.createContext({});
vm.runInContext(m[1], ctx, { filename: 'sim-core.js' });
const SimCore = ctx.SimCore;
const { World, Vehicle, createRng, CONST } = SimCore;

/* ---------- 簡易テストランナー ---------- */
let passed = 0, failed = 0;
function test(name, fn){
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     → ${e.message}`); }
}
function assert(cond, msg){ if (!cond) throw new Error(msg); }
function approx(a, b, eps, msg){ if (Math.abs(a - b) > eps) throw new Error(`${msg} (got ${a}, want ${b}±${eps})`); }

/* ---------- ヘルパー: シナリオ実行 ---------- */
const DT = 1 / 20;
function runScenario(seed, opts){
  opts = opts || {};
  const seconds = opts.seconds || 300;
  const measureFrom = opts.measureFrom || 120;
  const w = new World({ rng: createRng(seed), spawnInterval: opts.interval || 800 });
  w.populateInitial();
  let sumL = 0, sumR = 0, samples = 0, minGap = Infinity;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    w.step(DT);
    const t = i * DT;
    if (i % 10 === 0) {
      // 貫通チェック（同一車線・車線変更中でない車両同士）
      for (const sec of ['L', 'R']) {
        const arr = w._sec[sec];
        for (let k = 1; k < arr.length; k++) {
          const a = arr[k - 1], b = arr[k];
          if (a.lc.state !== 'none' || b.lc.state !== 'none') continue;
          if (a.lane !== b.lane) continue;
          const gap = Math.abs(b.z - a.z) - (a.length + b.length) / 2;
          if (gap < minGap) minGap = gap;
        }
      }
      if (t >= measureFrom) {
        sumL += w.computeSection('L').score;
        sumR += w.computeSection('R').score;
        samples++;
      }
    }
  }
  return { L: sumL / samples, R: sumR / samples, minGap, world: w };
}

/* ============================================================
   1. メイン要件: 渋滞スコアに約10ポイントの差が出ること
   人間らしい運転モデル(ブレーキ連鎖・渋滞波)導入後は渋滞が準安定
   状態を持つため、シードごとの差は±4〜5程度ゆらぐ。個別シードは
   10±4.5、5シード平均は10±2で判定する。
   ============================================================ */
console.log('\n■ 渋滞スコア差（義務あり vs 義務なし）');
const SEEDS = [11, 22, 33, 44, 55];
const DIFF_TARGET = 10, DIFF_TOL = 4.5;
const results = [];
for (const seed of SEEDS) {
  const r = runScenario(seed);
  results.push({ seed, ...r });
}
for (const r of results) {
  const diff = Math.round((r.R - r.L) * 10) / 10; // 表示と同じ精度で判定する
  test(`seed=${r.seed}: 義務なし側のスコアが約10ポイント高い ` +
       `(義務あり ${r.L.toFixed(1)} / 義務なし ${r.R.toFixed(1)} → 差 ${diff.toFixed(1)})`,
    () => {
      assert(r.R > r.L, `義務なし側の方が渋滞するはずが逆転 (L=${r.L.toFixed(1)}, R=${r.R.toFixed(1)})`);
      assert(Math.abs(diff - DIFF_TARGET) <= DIFF_TOL,
        `スコア差 ${diff.toFixed(1)} が目標 ${DIFF_TARGET}±${DIFF_TOL} の範囲外`);
    });
}
{
  const avg = results.reduce((s, r) => s + (r.R - r.L), 0) / results.length;
  test(`5シード平均のスコア差が ${DIFF_TARGET}±2 に収まる (平均 ${avg.toFixed(1)})`,
    () => assert(Math.abs(avg - DIFF_TARGET) <= 2, `平均差 ${avg.toFixed(1)} が範囲外`));
  console.log(`  📊 平均スコア差: ${avg.toFixed(1)} ポイント (全${SEEDS.length}シード)`);
}

/* ============================================================
   2. 「追いつかれた車両の義務」の挙動
   ============================================================ */
console.log('\n■ 追いつかれた車両の義務');
test('義務あり区間: 速い後続車が迫ると左車線へ譲る', () => {
  const w = new World({ rng: createRng(1), spawnInterval: 1e9 });
  const slow = new Vehicle(w, 'L', 1, 0, 'Truck', 16);   slow.speed = 16;
  const fast = new Vehicle(w, 'L', 1, 40, 'SportsCar', 34); fast.speed = 32;
  w.vehicles.push(slow, fast);
  let yielded = false;
  for (let i = 0; i < 400; i++) {
    w.step(DT);
    if (slow.lane === 2 || (slow.lc.state !== 'none' && slow.lc.to === 2)) { yielded = true; break; }
  }
  assert(yielded, '左車線(レーン2)へ譲る車線変更が発生しなかった');
});

test('義務なし区間: 同じ状況でも譲らない', () => {
  const w = new World({ rng: createRng(1), spawnInterval: 1e9 });
  const slow = new Vehicle(w, 'R', 1, 0, 'Truck', 16);   slow.speed = 16;
  const fast = new Vehicle(w, 'R', 1, 40, 'SportsCar', 34); fast.speed = 32;
  w.vehicles.push(slow, fast);
  let yielded = false;
  for (let i = 0; i < 400; i++) {
    w.step(DT);
    if (slow.lane === 2 || (slow.lc.state !== 'none' && slow.lc.to === 2)) { yielded = true; break; }
  }
  assert(!yielded, '義務がないのに左車線へ譲ってしまった');
});

/* ============================================================
   3. 追い越し挙動（両区間共通）
   ============================================================ */
console.log('\n■ 追い越し');
for (const sec of ['L', 'R']) {
  const name = sec === 'L' ? '義務あり' : '義務なし';
  test(`${name}区間: 遅い前方車がいれば右(追い越し車線)へ出る`, () => {
    const w = new World({ rng: createRng(2), spawnInterval: 1e9 });
    const slow = new Vehicle(w, sec, 2, 0, 'Truck', 16);    slow.speed = 16;
    const fast = new Vehicle(w, sec, 2, 60, 'SportsCar', 34); fast.speed = 34;
    w.vehicles.push(slow, fast);
    let overtook = false;
    // 人間モデルでは「しばらく抑え込まれてから」追い越しを決意するため長めに観察
    for (let i = 0; i < 1600; i++) {
      w.step(DT);
      if (fast.lane < 2 || (fast.lc.state !== 'none' && fast.lc.to < 2)) { overtook = true; break; }
    }
    assert(overtook, '追い越し車線への車線変更が発生しなかった');
  });
}

test('義務あり区間: 追い越し後は走行車線へ復帰する', () => {
  const w = new World({ rng: createRng(3), spawnInterval: 1e9 });
  const v = new Vehicle(w, 'L', 0, 0, 'Sedan', 26); v.speed = 26;
  w.vehicles.push(v);
  let returned = false;
  for (let i = 0; i < Math.round((CONST.OVERTAKE_LANE_RETURN_TIME + 4) / DT); i++) {
    w.step(DT);
    if (v.lane === 1 || (v.lc.state !== 'none' && v.lc.to === 1)) { returned = true; break; }
  }
  assert(returned, '追い越し車線から復帰しなかった');
});

test('義務なし区間: 復帰は義務あり区間より明確に遅い設定', () => {
  const w = new World({ rng: createRng(4), spawnInterval: 1e9 });
  for (let i = 0; i < 40; i++) {
    const v = new Vehicle(w, 'R', 0, i * 10, 'Sedan', 26);
    assert(v.returnTime >= CONST.OVERTAKE_LANE_RETURN_TIME * 3,
      `returnTime=${v.returnTime.toFixed(1)}s は短すぎる`);
  }
});

/* ============================================================
   4. 安全性: 車両の貫通防止
   ============================================================ */
console.log('\n■ 衝突回避・貫通防止');
test('長時間運転しても同一車線内で車両が重ならない (許容 -1.0m)', () => {
  let worstGap = Infinity;
  for (const r of results) worstGap = Math.min(worstGap, r.minGap);
  assert(worstGap > -1.0, `車間が ${worstGap.toFixed(2)}m まで縮まり貫通が発生`);
});

/* ============================================================
   5. 渋滞スコアの計算式 (速度75% + 密度25%)
   ============================================================ */
console.log('\n■ ハザードランプ');
test('停止列の最後尾はハザードを点灯し、後続が停車したら次の最後尾へ移る', () => {
  const w = new World({ rng: createRng(3), spawnInterval: 1e9 });
  const tail = new Vehicle(w, 'L', 1, 0, 'Sedan', 25);
  tail.speed = 0;
  w.vehicles.push(tail);
  w.step(DT);
  assert(tail.hazard, '最後尾(後続なし)でハザードが点かない');
  const f = new Vehicle(w, 'L', 1, 8, 'Sedan', 25); // 直後で停車した後続
  f.speed = 0;
  w.vehicles.push(f);
  w.step(DT);
  assert(!tail.hazard, '後続が停車してもハザードが消えない');
  assert(f.hazard, '新しい最後尾にハザードが移らない');
});

console.log('\n■ 渋滞スコア算出');
test('スコア = (0.75×速度要因 + 0.25×密度要因) × 100', () => {
  const w = new World({ rng: createRng(5), spawnInterval: 1e9 });
  for (let i = 0; i < 4; i++) {
    const v = new Vehicle(w, 'L', i % 3, i * 30, 'Sedan', 24);
    v.speed = 16;
    w.vehicles.push(v);
  }
  const s = w.computeSection('L');
  const expected = (0.75 * (1 - 16 / CONST.REF_SPEED) + 0.25 * (4 / CONST.MAX_PER_SECTION)) * 100;
  approx(s.score, expected, 1e-9, 'スコア計算式が仕様と不一致');
  assert(s.n === 4, `車両数カウント不一致: ${s.n}`);
});

test('車両ゼロのときスコアは0', () => {
  const w = new World({ rng: createRng(6) });
  assert(w.computeSection('L').score === 0, 'スコアが0でない');
});

/* ============================================================
   6. ペア生成
   ============================================================ */
console.log('\n■ 車両ペア生成');
test('ペアは同タイプ・同初期速度で左右に1台ずつ生成される', () => {
  const w = new World({ rng: createRng(7), spawnInterval: 1e9 });
  assert(w.spawnPair(), 'spawnPairが失敗');
  assert(w.vehicles.length === 2, `生成台数 ${w.vehicles.length} ≠ 2`);
  const [a, b] = w.vehicles;
  assert(a.section === 'L' && b.section === 'R', 'セクション割り当てが不正');
  assert(a.typeName === b.typeName, 'ペアのタイプが不一致');
  approx(a.initialDesiredSpeed, b.initialDesiredSpeed, 1e-12, 'ペアの初期速度が不一致');
});

test('最大車両数280台を超えない', () => {
  const w = new World({ rng: createRng(8), spawnInterval: 50 });
  w.populateInitial();
  for (let i = 0; i < Math.round(300 / DT); i++) w.step(DT);
  assert(w.vehicles.length <= CONST.MAX_VEHICLES,
    `${w.vehicles.length}台 > 上限${CONST.MAX_VEHICLES}台`);
});

/* ---------- 結果 ---------- */
console.log(`\n${'='.repeat(56)}`);
console.log(`結果: ${passed} passed / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

import assert from "node:assert/strict";
import {
  DEFAULT_EVAL, DEFAULT_COSTS, buildSamples, brier, logLoss, calibration, classFrequencies, clusterBootstrap, confusion,
  mulberry32, ruleCalls, runEval, simulate, chooseHoldoutStart, type Call, type EvalConfig,
} from "../eval/core.ts";

const TF = 300000;
const TFMIN = 5;
type C = { t: number; o: number; h: number; l: number; c: number; v: number };

function gauss(rnd: () => number) {
  return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
}
function fromReturns(rets: number[], rnd: () => number, t0 = 0, start = 100): C[] {
  let p = start;
  return rets.map((r, i) => {
    const o = p;
    const c = o * Math.exp(r);
    p = c;
    return { t: t0 + i * TF, o, h: Math.max(o, c) * (1 + Math.abs(gauss(rnd)) * 0.0004), l: Math.min(o, c) * (1 - Math.abs(gauss(rnd)) * 0.0004), c, v: 1 };
  });
}
const randomWalk = (n: number, seed: number) => {
  const rnd = mulberry32(seed);
  return fromReturns(Array.from({ length: n }, () => gauss(rnd) * 0.0015), rnd);
};
// Ranges followed by a breakout that CONTINUES: a series where the rule genuinely has an edge.
function plantedEdge(n: number, seed: number) {
  const rnd = mulberry32(seed);
  const rets: number[] = [];
  while (rets.length < n) {
    // range: mean-reverting noise around the level, then a directional move
    let dev = 0;
    for (let k = 0; k < 40; k++) {
      const target = (k % 2 ? 1 : -1) * 0.004;
      dev = 0.5 * dev + 0.5 * target;
      rets.push((dev - (rets.length ? 0 : 0)) * 0 + (k % 2 ? 0.003 : -0.003) + gauss(rnd) * 0.0003);
    }
    const dir = rnd() < 0.5 ? 1 : -1;
    for (let k = 0; k < 30; k++) rets.push(dir * 0.0035 + gauss(rnd) * 0.0004);
    for (let k = 0; k < 20; k++) rets.push((k % 2 ? 1 : -1) * 0.0004 * gauss(rnd));
  }
  return fromReturns(rets.slice(0, n), rnd);
}

const cfgFor = (candles: C[], over: Partial<EvalConfig> = {}): EvalConfig => ({
  ...DEFAULT_EVAL,
  holdoutStartT: chooseHoldoutStart(candles[0].t, candles[candles.length - 1].t, 0.2),
  ...over,
});

// ---- 1. causality: editing the future never changes a past signal ----
{
  const a = plantedEdge(1500, 3);
  const base = ruleCalls(a, TF, DEFAULT_EVAL.rule);
  const k = 900;
  const b = a.map((c, i) => (i > k ? { ...c, o: c.o * 1.3, h: c.h * 1.3, l: c.l * 1.3, c: c.c * 1.3 } : c));
  const alt = ruleCalls(b, TF, DEFAULT_EVAL.rule);
  assert.deepEqual(alt.slice(0, k + 1), base.slice(0, k + 1), "signals up to candle k must not depend on later candles");
  assert.ok(base.some((x) => x !== "NONE"), "the planted series should produce signals");
}

// ---- 2. samples: gaps drop samples; target uses the horizon-end close ----
{
  const a = randomWalk(400, 1);
  const calls = new Array(a.length).fill("NONE") as Call[];
  const s = buildSamples(a, TFMIN, 60, calls, DEFAULT_COSTS);
  assert.ok(s.length > 0);
  const x = s[0];
  assert.equal(x.endT, a[x.i + 12].t + TF);
  assert.ok(Math.abs(x.retPct - ((a[x.i + 12].c - a[x.i].c) / a[x.i].c) * 100) < 1e-12);
  const gapped = a.filter((c) => c.t !== 200 * TF);
  const s2 = buildSamples(gapped, TFMIN, 60, new Array(gapped.length).fill("NONE") as Call[], DEFAULT_COSTS);
  for (const y of s2) {
    const lo = gapped[y.i - Math.max(24, 12)].t;
    const hi = gapped[y.i + 12].t;
    assert.ok(!(lo < 200 * TF && hi > 200 * TF), "no sample may span the gap");
  }
  assert.ok(s2.length < s.length);
}

// ---- 3. costs and delay ----
{
  const a = plantedEdge(3000, 5);
  const calls = ruleCalls(a, TF, DEFAULT_EVAL.rule);
  const samples = buildSamples(a, TFMIN, 60, calls, DEFAULT_COSTS);
  const cheap = simulate(a, samples, (s) => s.call, { feePct: 0, slippagePct: 0, delayCandles: 1 }, 60, TFMIN);
  const dear = simulate(a, samples, (s) => s.call, { feePct: 0.1, slippagePct: 0, delayCandles: 1 }, 60, TFMIN);
  assert.equal(cheap.length, dear.length);
  assert.ok(cheap.length > 5);
  for (let i = 0; i < cheap.length; i++) assert.ok(Math.abs(cheap[i].netPct - dear[i].netPct - 0.2) < 1e-9, "a 0.1% fee per side costs exactly 0.2% per trade");
  // no overlapping positions
  const spans = dear.map((t) => t.closeT);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i] - spans[i - 1] >= 60 * 60000 - 1, "positions never overlap");
  // a delay longer than the horizon means no trade can be entered
  assert.equal(simulate(a, samples, (s) => s.call, { ...DEFAULT_COSTS, delayCandles: 20 }, 60, TFMIN).length, 0);
  // later entry is worse on a continuing move
  const late = simulate(a, samples, (s) => s.call, { feePct: 0, slippagePct: 0, delayCandles: 4 }, 60, TFMIN);
  const mean = (t: { netPct: number }[]) => t.reduce((x, y) => x + y.netPct, 0) / t.length;
  assert.ok(mean(late) < mean(cheap), "extra delay lowers the return when the move is continuing");
}

// ---- 4. scoring functions ----
{
  const P = (u: number, d: number, s: number): [number, number, number] => [u, d, s];
  // perfect and worst predictions
  assert.equal(brier([P(1, 0, 0)], ["UP"]), 0);
  assert.equal(brier([P(0, 1, 0)], ["UP"]), 2);
  assert.ok(Math.abs(logLoss([P(0.5, 0.25, 0.25)], ["UP"]) - Math.log(2)) < 1e-12);
  assert.ok(Number.isFinite(logLoss([P(0, 0, 1)], ["UP"])), "log loss is clipped, never infinite");
  const f = classFrequencies(["UP", "UP", "DOWN", "SIDEWAYS"]);
  assert.ok(Math.abs(f[0] + f[1] + f[2] - 1) < 1e-12 && f.every((x) => x > 0));
  // confusion + precision
  const c = confusion(["UP", "UP", "DOWN", "NONE", "UP"], ["UP", "DOWN", "DOWN", "SIDEWAYS", "UP"]);
  assert.equal(c.matrix.UP.UP, 2);
  assert.equal(c.matrix.UP.DOWN, 1);
  assert.ok(Math.abs(c.precisionUp! - 2 / 3) < 1e-12);
  assert.equal(c.precisionDown, 1);
  assert.equal(c.recallUp, 1);
  // calibration bins
  const cal = calibration([P(0.9, 0.05, 0.05), P(0.9, 0.05, 0.05), P(0.1, 0.8, 0.1)], ["UP", "DOWN", "DOWN"], "UP", 10);
  const hi = cal.find((r) => r.from === 0.9)!;
  assert.equal(hi.n, 2);
  assert.equal(hi.observed, 0.5);
}

// ---- 5. bootstrap: separates real signal from noise ----
{
  const rnd = mulberry32(9);
  const day = 86400000;
  // calibration: on zero-mean noise the one-sided lower bound at alpha 0.025 may exceed 0 only about 2.5% of the time
  let falsePositives = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const r2 = mulberry32(seed);
    const noise = Array.from({ length: 300 }, (_, i) => ({ closeT: Math.floor(i / 3) * day, netPct: gauss(r2) * 0.5 }));
    if (clusterBootstrap(noise, 0.025).lower > 0) falsePositives++;
  }
  assert.ok(falsePositives <= 8, `false-positive rate too high: ${falsePositives}/100`);
  const real = Array.from({ length: 300 }, (_, i) => ({ closeT: Math.floor(i / 3) * day, netPct: 0.4 + gauss(rnd) * 0.5 }));
  assert.ok(clusterBootstrap(real, 0.025).lower > 0, "a clear edge must be detected");
  assert.deepEqual(clusterBootstrap([], 0.05).days, 0);
}

// ---- 6. end to end: random walks never pass; the planted edge does ----
{
  for (const seed of [11, 12, 13, 14, 15]) {
    const data = [{ symbol: "RW", candles: randomWalk(25000, seed) }, { symbol: "RW2", candles: randomWalk(25000, seed + 100) }];
    const cfg = cfgFor(data[0].candles, { minTrades: 30 });
    for (const r of runEval(data, cfg) as any[]) {
      assert.ok(!r.verdict.startsWith("PASSES"), `random walk seed ${seed} h${r.horizonMin} must not pass: ${r.verdict}`);
    }
  }
  const data = [{ symbol: "PE", candles: plantedEdge(30000, 21) }, { symbol: "PE2", candles: plantedEdge(30000, 22) }];
  const cfg = cfgFor(data[0].candles, { minTrades: 30, horizonsMin: [60] });
  const [r] = runEval(data, cfg) as any[];
  assert.ok(r.strategies.rule.trades >= 30, `planted edge should yield trades, got ${r.strategies.rule.trades}`);
  assert.ok(r.strategies.rule.meanNetPct > 0, "planted edge is profitable after costs");
  assert.ok(r.verdict.startsWith("PASSES"), r.verdict);
  // too little data -> an explicit refusal to judge
  const [few] = runEval(data, { ...cfg, minTrades: 100000 }) as any[];
  assert.ok(few.verdict.startsWith("INSUFFICIENT DATA"));
}

// ---- 7. the holdout is untouched: changing it cannot change any development number ----
{
  const a = plantedEdge(20000, 31);
  const cfg = cfgFor(a, { horizonsMin: [60, 240], minTrades: 10 });
  const before = JSON.stringify(runEval([{ symbol: "X", candles: a }], cfg));
  const wrecked = a.map((c) => (c.t >= cfg.holdoutStartT ? { ...c, o: c.o * 7, h: c.h * 7, l: c.l * 7, c: c.c * 7 } : c));
  const after = JSON.stringify(runEval([{ symbol: "X", candles: wrecked }], cfg));
  // candles whose horizon reaches into the holdout are excluded, so this must be byte-identical
  assert.equal(after, before, "development results must not depend on holdout data");
  const fin = runEval([{ symbol: "X", candles: a }], { ...cfg, mode: "final" }) as any[];
  assert.ok(fin[0].samples > 0 && fin[0].folds.length === 1);
}
console.log("eval tests passed");

import assert from "node:assert/strict";
import { DEFAULT_RETEST_EVAL, randomDirection, replaySetups, runRetestEval, simulateSetups, type ReplaySetup, type RetestEvalConfig } from "../eval/retest.ts";
import { COSTS_PLACEHOLDER, TRIGGER_DEFAULTS, tradeEconomics } from "../lib/retest.ts";
import { chooseHoldoutStart, mulberry32 } from "../eval/core.ts";

const M5 = 300000;
type C = { t: number; o: number; h: number; l: number; c: number; v: number };
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

// ---------- simulateSetups: execution rules ----------
const flat = (n: number, px = 100): C[] => Array.from({ length: n }, (_, i) => ({ t: i * M5, o: px, h: px + 0.05, l: px - 0.05, c: px, v: 1 }));
const cfg0: RetestEvalConfig = { ...DEFAULT_RETEST_EVAL, holdoutStartT: Infinity, costs: { takerFeePct: 0.1, makerFeePct: 0.1, slippagePct: 0, spreadPct: 0, targetFill: "taker", fundingPct: 0 }, delayCandles: 0, maxHoldCandles: 20 };
const setup = (over: Partial<ReplaySetup> = {}): ReplaySetup => ({
  dir: "long", triggerT: 4 * M5, closeT: 5 * M5, refPrice: 100, zoneLow: 99, zoneHigh: 100, priorBounces: 2, avgReactionAtr: 1, atrHtf: 1,
  stopPrice: 99, targetPrice: 101, stopPct: 1, targetPct: 1, invalidationPrice: 99, wickFrac: 0.5, volRatio: null,
  economics: tradeEconomics(1, 1, cfg0.costs), evidence: "", k: 4, regime: "ranging", highVol: false, ...over,
});
{
  // target hit
  const c = flat(30);
  c[8] = { ...c[8], h: 101.2 };
  const r = simulateSetups(c, [setup()], cfg0).trades[0];
  assert.equal(r.exit, "target");
  near(r.grossPct, 1, 1e-9);
  near(r.netPct, 1 - 0.2, 1e-9); // taker in and out
}
{
  // stop AND target inside one candle -> the stop is assumed to fill first
  const c = flat(30);
  c[8] = { ...c[8], h: 101.5, l: 98.5 };
  assert.equal(simulateSetups(c, [setup()], cfg0).trades[0].exit, "stop");
}
{
  // a candle that opens through the stop fills at the open, not at the stop
  const c = flat(30);
  c[8] = { t: 8 * M5, o: 97, h: 97.2, l: 96.8, c: 97, v: 1 };
  const t = simulateSetups(c, [setup()], cfg0).trades[0];
  assert.equal(t.exit, "stop");
  near(t.grossPct, -3, 1e-9);
}
{
  // time stop
  const t = simulateSetups(flat(40), [setup()], cfg0).trades[0];
  assert.equal(t.exit, "time");
}
{
  // entry delay: market already beyond the target when we could have entered -> no trade, counted as missed
  const c = flat(30);
  for (let i = 5; i < 30; i++) c[i] = { ...c[i], o: 102, h: 102.1, l: 101.9, c: 102 };
  const r = simulateSetups(c, [setup()], { ...cfg0, delayCandles: 1 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.late, 1);
}
{
  // data ends before the trade can resolve: dropped as unfinished, never force-closed at the last candle
  const r = simulateSetups(flat(15), [setup()], cfg0);
  assert.equal(r.trades.length, 0);
  assert.equal(r.unfinished, 1);
}
{
  // one position at a time: a second setup while the first is open is blocked, not stacked
  const c = flat(60);
  const r = simulateSetups(c, [setup(), setup({ k: 6, closeT: 7 * M5, triggerT: 6 * M5 })], cfg0);
  assert.equal(r.trades.length, 1);
  assert.equal(r.blocked, 1);
}
{
  // a hole in the data inside the trade window drops the trade instead of inventing prices
  const c = flat(60).filter((x) => x.t !== 9 * M5);
  const r = simulateSetups(c, [setup()], cfg0);
  assert.equal(r.trades.length, 0);
  assert.equal(r.gapDropped, 1);
}
{
  // costs: slippage + spread hurt both legs; short mirrors long
  const cs = { ...cfg0, costs: { ...cfg0.costs, slippagePct: 0.05, spreadPct: 0.02 } };
  const c = flat(30);
  c[8] = { ...c[8], h: 101.5 };
  const t = simulateSetups(c, [setup()], cs).trades[0];
  assert.ok(t.netPct < 1 - 0.2, "slippage and spread reduce the net result");
  const sh = flat(30);
  sh[8] = { ...sh[8], l: 98.5 };
  const s = simulateSetups(sh, [setup({ dir: "short", stopPrice: 101, targetPrice: 99 })], cfg0).trades[0];
  assert.equal(s.exit, "target");
  near(s.grossPct, 1, 1e-9);
}
{
  // random direction keeps the same stop/target distances and is reproducible
  const a = randomDirection([setup(), setup({ k: 9 }), setup({ k: 15 })], 5);
  const b = randomDirection([setup(), setup({ k: 9 }), setup({ k: 15 })], 5);
  assert.deepEqual(a, b);
  for (const s of a) near(Math.abs(s.refPrice - s.stopPrice) / s.refPrice * 100, 1, 1e-9);
}

// ---------- synthetic markets ----------
function randomWalk(n: number, seed: number): C[] {
  const r = mulberry32(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    const c = o * Math.exp(gauss(r) * 0.0012);
    p = c;
    return { t: i * M5, o, h: Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0003), l: Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0003), c, v: 10 };
  });
}
// price swings between a floor at 100 and a ceiling at 103; every turn is a clean rejection with a wick
function swings(n: number): C[] {
  const out: C[] = [];
  let p = 103;
  let dir = -1;
  let t = 0;
  while (out.length < n) {
    for (let k = 0; k < 36 && out.length < n; k++) {
      const o = p;
      const c = p + dir * (3 / 36);
      p = c;
      out.push({ t, o, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, c, v: 10 });
      t += M5;
    }
    dir = -dir;
  }
  return out;
}
const loose = { ...TRIGGER_DEFAULTS, maxStopPct: 3, minNetRR: 0.3, minWickFrac: 0.3 };
const mk = (candles: C[], over: Partial<RetestEvalConfig> = {}): RetestEvalConfig => ({
  ...DEFAULT_RETEST_EVAL, trig: loose, minTrades: 30,
  holdoutStartT: chooseHoldoutStart(candles[0].t, candles[candles.length - 1].t, 0.2), ...over,
});

// ---------- causality: editing the future never changes an earlier signal ----------
{
  const a = swings(4000);
  const cfg = mk(a);
  const base = replaySetups(a, cfg, 2).setups;
  assert.ok(base.length > 5, `planted series should produce setups, got ${base.length}`);
  const cut = 2500;
  const b = a.map((c, i) => (i > cut ? { ...c, o: c.o * 1.4, h: c.h * 1.4, l: c.l * 1.4, c: c.c * 1.4 } : c));
  const alt = replaySetups(b, cfg, 2).setups;
  assert.deepEqual(alt.filter((s) => s.k <= cut), base.filter((s) => s.k <= cut));
}

// ---------- end to end ----------
{
  // random walks: no edge may be claimed, and costs make the average negative
  let totalTrades = 0;
  for (const seed of [41, 42, 43, 44]) {
    const data = [{ symbol: "A", candles: randomWalk(14000, seed) }, { symbol: "B", candles: randomWalk(14000, seed + 50) }];
    const cfg = mk(data[0].candles, { minTrades: 15, zone: { ...DEFAULT_RETEST_EVAL.zone, minPriorBounces: 0 } });
    const res = runRetestEval(data, cfg);
    assert.ok(!res.verdict.startsWith("PASSES"), `random walk seed ${seed}: ${res.verdict}`);
    const p = res.arms.find((a) => a.minPriorBounces === 2)!;
    totalTrades += p.stats.trades;
  }
  assert.ok(totalTrades > 0, "random-walk runs should still generate some trades to judge");
}
{
  // planted edge: clean rejections off a floor/ceiling pay after costs, and beat the coin flip
  const data = [{ symbol: "P", candles: swings(14000) }];
  const cfg = mk(data[0].candles, { minTrades: 30 });
  const res = runRetestEval(data, cfg);
  const p = res.arms.find((a) => a.minPriorBounces === 2)!;
  assert.ok(p.stats.trades >= 30, `planted edge should trade, got ${p.stats.trades}`);
  assert.ok(p.stats.expectancyNetPct! > 0);
  assert.ok(p.stats.expectancyNetPct! > p.randomDirection.expectancyNetPct!);
  assert.ok(res.verdict.startsWith("PASSES"), res.verdict);
  // more delay can only hurt a continuing move
  const slow = runRetestEval(data, { ...cfg, delayCandles: 8 });
  const ps = slow.arms.find((a) => a.minPriorBounces === 2)!;
  assert.ok((ps.stats.expectancyNetPct ?? -Infinity) <= p.stats.expectancyNetPct! + 1e-9);
  // not enough trades -> an explicit refusal to judge
  assert.ok(runRetestEval(data, { ...cfg, minTrades: 100000 }).verdict.startsWith("INSUFFICIENT DATA"));
}
// ---------- the holdout is untouched ----------
{
  const a = swings(14000);
  const cfg = mk(a, { minTrades: 5 });
  const before = JSON.stringify(runRetestEval([{ symbol: "X", candles: a }], cfg));
  const wrecked = a.map((c) => (c.t >= cfg.holdoutStartT ? { ...c, o: c.o * 5, h: c.h * 5, l: c.l * 5, c: c.c * 5 } : c));
  const after = JSON.stringify(runRetestEval([{ symbol: "X", candles: wrecked }], cfg));
  assert.equal(after, before, "development results must not depend on holdout data");
  const fin = runRetestEval([{ symbol: "X", candles: a }], { ...cfg, mode: "final" });
  assert.ok(fin.arms[0].stats.trades >= 0 && fin.arms.length === 4);
}
console.log("retest eval tests passed");

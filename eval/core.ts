// Walk-forward evaluation core. Pure functions, no network, no database. SIMULATION / RESEARCH ONLY.
//
// What it answers: do the app's forecasts beat simple baselines on data they were not tuned on, after costs?
// Design rules enforced here:
//  * Signals are generated causally (candle i sees candles 0..i only; tests prove future edits change nothing).
//  * The target is the one used live (lib/outcome.ts): cost-aware UP / DOWN / SIDEWAYS at a fixed horizon.
//  * Training data for any fitted baseline is purged: a training label whose horizon-end is after the test
//    block starts is dropped, so no label overlaps the test period.
//  * A time-locked holdout (the latest slice of history) is excluded from every development number.
//  * Trades pay fees + slippage on both sides, enter after a configurable alert/execution delay, never overlap.
//  * Edge is judged by a day-clustered bootstrap with a Bonferroni-adjusted level, a minimum trade count, and
//    a comparison with baselines. Failing any of these is reported plainly as NO EDGE / INSUFFICIENT DATA.
import type { Candle } from "../lib/types";
import { detectRange, scanBreakout } from "../lib/range.ts";
import { classifyReturn, thresholdPct } from "../lib/outcome.ts";

export type Actual = "UP" | "DOWN" | "SIDEWAYS";
export type Call = "UP" | "DOWN" | "NONE";
const ACTUALS: Actual[] = ["UP", "DOWN", "SIDEWAYS"];

export interface RuleParams {
  lookback: number;
  maxWidthPct: number;
  minTouches: number;
  touchTolPct: number;
  expireCandles: number;
  bufferPct: number;
  confirmCloses: number;
}
export const DEFAULT_RULE: RuleParams = { lookback: 24, maxWidthPct: 2.5, minTouches: 2, touchTolPct: 20, expireCandles: 48, bufferPct: 0.05, confirmCloses: 1 };

export interface Costs {
  feePct: number; // per side
  slippagePct: number; // per side, adverse
  delayCandles: number; // alert + execution delay, in whole candles after the signal candle closes
}
export const DEFAULT_COSTS: Costs = { feePct: 0.1, slippagePct: 0.05, delayCandles: 1 };
export const roundTripCostPct = (c: Costs) => 2 * (c.feePct + c.slippagePct);

// ---------- causal signals (mirrors the live engine's tight-range state machine) ----------
export function ruleCalls(candles: Candle[], tfMs: number, p: RuleParams): Call[] {
  const out: Call[] = new Array(candles.length).fill("NONE");
  let active: { high: number; low: number; endT: number; nextIdx: number } | null = null;
  let minStartT = 0;
  for (let i = 0; i < candles.length; i++) {
    if (active) {
      const after = candles.slice(active.nextIdx, i + 1);
      const b = scanBreakout(after, active, tfMs, p.bufferPct, p.confirmCloses);
      if (b) {
        if (b.confirmT === candles[i].t) out[i] = b.direction === "up" ? "UP" : "DOWN";
        minStartT = b.confirmT + 1;
        active = null;
      } else if (after.length >= p.expireCandles) {
        minStartT = active.endT + 1;
        active = null;
      } else continue; // still watching: the live engine does not look for a new range meanwhile
    }
    if (i + 1 < p.lookback) continue;
    const r = detectRange(candles.slice(i + 1 - p.lookback, i + 1), { lookback: p.lookback, maxWidthPct: p.maxWidthPct, minTouches: p.minTouches, touchTolPct: p.touchTolPct }, minStartT);
    if (r) active = { high: r.high, low: r.low, endT: r.endT, nextIdx: i + 1 };
  }
  return out;
}

// ---------- samples: one per closed candle, with the cost-aware outcome at the horizon ----------
export interface Sample {
  i: number;
  closeT: number; // when the signal candle closed (forecast issue time)
  endT: number; // when the horizon ended
  call: Call; // the app's rule
  mom: Call; // momentum baseline: sign of the trailing move over the same horizon, if it exceeds the threshold
  retPct: number; // close(i) -> close(i + h)
  actual: Actual;
}

// Index k is "continuous" with k-1 if exactly one candle length apart. Samples spanning a gap are dropped.
function gapPrefix(candles: Candle[], tfMs: number): number[] {
  const g = new Array(candles.length).fill(0);
  for (let k = 1; k < candles.length; k++) g[k] = g[k - 1] + (candles[k].t - candles[k - 1].t === tfMs ? 0 : 1);
  return g;
}

export function buildSamples(candles: Candle[], tfMin: number, horizonMin: number, calls: Call[], costs: Costs, minMovePct = 0, warm = 24): Sample[] {
  const tfMs = tfMin * 60000;
  const hc = Math.round(horizonMin / tfMin);
  if (hc < 1 || hc * tfMin !== horizonMin) throw new Error("horizon must be a whole number of candles");
  const thr = thresholdPct({ costPct: roundTripCostPct(costs), minMovePct });
  const gp = gapPrefix(candles, tfMs);
  const back = Math.max(warm, hc);
  const out: Sample[] = [];
  for (let i = back; i + hc < candles.length; i++) {
    if (gp[i + hc] - gp[i - back] !== 0) continue; // a gap anywhere in [i-back, i+hc] voids the sample
    const retPct = ((candles[i + hc].c - candles[i].c) / candles[i].c) * 100;
    const trail = ((candles[i].c - candles[i - hc].c) / candles[i - hc].c) * 100;
    out.push({
      i,
      closeT: candles[i].t + tfMs,
      endT: candles[i + hc].t + tfMs,
      call: calls[i],
      mom: trail > thr ? "UP" : trail < -thr ? "DOWN" : "NONE",
      retPct,
      actual: classifyReturn(retPct, thr),
    });
  }
  return out;
}

// ---------- trade simulation ----------
export interface Trade {
  closeT: number;
  dir: 1 | -1;
  grossPct: number;
  netPct: number;
}

// Enter at the OPEN of candle (i + 1 + delay) with adverse slippage, exit at the CLOSE of candle i + h with
// adverse slippage, pay the fee on both sides. One position at a time per series: signals that arrive while a
// position is open are ignored. Entry after the exit candle is skipped (delay too long for the horizon).
export function simulate(candles: Candle[], samples: Sample[], pick: (s: Sample) => Call, costs: Costs, horizonMin: number, tfMin: number): Trade[] {
  const hc = Math.round(horizonMin / tfMin);
  const trades: Trade[] = [];
  let freeFrom = -1; // candle index from which a new signal may be taken
  for (const s of samples) {
    if (s.i < freeFrom) continue;
    const c = pick(s);
    if (c === "NONE") continue;
    const e = s.i + 1 + costs.delayCandles;
    const x = s.i + hc;
    if (e > x || e >= candles.length) continue;
    const dir: 1 | -1 = c === "UP" ? 1 : -1;
    const slip = costs.slippagePct / 100;
    const entry = candles[e].o * (1 + dir * slip);
    const exit = candles[x].c * (1 - dir * slip);
    const grossPct = dir * ((exit / entry) - 1) * 100;
    trades.push({ closeT: candles[x].t + tfMin * 60000, dir, grossPct, netPct: grossPct - 2 * costs.feePct });
    freeFrom = x;
  }
  return trades;
}

// ---------- statistics ----------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Day-clustered bootstrap of the mean net return per trade (trades the same day, across symbols, move together).
// Returns the one-sided lower bound at level `alpha` (already Bonferroni-adjusted by the caller).
export function clusterBootstrap(trades: { closeT: number; netPct: number }[], alpha: number, reps = 4000, seed = 12345) {
  const n = trades.length;
  if (!n) return { mean: NaN, lower: NaN, days: 0 };
  const byDay = new Map<number, number[]>();
  for (const t of trades) {
    const d = Math.floor(t.closeT / 86400000);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t.netPct);
  }
  const days = [...byDay.values()];
  const mean = trades.reduce((a, t) => a + t.netPct, 0) / n;
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < days.length; k++) {
      const d = days[Math.floor(rnd() * days.length)];
      for (const v of d) sum += v;
      cnt += d.length;
    }
    means.push(sum / cnt);
  }
  means.sort((a, b) => a - b);
  return { mean, lower: means[Math.max(0, Math.floor(alpha * reps))], days: days.length };
}

export function equityStats(trades: Trade[], fraction: number) {
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const t of trades) {
    eq *= 1 + (fraction * t.netPct) / 100;
    if (eq > peak) peak = eq;
    dd = Math.max(dd, (peak - eq) / peak);
  }
  return { finalReturnPct: (eq - 1) * 100, maxDrawdownPct: dd * 100 };
}

export function summarizeTrades(trades: Trade[], fraction: number, alpha: number) {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPct > 0).length;
  const ci = clusterBootstrap(trades, alpha);
  const eq = equityStats(trades, fraction);
  return {
    trades: n,
    winRatePct: n ? (wins / n) * 100 : null,
    meanNetPct: n ? ci.mean : null,
    meanGrossPct: n ? trades.reduce((a, t) => a + t.grossPct, 0) / n : null,
    lowerBoundNetPct: n ? ci.lower : null,
    days: ci.days,
    finalReturnPct: eq.finalReturnPct,
    maxDrawdownPct: eq.maxDrawdownPct,
  };
}

export function confusion(calls: Call[], actuals: Actual[]) {
  const m: Record<Call, Record<Actual, number>> = { UP: { UP: 0, DOWN: 0, SIDEWAYS: 0 }, DOWN: { UP: 0, DOWN: 0, SIDEWAYS: 0 }, NONE: { UP: 0, DOWN: 0, SIDEWAYS: 0 } };
  for (let k = 0; k < calls.length; k++) m[calls[k]][actuals[k]]++;
  const rate = (a: Actual) => (actuals.length ? actuals.filter((x) => x === a).length / actuals.length : null);
  const prec = (c: "UP" | "DOWN") => {
    const row = m[c];
    const tot = row.UP + row.DOWN + row.SIDEWAYS;
    return tot ? row[c] / tot : null;
  };
  const rec = (c: "UP" | "DOWN") => {
    const tot = m.UP[c] + m.DOWN[c] + m.NONE[c];
    return tot ? m[c][c] / tot : null;
  };
  return { matrix: m, precisionUp: prec("UP"), precisionDown: prec("DOWN"), recallUp: rec("UP"), recallDown: rec("DOWN"), baseRate: { UP: rate("UP"), DOWN: rate("DOWN"), SIDEWAYS: rate("SIDEWAYS") } };
}

// Probabilistic scoring (used for baselines now, and for any model that outputs probabilities later).
export type Probs = [number, number, number]; // UP, DOWN, SIDEWAYS
export function brier(probs: Probs[], actuals: Actual[]): number {
  let s = 0;
  for (let k = 0; k < probs.length; k++) for (let j = 0; j < 3; j++) s += (probs[k][j] - (actuals[k] === ACTUALS[j] ? 1 : 0)) ** 2;
  return s / probs.length;
}
export function logLoss(probs: Probs[], actuals: Actual[]): number {
  let s = 0;
  for (let k = 0; k < probs.length; k++) s -= Math.log(Math.max(1e-12, probs[k][ACTUALS.indexOf(actuals[k])]));
  return s / probs.length;
}
export function calibration(probs: Probs[], actuals: Actual[], cls: Actual, bins = 10) {
  const j = ACTUALS.indexOf(cls);
  const rows = Array.from({ length: bins }, (_, b) => ({ from: b / bins, to: (b + 1) / bins, n: 0, meanPredicted: 0, observed: 0 }));
  for (let k = 0; k < probs.length; k++) {
    const p = probs[k][j];
    const r = rows[Math.min(bins - 1, Math.floor(p * bins))];
    r.n++;
    r.meanPredicted += p;
    r.observed += actuals[k] === cls ? 1 : 0;
  }
  return rows.filter((r) => r.n).map((r) => ({ ...r, meanPredicted: r.meanPredicted / r.n, observed: r.observed / r.n }));
}
export function classFrequencies(actuals: Actual[]): Probs {
  const n = actuals.length || 1;
  return ACTUALS.map((a) => (actuals.filter((x) => x === a).length + 1) / (n + 3)) as Probs; // +1 smoothing: never a zero probability
}

// ---------- split: chronological dev / locked holdout ----------
export interface Split {
  holdoutStartT: number; // ms. Anything whose label ends after this belongs to the holdout.
}
export function chooseHoldoutStart(firstT: number, lastT: number, holdoutFrac: number): number {
  return Math.floor(lastT - (lastT - firstT) * holdoutFrac);
}

// ---------- the evaluation ----------
export interface EvalConfig {
  tfMin: number;
  horizonsMin: number[];
  rule: RuleParams;
  costs: Costs;
  minMovePct: number;
  holdoutStartT: number;
  mode: "dev" | "final"; // dev = walk-forward on development data only; final = score the locked holdout
  folds: number;
  minTrainFrac: number; // fraction of the dev timeline used as the first training block
  minTrades: number; // below this many trades pooled, no verdict
  alpha: number; // family-wise error rate, split across horizons (Bonferroni)
  equityFraction: number;
}
export const DEFAULT_EVAL: Omit<EvalConfig, "holdoutStartT"> = { tfMin: 5, horizonsMin: [60, 240], rule: DEFAULT_RULE, costs: DEFAULT_COSTS, minMovePct: 0, mode: "dev", folds: 4, minTrainFrac: 0.4, minTrades: 100, alpha: 0.05, equityFraction: 0.1 };

export interface Dataset {
  symbol: string;
  candles: Candle[];
}

export function runEval(data: Dataset[], cfg: EvalConfig) {
  const tfMs = cfg.tfMin * 60000;
  const alphaEach = cfg.alpha / cfg.horizonsMin.length;
  const perSymbol = data.map((d) => ({ d, calls: ruleCalls(d.candles, tfMs, cfg.rule) }));
  const results = [];

  for (const h of cfg.horizonsMin) {
    // test region (by label end time) and the training pool (always development data only)
    const all = perSymbol.map(({ d, calls }) => ({ symbol: d.symbol, candles: d.candles, samples: buildSamples(d.candles, cfg.tfMin, h, calls, cfg.costs, cfg.minMovePct, cfg.rule.lookback) }));
    const devSamples = (s: Sample) => s.endT <= cfg.holdoutStartT;
    const holdSamples = (s: Sample) => s.closeT >= cfg.holdoutStartT; // purge: the whole label lies inside the holdout

    // fold boundaries on the development timeline (times, not indices, so symbols stay aligned)
    const devEnds = all.flatMap((x) => x.samples.filter(devSamples).map((s) => s.endT)).sort((a, b) => a - b);
    const testBlocks: { from: number; to: number; train: (s: Sample) => boolean; test: (s: Sample) => boolean }[] = [];
    if (cfg.mode === "dev") {
      if (devEnds.length < 50) {
        results.push({ horizonMin: h, error: "not enough development data" });
        continue;
      }
      const t0 = devEnds[0];
      const t1 = devEnds[devEnds.length - 1];
      const start = t0 + (t1 - t0) * cfg.minTrainFrac;
      const step = (t1 - start) / cfg.folds;
      for (let f = 0; f < cfg.folds; f++) {
        const from = start + f * step;
        const to = f === cfg.folds - 1 ? t1 + 1 : start + (f + 1) * step;
        testBlocks.push({ from, to, train: (s) => s.endT <= from, test: (s) => devSamples(s) && s.closeT >= from && s.endT < to });
      }
    } else {
      testBlocks.push({ from: cfg.holdoutStartT, to: Infinity, train: devSamples, test: holdSamples });
    }

    const pooled: { s: Sample; sym: string }[] = [];
    const trades: Record<string, Trade[]> = { rule: [], momentum: [], rule_timing_long: [] };
    const foldRows: { from: number; to: number; ruleTrades: number; ruleMeanNetPct: number | null; majority: string }[] = [];
    const probsFreq: Probs[] = [];
    const probsUniform: Probs[] = [];
    const probActuals: Actual[] = [];
    let majorityHits = 0;
    let majorityN = 0;
    let buyHoldNet = 0;
    let buyHoldDays = 0;

    for (const b of testBlocks) {
      const trainActuals = all.flatMap((x) => x.samples.filter(b.train).map((s) => s.actual));
      const freq = classFrequencies(trainActuals);
      const maj = ACTUALS[freq.indexOf(Math.max(...freq))];
      const blockTrades: Trade[] = [];
      for (const x of all) {
        const test = x.samples.filter(b.test);
        if (!test.length) continue;
        for (const s of test) {
          pooled.push({ s, sym: x.symbol });
          probsFreq.push(freq);
          probsUniform.push([1 / 3, 1 / 3, 1 / 3]);
          probActuals.push(s.actual);
          majorityN++;
          if (s.actual === maj) majorityHits++;
        }
        const r = simulate(x.candles, test, (s) => s.call, cfg.costs, h, cfg.tfMin);
        trades.rule.push(...r);
        blockTrades.push(...r);
        trades.momentum.push(...simulate(x.candles, test, (s) => s.mom, cfg.costs, h, cfg.tfMin));
        trades.rule_timing_long.push(...simulate(x.candles, test, (s) => (s.call === "NONE" ? "NONE" : "UP"), cfg.costs, h, cfg.tfMin));
        // buy-and-hold over this symbol's test span, one round trip of costs
        const first = test[0].i + 1;
        const last = test[test.length - 1].i + Math.round(h / cfg.tfMin);
        if (last > first && last < x.candles.length) {
          const slip = cfg.costs.slippagePct / 100;
          const ret = (x.candles[last].c * (1 - slip)) / (x.candles[first].o * (1 + slip)) - 1;
          buyHoldNet += ret * 100 - 2 * cfg.costs.feePct;
          buyHoldDays += (x.candles[last].t - x.candles[first].t) / 86400000;
        }
      }
      foldRows.push({
        from: b.from,
        to: b.to,
        ruleTrades: blockTrades.length,
        ruleMeanNetPct: blockTrades.length ? blockTrades.reduce((a, t) => a + t.netPct, 0) / blockTrades.length : null,
        majority: maj,
      });
    }

    const actuals = pooled.map((p) => p.s.actual);
    const conf = confusion(pooled.map((p) => p.s.call), actuals);
    const strat: Record<string, ReturnType<typeof summarizeTrades>> = {};
    for (const k of Object.keys(trades)) strat[k] = summarizeTrades(trades[k].sort((a, b) => a.closeT - b.closeT), cfg.equityFraction, alphaEach);

    const rule = strat.rule;
    const mom = strat.momentum;
    const timing = strat.rule_timing_long;
    let verdict: string;
    if (rule.trades < cfg.minTrades) verdict = `INSUFFICIENT DATA: ${rule.trades} trades pooled (need ${cfg.minTrades}). No claim either way.`;
    else if (!(rule.lowerBoundNetPct! > 0)) verdict = `NO EDGE DEMONSTRATED: net mean per trade ${rule.meanNetPct!.toFixed(3)}%, one-sided lower bound ${rule.lowerBoundNetPct!.toFixed(3)}% (not above 0 at the adjusted level).`;
    else if (!(rule.meanNetPct! > (mom.meanNetPct ?? -Infinity)) || !(rule.meanNetPct! > (timing.meanNetPct ?? -Infinity))) verdict = "POSITIVE BUT DOES NOT BEAT BASELINES: momentum or always-long-at-the-same-times does as well or better.";
    else verdict = "PASSES ON THIS SAMPLE: net lower bound above 0 and above both baselines. This is evidence, not a guarantee; confirm on fresh forward data.";

    results.push({
      horizonMin: h,
      mode: cfg.mode,
      samples: pooled.length,
      classBalance: conf.baseRate,
      ruleCalls: { UP: conf.matrix.UP.UP + conf.matrix.UP.DOWN + conf.matrix.UP.SIDEWAYS, DOWN: conf.matrix.DOWN.UP + conf.matrix.DOWN.DOWN + conf.matrix.DOWN.SIDEWAYS },
      confusion: conf,
      majority: { accuracy: majorityN ? majorityHits / majorityN : null },
      probScores: {
        trainFrequency: { brier: probsFreq.length ? brier(probsFreq, probActuals) : null, logLoss: probsFreq.length ? logLoss(probsFreq, probActuals) : null },
        uniform: { brier: probsUniform.length ? brier(probsUniform, probActuals) : null, logLoss: probsUniform.length ? logLoss(probsUniform, probActuals) : null },
      },
      strategies: strat,
      buyAndHold: { netPctSumAcrossSymbols: buyHoldNet, symbolDays: buyHoldDays },
      folds: foldRows,
      alphaPerHorizon: alphaEach,
      verdict,
    });
  }
  return results;
}

// ---------- text report ----------
const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? "n/a" : x.toFixed(d));
export function renderReport(results: any[], cfg: EvalConfig, meta: { symbols: string[]; firstT: number; lastT: number }): string {
  const L: string[] = [];
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + "Z";
  L.push(`WALK-FORWARD EVALUATION (${cfg.mode === "final" ? "LOCKED HOLDOUT" : "development data only; holdout untouched"})`);
  L.push(`symbols ${meta.symbols.join(",")} | ${cfg.tfMin}m candles | data ${iso(meta.firstT)} -> ${iso(meta.lastT)} | holdout starts ${iso(cfg.holdoutStartT)}`);
  L.push(`costs per side: fee ${cfg.costs.feePct}% + slippage ${cfg.costs.slippagePct}% | delay ${cfg.costs.delayCandles} candle(s) | round trip ${roundTripCostPct(cfg.costs).toFixed(2)}% | rule params fixed, nothing tuned`);
  for (const r of results) {
    L.push("");
    L.push(`=== horizon ${r.horizonMin} min ===`);
    if (r.error) {
      L.push(`  ${r.error}`);
      continue;
    }
    L.push(`  forecast samples ${r.samples} | actual UP ${f(r.classBalance.UP * 100, 1)}% DOWN ${f(r.classBalance.DOWN * 100, 1)}% SIDEWAYS ${f(r.classBalance.SIDEWAYS * 100, 1)}%`);
    L.push(`  rule calls: ${r.ruleCalls.UP} UP, ${r.ruleCalls.DOWN} DOWN | precision UP ${f(r.confusion.precisionUp !== null ? r.confusion.precisionUp * 100 : null, 1)}% (base ${f(r.confusion.baseRate.UP * 100, 1)}%), DOWN ${f(r.confusion.precisionDown !== null ? r.confusion.precisionDown * 100 : null, 1)}% (base ${f(r.confusion.baseRate.DOWN * 100, 1)}%)`);
    L.push(`  confusion (rows = call, cols = actual UP/DOWN/SIDEWAYS): UP ${Object.values(r.confusion.matrix.UP).join("/")} | DOWN ${Object.values(r.confusion.matrix.DOWN).join("/")} | NONE ${Object.values(r.confusion.matrix.NONE).join("/")}`);
    L.push(`  majority-class accuracy ${f(r.majority.accuracy * 100, 1)}% | Brier train-frequency ${f(r.probScores.trainFrequency.brier)} vs uniform ${f(r.probScores.uniform.brier)} | log loss ${f(r.probScores.trainFrequency.logLoss)} vs ${f(r.probScores.uniform.logLoss)}`);
    L.push(`  (the rule outputs no probabilities, so Brier/log loss/calibration are reported for baselines only until a probability model exists)`);
    L.push(`  net after costs, per trade (${"lower bound = one-sided, day-clustered bootstrap, alpha " + f(r.alphaPerHorizon, 4)}):`);
    for (const [name, s] of Object.entries<any>(r.strategies)) {
      L.push(`    ${name.padEnd(17)} trades ${String(s.trades).padStart(4)} | mean ${f(s.meanNetPct)}% (gross ${f(s.meanGrossPct)}%) | lower ${f(s.lowerBoundNetPct)}% | win ${f(s.winRatePct, 1)}% | equity ${f(s.finalReturnPct, 2)}% @${cfg.equityFraction * 100}% sizing, max DD ${f(s.maxDrawdownPct, 2)}%`);
    }
    L.push(`    buy-and-hold      net ${f(r.buyAndHold.netPctSumAcrossSymbols, 2)}% summed over symbols and test blocks (${f(r.buyAndHold.symbolDays, 1)} symbol-days)`);
    L.push(`  per-fold rule: ${r.folds.map((x: any) => `${iso(x.from).slice(5, 10)}:${x.ruleTrades}t/${f(x.ruleMeanNetPct, 2)}%`).join("  ")}`);
    L.push(`  VERDICT: ${r.verdict}`);
  }
  L.push("");
  L.push(`Tested ${results.length} horizon(s); the error rate is split across them. No asset, horizon or date range was selected after seeing results.`);
  return L.join("\n");
}

// Replay backtest for the retest-scalp rule. Pure functions, no network. RESEARCH / PAPER ONLY.
//
// Question answered: do confirmed bounces off repeatedly-tested zones beat a coin-flip direction at the same
// times, after taker entry, stops, slippage, spread, fees, funding and alert delay? And does the retest count
// matter at all? Arms with minPriorBounces 0,1,2,3 are reported side by side with the SAME other rules.
//
// Causality: signals at candle k use only candles <= k (higher-timeframe buckets are used only once fully
// elapsed). The rule has no fitted parameters, so there is nothing to tune on the data: the walk-forward element
// is chronological folds for stability plus a locked holdout scored once.
import type { Candle } from "../lib/types";
import {
  ZONE_DEFAULTS, TRIGGER_DEFAULTS, COSTS_PLACEHOLDER, buildZones, evaluateTrigger, inCooldown, resample,
  type Costs, type Setup, type SkipReason, type TriggerParams, type ZoneParams,
} from "../lib/retest.ts";
import { clusterBootstrap, mulberry32 } from "./core.ts";

export interface RetestEvalConfig {
  ltfMin: number;
  htfMin: number;
  zone: ZoneParams;
  trig: TriggerParams;
  costs: Costs;
  delayCandles: number; // alert + human/execution delay in trigger-timeframe candles after the confirming close
  maxHoldCandles: number;
  holdoutStartT: number;
  mode: "dev" | "final";
  arms: number[]; // minPriorBounces values compared side by side
  primaryArm: number; // the pre-declared arm the verdict is about
  minTrades: number;
  alpha: number;
  seed: number;
  riskPct: number; // equity risk per trade, for the equity curve
  folds: number;
}
export const DEFAULT_RETEST_EVAL: Omit<RetestEvalConfig, "holdoutStartT"> = {
  ltfMin: 5, htfMin: 60, zone: ZONE_DEFAULTS, trig: TRIGGER_DEFAULTS, costs: COSTS_PLACEHOLDER,
  delayCandles: 1, maxHoldCandles: 48, mode: "dev", arms: [0, 1, 2, 3], primaryArm: 2, minTrades: 100, alpha: 0.05, seed: 7, riskPct: 1, folds: 4,
};

export type Regime = "trending" | "ranging";
export interface ReplaySetup extends Setup {
  k: number; // index of the confirming candle
  regime: Regime;
  highVol: boolean;
}
const efficiency = (c: Candle[], n: number) => {
  if (c.length <= n) return NaN;
  const s = c.slice(-n - 1);
  let path = 0;
  for (let i = 1; i < s.length; i++) path += Math.abs(s[i].c - s[i - 1].c);
  return path > 0 ? Math.abs(s[s.length - 1].c - s[0].c) / path : 0;
};

// All raw (pre-cooldown) setups for one symbol at one minPriorBounces value, plus a histogram of near-miss reasons.
export function replaySetups(ltf: Candle[], cfg: RetestEvalConfig, minPriorBounces: number, fromT = -Infinity) {
  const ltfMs = cfg.ltfMin * 60000;
  const htfMs = cfg.htfMin * 60000;
  const htfAll = resample(ltf, htfMs, Infinity);
  const zp = { ...cfg.zone, minPriorBounces };
  const look = Math.max(cfg.trig.approachBars, cfg.trig.volLookback) + 2;
  const setups: ReplaySetup[] = [];
  const reasons: Partial<Record<SkipReason, number>> = {};
  let n = 0; // number of fully elapsed HTF buckets at candle k
  let built: ReturnType<typeof buildZones> | null = null;
  let regime: Regime = "ranging";
  let highVol = false;
  const atrPcts: number[] = [];
  for (let k = 0; k < ltf.length; k++) {
    const closeT = ltf[k].t + ltfMs;
    let moved = false;
    while (n < htfAll.length && htfAll[n].t + htfMs <= closeT) {
      n++;
      moved = true;
    }
    if (moved) {
      const hist = htfAll.slice(0, n);
      built = buildZones(hist, zp);
      const er = efficiency(hist, 24);
      regime = er >= 0.35 ? "trending" : "ranging";
      if (Number.isFinite(built.atrNow) && hist.length) {
        const pct = (built.atrNow / hist[hist.length - 1].c) * 100;
        atrPcts.push(pct);
        const med = [...atrPcts.slice(-200)].sort((a, b) => a - b)[Math.floor(Math.min(atrPcts.length, 200) / 2)];
        highVol = pct > med;
      }
    }
    if (!built || !built.zones.length || k < 1 || closeT < fromT) continue; // state above is kept; nothing is emitted or counted before fromT
    const r = evaluateTrigger(built.zones, built.atrNow, ltf.slice(Math.max(0, k - look), k + 1), ltfMs, zp, cfg.trig, cfg.costs);
    for (const s of r.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
    if (r.setup) setups.push({ ...r.setup, k, regime, highVol });
  }
  return { setups, reasons };
}

export interface RetestTrade {
  setupCloseT: number;
  closeT: number; // exit time
  dir: 1 | -1;
  grossPct: number;
  netPct: number;
  netR: number; // net result in units of the setup's cost-inclusive risk
  priorBounces: number;
  regime: Regime;
  highVol: boolean;
  exit: "target" | "stop" | "time";
}

const marketPct = (c: Costs) => (c.slippagePct + c.spreadPct / 2) / 100;

// Enter at the OPEN of candle k + 1 + delay (market, adverse slippage + half spread). Stop is a market order.
// If stop and target both lie inside one candle, the STOP is assumed to fill first (conservative). A candle that
// opens beyond a level fills at the open (gap risk). One position at a time. Trades that would span a data gap
// are dropped and counted, never patched.
export function simulateSetups(candles: Candle[], setups: ReplaySetup[], cfg: RetestEvalConfig) {
  const ltfMs = cfg.ltfMin * 60000;
  const c = cfg.costs;
  const trades: RetestTrade[] = [];
  let freeFrom = -1;
  let blocked = 0;
  let gapDropped = 0;
  let late = 0;
  let unfinished = 0;
  for (const s of setups) {
    if (s.k < freeFrom) {
      blocked++;
      continue;
    }
    const e = s.k + 1 + cfg.delayCandles;
    if (e >= candles.length) continue;
    const long = s.dir === "long";
    const g = long ? 1 : -1;
    const entry = candles[e].o * (1 + g * marketPct(c));
    // the market ran past the stop or already reached the target during the delay: no trade
    if (long ? entry <= s.stopPrice || entry >= s.targetPrice : entry >= s.stopPrice || entry <= s.targetPrice) {
      late++;
      continue;
    }
    let exitPx = NaN;
    let exitJ = -1;
    let why: RetestTrade["exit"] = "time";
    let gap = false;
    const fullWindow = e + cfg.maxHoldCandles - 1 <= candles.length - 1;
    const last = Math.min(candles.length - 1, e + cfg.maxHoldCandles - 1);
    for (let j = e; j <= last; j++) {
      if (j > s.k && candles[j].t - candles[j - 1].t !== ltfMs) {
        gap = true;
        break;
      }
      const x = candles[j];
      const stopHit = long ? x.l <= s.stopPrice : x.h >= s.stopPrice;
      const tgtHit = long ? x.h >= s.targetPrice : x.l <= s.targetPrice;
      if (stopHit) {
        const raw = long ? Math.min(s.stopPrice, x.o) : Math.max(s.stopPrice, x.o);
        exitPx = raw * (1 - g * marketPct(c));
        exitJ = j;
        why = "stop";
        break;
      }
      if (tgtHit) {
        exitPx = c.targetFill === "maker" ? s.targetPrice : s.targetPrice * (1 - g * marketPct(c));
        exitJ = j;
        why = "target";
        break;
      }
      if (j === last && fullWindow) {
        exitPx = x.c * (1 - g * marketPct(c));
        exitJ = j;
      }
    }
    if (gap) {
      gapDropped++;
      continue;
    }
    if (exitJ < 0) {
      unfinished++; // the data ends before the trade could resolve: never force-closed, never counted
      continue;
    }
    const grossPct = g * (exitPx / entry - 1) * 100;
    const exitFee = why === "target" && c.targetFill === "maker" ? c.makerFeePct : c.takerFeePct;
    const netPct = grossPct - c.takerFeePct - exitFee - c.fundingPct;
    trades.push({
      setupCloseT: s.closeT,
      closeT: candles[exitJ].t + ltfMs,
      dir: g,
      grossPct,
      netPct,
      netR: s.economics.netLossPct > 0 ? netPct / s.economics.netLossPct : 0,
      priorBounces: s.priorBounces,
      regime: s.regime,
      highVol: s.highVol,
      exit: why,
    });
    freeFrom = exitJ + 1;
  }
  return { trades, blocked, gapDropped, late, unfinished };
}

// Same setups, same stop/target distances, but a seeded coin-flip direction: the "no information" benchmark.
export function randomDirection(setups: ReplaySetup[], seed: number): ReplaySetup[] {
  const rnd = mulberry32(seed);
  return setups.map((s) => {
    if (rnd() < 0.5) return s;
    const long = s.dir !== "long";
    const stopD = s.stopPct / 100;
    const tgtD = s.targetPct / 100;
    return { ...s, dir: long ? "long" : "short", stopPrice: long ? s.refPrice * (1 - stopD) : s.refPrice * (1 + stopD), targetPrice: long ? s.refPrice * (1 + tgtD) : s.refPrice * (1 - tgtD) };
  });
}

export function summarize(trades: RetestTrade[], riskPct: number, alpha: number) {
  const n = trades.length;
  const sorted = [...trades].sort((a, b) => a.closeT - b.closeT);
  const wins = sorted.filter((t) => t.netPct > 0);
  const losses = sorted.filter((t) => t.netPct <= 0);
  const ci = clusterBootstrap(sorted.map((t) => ({ closeT: t.closeT, netPct: t.netPct })), alpha);
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const t of sorted) {
    eq *= Math.max(0, 1 + (riskPct / 100) * t.netR);
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak);
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    trades: n,
    winRatePct: n ? (wins.length / n) * 100 : null,
    avgWinPct: avg(wins.map((t) => t.netPct)),
    avgLossPct: avg(losses.map((t) => t.netPct)),
    expectancyNetPct: n ? ci.mean : null,
    expectancyNetR: avg(sorted.map((t) => t.netR)),
    lowerBoundNetPct: n ? ci.lower : null,
    days: ci.days,
    exits: { target: sorted.filter((t) => t.exit === "target").length, stop: sorted.filter((t) => t.exit === "stop").length, time: sorted.filter((t) => t.exit === "time").length },
    equityReturnPct: (eq - 1) * 100,
    maxDrawdownPct: dd * 100,
  };
}

export interface RetestData {
  symbol: string;
  candles: Candle[];
}

export function runRetestEval(data: RetestData[], cfg: RetestEvalConfig) {
  const ltfMs = cfg.ltfMin * 60000;
  const alphaEach = cfg.alpha / cfg.arms.length;
  const arms = [];
  for (const arm of cfg.arms) {
    const trades: RetestTrade[] = [];
    const rand: RetestTrade[] = [];
    const reasons: Partial<Record<SkipReason, number>> = {};
    let raw = 0;
    let duplicates = 0;
    let blocked = 0;
    let gapDropped = 0;
    let late = 0;
    let unfinished = 0;
    for (const d of data) {
      // Development mode cannot even see holdout candles; final mode scores only setups confirmed inside the holdout.
      const cs = cfg.mode === "dev" ? d.candles.filter((x) => x.t + ltfMs <= cfg.holdoutStartT) : d.candles;
      if (cs.length < 2) continue;
      const rep = replaySetups(cs, cfg, arm, cfg.mode === "final" ? cfg.holdoutStartT : -Infinity);
      for (const [r, v] of Object.entries(rep.reasons)) reasons[r as SkipReason] = (reasons[r as SkipReason] ?? 0) + (v ?? 0);
      raw += rep.setups.length;
      const kept: ReplaySetup[] = [];
      for (const s of rep.setups) {
        if (inCooldown(kept, s, cfg.trig.cooldownMin)) duplicates++;
        else kept.push(s);
      }
      const sim = simulateSetups(cs, kept, cfg);
      const sr = simulateSetups(cs, randomDirection(kept, cfg.seed + arm), cfg);
      blocked += sim.blocked;
      gapDropped += sim.gapDropped;
      late += sim.late;
      unfinished += sim.unfinished;
      trades.push(...sim.trades);
      rand.push(...sr.trades);
    }
    // chronological folds inside the evaluated period, for stability
    const times = trades.map((t) => t.closeT).sort((a, b) => a - b);
    const folds = [];
    if (times.length >= cfg.folds * 5) {
      for (let f = 0; f < cfg.folds; f++) {
        const lo = times[Math.floor((f * times.length) / cfg.folds)];
        const hi = f === cfg.folds - 1 ? Infinity : times[Math.floor(((f + 1) * times.length) / cfg.folds)];
        const part = trades.filter((t) => t.closeT >= lo && t.closeT < hi);
        folds.push({ from: lo, trades: part.length, expectancyNetPct: part.length ? part.reduce((a, t) => a + t.netPct, 0) / part.length : null });
      }
    }
    const group = (key: (t: RetestTrade) => string) => {
      const o: Record<string, ReturnType<typeof summarize>> = {};
      for (const k of new Set(trades.map(key))) o[k] = summarize(trades.filter((t) => key(t) === k), cfg.riskPct, alphaEach);
      return o;
    };
    arms.push({
      minPriorBounces: arm,
      rawSetups: raw,
      duplicatesSuppressed: duplicates,
      blockedByOpenPosition: blocked,
      droppedForDataGap: gapDropped,
      missedDuringDelay: late,
      unfinishedAtDataEnd: unfinished,
      nearMissReasons: reasons,
      stats: summarize(trades, cfg.riskPct, alphaEach),
      randomDirection: summarize(rand, cfg.riskPct, alphaEach),
      byRegime: group((t) => t.regime),
      byVolatility: group((t) => (t.highVol ? "high_vol" : "low_vol")),
      byDirection: group((t) => (t.dir === 1 ? "long" : "short")),
      folds,
    });
  }
  const p = arms.find((a) => a.minPriorBounces === cfg.primaryArm) ?? arms[arms.length - 1];
  const s = p.stats;
  let verdict: string;
  if (s.trades < cfg.minTrades) verdict = `INSUFFICIENT DATA: ${s.trades} trades in the primary arm (need ${cfg.minTrades}). No claim either way.`;
  else if (!(s.lowerBoundNetPct! > 0)) verdict = `NO EDGE DEMONSTRATED: net expectancy ${s.expectancyNetPct!.toFixed(3)}% per trade, lower bound ${s.lowerBoundNetPct!.toFixed(3)}% (not above 0 at the adjusted level).`;
  else if (!(s.expectancyNetPct! > (p.randomDirection.expectancyNetPct ?? -Infinity))) verdict = "POSITIVE BUT NOT BETTER THAN A COIN-FLIP DIRECTION at the same times.";
  else verdict = "PASSES ON THIS SAMPLE: net lower bound above 0 and above the coin-flip baseline. Evidence, not a guarantee; confirm forward on fresh data.";
  return { arms, primaryArm: cfg.primaryArm, verdict, alphaPerArm: alphaEach, ltfMs };
}

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? "n/a" : x.toFixed(d));
export function renderRetestReport(res: ReturnType<typeof runRetestEval>, cfg: RetestEvalConfig, meta: { symbols: string[]; firstT: number; lastT: number }) {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + "Z";
  const c = cfg.costs;
  const L: string[] = [];
  L.push(`RETEST-SCALP REPLAY (${cfg.mode === "final" ? "LOCKED HOLDOUT" : "development data only; holdout untouched"})`);
  L.push(`symbols ${meta.symbols.join(",")} | zones ${cfg.htfMin}m, trigger ${cfg.ltfMin}m | data ${iso(meta.firstT)} -> ${iso(meta.lastT)} | holdout starts ${iso(cfg.holdoutStartT)}`);
  L.push(`costs: taker ${c.takerFeePct}% maker ${c.makerFeePct}% slippage ${c.slippagePct}% spread ${c.spreadPct}% funding ${c.fundingPct}% | target fill ${c.targetFill} | delay ${cfg.delayCandles} candle(s) | target ${cfg.trig.targetPct}% | max hold ${cfg.maxHoldCandles} candles`);
  L.push(`FEES ABOVE ARE PLACEHOLDERS unless you set them (--taker --maker --slip --spread --funding). Results are only as true as these numbers.`);
  L.push(`rule parameters fixed in advance; nothing was tuned on this data. Arms differ ONLY in the required number of prior bounces. Primary arm (declared before looking): ${res.primaryArm}.`);
  for (const a of res.arms) {
    const s = a.stats;
    L.push("");
    L.push(`=== minPriorBounces ${a.minPriorBounces}${a.minPriorBounces === res.primaryArm ? "  (PRIMARY)" : ""} ===`);
    L.push(`  raw setups ${a.rawSetups} | duplicates suppressed ${a.duplicatesSuppressed} | blocked (position open) ${a.blockedByOpenPosition} | missed in delay ${a.missedDuringDelay} | dropped for data gap ${a.droppedForDataGap} | unfinished at data end ${a.unfinishedAtDataEnd}`);
    L.push(`  near-misses by reason: ${Object.entries(a.nearMissReasons).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    L.push(`  trades ${s.trades} | win ${f(s.winRatePct, 1)}% | avg win ${f(s.avgWinPct)}% | avg loss ${f(s.avgLossPct)}% | exits target/stop/time ${s.exits.target}/${s.exits.stop}/${s.exits.time}`);
    L.push(`  expectancy net ${f(s.expectancyNetPct)}% per trade (${f(s.expectancyNetR, 2)} R) | lower bound ${f(s.lowerBoundNetPct)}% | equity ${f(s.equityReturnPct, 2)}% at ${cfg.riskPct}% risk, max DD ${f(s.maxDrawdownPct, 2)}%`);
    L.push(`  coin-flip direction, same times: trades ${a.randomDirection.trades} | expectancy ${f(a.randomDirection.expectancyNetPct)}% | win ${f(a.randomDirection.winRatePct, 1)}%`);
    for (const [name, grp] of [["regime", a.byRegime], ["volatility", a.byVolatility], ["direction", a.byDirection]] as const) {
      L.push(`  by ${name}: ${Object.entries(grp).map(([k, v]) => `${k} ${v.trades}t/${f(v.expectancyNetPct, 2)}%`).join("  ") || "none"}`);
    }
    if (a.folds.length) L.push(`  folds: ${a.folds.map((x) => `${iso(x.from).slice(5, 10)}:${x.trades}t/${f(x.expectancyNetPct, 2)}%`).join("  ")}`);
  }
  L.push("");
  L.push(`VERDICT (primary arm): ${res.verdict}`);
  L.push(`${res.arms.length} arms were compared; the error rate is split across them (alpha ${f(res.alphaPerArm, 4)} each). Slices (regime/volatility/direction) are descriptive only: a slice that looks good is a hypothesis for fresh data, not a finding.`);
  return L.join("\n");
}

// Retest-scalp setup detection. PURE: no network, no database, no clock. RESEARCH / PAPER ONLY.
//
// Idea being tested (not assumed true): after price has bounced off a support/resistance ZONE more than once,
// a confirmed rejection on a small timeframe may offer a small scalp. Repeated tests might make a level more
// significant, less significant, or irrelevant; the replay backtest (eval/retest.ts) is what decides.
//
// Everything is causal: a function only ever reads candles it is handed, and callers hand it CLOSED candles only.
// Only type imports here, so the file runs under plain node for tests and under Next for the app.
import type { Candle } from "./types";

// ============================ economics ============================
export interface Costs {
  takerFeePct: number; // per market fill, % of notional. PLACEHOLDER until you enter your real tier.
  makerFeePct: number; // per resting limit fill, %
  slippagePct: number; // adverse slippage per market fill, %
  spreadPct: number; // full quoted spread, %; half is paid on each market fill
  targetFill: "maker" | "taker"; // is the profit target a resting limit (maker) or a market order (taker)?
  fundingPct: number; // expected funding paid over the hold, % (0 for spot; signed: positive = cost)
}
// NOT real exchange fees. Overwrite with the values from your own fee page before trusting any output.
export const COSTS_PLACEHOLDER: Costs = { takerFeePct: 0.1, makerFeePct: 0.1, slippagePct: 0.03, spreadPct: 0.01, targetFill: "taker", fundingPct: 0 };

export interface Economics {
  entryCostPct: number;
  stopExitCostPct: number;
  targetExitCostPct: number;
  netWinPct: number; // what a winner actually keeps
  netLossPct: number; // what a loser actually loses
  netRR: number; // netWin / netLoss
  breakEvenWinRate: number; // win rate needed for zero expectancy
}

const marketCost = (c: Costs) => c.takerFeePct + c.slippagePct + c.spreadPct / 2;

// Entry is always a market order (user's stated method). Stop exit is a market order. Percentages are of entry notional.
export function tradeEconomics(stopPct: number, targetPct: number, c: Costs): Economics {
  const entryCostPct = marketCost(c);
  const stopExitCostPct = marketCost(c);
  const targetExitCostPct = c.targetFill === "maker" ? c.makerFeePct : marketCost(c);
  const netWinPct = targetPct - entryCostPct - targetExitCostPct - c.fundingPct;
  const netLossPct = stopPct + entryCostPct + stopExitCostPct + c.fundingPct;
  const netRR = netLossPct > 0 ? netWinPct / netLossPct : 0;
  const breakEvenWinRate = netWinPct > 0 ? netLossPct / (netWinPct + netLossPct) : 1;
  return { entryCostPct, stopExitCostPct, targetExitCostPct, netWinPct, netLossPct, netRR, breakEvenWinRate };
}
export const expectancyPct = (winRate: number, e: Economics) => winRate * e.netWinPct - (1 - winRate) * e.netLossPct;

// Size so that a stop-out loses `riskPct` of equity INCLUDING costs, then cap by leverage and notional share.
export function positionSize(o: { equity: number; riskPct: number; netLossPct: number; maxLeverage: number; maxNotionalPctOfEquity?: number }) {
  if (!(o.equity > 0) || !(o.netLossPct > 0)) return { notional: 0, marginUsed: 0, riskUsd: 0, cappedBy: "invalid input" as string | null };
  const riskUsd = (o.equity * o.riskPct) / 100;
  let notional = riskUsd / (o.netLossPct / 100);
  let cappedBy: string | null = null;
  const levCap = o.equity * Math.max(0, o.maxLeverage);
  if (notional > levCap) {
    notional = levCap;
    cappedBy = "leverage";
  }
  if (o.maxNotionalPctOfEquity !== undefined) {
    const cap = (o.equity * o.maxNotionalPctOfEquity) / 100;
    if (notional > cap) {
      notional = cap;
      cappedBy = "max notional";
    }
  }
  return { notional, marginUsed: o.maxLeverage > 0 ? notional / o.maxLeverage : notional, riskUsd: (notional * o.netLossPct) / 100, cappedBy };
}

// ============================ resampling ============================
// Builds larger candles (e.g. 1h -> 4h) on UTC-aligned boundaries. A bucket is included only once it has fully
// elapsed (bucketEnd <= asOf). Exchanges omit empty candles, so missing constituents are tolerated.
export function resample(c: Candle[], toMs: number, asOf: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curStart = -1;
  for (const x of c) {
    const b = Math.floor(x.t / toMs) * toMs;
    if (b !== curStart) {
      if (cur) out.push(cur);
      curStart = b;
      cur = { t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v };
    } else if (cur) {
      cur.h = Math.max(cur.h, x.h);
      cur.l = Math.min(cur.l, x.l);
      cur.c = x.c;
      cur.v += x.v;
    }
  }
  if (cur) out.push(cur);
  return out.filter((b) => b.t + toMs <= asOf);
}

// ============================ indicators / pivots ============================
export function atrSeries(c: Candle[], n: number): number[] {
  const out = new Array(c.length).fill(NaN);
  if (c.length <= n) return out;
  const tr = (i: number) => Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr(i);
  a /= n;
  out[n] = a;
  for (let i = n + 1; i < c.length; i++) {
    a = (a * (n - 1) + tr(i)) / n;
    out[i] = a;
  }
  return out;
}

export interface Pivot {
  i: number;
  t: number;
  price: number;
  kind: "high" | "low";
}
// A pivot at i needs `k` candles on each side, so it is only known k candles later (no look-ahead).
export function findPivots(c: Candle[], k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true;
    let lo = true;
    for (let j = 1; j <= k && (hi || lo); j++) {
      if (!(c[i].h > c[i - j].h && c[i].h >= c[i + j].h)) hi = false;
      if (!(c[i].l < c[i - j].l && c[i].l <= c[i + j].l)) lo = false;
    }
    if (hi) out.push({ i, t: c[i].t, price: c[i].h, kind: "high" });
    if (lo) out.push({ i, t: c[i].t, price: c[i].l, kind: "low" });
  }
  return out;
}

// ============================ zones and visits ============================
export interface ZoneParams {
  pivotBars: number; // candles each side that define a swing pivot
  atrPeriod: number;
  bandAtr: number; // pivots within 2 * bandAtr * ATR of each other form one zone
  minWidthAtr: number; // a zone is never thinner than this many ATR
  padAtr: number; // padding added around the pivot extremes
  leaveAtr: number; // price must get this many ATR clear of the zone to count as having left it
  minAwayBars: number; // ...for at least this many consecutive candles, otherwise it is still the same visit
  maxAgeBars: number; // only the most recent N higher-timeframe candles are used
  minPriorBounces: number; // completed bounces (same side, since the last break) required before a setup may fire
  breakAtr: number; // an LTF wick deeper than this beyond the far edge means the zone is failing: no setup
}
export const ZONE_DEFAULTS: ZoneParams = { pivotBars: 3, atrPeriod: 14, bandAtr: 0.35, minWidthAtr: 0.3, padAtr: 0.05, leaveAtr: 0.75, minAwayBars: 2, maxAgeBars: 500, minPriorBounces: 2, breakAtr: 0.25 };

export interface Visit {
  startIdx: number;
  endIdx: number | null;
  approach: "above" | "below"; // above = came down onto it (support test); below = came up into it (resistance test)
  outcome: "bounce" | "break" | "open";
  reactionAtr: number; // furthest move away after a bounce, in ATR
}
export interface Zone {
  low: number;
  high: number;
  mid: number;
  firstIdx: number;
  pivots: number;
  visits: Visit[];
}

function findVisits(w: Candle[], z: { low: number; high: number }, atr: number[], p: ZoneParams, startIdx: number, initSide: "above" | "below"): Visit[] {
  const visits: Visit[] = [];
  let cur: Visit | null = null;
  let awaySide: "above" | "below" | null = null;
  let awayRun = 0;
  let separated = true;
  let lastSide = initSide;
  for (let i = Math.max(startIdx, p.atrPeriod); i < w.length; i++) {
    const c = w[i];
    const a = atr[i];
    if (!Number.isFinite(a)) continue;
    const sd: "above" | "below" | null = c.l - z.high >= p.leaveAtr * a ? "above" : z.low - c.h >= p.leaveAtr * a ? "below" : null;
    const overlap = c.l <= z.high && c.h >= z.low;
    if (!cur) {
      if (overlap && separated) {
        cur = { startIdx: i, endIdx: null, approach: lastSide, outcome: "open", reactionAtr: 0 };
        visits.push(cur);
        separated = false;
        awayRun = 0;
        awaySide = null;
      } else {
        const last = visits[visits.length - 1];
        if (last && last.outcome === "bounce") {
          const ex = last.approach === "above" ? (c.h - z.high) / a : (z.low - c.l) / a;
          if (ex > last.reactionAtr) last.reactionAtr = ex;
        }
        if (sd) lastSide = sd;
        continue;
      }
    }
    if (sd) {
      if (sd === awaySide) awayRun++;
      else {
        awaySide = sd;
        awayRun = 1;
      }
    } else {
      awaySide = null;
      awayRun = 0;
    }
    if (awayRun >= p.minAwayBars && awaySide) {
      cur.endIdx = i;
      cur.outcome = awaySide === cur.approach ? "bounce" : "break";
      cur.reactionAtr = Math.max(cur.reactionAtr, p.leaveAtr);
      lastSide = awaySide;
      cur = null;
      separated = true;
    }
  }
  return visits;
}

// Zones from CLOSED higher-timeframe candles (ascending). Only the newest maxAgeBars are used.
export function buildZones(htf: Candle[], p: ZoneParams): { zones: Zone[]; atrNow: number } {
  const w = htf.slice(-p.maxAgeBars);
  const atr = atrSeries(w, p.atrPeriod);
  const atrNow = atr[w.length - 1];
  if (!Number.isFinite(atrNow) || !(atrNow > 0)) return { zones: [], atrNow: NaN };
  const piv = findPivots(w, p.pivotBars).filter((x) => x.i >= p.atrPeriod);
  if (!piv.length) return { zones: [], atrNow };
  const sorted = [...piv].sort((a, b) => a.price - b.price);
  const width = 2 * p.bandAtr * atrNow;
  const groups: Pivot[][] = [];
  let g: Pivot[] = [sorted[0]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].price - g[0].price <= width) g.push(sorted[k]);
    else {
      groups.push(g);
      g = [sorted[k]];
    }
  }
  groups.push(g);

  const zones: Zone[] = [];
  for (const grp of groups) {
    let lo = Math.min(...grp.map((x) => x.price)) - p.padAtr * atrNow;
    let hi = Math.max(...grp.map((x) => x.price)) + p.padAtr * atrNow;
    const minW = p.minWidthAtr * atrNow;
    if (hi - lo < minW) {
      const m = (hi + lo) / 2;
      lo = m - minW / 2;
      hi = m + minW / 2;
    }
    const first = grp.reduce((a, b) => (b.i < a.i ? b : a));
    const prev = first.i > 0 ? w[first.i - 1].c : first.price;
    const init: "above" | "below" = prev > hi ? "above" : prev < lo ? "below" : first.kind === "low" ? "above" : "below";
    zones.push({ low: lo, high: hi, mid: (lo + hi) / 2, firstIdx: first.i, pivots: grp.length, visits: findVisits(w, { low: lo, high: hi }, atr, p, first.i, init) });
  }
  return { zones, atrNow };
}

// Completed bounces for one approach side, counting only those after the zone's most recent break.
export function priorBounces(z: Zone, approach: "above" | "below") {
  let lastBreak = -1;
  for (const v of z.visits) if (v.outcome === "break" && v.endIdx !== null) lastBreak = Math.max(lastBreak, v.endIdx);
  const b = z.visits.filter((v) => v.outcome === "bounce" && v.approach === approach && (v.endIdx ?? -1) > lastBreak);
  return { n: b.length, avgReactionAtr: b.length ? b.reduce((s, v) => s + v.reactionAtr, 0) / b.length : 0 };
}

// ============================ trigger ============================
export interface TriggerParams {
  closeBufferPct: number; // the rejection candle must close this far clear of the zone edge
  minWickFrac: number; // rejection wick as a fraction of the candle's range
  requireDirectionalClose: boolean; // long: close > open, short: close < open
  volMult: number; // 0 = off; otherwise candle volume must be >= volMult * median of the previous volLookback candles
  volLookback: number;
  approachBars: number; // price must have been clearly on the approach side within this many trigger-timeframe candles
  maxChasePct: number; // skip if the close is already this far from the zone edge (the move has happened)
  stopBufferPct: number; // stop sits this far beyond the far zone edge (or the rejection wick, whichever is further)
  minStopPct: number;
  maxStopPct: number;
  targetPct: number; // gross target, % of entry
  minNetRR: number; // after costs
  cooldownMin: number;
}
export const TRIGGER_DEFAULTS: TriggerParams = { closeBufferPct: 0.03, minWickFrac: 0.35, requireDirectionalClose: true, volMult: 0, volLookback: 20, approachBars: 48, maxChasePct: 0.35, stopBufferPct: 0.1, minStopPct: 0.25, maxStopPct: 1.0, targetPct: 1.0, minNetRR: 1.0, cooldownMin: 60 };

export interface Setup {
  dir: "long" | "short";
  triggerT: number; // open time of the confirming candle
  closeT: number; // when it closed = earliest moment the setup was knowable
  refPrice: number;
  zoneLow: number;
  zoneHigh: number;
  priorBounces: number;
  avgReactionAtr: number;
  atrHtf: number;
  stopPrice: number;
  targetPrice: number;
  stopPct: number;
  targetPct: number;
  invalidationPrice: number; // a close beyond this voids the setup
  wickFrac: number;
  volRatio: number | null;
  economics: Economics;
  evidence: string;
}
export type SkipReason = "no_approach" | "too_few_bounces" | "no_rejection_shape" | "low_volume" | "chased" | "stop_too_tight" | "stop_too_wide" | "costs_kill_rr" | "zone_failing";
export interface Skip {
  reason: SkipReason;
  zoneLow: number;
  zoneHigh: number;
  dir: "long" | "short";
  detail: string;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

// Looks only at the NEWEST candle of `ltf` (all candles must be closed). Returns the best setup (most prior
// bounces, then tightest stop) plus every near-miss with its reason, so "why no alert?" always has an answer.
export function evaluateTrigger(zones: Zone[], atrHtf: number, ltf: Candle[], ltfMs: number, zp: ZoneParams, tp: TriggerParams, costs: Costs): { setup: Setup | null; skipped: Skip[] } {
  const skipped: Skip[] = [];
  const k = ltf.length - 1;
  if (k < 1 || !(atrHtf > 0)) return { setup: null, skipped };
  const c = ltf[k];
  const range = c.h - c.l;
  const found: Setup[] = [];
  for (const z of zones) {
    for (const dir of ["long", "short"] as const) {
      const long = dir === "long";
      // does this candle test the zone from the right side and close back out of it?
      const touches = long ? c.l <= z.high && c.c > z.high : c.h >= z.low && c.c < z.low;
      if (!touches) continue;
      const skip = (reason: SkipReason, detail: string) => skipped.push({ reason, zoneLow: z.low, zoneHigh: z.high, dir, detail });
      const edge = long ? z.high : z.low;
      const closeClear = long ? c.c >= edge * (1 + tp.closeBufferPct / 100) : c.c <= edge * (1 - tp.closeBufferPct / 100);
      if (!closeClear) continue; // closed inside / too near the edge: not a confirmation, not worth a log line
      if (long ? c.l < z.low - zp.breakAtr * atrHtf : c.h > z.high + zp.breakAtr * atrHtf) {
        skip("zone_failing", "wick went through the far edge by more than the break allowance");
        continue;
      }
      let approached = false;
      for (let j = Math.max(0, k - tp.approachBars); j < k && !approached; j++) {
        approached = long ? ltf[j].l - z.high >= zp.leaveAtr * atrHtf : z.low - ltf[j].h >= zp.leaveAtr * atrHtf;
      }
      if (!approached) {
        skip("no_approach", `price was not clearly ${long ? "above" : "below"} the zone in the last ${tp.approachBars} candles`);
        continue;
      }
      const pb = priorBounces(z, long ? "above" : "below");
      if (pb.n < zp.minPriorBounces) {
        skip("too_few_bounces", `${pb.n} completed bounce(s), need ${zp.minPriorBounces}`);
        continue;
      }
      const wick = range > 0 ? (long ? Math.min(c.o, c.c) - c.l : c.h - Math.max(c.o, c.c)) / range : 0;
      const dirOk = !tp.requireDirectionalClose || (long ? c.c > c.o : c.c < c.o);
      if (!(wick >= tp.minWickFrac) || !dirOk) {
        skip("no_rejection_shape", `wick ${(wick * 100).toFixed(0)}% of range (need ${(tp.minWickFrac * 100).toFixed(0)}%)${dirOk ? "" : ", candle closed against the direction"}`);
        continue;
      }
      let volRatio: number | null = null;
      if (tp.volMult > 0) {
        const prev = ltf.slice(Math.max(0, k - tp.volLookback), k).map((x) => x.v);
        const m = median(prev);
        volRatio = m > 0 ? c.v / m : null;
        if (volRatio === null || volRatio < tp.volMult) {
          skip("low_volume", `volume ${volRatio === null ? "n/a" : volRatio.toFixed(2) + "x"} of recent median (need ${tp.volMult}x)`);
          continue;
        }
      }
      const chase = (Math.abs(c.c - edge) / edge) * 100;
      if (chase > tp.maxChasePct) {
        skip("chased", `close is already ${chase.toFixed(2)}% from the zone edge (limit ${tp.maxChasePct}%)`);
        continue;
      }
      const ref = c.c;
      const stop = long ? Math.min(z.low, c.l) * (1 - tp.stopBufferPct / 100) : Math.max(z.high, c.h) * (1 + tp.stopBufferPct / 100);
      const stopPct = (Math.abs(ref - stop) / ref) * 100;
      if (stopPct < tp.minStopPct) {
        skip("stop_too_tight", `stop ${stopPct.toFixed(2)}% away (min ${tp.minStopPct}%)`);
        continue;
      }
      if (stopPct > tp.maxStopPct) {
        skip("stop_too_wide", `stop ${stopPct.toFixed(2)}% away (max ${tp.maxStopPct}%)`);
        continue;
      }
      const eco = tradeEconomics(stopPct, tp.targetPct, costs);
      if (!(eco.netRR >= tp.minNetRR)) {
        skip("costs_kill_rr", `after costs a win keeps ${eco.netWinPct.toFixed(2)}% and a loss costs ${eco.netLossPct.toFixed(2)}% (net R:R ${eco.netRR.toFixed(2)}, need ${tp.minNetRR}; break-even win rate ${(eco.breakEvenWinRate * 100).toFixed(0)}%)`);
        continue;
      }
      found.push({
        dir,
        triggerT: c.t,
        closeT: c.t + ltfMs,
        refPrice: ref,
        zoneLow: z.low,
        zoneHigh: z.high,
        priorBounces: pb.n,
        avgReactionAtr: pb.avgReactionAtr,
        atrHtf,
        stopPrice: stop,
        targetPrice: long ? ref * (1 + tp.targetPct / 100) : ref * (1 - tp.targetPct / 100),
        stopPct,
        targetPct: tp.targetPct,
        invalidationPrice: stop,
        wickFrac: wick,
        volRatio,
        economics: eco,
        evidence: `Observed: ${pb.n} earlier bounce(s) off this zone (${z.low.toFixed(2)}-${z.high.toFixed(2)}); the last candle wicked into it and closed ${long ? "above" : "below"} it with a ${(wick * 100).toFixed(0)}% rejection wick. Inference: none calibrated; whether such bounces continue is what the backtest measures.`,
      });
    }
  }
  found.sort((a, b) => b.priorBounces - a.priorBounces || a.stopPct - b.stopPct);
  return { setup: found[0] ?? null, skipped };
}

// Alert/entry dedupe shared by the live engine and the replay: one setup per direction per overlapping zone per cooldown.
export function overlapsZone(a: { zoneLow: number; zoneHigh: number }, b: { zoneLow: number; zoneHigh: number }) {
  return a.zoneLow <= b.zoneHigh && b.zoneLow <= a.zoneHigh;
}
export function inCooldown(prev: { dir: string; closeT: number; zoneLow: number; zoneHigh: number }[], s: Setup, cooldownMin: number) {
  return prev.some((p) => p.dir === s.dir && s.closeT - p.closeT < cooldownMin * 60000 && overlapsZone(p, s));
}

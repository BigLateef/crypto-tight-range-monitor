// Pure paper-trading math. SIMULATION ONLY: nothing here talks to an exchange.
import type { Candle, Direction } from "./types";
import type { Settings } from "./config";

// Adverse slippage: buys fill higher, sells fill lower.
export function slipPrice(price: number, dir: Direction, leg: "entry" | "exit", slipPct: number): number {
  const buying = (dir === "long") === (leg === "entry");
  const f = slipPct / 100;
  return buying ? price * (1 + f) : price * (1 - f);
}

type LevelSettings = Pick<Settings, "stopMode" | "stopPct" | "targetMode" | "targetPct" | "targetR">;

export function levels(
  dir: Direction,
  fill: number,
  range: { high: number; low: number } | null,
  s: LevelSettings,
): { stop: number | null; target: number | null; error?: string } {
  let stop: number | null = null;
  if (s.stopMode === "pct") stop = dir === "long" ? fill * (1 - s.stopPct / 100) : fill * (1 + s.stopPct / 100);
  else if (s.stopMode === "range_edge") {
    if (!range) return { stop: null, target: null, error: "range missing for range-edge stop" };
    stop = dir === "long" ? range.high : range.low;
  }
  if (stop !== null && (dir === "long" ? stop >= fill : stop <= fill)) {
    return { stop: null, target: null, error: "stop would be on the wrong side of the fill" };
  }
  const risk = stop === null ? null : Math.abs(fill - stop);
  let target: number | null = null;
  if (s.targetMode === "pct") target = dir === "long" ? fill * (1 + s.targetPct / 100) : fill * (1 - s.targetPct / 100);
  else if (s.targetMode === "r_multiple") {
    if (risk === null) return { stop, target: null, error: "R target needs a stop" };
    target = dir === "long" ? fill + risk * s.targetR : fill - risk * s.targetR;
  }
  if (target !== null && target <= 0) target = null;
  return { stop, target };
}

export function sizePosition(a: {
  mode: Settings["sizingMode"];
  equity: number;
  cash: number;
  entry: number;
  stop: number | null;
  fixedUsd: number;
  pctEquity: number;
  riskPct: number;
  feePct: number;
}): { units: number; notional: number } {
  let notional = 0;
  if (a.mode === "fixed_usd") notional = a.fixedUsd;
  else if (a.mode === "pct_equity") notional = (a.equity * a.pctEquity) / 100;
  else if (a.mode === "risk_pct") {
    if (a.stop === null || a.stop === a.entry) return { units: 0, notional: 0 };
    const units = (a.equity * a.riskPct) / 100 / Math.abs(a.entry - a.stop);
    notional = units * a.entry;
  }
  notional = Math.min(notional, a.cash / (1 + a.feePct / 100));
  if (!(notional >= 1) || !(a.entry > 0)) return { units: 0, notional: 0 };
  return { units: notional / a.entry, notional };
}

// Did this candle trigger the stop or target? Uses only the candle's own OHLC.
// If both are touched inside one candle we assume the stop came first (pessimistic).
// A gap through a level fills at the candle open, not at the level.
export function evaluateExit(
  t: { direction: Direction; stop: number | null; target: number | null },
  c: Candle,
): { reason: "stop" | "target"; price: number } | null {
  if (t.direction === "long") {
    if (t.stop !== null && c.l <= t.stop) return { reason: "stop", price: c.o <= t.stop ? c.o : t.stop };
    if (t.target !== null && c.h >= t.target) return { reason: "target", price: c.o >= t.target ? c.o : t.target };
  } else {
    if (t.stop !== null && c.h >= t.stop) return { reason: "stop", price: c.o >= t.stop ? c.o : t.stop };
    if (t.target !== null && c.l <= t.target) return { reason: "target", price: c.o <= t.target ? c.o : t.target };
  }
  return null;
}

export function unrealizedPnl(dir: Direction, entry: number, price: number, units: number): number {
  return (dir === "long" ? price - entry : entry - price) * units;
}

export function closeMath(dir: Direction, entry: number, exitFill: number, units: number, entryFee: number, feePct: number) {
  const gross = unrealizedPnl(dir, entry, exitFill, units);
  const exitFee = (exitFill * units * feePct) / 100;
  return { gross, exitFee, net: gross - entryFee - exitFee };
}

export function maxDrawdown(series: number[]): { usd: number; pct: number } {
  let peak = -Infinity;
  let usd = 0;
  let pct = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const d = peak - v;
    if (d > usd) usd = d;
    if (peak > 0 && (d / peak) * 100 > pct) pct = (d / peak) * 100;
  }
  return { usd, pct };
}

export function computeStats(pnls: number[], equitySeries: number[], startingBalance: number) {
  const count = pnls.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const sumW = wins.reduce((a, b) => a + b, 0);
  const sumL = losses.reduce((a, b) => a + b, 0);
  let series = equitySeries;
  if (series.length < 2) {
    let run = startingBalance;
    series = [run];
    for (const p of pnls) series.push((run += p));
  }
  const dd = maxDrawdown(series);
  return {
    closedCount: count,
    wins: wins.length,
    losses: losses.length,
    winRatePct: count ? (wins.length / count) * 100 : null,
    avgWin: wins.length ? sumW / wins.length : null,
    avgLoss: losses.length ? sumL / losses.length : null,
    profitFactor: sumL < 0 ? sumW / Math.abs(sumL) : null,
    best: count ? Math.max(...pnls) : null,
    worst: count ? Math.min(...pnls) : null,
    maxDrawdownUsd: dd.usd,
    maxDrawdownPct: dd.pct,
  };
}

export interface PosState {
  direction: Direction;
  stop: number | null;
  target: number | null;
  lockTrigger: number | null; // price that arms the profit lock
  lockStop: number | null; // stop level once armed (beyond entry, in profit)
  locked: boolean;
}

// Replays CLOSED 1-minute candles in order, using only what each candle shows.
// Profit lock: when a candle's high (long) / low (short) reaches the trigger, the stop is raised to the
// lock level from the NEXT candle on. Order inside one candle is unknown, so it never acts within that candle.
export function replayCandles(p: PosState, candles: Candle[], fromT: number) {
  let stop = p.stop;
  let locked = p.locked;
  let lockedT: number | null = null;
  const long = p.direction === "long";
  for (const c of candles) {
    if (c.t < fromT) continue;
    const ex = evaluateExit({ direction: p.direction, stop, target: p.target }, c);
    if (ex) {
      return { exit: { reason: ex.reason === "stop" && locked ? ("profit_lock" as const) : ex.reason, price: ex.price, closeT: c.t + 60000 }, stop, locked, lockedT };
    }
    if (!locked && p.lockTrigger !== null && p.lockStop !== null && (long ? c.h >= p.lockTrigger : c.l <= p.lockTrigger)) {
      stop = long ? Math.max(stop ?? -Infinity, p.lockStop) : Math.min(stop ?? Infinity, p.lockStop);
      locked = true;
      lockedT = c.t + 60000;
    }
  }
  return { exit: null, stop, locked, lockedT };
}

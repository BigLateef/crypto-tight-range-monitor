// Pure range detection + breakout confirmation. Works on CLOSED candles only.
import type { Candle } from "./types";

export interface RangeParams {
  lookback: number;
  maxWidthPct: number;
  minTouches: number;
  touchTolPct: number; // % of range height that counts as "touching" an edge
}
export interface Range {
  high: number;
  low: number;
  widthPct: number;
  startT: number;
  endT: number; // open time of the last candle inside the window
  touchesHigh: number;
  touchesLow: number;
  candles: number;
}

// `closed` = ascending closed candles. The window is the last `lookback` candles.
// minStartT: window must start at/after this time (prevents re-alerting on an old, already-resolved range).
export function detectRange(closed: Candle[], p: RangeParams, minStartT = 0): Range | null {
  if (closed.length < p.lookback) return null;
  const w = closed.slice(closed.length - p.lookback);
  if (w[0].t < minStartT) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of w) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  if (!(hi > lo) || lo <= 0) return null;
  const widthPct = ((hi - lo) / ((hi + lo) / 2)) * 100;
  if (widthPct > p.maxWidthPct) return null;
  const tol = ((hi - lo) * p.touchTolPct) / 100;
  let th = 0;
  let tl = 0;
  for (const c of w) {
    if (c.h >= hi - tol) th++;
    if (c.l <= lo + tol) tl++;
  }
  if (th < p.minTouches || tl < p.minTouches) return null;
  // Reject slow trends: the average close may not drift more than 35% of the range height.
  const half = Math.floor(w.length / 2);
  const mean = (a: Candle[]) => a.reduce((x, c) => x + c.c, 0) / a.length;
  if (Math.abs(mean(w.slice(half)) - mean(w.slice(0, half))) > (hi - lo) * 0.35) return null;
  return { high: hi, low: lo, widthPct, startT: w[0].t, endT: w[w.length - 1].t, touchesHigh: th, touchesLow: tl, candles: w.length };
}

export interface Breakout {
  direction: "up" | "down";
  confirmT: number; // open time of the candle whose close confirmed the breakout
  confirmCloseTime: number; // when that candle closed (ms)
  close: number;
}

// Scan closed candles AFTER the range for `confirmCloses` consecutive closes beyond an edge
// (by bufferPct). A wick outside the range never counts; a close back inside resets the count.
export function scanBreakout(
  after: Candle[],
  range: { high: number; low: number; endT: number },
  tfMs: number,
  bufferPct: number,
  confirmCloses: number,
): Breakout | null {
  const up = range.high * (1 + bufferPct / 100);
  const dn = range.low * (1 - bufferPct / 100);
  let dir: "up" | "down" | null = null;
  let n = 0;
  for (const c of after) {
    if (c.t <= range.endT) continue;
    const d = c.c > up ? "up" : c.c < dn ? "down" : null;
    if (d && d === dir) n++;
    else if (d) {
      dir = d;
      n = 1;
    } else {
      dir = null;
      n = 0;
    }
    if (d && n >= confirmCloses) return { direction: d, confirmT: c.t, confirmCloseTime: c.t + tfMs, close: c.c };
  }
  return null;
}

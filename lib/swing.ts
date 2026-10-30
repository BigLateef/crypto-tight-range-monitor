// "Swing pattern" detection: price swings up >= upPct and back >= backPct, N cycles in a row.
// Pure and dependency-free (type imports only). Works on CLOSED candles' closes.
import type { Candle } from "./types";
import type { Range } from "./range";

export const MIN_CYCLES = 2; // built in: fewer than 2 back-and-forth cycles is not "repeated"

export interface SwingParams {
  minPct: number; // every swing (leg) must be at least this big, any percentage you like
  bandTolPct: number; // swing highs (and swing lows) may differ by at most this % of the swing height
  maxCandles: number; // how far back to look
}
export interface Pivot {
  i: number;
  t: number;
  price: number;
  type: "H" | "L";
}

// Standard zig-zag on closes: a pivot is confirmed once price reverses by >= thPct from the running extreme.
export function zigzag(candles: Candle[], thPct: number): Pivot[] {
  const th = thPct / 100;
  const pv: Pivot[] = [];
  if (candles.length < 2) return pv;
  const px = candles.map((c) => c.c);
  let dir = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < px.length; i++) {
    const p = px[i];
    if (dir === 0) {
      if (p >= px[lo] * (1 + th)) {
        pv.push({ i: lo, t: candles[lo].t, price: px[lo], type: "L" });
        dir = 1;
        hi = i;
      } else if (p <= px[hi] * (1 - th)) {
        pv.push({ i: hi, t: candles[hi].t, price: px[hi], type: "H" });
        dir = -1;
        lo = i;
      } else {
        if (p > px[hi]) hi = i;
        if (p < px[lo]) lo = i;
      }
    } else if (dir === 1) {
      if (p > px[hi]) hi = i;
      else if (p <= px[hi] * (1 - th)) {
        pv.push({ i: hi, t: candles[hi].t, price: px[hi], type: "H" });
        dir = -1;
        lo = i;
      }
    } else {
      if (p < px[lo]) lo = i;
      else if (p >= px[lo] * (1 + th)) {
        pv.push({ i: lo, t: candles[lo].t, price: px[lo], type: "L" });
        dir = 1;
        hi = i;
      }
    }
  }
  return pv;
}

function bandOk(pv: Pivot[], bandTolPct: number): boolean {
  const highs = pv.filter((v) => v.type === "H").map((v) => v.price);
  const lows = pv.filter((v) => v.type === "L").map((v) => v.price);
  if (!highs.length || !lows.length) return false;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const height = mean(highs) - mean(lows);
  if (!(height > 0)) return false;
  const tol = (bandTolPct / 100) * height;
  return Math.max(...highs) - Math.min(...highs) <= tol && Math.max(...lows) - Math.min(...lows) <= tol;
}

// Finds consecutive swings that stay inside a band (scalping-style oscillation). The ENGINE decides how many
// cycles: it starts from the latest 2 cycles and extends backwards while the band still holds.
// The band check is scale-free: the spread of swing highs, and of swing lows, must each be within bandTolPct
// of the average swing height (a staircase trend fails it; a ping-pong passes).
// minStartT keeps an already-resolved pattern from being found again.
export function detectSwingPattern(closed: Candle[], p: SwingParams, minStartT = 0): Range | null {
  const win = closed.filter((c) => c.t >= minStartT).slice(-p.maxCandles);
  if (win.length < 4) return null;
  const pivots = zigzag(win, p.minPct);
  let legs = MIN_CYCLES * 2;
  if (pivots.length < legs + 1) return null;
  let used = pivots.slice(pivots.length - (legs + 1));
  if (!bandOk(used, p.bandTolPct)) return null;
  while (pivots.length >= legs + 2) {
    const next = pivots.slice(pivots.length - (legs + 2));
    if (!bandOk(next, p.bandTolPct)) break;
    legs++;
    used = next;
  }
  const cycles = Math.floor(legs / 2);
  const hi = Math.max(...used.filter((v) => v.type === "H").map((v) => v.price));
  const lo = Math.min(...used.filter((v) => v.type === "L").map((v) => v.price));
  if (!(hi > lo) || lo <= 0) return null;
  const first = used[0];
  const last = used[used.length - 1];
  return {
    high: hi,
    low: lo,
    widthPct: ((hi - lo) / ((hi + lo) / 2)) * 100,
    startT: first.t,
    endT: last.t,
    touchesHigh: cycles,
    touchesLow: cycles,
    candles: last.i - first.i + 1,
  };
}

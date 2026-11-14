// Pure outcome labelling. The prediction target is defined here and nowhere else:
//   return% = (close of the candle ending at issued + horizon  -  ref_price) / ref_price * 100
//   UP       if return%  >  threshold
//   DOWN     if return%  < -threshold
//   SIDEWAYS otherwise
// threshold = max(round-trip cost %, minMovePct): a move too small to pay for fees and slippage is not "UP" or
// "DOWN" in any useful sense. Only candles that closed at or before the horizon end are used (no look-ahead).
import type { Candle } from "./types";

export type Actual = "UP" | "DOWN" | "SIDEWAYS";

export interface OutcomeParams {
  tfMs: number;
  costPct: number; // round-trip fees + slippage, %
  minMovePct: number; // floor on the threshold, %
}

export const thresholdPct = (p: Pick<OutcomeParams, "costPct" | "minMovePct">) => Math.max(p.costPct, p.minMovePct);

export function classifyReturn(returnPct: number, thr: number): Actual {
  if (returnPct > thr) return "UP";
  if (returnPct < -thr) return "DOWN";
  return "SIDEWAYS";
}

export interface DueForecast {
  issuedT: number; // ms, close time of the candle the forecast used
  horizonMin: number;
  refPrice: number;
}

export type Resolution =
  | { status: "resolved"; actual: Actual; endT: number; endPrice: number; returnPct: number; thresholdPct: number }
  | { status: "pending" } // horizon not over yet, or the end candle has not been seen yet
  | { status: "unresolvable"; why: string };

// `candles` = any ascending candles of the forecast's timeframe. The end candle is the one that CLOSES at
// issuedT + horizon, i.e. whose open time is issuedT + horizon - tf.
// Forecasts whose end candle is still missing long after the horizon (graceVs) become unresolvable instead of
// silently waiting forever or being filled with a guess.
export function resolveForecast(f: DueForecast, candles: Candle[], now: number, p: OutcomeParams, graceMs = 6 * 3600000, maxCarry = 3): Resolution {
  const endClose = f.issuedT + f.horizonMin * 60000;
  if (f.horizonMin * 60000 % p.tfMs !== 0) return { status: "unresolvable", why: "horizon is not a multiple of the candle length" };
  if (!(f.refPrice > 0)) return { status: "unresolvable", why: "bad reference price" };
  if (now < endClose) return { status: "pending" };
  const openT = endClose - p.tfMs;
  let c = candles.find((x) => x.t === openT);
  if (!c) {
    // No candle for that period: exchanges omit candles when nothing traded. If a LATER candle exists (so the quiet
    // spell is over and nothing was skipped by a poll failure) and an earlier one is at most `maxCarry` candles
    // back, the price at the horizon end was the last close before it. Never uses a close after the horizon end.
    const later = candles.some((x) => x.t >= endClose);
    const before = [...candles].reverse().find((x) => x.t < openT);
    if (later && before && openT - before.t <= maxCarry * p.tfMs) c = before;
  }
  if (!c || !(c.c > 0)) {
    return now - endClose > graceMs ? { status: "unresolvable", why: "horizon-end candle never became available" } : { status: "pending" };
  }
  const returnPct = ((c.c - f.refPrice) / f.refPrice) * 100;
  const thr = thresholdPct(p);
  return { status: "resolved", actual: classifyReturn(returnPct, thr), endT: endClose, endPrice: c.c, returnPct, thresholdPct: thr };
}

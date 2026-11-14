// Pure data-quality gate. A symbol that fails this check must NEVER produce a signal or forecast;
// the engine reports the reasons as a health problem instead. No imports except types.
import type { Candle } from "./types";

export interface QualityParams {
  tfMs: number; // candle length
  now: number; // ms
  window: number; // the most recent N closed candles must be contiguous and sane
  maxLagMs: number; // newest closed candle may have closed at most this long ago
  maxJumpPct: number; // close-to-close move above this inside the window is treated as a bad print
  maxFillRun?: number; // up to this many consecutive missing candles are treated as "no trades" and filled flat (default 3)
}

export type QualityIssue = "empty" | "too_few" | "stale" | "gap" | "duplicate_or_unsorted" | "bad_ohlc" | "jump";

export interface QualityResult {
  ok: boolean;
  issues: QualityIssue[];
  reasons: string[]; // human-readable, safe to send in a health alert
  closed: Candle[]; // closed candles only (ascending, short no-trade holes filled flat), what detection may use
  filled: number; // how many flat candles were inserted for no-trade minutes
  lastCloseMs: number | null; // when the newest closed candle closed
  ageMs: number | null; // now - lastCloseMs (data freshness)
}

const finitePos = (n: number) => Number.isFinite(n) && n > 0;

export function checkCandles(all: Candle[], p: QualityParams): QualityResult {
  const issues = new Set<QualityIssue>();
  const reasons: string[] = [];
  const flag = (i: QualityIssue, why: string) => {
    if (!issues.has(i)) reasons.push(why);
    issues.add(i);
  };

  const real = (all || []).filter((c) => c.t + p.tfMs <= p.now);
  // Exchanges such as Coinbase omit candles for periods with no trades. A short hole is therefore NOT a data
  // fault: it is filled with a flat zero-volume candle at the previous close. Long holes stay as gaps (a fault).
  const maxFill = p.maxFillRun ?? 3;
  const closed: Candle[] = [];
  let filled = 0;
  for (let k = 0; k < real.length; k++) {
    const c = real[k];
    if (k > 0) {
      const prev = real[k - 1];
      const d = c.t - prev.t;
      if (d > p.tfMs && d % p.tfMs === 0 && d / p.tfMs - 1 <= maxFill) {
        for (let m = 1; m < d / p.tfMs; m++) {
          closed.push({ t: prev.t + m * p.tfMs, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
          filled++;
        }
      }
    }
    closed.push(c);
  }
  const done = (): QualityResult => {
    const last = closed.length ? closed[closed.length - 1] : null;
    const lastCloseMs = last ? last.t + p.tfMs : null;
    return { ok: issues.size === 0, issues: [...issues], reasons, closed, filled, lastCloseMs, ageMs: lastCloseMs === null ? null : p.now - lastCloseMs };
  };

  if (!all || all.length === 0) {
    flag("empty", "no candles returned by the data provider");
    return done();
  }
  if (closed.length < p.window) {
    flag("too_few", `only ${closed.length} closed candles, need ${p.window}`);
    return done();
  }

  const last = closed[closed.length - 1];
  const lag = p.now - (last.t + p.tfMs);
  if (lag > p.maxLagMs) flag("stale", `newest closed candle closed ${Math.round(lag / 60000)} min ago (limit ${Math.round(p.maxLagMs / 60000)} min)`);

  const w = closed.slice(closed.length - p.window);
  const filledInWindow = w.filter((c) => c.v === 0 && c.o === c.h && c.h === c.l && c.l === c.c).length;
  if (filledInWindow > Math.floor(p.window * 0.25)) flag("gap", `${filledInWindow} of the last ${p.window} candles had no trades (market too quiet or provider incomplete)`);
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (![c.o, c.h, c.l, c.c].every(finitePos) || c.h < Math.max(c.o, c.c, c.l) || c.l > Math.min(c.o, c.c, c.h)) {
      flag("bad_ohlc", `inconsistent OHLC in candle at ${new Date(c.t).toISOString()}`);
    }
    if (i === 0) continue;
    const d = c.t - w[i - 1].t;
    if (d <= 0) flag("duplicate_or_unsorted", "duplicate or out-of-order candle timestamps");
    else if (d !== p.tfMs) flag("gap", `missing candle(s) between ${new Date(w[i - 1].t).toISOString()} and ${new Date(c.t).toISOString()}`);
    const prev = w[i - 1].c;
    if (finitePos(prev) && finitePos(c.c) && (Math.abs(c.c - prev) / prev) * 100 > p.maxJumpPct) {
      flag("jump", `close-to-close move over ${p.maxJumpPct}% at ${new Date(c.t).toISOString()}`);
    }
  }
  return done();
}

// Debounced alerting for data health, so one slow poll does not message you. A problem is announced only after
// `after` consecutive bad ticks, and recovery is announced only if a problem was announced.
export interface HealthState {
  badStreak: number;
  alerted: boolean;
}
export function nextHealthState(prev: HealthState | null, bad: boolean, after: number): { state: HealthState; send: "problem" | "recovered" | null } {
  const p = prev ?? { badStreak: 0, alerted: false };
  if (!bad) return { state: { badStreak: 0, alerted: false }, send: p.alerted ? "recovered" : null };
  const streak = p.badStreak + 1;
  if (!p.alerted && streak >= after) return { state: { badStreak: streak, alerted: true }, send: "problem" };
  return { state: { badStreak: streak, alerted: p.alerted }, send: null };
}

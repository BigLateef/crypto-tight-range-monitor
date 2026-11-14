import assert from "node:assert/strict";
import { checkCandles, nextHealthState } from "../lib/dataquality.ts";

const TF = 300000;
const mk = (i: number, o = 100, h = 101, l = 99, c = 100) => ({ t: i * TF, o, h, l, c, v: 1 });
const series = (n: number) => Array.from({ length: n }, (_, i) => mk(i));
const NOW = 30 * TF + 60000; // candle 29 closed 1 minute ago
const P = { tfMs: TF, now: NOW, window: 24, maxLagMs: 2 * TF, maxJumpPct: 20 };

// healthy data passes and reports freshness
{
  const r = checkCandles(series(30), P);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.ageMs, 60000);
  assert.equal(r.closed.length, 30);
}
// still-forming candle is excluded, not counted as data
{
  const r = checkCandles(series(31), P);
  assert.equal(r.closed.length, 30);
  assert.equal(r.ok, true);
}
// stale: newest closed candle is far in the past
{
  const r = checkCandles(series(30), { ...P, now: NOW + 10 * TF });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes("stale"));
}
// empty / too few
assert.ok(checkCandles([], P).issues.includes("empty"));
assert.ok(checkCandles(series(10), P).issues.includes("too_few"));
// a short hole (no trades for 1-3 candles) is filled flat, NOT treated as a data fault
{
  const s = series(30).filter((c) => c.t !== 20 * TF);
  const r = checkCandles(s, P);
  assert.equal(r.ok, true);
  assert.equal(r.filled, 1);
  assert.equal(r.closed.length, 30);
  const f = r.closed.find((c) => c.t === 20 * TF)!;
  assert.ok(f.v === 0 && f.o === f.c && f.h === f.l && f.c === 100, "filled candle is flat at the previous close");
}
// a long hole inside the window IS a fault
{
  const s = series(40).filter((c) => c.t < 25 * TF || c.t > 32 * TF);
  const r = checkCandles(s, { ...P, now: 40 * TF + 60000 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes("gap"));
}
// too many quiet candles in the window (more than 25%) is a fault even if each hole is short
{
  const s = series(30).filter((c) => !(c.t >= 10 * TF && c.t < 29 * TF && c.t % (2 * TF) === 0));
  const r = checkCandles(s, P);
  assert.ok(r.issues.includes("gap"));
}
// real-world 1m case from production: newest candle closed 4 minutes ago must NOT be stale (limit is 6 min)
{
  const T1 = 60000;
  const s1 = Array.from({ length: 40 }, (_, i) => ({ t: i * T1, o: 100, h: 101, l: 99, c: 100, v: 1 }));
  const now = 40 * T1 + 3 * T1; // newest closed candle (index 39) closed 3 minutes ago
  const ok = checkCandles(s1, { tfMs: T1, now, window: 24, maxLagMs: 6 * T1, maxJumpPct: 20 });
  assert.equal(ok.ok, true);
  const bad = checkCandles(s1, { tfMs: T1, now: 40 * T1 + 8 * T1, window: 24, maxLagMs: 6 * T1, maxJumpPct: 20 });
  assert.ok(bad.issues.includes("stale"));
}
// a gap OLDER than the window does not matter
{
  const s = series(40).filter((c) => c.t !== 2 * TF);
  const r = checkCandles(s, { ...P, now: 40 * TF + 60000 });
  assert.equal(r.ok, true);
}
// duplicate timestamps
{
  const s = series(30);
  s.splice(15, 0, s[15]);
  assert.ok(checkCandles(s, P).issues.includes("duplicate_or_unsorted"));
}
// bad OHLC: high below close, zero price, NaN
{
  const a = series(30);
  a[25] = mk(25, 100, 99, 98, 100);
  assert.ok(checkCandles(a, P).issues.includes("bad_ohlc"));
  const b = series(30);
  b[25] = mk(25, 0, 1, 0, 1);
  assert.ok(checkCandles(b, P).issues.includes("bad_ohlc"));
  const c = series(30);
  c[25] = { ...mk(25), c: NaN };
  assert.ok(checkCandles(c, P).issues.includes("bad_ohlc"));
}
// bad print / jump
{
  const s = series(30);
  s[26] = mk(26, 100, 200, 99, 150);
  assert.ok(checkCandles(s, P).issues.includes("jump"));
}
// every failure carries a human-readable reason
{
  const r = checkCandles(series(30), { ...P, now: NOW + 10 * TF });
  assert.ok(r.reasons.length >= 1 && r.reasons.every((x) => x.length > 5));
}
// debounced health alerts: no message on a single bad tick, one message when it persists, one on recovery
{
  let st: any = null;
  const sends: (string | null)[] = [];
  for (const bad of [true, false, true, true, true, true, false, false]) {
    const r = nextHealthState(st, bad, 3);
    st = r.state;
    sends.push(r.send);
  }
  assert.deepEqual(sends, [null, null, null, null, "problem", null, "recovered", null]);
  // a blip that clears before the threshold never sends anything, including no recovery message
  const a = nextHealthState(nextHealthState(null, true, 3).state, false, 3);
  assert.equal(a.send, null);
}
console.log("data quality tests passed");

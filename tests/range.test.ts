import assert from "node:assert/strict";
import { detectRange, scanBreakout } from "../lib/range.ts";

const TF = 300000;
const mk = (i: number, o: number, h: number, l: number, c: number) => ({ t: i * TF, o, h, l, c, v: 1 });
const P = { lookback: 10, maxWidthPct: 2, minTouches: 2, touchTolPct: 20 };

// choppy range 100..101
const flat = Array.from({ length: 10 }, (_, i) => (i % 2 ? mk(i, 100.2, 101, 100.1, 100.8) : mk(i, 100.8, 100.9, 100, 100.3)));
{
  const r = detectRange(flat, P);
  assert.ok(r);
  assert.equal(r!.high, 101);
  assert.equal(r!.low, 100);
  assert.ok(r!.widthPct < 2);
  assert.equal(r!.endT, 9 * TF);
}
// too wide
assert.equal(detectRange(flat, { ...P, maxWidthPct: 0.5 }), null);
// not enough candles
assert.equal(detectRange(flat.slice(0, 5), P), null);
// window may not overlap an already-resolved range
assert.equal(detectRange(flat, P, 1 * TF), null);
assert.ok(detectRange(flat, P, 0));
// trending candles never touch both edges twice
const trend = Array.from({ length: 10 }, (_, i) => mk(i, 100 + i * 0.3, 100.35 + i * 0.3, 100 + i * 0.3, 100.3 + i * 0.3));
assert.equal(detectRange(trend, { ...P, maxWidthPct: 5, minTouches: 3 }), null);

const range = { high: 101, low: 100, endT: 9 * TF };
// wick above does NOT confirm
assert.equal(scanBreakout([mk(10, 100.5, 102, 100.4, 100.9)], range, TF, 0, 1), null);
// close above confirms, in that direction
const up = scanBreakout([mk(10, 100.9, 101.5, 100.9, 101.4)], range, TF, 0, 1);
assert.ok(up);
assert.equal(up!.direction, "up");
assert.equal(up!.confirmCloseTime, 11 * TF);
// close below confirms down
assert.equal(scanBreakout([mk(10, 100.1, 100.2, 99.4, 99.5)], range, TF, 0, 1)!.direction, "down");
// buffer: close 101.02 is not beyond 101*(1+0.05%)=101.0505
assert.equal(scanBreakout([mk(10, 100.9, 101.1, 100.9, 101.02)], range, TF, 0.05, 1), null);
// 2 closes required; a fake-out in between resets
const c1 = mk(10, 101, 101.6, 101, 101.5);
const back = mk(11, 101.5, 101.5, 100.5, 100.6);
const c2 = mk(12, 101, 101.7, 101, 101.6);
assert.equal(scanBreakout([c1, back, c2], range, TF, 0, 2), null);
assert.ok(scanBreakout([c1, mk(11, 101.5, 101.8, 101.4, 101.7)], range, TF, 0, 2));
// candles inside the window are ignored
assert.equal(scanBreakout([mk(9, 100, 103, 99, 103)], range, TF, 0, 1), null);
console.log("range tests passed");

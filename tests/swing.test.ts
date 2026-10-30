import assert from "node:assert/strict";
import { zigzag, detectSwingPattern } from "../lib/swing.ts";

const TF = 300000;
const mk = (closes: number[]) => closes.map((c, i) => ({ t: i * TF, o: c, h: c, l: c, c, v: 1 }));
const P = { minPct: 0.5, bandTolPct: 50, maxCandles: 100 };

// ping-pong 100 <-> 101, two full cycles (last low confirmed by the final close)
const pp = mk([100, 100.5, 101, 100.5, 100, 100.5, 101, 100.5, 100, 101]);
{
  const r = detectSwingPattern(pp, P);
  assert.ok(r, "ping-pong should be detected");
  assert.equal(r!.high, 101);
  assert.equal(r!.low, 100);
  assert.equal(r!.endT, 8 * TF);
}
// any size works: a 0.2% scalping ping-pong with minPct 0.1
const tiny = mk([100, 100.1, 100.2, 100.1, 100, 100.1, 100.2, 100.1, 100, 100.2]);
assert.ok(detectSwingPattern(tiny, { ...P, minPct: 0.1 }));
// ...and is ignored when the minimum swing is bigger than what price does
assert.equal(detectSwingPattern(tiny, { ...P, minPct: 0.5 }), null);
// staircase trend (+1.2%/-0.6% repeating) is NOT a band at 50% looseness, but passes when loosened
const stairs = mk([100, 100.4, 101.2, 100.9, 100.6, 101.0, 101.8, 101.5, 101.2, 101.8]);
assert.equal(detectSwingPattern(stairs, P), null);
assert.ok(detectSwingPattern(stairs, { ...P, bandTolPct: 200 }));
// only one cycle is never enough (built-in minimum is 2)
assert.equal(detectSwingPattern(mk([100, 100.5, 101, 100.5, 100, 100.6]), P), null);
// the engine counts the cycles itself: 3 clean cycles are all used
const three = mk([100, 100.5, 101, 100.5, 100, 100.5, 101, 100.5, 100, 100.5, 101, 100.5, 100, 101]);
{
  const r = detectSwingPattern(three, P)!;
  assert.equal(r.touchesHigh, 3);
  assert.equal(r.startT, 0);
}
// ...and it stops extending where the band breaks (an earlier spike to 103 is left out)
const spike = mk([100, 103, 100, 100.5, 101, 100.5, 100, 100.5, 101, 100.5, 100, 101]);
{
  const r = detectSwingPattern(spike, P)!;
  assert.equal(r.touchesHigh, 2);
  assert.equal(r.startT, 2 * TF);
  assert.equal(r.high, 101);
}
// a resolved earlier pattern is not found again
assert.equal(detectSwingPattern(pp, P, 5 * TF), null);
// pivots alternate H/L
const pv = zigzag(pp, 0.5);
for (let i = 1; i < pv.length; i++) assert.notEqual(pv[i].type, pv[i - 1].type);
console.log("swing tests passed");

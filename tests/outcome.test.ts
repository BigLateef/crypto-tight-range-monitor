import assert from "node:assert/strict";
import { classifyReturn, resolveForecast, thresholdPct } from "../lib/outcome.ts";

const TF = 300000;
const P = { tfMs: TF, costPct: 0.3, minMovePct: 0 };
const H = 60; // minutes -> 12 candles
const issuedT = 100 * TF; // close time of the candle the forecast used
const endOpen = issuedT + H * 60000 - TF;
const candle = (t: number, c: number) => ({ t, o: c, h: c, l: c, c, v: 1 });
const F = { issuedT, horizonMin: H, refPrice: 100 };
const NOW = issuedT + H * 60000 + 60000;

// threshold is the larger of round-trip cost and the configured floor
assert.equal(thresholdPct({ costPct: 0.3, minMovePct: 0 }), 0.3);
assert.equal(thresholdPct({ costPct: 0.3, minMovePct: 0.5 }), 0.5);
// labelling boundaries: exactly the threshold is NOT a move
assert.equal(classifyReturn(0.31, 0.3), "UP");
assert.equal(classifyReturn(0.3, 0.3), "SIDEWAYS");
assert.equal(classifyReturn(-0.3, 0.3), "SIDEWAYS");
assert.equal(classifyReturn(-0.31, 0.3), "DOWN");

// resolves from the candle that closes at issued + horizon
{
  const r = resolveForecast(F, [candle(endOpen, 101)], NOW, P);
  assert.equal(r.status, "resolved");
  if (r.status === "resolved") {
    assert.equal(r.actual, "UP");
    assert.equal(r.endT, issuedT + H * 60000);
    assert.ok(Math.abs(r.returnPct - 1) < 1e-9);
  }
}
// a move smaller than costs is SIDEWAYS, not UP
{
  const r = resolveForecast(F, [candle(endOpen, 100.2)], NOW, P);
  assert.ok(r.status === "resolved" && r.actual === "SIDEWAYS");
}
// DOWN
{
  const r = resolveForecast(F, [candle(endOpen, 98)], NOW, P);
  assert.ok(r.status === "resolved" && r.actual === "DOWN");
}
// NO LOOK-AHEAD: later candles never substitute for the horizon-end candle
{
  const r = resolveForecast(F, [candle(endOpen + TF, 150), candle(endOpen + 2 * TF, 150)], NOW, P);
  assert.equal(r.status, "pending");
}
// horizon not over yet -> pending, even if a matching candle somehow exists
assert.equal(resolveForecast(F, [candle(endOpen, 120)], issuedT + 30 * 60000, P).status, "pending");
// missing end candle far past the horizon -> unresolvable (never guessed)
{
  const r = resolveForecast(F, [], issuedT + H * 60000 + 7 * 3600000, P);
  assert.equal(r.status, "unresolvable");
}
// horizon that is not a multiple of the candle length, and a bad reference price
assert.equal(resolveForecast({ ...F, horizonMin: 7 }, [], NOW, P).status, "unresolvable");
assert.equal(resolveForecast({ ...F, refPrice: 0 }, [candle(endOpen, 1)], NOW, P).status, "unresolvable");
console.log("outcome tests passed");

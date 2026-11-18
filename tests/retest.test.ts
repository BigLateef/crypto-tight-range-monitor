import assert from "node:assert/strict";
import {
  COSTS_PLACEHOLDER, TRIGGER_DEFAULTS, ZONE_DEFAULTS, atrSeries, buildZones, evaluateTrigger, expectancyPct, findPivots,
  inCooldown, positionSize, priorBounces, resample, tradeEconomics, type Zone,
} from "../lib/retest.ts";

const H = 3600000;
const M5 = 300000;
type C = { t: number; o: number; h: number; l: number; c: number; v: number };
const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

// closes follow straight legs between waypoints; wicks are small
function path(points: [number, number][], tf = H, t0 = 0, wick = 0.05): C[] {
  const out: C[] = [];
  let prev = points[0][0];
  let t = t0;
  for (const [target, bars] of points.slice(1)) {
    for (let k = 1; k <= bars; k++) {
      const c = prev + ((target - prev) * k) / bars;
      const o = out.length ? out[out.length - 1].c : prev;
      out.push({ t, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 10 });
      t += tf;
    }
    prev = target;
  }
  return out;
}
const warm: [number, number][] = [[110, 0], [111, 10], [109.5, 10], [111, 10], [110, 10]]; // 40 bars of chop around 110

// ---------------- economics ----------------
{
  const c = { takerFeePct: 0.1, makerFeePct: 0.05, slippagePct: 0.02, spreadPct: 0.02, targetFill: "maker" as const, fundingPct: 0 };
  const e = tradeEconomics(0.5, 1, c);
  near(e.entryCostPct, 0.1 + 0.02 + 0.01);
  near(e.stopExitCostPct, 0.13);
  near(e.targetExitCostPct, 0.05);
  near(e.netWinPct, 1 - 0.13 - 0.05);
  near(e.netLossPct, 0.5 + 0.26);
  near(e.netRR, 0.82 / 0.76);
  near(e.breakEvenWinRate, 0.76 / (0.82 + 0.76));
  near(expectancyPct(e.breakEvenWinRate, e), 0, 1e-9);
  // a 1% target stops being worth it as costs rise
  const dear = tradeEconomics(0.5, 1, { ...c, takerFeePct: 0.4, makerFeePct: 0.4, targetFill: "taker" });
  assert.ok(dear.netWinPct < 0.2 && dear.breakEvenWinRate > 0.8, "high costs push the break-even win rate past 80%");
  // funding is a cost on both outcomes
  const f = tradeEconomics(0.5, 1, { ...c, fundingPct: 0.03 });
  near(f.netWinPct, e.netWinPct - 0.03);
  near(f.netLossPct, e.netLossPct + 0.03);
  // a target smaller than costs can never break even
  assert.equal(tradeEconomics(0.5, 0.1, c).breakEvenWinRate, 1);
}
// ---------------- sizing ----------------
{
  const s = positionSize({ equity: 10000, riskPct: 1, netLossPct: 0.8, maxLeverage: 5 });
  near(s.riskUsd, 100);
  near(s.notional, 12500);
  assert.equal(s.cappedBy, null);
  const capped = positionSize({ equity: 10000, riskPct: 2, netLossPct: 0.4, maxLeverage: 3 });
  near(capped.notional, 30000);
  assert.equal(capped.cappedBy, "leverage");
  assert.ok(capped.riskUsd < 200, "a leverage cap reduces risk below the target, never raises it");
  near(capped.marginUsed, 10000);
  assert.equal(positionSize({ equity: 0, riskPct: 1, netLossPct: 1, maxLeverage: 1 }).notional, 0);
  assert.equal(positionSize({ equity: 1000, riskPct: 1, netLossPct: 0, maxLeverage: 1 }).notional, 0);
}
// ---------------- resample ----------------
{
  const c5 = path([[100, 0], [101, 24]], M5);
  const h = resample(c5, H, 24 * M5);
  assert.equal(h.length, 2);
  assert.equal(h[0].t, 0);
  assert.equal(h[0].o, c5[0].o);
  assert.equal(h[0].c, c5[11].c);
  near(h[0].h, Math.max(...c5.slice(0, 12).map((x) => x.h)));
  near(h[0].v, 120);
  // a bucket still forming is never emitted
  assert.equal(resample(c5, H, 23 * M5).length, 1);
}
// ---------------- atr / pivots ----------------
{
  const flat = path([[100, 0], [100, 30]]);
  const a = atrSeries(flat, 14);
  assert.ok(Number.isNaN(a[13]) && Number.isFinite(a[14]));
  near(a[20], 0.1, 1e-6);
  const v = path([[100, 0], [90, 5], [100, 5], [90, 5], [100, 5]]);
  const p = findPivots(v, 2);
  assert.ok(p.some((x) => x.kind === "low" && x.i === 4) && p.some((x) => x.kind === "high" && x.i === 9));
  // pivots need candles on both sides: none within `k` of the end
  assert.ok(p.every((x) => x.i < v.length - 2));
}

// ---------------- zones: bounces, breaks, noise ----------------
const bouncing = path([...warm, [100.1, 10], [108, 8], [100.2, 8], [109, 8], [100.1, 8], [107, 8]]);
const zoneNear = (zs: Zone[], px: number) => zs.find((z) => z.low <= px && px <= z.high);
{
  const { zones, atrNow } = buildZones(bouncing, ZONE_DEFAULTS);
  assert.ok(atrNow > 0);
  const z = zoneNear(zones, 100.1)!;
  assert.ok(z, "a zone forms around the repeated lows");
  const pb = priorBounces(z, "above");
  assert.equal(pb.n, 3, `three separate bounces expected, got ${JSON.stringify(z.visits)}`);
  assert.ok(pb.avgReactionAtr >= ZONE_DEFAULTS.leaveAtr);
  assert.equal(priorBounces(z, "below").n, 0);
}
// a break through the zone resets the count
{
  const broke = path([...warm, [100.1, 10], [108, 8], [100.2, 8], [109, 8], [100.1, 8], [107, 8], [95, 8], [94, 6]]);
  const { zones } = buildZones(broke, ZONE_DEFAULTS);
  const z = zoneNear(zones, 100.1)!;
  assert.ok(z.visits.some((v) => v.outcome === "break"));
  assert.equal(priorBounces(z, "above").n, 0, "bounces before a break do not count");
}
// wiggling around the zone is ONE visit, not several retests
{
  const wig = path([...warm, [100.1, 10], [100.6, 1], [100.05, 1], [100.5, 1], [100.1, 1], [100.4, 1], [108, 8]]);
  const { zones } = buildZones(wig, ZONE_DEFAULTS);
  const z = zoneNear(zones, 100.1)!;
  const done = z.visits.filter((v) => v.outcome !== "open");
  assert.equal(done.length, 1, `noise inside one visit must be one visit, got ${JSON.stringify(z.visits)}`);
}
// causality: candles after the cut cannot change zones built from data before it
{
  const cut = 70;
  const a = buildZones(bouncing.slice(0, cut), ZONE_DEFAULTS);
  const mutated = bouncing.map((c, i) => (i >= cut ? { ...c, o: c.o * 2, h: c.h * 2, l: c.l * 2, c: c.c * 2 } : c));
  const b = buildZones(mutated.slice(0, cut), ZONE_DEFAULTS);
  assert.deepEqual(a, b);
}

// ---------------- trigger ----------------
const zone: Zone = {
  low: 99.5, high: 100.5, mid: 100, firstIdx: 20, pivots: 3,
  visits: [0, 1, 2].map((k) => ({ startIdx: 20 + k * 10, endIdx: 25 + k * 10, approach: "above" as const, outcome: "bounce" as const, reactionAtr: 1.2 })),
};
const ATR = 1.5;
const loose = { ...TRIGGER_DEFAULTS, maxStopPct: 2, minNetRR: 0.3 };
// approach from well above, then a rejection candle
const approach = Array.from({ length: 30 }, (_, i) => ({ t: i * M5, o: 103 - i * 0.08, h: 103.1 - i * 0.08, l: 102.7 - i * 0.08, c: 102.9 - i * 0.08, v: 10 }));
const rej = (o: number, h: number, l: number, c: number, v = 10) => [...approach, { t: 30 * M5, o, h, l, c, v }];
const run = (ltf: C[], tp = loose, zp = ZONE_DEFAULTS, zs: Zone[] = [zone]) => evaluateTrigger(zs, ATR, ltf, M5, zp, tp, COSTS_PLACEHOLDER);
{
  const r = run(rej(100.45, 101.0, 99.9, 100.8));
  assert.ok(r.setup, JSON.stringify(r.skipped));
  const s = r.setup!;
  assert.equal(s.dir, "long");
  assert.equal(s.priorBounces, 3);
  near(s.stopPrice, 99.5 * 0.999, 1e-9); // far zone edge minus buffer (below the wick low 99.9)
  assert.ok(s.targetPrice > s.refPrice && s.stopPrice < s.refPrice);
  assert.equal(s.closeT, 31 * M5);
  assert.match(s.evidence, /Observed/);
  assert.match(s.evidence, /Inference/);
  assert.ok(s.economics.netRR > 0);
  // the reverse (resistance) case is symmetric
  const mirror = (c: C) => ({ ...c, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c });
  const mz: Zone = { ...zone, low: 200 - zone.high, high: 200 - zone.low, mid: 200 - zone.mid, visits: zone.visits.map((v) => ({ ...v, approach: "below" as const })) };
  const m = run(rej(100.45, 101.0, 99.9, 100.8).map(mirror), loose, ZONE_DEFAULTS, [mz]);
  assert.ok(m.setup && m.setup.dir === "short", JSON.stringify(m.skipped));
}
// each rule can say no, with a reason
const reason = (r: ReturnType<typeof run>) => r.skipped.map((s) => s.reason);
assert.deepEqual(reason(run(rej(100.45, 101.0, 99.9, 100.8), { ...loose, minNetRR: 5 })), ["costs_kill_rr"]);
assert.deepEqual(reason(run(rej(100.45, 101.0, 99.9, 100.8), { ...loose, maxStopPct: 0.5 })), ["stop_too_wide"]);
assert.deepEqual(reason(run(rej(100.45, 101.0, 99.9, 100.8), { ...loose, minStopPct: 5, maxStopPct: 9 })), ["stop_too_tight"]);
assert.deepEqual(reason(run(rej(100.45, 101.4, 99.9, 101.3))), ["chased"]);
assert.deepEqual(reason(run(rej(100.45, 100.9, 100.4, 100.8))), ["no_rejection_shape"]); // no real wick
assert.deepEqual(reason(run(rej(100.8, 101.0, 99.9, 100.6))), ["no_rejection_shape"]); // closed against the direction
assert.deepEqual(reason(run(rej(100.45, 101.0, 99.9, 100.8), { ...loose, volMult: 2 })), ["low_volume"]);
assert.ok(run(rej(100.45, 101.0, 99.9, 100.8, 30), { ...loose, volMult: 2 }).setup, "high volume passes the volume rule");
assert.deepEqual(reason(run(rej(100.45, 101.0, 99.9, 100.8), loose, { ...ZONE_DEFAULTS, minPriorBounces: 4 })), ["too_few_bounces"]);
assert.deepEqual(reason(run(rej(100.45, 101.0, 98.9, 100.8))), ["zone_failing"]); // wick through the far edge
// no approach from the right side: price was never clearly above the zone
{
  const inside = Array.from({ length: 30 }, (_, i) => ({ t: i * M5, o: 100.2, h: 100.4, l: 99.9, c: 100.1, v: 10 }));
  const r = run([...inside, { t: 30 * M5, o: 100.45, h: 101.0, l: 99.9, c: 100.8, v: 10 }]);
  assert.deepEqual(reason(r), ["no_approach"]);
}
// a candle that does not touch the zone, or closes inside it, produces nothing at all
assert.equal(run(rej(102, 102.5, 101.5, 102.2)).skipped.length, 0);
assert.equal(run(rej(100.45, 100.7, 99.9, 100.52)).setup, null);
// the newest candle only: a rejection on an older candle is not re-reported
{
  const ltf = [...rej(100.45, 101.0, 99.9, 100.8), { t: 31 * M5, o: 100.8, h: 101.2, l: 100.7, c: 101.1, v: 10 }];
  const r = run(ltf);
  assert.equal(r.setup, null);
}
// best setup wins: more bounces first
{
  const weak: Zone = { ...zone, visits: zone.visits.slice(0, 2) };
  const r = run(rej(100.45, 101.0, 99.9, 100.8), loose, ZONE_DEFAULTS, [weak, zone]);
  assert.equal(r.setup!.priorBounces, 3);
}

// ---------------- cooldown ----------------
{
  const s = run(rej(100.45, 101.0, 99.9, 100.8)).setup!;
  const prev = [{ dir: "long", closeT: s.closeT - 30 * 60000, zoneLow: 99.6, zoneHigh: 100.4 }];
  assert.equal(inCooldown(prev, s, 60), true);
  assert.equal(inCooldown(prev, s, 20), false);
  assert.equal(inCooldown([{ ...prev[0], dir: "short" }], s, 60), false);
  assert.equal(inCooldown([{ ...prev[0], zoneLow: 90, zoneHigh: 91 }], s, 60), false);
}
console.log("retest tests passed");

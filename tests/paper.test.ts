import assert from "node:assert/strict";
import { slipPrice, levels, sizePosition, evaluateExit, closeMath, unrealizedPnl, maxDrawdown, computeStats } from "../lib/paper.ts";

const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

// slippage is always adverse
near(slipPrice(100, "long", "entry", 1), 101);
near(slipPrice(100, "long", "exit", 1), 99);
near(slipPrice(100, "short", "entry", 1), 99);
near(slipPrice(100, "short", "exit", 1), 101);

// levels
const S = { stopMode: "pct", stopPct: 2, targetMode: "r_multiple", targetPct: 3, targetR: 2 } as const;
{
  const l = levels("long", 100, null, S as any);
  near(l.stop!, 98);
  near(l.target!, 104);
  const sh = levels("short", 100, null, S as any);
  near(sh.stop!, 102);
  near(sh.target!, 96);
  const re = levels("long", 101.5, { high: 101, low: 100 }, { ...S, stopMode: "range_edge" } as any);
  near(re.stop!, 101);
  near(re.target!, 102.5);
  // range-edge stop above a long fill is rejected
  assert.ok(levels("long", 100.5, { high: 101, low: 100 }, { ...S, stopMode: "range_edge" } as any).error);
  // R target without stop is rejected
  assert.ok(levels("long", 100, null, { ...S, stopMode: "off" } as any).error);
}

// sizing
{
  const base = { equity: 10000, cash: 10000, entry: 100, stop: 98, fixedUsd: 500, pctEquity: 10, riskPct: 1, feePct: 0.1 };
  near(sizePosition({ ...base, mode: "fixed_usd" }).notional, 500);
  near(sizePosition({ ...base, mode: "pct_equity" }).notional, 1000);
  const r = sizePosition({ ...base, mode: "risk_pct" }); // risk $100, $2 stop => 50 units
  near(r.units, 50);
  near(r.notional, 5000);
  // cannot spend more than cash (incl. fee)
  const c = sizePosition({ ...base, mode: "fixed_usd", cash: 100 });
  near(c.notional, 100 / 1.001);
  // too little cash => no trade
  assert.equal(sizePosition({ ...base, mode: "fixed_usd", cash: 0.5 }).units, 0);
  // risk sizing without a stop => no trade
  assert.equal(sizePosition({ ...base, mode: "risk_pct", stop: null }).units, 0);
}

// exits
{
  const c = (o: number, h: number, l: number, cl: number) => ({ t: 0, o, h, l, c: cl, v: 1 });
  const L = { direction: "long" as const, stop: 98, target: 104 };
  assert.equal(evaluateExit(L, c(100, 103, 99, 102)), null);
  assert.deepEqual(evaluateExit(L, c(100, 101, 97, 99)), { reason: "stop", price: 98 });
  assert.deepEqual(evaluateExit(L, c(100, 105, 99, 104)), { reason: "target", price: 104 });
  // both touched in one candle: stop wins (pessimistic)
  assert.equal(evaluateExit(L, c(100, 105, 97, 100))!.reason, "stop");
  // gap down through the stop fills at the open
  assert.deepEqual(evaluateExit(L, c(95, 96, 94, 95)), { reason: "stop", price: 95 });
  const Sh = { direction: "short" as const, stop: 102, target: 96 };
  assert.deepEqual(evaluateExit(Sh, c(100, 103, 99, 101)), { reason: "stop", price: 102 });
  assert.deepEqual(evaluateExit(Sh, c(100, 101, 95, 96)), { reason: "target", price: 96 });
}

// accounting: round trip with fees
{
  const entryFill = 100;
  const units = 5;
  const entryFee = (entryFill * units * 0.1) / 100; // 0.5
  const m = closeMath("long", entryFill, 104, units, entryFee, 0.1);
  near(m.gross, 20);
  near(m.exitFee, 0.52);
  near(m.net, 20 - 0.5 - 0.52);
  near(unrealizedPnl("short", 100, 98, 5), 10);
  const s = closeMath("short", 100, 102, 5, 0.5, 0.1);
  near(s.gross, -10);
}

// drawdown + stats
{
  const dd = maxDrawdown([100, 120, 90, 110, 80, 130]);
  near(dd.usd, 40);
  near(dd.pct, (40 / 120) * 100);
  const st = computeStats([10, -5, 20, -10], [], 1000);
  assert.equal(st.closedCount, 4);
  near(st.winRatePct!, 50);
  near(st.profitFactor!, 2);
  near(st.maxDrawdownUsd, 10);
  assert.equal(computeStats([], [], 1000).winRatePct, null);
}
console.log("paper tests passed");

// profit lock
{
  const { replayCandles } = await import("../lib/paper.ts");
  const c = (t: number, o: number, h: number, l: number, cl: number) => ({ t: t * 60000, o, h, l, c: cl, v: 1 });
  // long from 100: stop 98, target off, lock at +1.5% (101.5) -> stop 100.5
  const base = { direction: "long" as const, stop: 98, target: null, lockTrigger: 101.5, lockStop: 100.5, locked: false };
  // reaches trigger, then falls back below the locked stop: exits in profit at the lock level
  let r = replayCandles(base, [c(1, 100, 101.6, 99.9, 101), c(2, 101, 101.1, 100.2, 100.4)], 0);
  assert.equal(r.exit!.reason, "profit_lock");
  near(r.exit!.price, 100.5);
  // trigger and a dip below the lock level inside the SAME candle: lock only acts from the next candle
  r = replayCandles(base, [c(1, 100, 101.6, 100.2, 101)], 0);
  assert.equal(r.exit, null);
  assert.equal(r.locked, true);
  near(r.stop!, 100.5);
  // never reaching the trigger: original stop still applies, labelled as a normal stop
  r = replayCandles(base, [c(1, 100, 101, 99.5, 100.5), c(2, 100.5, 100.6, 97.5, 98)], 0);
  assert.equal(r.exit!.reason, "stop");
  near(r.exit!.price, 98);
  // gap down through the locked stop fills at the open (can be below the lock level)
  r = replayCandles({ ...base, locked: true, stop: 100.5 }, [c(1, 100.0, 100.1, 99.8, 99.9)], 0);
  assert.equal(r.exit!.reason, "profit_lock");
  near(r.exit!.price, 100.0);
  // stop off + lock on: lock creates the stop
  r = replayCandles({ ...base, stop: null }, [c(1, 100, 101.6, 100.2, 101)], 0);
  near(r.stop!, 100.5);
  // short mirrors it: entry 100, lock at 98.5 -> stop 99.5
  const sh = { direction: "short" as const, stop: 102, target: null, lockTrigger: 98.5, lockStop: 99.5, locked: false };
  r = replayCandles(sh, [c(1, 100, 100.2, 98.4, 99), c(2, 99, 99.6, 98.8, 99.4)], 0);
  assert.equal(r.exit!.reason, "profit_lock");
  near(r.exit!.price, 99.5);
  // candles before fromT are ignored
  assert.equal(replayCandles(base, [c(1, 100, 105, 90, 100)], 120000).exit, null);
}
console.log("profit lock tests passed");

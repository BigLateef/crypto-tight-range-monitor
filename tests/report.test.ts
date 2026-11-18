import assert from "node:assert/strict";
import { paperReport, wilson } from "../lib/report.ts";

const t = (pnl: number, symbol = "BTC-USD", direction = "long", breakEven: number | null = 0.45) => ({ pnl, symbol, direction, breakEven });
// wilson interval sanity
{
  const w = wilson(50, 100);
  assert.ok(w.low > 0.40 && w.low < 0.41 && w.high > 0.59 && w.high < 0.60);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
}
// small sample: never a verdict about edge, even if every trade won
{
  const r = paperReport(Array.from({ length: 10 }, () => t(5)), []);
  assert.ok(r.verdict.startsWith("INSUFFICIENT EVIDENCE"));
  assert.equal(r.winRate, 1);
}
// big sample, clear win rate above break-even
{
  const trades = [...Array.from({ length: 70 }, () => t(10)), ...Array.from({ length: 50 }, () => t(-8))];
  const r = paperReport(trades, []);
  assert.equal(r.n, 120);
  assert.ok(r.verdict.startsWith("WIN RATE ABOVE BREAK-EVEN"));
  assert.ok(r.winRateLow! > 0.45);
  assert.ok(Math.abs(r.expectancy! - (700 - 400) / 120) < 1e-9);
}
// big sample, negative expectancy
{
  const r = paperReport([...Array.from({ length: 40 }, () => t(10)), ...Array.from({ length: 80 }, () => t(-10))], []);
  assert.ok(r.verdict.startsWith("NO EDGE DEMONSTRATED"));
}
// positive expectancy but win rate not clearly above break-even
{
  const r = paperReport([...Array.from({ length: 50 }, () => t(30)), ...Array.from({ length: 70 }, () => t(-20))], []);
  assert.ok(r.verdict.startsWith("INCONCLUSIVE"), r.verdict);
}
// funnel: missed signals are counted and reasons are grouped with numbers stripped
{
  const r = paperReport([], [
    { state: "entered", note: null, n: 4 },
    { state: "skipped", note: "price already moved 0.41% in the trade direction since the confirming close (limit 0.35%): not chasing", n: 2 },
    { state: "skipped", note: "price already moved 0.52% in the trade direction since the confirming close (limit 0.35%): not chasing", n: 1 },
    { state: "skipped", note: "Max open positions reached", n: 1 },
    { state: "pending", note: null, n: 1 },
  ]);
  assert.deepEqual({ ...r.setups, topSkipReasons: undefined }, { total: 9, entered: 4, pending: 1, skipped: 4, topSkipReasons: undefined });
  assert.equal(r.setups.topSkipReasons[0].count, 3);
}
// slices
{
  const r = paperReport([t(1, "BTC-USD", "long"), t(-1, "ETH-USD", "short"), t(2, "BTC-USD", "short")], []);
  assert.equal(r.bySymbol[0].key, "BTC-USD");
  assert.equal(r.byDirection.length, 2);
}
console.log("report tests passed");

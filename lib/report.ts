// Plain-language scorecard for the paper account. PURE (no imports). It reports what happened and whether the
// sample is big enough to say anything; it never says the strategy "works".
export interface ReportTrade { pnl: number; breakEven: number | null; direction: string; symbol: string }
export interface FunnelRow { state: string; note: string | null; n: number }

export function wilson(wins: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

const slice = (ts: ReportTrade[]) => {
  const n = ts.length;
  const wins = ts.filter((t) => t.pnl > 0).length;
  return { n, winRate: n ? wins / n : null, net: ts.reduce((a, t) => a + t.pnl, 0) };
};

export function paperReport(trades: ReportTrade[], funnel: FunnelRow[], minTrades = 100) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = n ? wins.length / n : null;
  const ci = wilson(wins.length, n);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : null;
  const expectancy = n ? trades.reduce((a, t) => a + t.pnl, 0) / n : null;
  const be = trades.filter((t) => t.breakEven !== null).map((t) => t.breakEven as number);
  const avgBreakEven = be.length ? be.reduce((a, b) => a + b, 0) / be.length : null;

  let verdict: string;
  if (n < minTrades) verdict = `INSUFFICIENT EVIDENCE: ${n} closed paper trade(s), need ${minTrades} before any win-rate or expectancy figure means much. No claim either way.`;
  else if (avgBreakEven !== null && ci.low > avgBreakEven && (expectancy ?? 0) > 0) verdict = "WIN RATE ABOVE BREAK-EVEN ON THIS SAMPLE: not proof. Paper fills are friendlier than real ones (no queue, no partial fills, no outages).";
  else if ((expectancy ?? 0) <= 0) verdict = "NO EDGE DEMONSTRATED: expectancy after costs is not positive on this sample.";
  else verdict = "INCONCLUSIVE: expectancy is positive but the win rate is not clearly above break-even.";

  const group = (key: (t: ReportTrade) => string) => {
    const m = new Map<string, ReportTrade[]>();
    for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return [...m.entries()].map(([k, v]) => ({ key: k, ...slice(v) })).sort((a, b) => b.n - a.n);
  };

  const entered = funnel.filter((f) => f.state === "entered").reduce((a, f) => a + f.n, 0);
  const pending = funnel.filter((f) => f.state === "pending").reduce((a, f) => a + f.n, 0);
  const skipped = funnel.filter((f) => f.state === "skipped").reduce((a, f) => a + f.n, 0);
  const reasons = new Map<string, number>();
  for (const f of funnel.filter((x) => x.state === "skipped")) {
    const k = (f.note || "no reason recorded").replace(/[-+]?\$?\d[\d,.]*%?/g, "#").slice(0, 70);
    reasons.set(k, (reasons.get(k) ?? 0) + f.n);
  }
  return {
    n, wins: wins.length, winRate, winRateLow: n ? ci.low : null, winRateHigh: n ? ci.high : null,
    avgWin, avgLoss, expectancy, avgBreakEven, minTrades, verdict,
    bySymbol: group((t) => t.symbol), byDirection: group((t) => t.direction),
    setups: { total: entered + pending + skipped, entered, pending, skipped, topSkipReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count })) },
  };
}

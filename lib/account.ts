import { sql, type Row } from "./db";
import { unrealizedPnl } from "./paper";
import type { Direction } from "./types";

// Virtual cash = starting balance + realized P&L (net of fees) - cost and entry fee of open positions.
export async function loadAccount(startingBalance: number) {
  const r: Row = (
    await sql()`select
      coalesce(sum(realized_pnl) filter (where status = 'closed'), 0) as realized,
      coalesce(sum(notional + entry_fee) filter (where status = 'open'), 0) as open_cost_fees,
      coalesce(sum(notional) filter (where status = 'open'), 0) as open_cost,
      coalesce(sum(entry_fee + coalesce(exit_fee, 0)) filter (where status = 'closed'), 0) as fees_closed,
      count(*) filter (where status = 'closed') as closed_count
    from paper_trades`
  )[0];
  const realized = Number(r.realized);
  const openCost = Number(r.open_cost);
  return {
    realized,
    openCost,
    feesClosed: Number(r.fees_closed),
    closedCount: Number(r.closed_count),
    cash: startingBalance + realized - Number(r.open_cost_fees),
  };
}

export function markOpen(rows: Row[], prices: Record<string, number>) {
  let value = 0;
  let unrealized = 0;
  for (const t of rows) {
    const px = prices[t.symbol] ?? (t.last_price != null ? Number(t.last_price) : Number(t.entry_price));
    const u = unrealizedPnl(t.direction as Direction, Number(t.entry_price), px, Number(t.units));
    unrealized += u;
    value += Number(t.notional) + u;
  }
  return { value, unrealized };
}

import { sql, type Row } from "./db";
import { loadSettings } from "./settings";
import { loadAccount, markOpen } from "./account";
import { fetchPrice } from "./provider";
import { computeStats, unrealizedPnl } from "./paper";
import type { Direction } from "./types";

const cache = new Map<string, { p: number; at: number }>();
async function livePrice(provider: any, sym: string): Promise<{ p: number | null; live: boolean }> {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < 8000) return { p: hit.p, live: true };
  try {
    const p = await fetchPrice(provider, sym);
    cache.set(sym, { p, at: Date.now() });
    return { p, live: true };
  } catch {
    return { p: null, live: false };
  }
}

export async function buildPortfolio() {
  const db = sql();
  const s = await loadSettings();
  const now = Date.now();
  const [openRows, closedRows, pnlRows, eqRows, eng, alertCount] = await Promise.all([
    db`select *, (extract(epoch from opened_at) * 1000)::bigint as opened_ms from paper_trades where status = 'open' order by id desc`,
    db`select *, (extract(epoch from opened_at) * 1000)::bigint as opened_ms, (extract(epoch from closed_at) * 1000)::bigint as closed_ms from paper_trades where status = 'closed' order by closed_at desc limit 200`,
    db`select realized_pnl from paper_trades where status = 'closed' order by closed_at asc limit 5000`,
    db`select equity from equity_snapshots order by ts asc limit 30000`,
    db`select (extract(epoch from last_tick_at) * 1000)::bigint as last_tick_ms, last_tick_ok, last_tick_note from engine_state where id = 1`,
    db`select count(*) as n from range_alerts where status = 'active'`,
  ]);
  const acct = await loadAccount(s.startingBalance);

  const syms: string[] = Array.from(new Set<string>(openRows.map((t: Row) => String(t.symbol))));
  const prices: Record<string, number> = {};
  const liveMap: Record<string, boolean> = {};
  await Promise.all(
    syms.map(async (sym) => {
      const r = await livePrice(s.provider, sym);
      if (r.p) prices[sym] = r.p;
      liveMap[sym] = r.live;
    }),
  );
  const mtm = markOpen(openRows, prices);
  const equity = acct.cash + mtm.value;

  const open = openRows.map((t: Row) => {
    const px = prices[t.symbol] ?? (t.last_price != null ? Number(t.last_price) : Number(t.entry_price));
    const pnl = unrealizedPnl(t.direction as Direction, Number(t.entry_price), px, Number(t.units));
    return {
      id: String(t.id),
      symbol: t.symbol,
      direction: t.direction,
      entryPrice: Number(t.entry_price),
      units: Number(t.units),
      notional: Number(t.notional),
      entryFee: Number(t.entry_fee),
      currentPrice: px,
      priceIsLive: !!liveMap[t.symbol],
      pnl,
      pnlPct: (pnl / Number(t.notional)) * 100,
      stop: t.stop_price == null ? null : Number(t.stop_price),
      stopLocked: !!t.stop_locked,
      lockTrigger: t.lock_trigger_price == null ? null : Number(t.lock_trigger_price),
      lockStop: t.lock_stop_price == null ? null : Number(t.lock_stop_price),
      target: t.target_price == null ? null : Number(t.target_price),
      openedMs: Number(t.opened_ms),
      maxHoldMinutes: Number(t.max_hold_minutes),
    };
  });
  const closed = closedRows.map((t: Row) => ({
    id: String(t.id),
    symbol: t.symbol,
    direction: t.direction,
    entryPrice: Number(t.entry_price),
    exitPrice: Number(t.exit_price),
    units: Number(t.units),
    notional: Number(t.notional),
    fees: Number(t.entry_fee) + Number(t.exit_fee ?? 0),
    slippageUsd: Number(t.entry_slippage_usd) + Number(t.exit_slippage_usd ?? 0),
    exitReason: t.exit_reason,
    pnl: Number(t.realized_pnl),
    openedMs: Number(t.opened_ms),
    closedMs: Number(t.closed_ms),
  }));
  const stats = computeStats(pnlRows.map((r: Row) => Number(r.realized_pnl)), eqRows.map((r: Row) => Number(r.equity)), s.startingBalance);
  const lastTickMs = eng[0]?.last_tick_ms ? Number(eng[0].last_tick_ms) : null;

  return {
    now,
    paperEnabled: s.paperEnabled,
    tickIntervalMin: s.tickIntervalMin,
    provider: s.provider,
    timeframeMin: s.timeframeMin,
    symbols: s.symbols,
    account: {
      startingBalance: s.startingBalance,
      cash: acct.cash,
      openCost: acct.openCost,
      openValue: mtm.value,
      unrealized: mtm.unrealized,
      realized: acct.realized,
      equity,
      equityChangePct: ((equity - s.startingBalance) / s.startingBalance) * 100,
    },
    stats,
    open,
    closed,
    engine: { lastTickMs, ok: eng[0]?.last_tick_ok ?? null, note: eng[0]?.last_tick_note || null },
    activeRanges: Number(alertCount[0]?.n ?? 0),
  };
}

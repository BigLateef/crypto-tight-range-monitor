// Export / restore of the simulated account, so you can move between databases (e.g. Neon -> Supabase).
// Rows are exported with their ids so trade <-> alert links survive. Restore REPLACES the target's data.
import { sql } from "./db";
import { FORMAT, checkBackup } from "./backupcheck";
import { DEFAULTS, validateSettings } from "./config";

export async function exportAll() {
  const db = sql();
  const [settings, alerts, trades, snaps] = await Promise.all([
    db`select data from app_settings where id = 1`,
    db`select * from range_alerts order by id`,
    db`select * from paper_trades order by id`,
    db`select * from equity_snapshots order by ts`,
  ]);
  return { format: FORMAT, exportedAt: new Date().toISOString(), settings: settings[0]?.data ?? {}, range_alerts: alerts, paper_trades: trades, equity_snapshots: snaps };
}

export async function restoreAll(backup: any) {
  const chk = checkBackup(backup);
  if (!chk.ok) throw new Error(chk.error);
  const db = sql();

  await db`delete from paper_trades`;
  await db`delete from range_alerts`;
  await db`delete from equity_snapshots`;

  if (backup.range_alerts.length) {
    await db`insert into range_alerts (id, symbol, timeframe_min, range_high, range_low, width_pct, touches_high, touches_low, window_candles, window_start_t, window_end_t, detected_at, status, breakout_direction, breakout_confirm_t, breakout_close, broken_at, paper_state, paper_note, trade_id)
      select id, symbol, timeframe_min, range_high, range_low, width_pct, touches_high, touches_low, window_candles, window_start_t, window_end_t, coalesce(detected_at, now()), coalesce(status, 'active'), breakout_direction, breakout_confirm_t, breakout_close, broken_at, coalesce(paper_state, 'none'), paper_note, trade_id
      from json_populate_recordset(null::range_alerts, ${JSON.stringify(backup.range_alerts)}::json)`;
  }
  if (backup.paper_trades.length) {
    await db`insert into paper_trades (id, alert_id, symbol, direction, status, units, notional, ref_entry_price, entry_price, entry_slippage_usd, entry_fee, stop_price, initial_stop_price, target_price, lock_trigger_price, lock_stop_price, stop_locked, locked_at, max_hold_minutes, opened_at, checked_through, last_price, last_price_at, ref_exit_price, exit_price, exit_slippage_usd, exit_fee, closed_at, exit_reason, gross_pnl, realized_pnl)
      select id, alert_id, symbol, direction, coalesce(status, 'open'), units, notional, ref_entry_price, entry_price, entry_slippage_usd, entry_fee, stop_price, initial_stop_price, target_price, lock_trigger_price, lock_stop_price, coalesce(stop_locked, false), locked_at, coalesce(max_hold_minutes, 0), coalesce(opened_at, now()), checked_through, last_price, last_price_at, ref_exit_price, exit_price, exit_slippage_usd, exit_fee, closed_at, exit_reason, gross_pnl, realized_pnl
      from json_populate_recordset(null::paper_trades, ${JSON.stringify(backup.paper_trades)}::json)`;
  }
  if (backup.equity_snapshots.length) {
    await db`insert into equity_snapshots (ts, equity) select ts, equity from json_populate_recordset(null::equity_snapshots, ${JSON.stringify(backup.equity_snapshots)}::json) on conflict (ts) do nothing`;
  }
  const merged = validateSettings(backup.settings, DEFAULTS).settings; // invalid/unknown fields fall back safely
  await db`update app_settings set data = ${JSON.stringify(merged)}::jsonb, updated_at = now() where id = 1`;

  // new rows after a restore must not reuse the restored ids
  await db`select setval(pg_get_serial_sequence('range_alerts', 'id'), greatest((select coalesce(max(id), 0) from range_alerts), 1), (select count(*) > 0 from range_alerts))`;
  await db`select setval(pg_get_serial_sequence('paper_trades', 'id'), greatest((select coalesce(max(id), 0) from paper_trades), 1), (select count(*) > 0 from paper_trades))`;
  return chk.counts;
}

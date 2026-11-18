// Pure validation of a backup file (no imports, testable with plain node).
export const FORMAT = "ctrm-backup-v1";

export function checkBackup(b: any): { ok: true; counts: { alerts: number; setups: number; trades: number; snapshots: number } } | { ok: false; error: string } {
  if (!b || typeof b !== "object") return { ok: false, error: "Not a backup file" };
  if (b.format !== FORMAT) return { ok: false, error: `Unknown backup format (expected ${FORMAT})` };
  for (const k of ["range_alerts", "paper_trades", "equity_snapshots"]) {
    if (!Array.isArray(b[k])) return { ok: false, error: `Backup is missing "${k}"` };
  }
  if (b.retest_setups !== undefined && !Array.isArray(b.retest_setups)) return { ok: false, error: 'Backup has a malformed "retest_setups"' };
  if (!b.settings || typeof b.settings !== "object" || Array.isArray(b.settings)) return { ok: false, error: 'Backup is missing "settings"' };
  if (b.range_alerts.length > 20000 || b.paper_trades.length > 50000 || b.equity_snapshots.length > 60000) return { ok: false, error: "Backup is larger than this app supports" };
  for (const t of b.paper_trades) {
    if (!t || t.id == null || !t.symbol || (t.direction !== "long" && t.direction !== "short")) return { ok: false, error: "A trade in the backup is malformed" };
  }
  for (const a of b.range_alerts) {
    if (!a || a.id == null || !a.symbol) return { ok: false, error: "An alert in the backup is malformed" };
  }
  for (const a of b.retest_setups || []) {
    if (!a || a.id == null || !a.symbol || (a.dir !== "long" && a.dir !== "short")) return { ok: false, error: "A setup in the backup is malformed" };
  }
  return { ok: true, counts: { alerts: b.range_alerts.length, setups: (b.retest_setups || []).length, trades: b.paper_trades.length, snapshots: b.equity_snapshots.length } };
}

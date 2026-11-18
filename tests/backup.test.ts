import assert from "node:assert/strict";
import { checkBackup, FORMAT } from "../lib/backupcheck.ts";

const good = { format: FORMAT, settings: {}, range_alerts: [{ id: "1", symbol: "BTC-USD" }], paper_trades: [{ id: "2", symbol: "BTC-USD", direction: "long" }], equity_snapshots: [] };
const r = checkBackup(good);
assert.equal(r.ok, true);
if (r.ok) assert.deepEqual(r.counts, { alerts: 1, setups: 0, trades: 1, snapshots: 0 });
assert.equal(checkBackup(null).ok, false);
assert.equal(checkBackup({ ...good, format: "x" }).ok, false);
assert.equal(checkBackup({ ...good, paper_trades: undefined }).ok, false);
assert.equal(checkBackup({ ...good, settings: [] }).ok, false);
assert.equal(checkBackup({ ...good, paper_trades: [{ id: "2", symbol: "BTC-USD", direction: "up" }] }).ok, false);
assert.equal(checkBackup({ ...good, range_alerts: [{ symbol: "BTC-USD" }] }).ok, false);
// retest_setups is optional (backups made by the range-rule version lack it) but must be well formed when present
const withSetups = { ...good, retest_setups: [{ id: "5", symbol: "ETH-USD", dir: "short" }] };
const r2 = checkBackup(withSetups);
assert.equal(r2.ok, true);
if (r2.ok) assert.equal(r2.counts.setups, 1);
assert.equal(checkBackup({ ...good, retest_setups: [{ id: "5", symbol: "ETH-USD", dir: "up" }] }).ok, false);
assert.equal(checkBackup({ ...good, retest_setups: "x" }).ok, false);
console.log("backup tests passed");

import assert from "node:assert/strict";
import { checkBackup, FORMAT } from "../lib/backupcheck.ts";

const good = { format: FORMAT, settings: {}, range_alerts: [{ id: "1", symbol: "BTC-USD" }], paper_trades: [{ id: "2", symbol: "BTC-USD", direction: "long" }], equity_snapshots: [] };
const r = checkBackup(good);
assert.equal(r.ok, true);
if (r.ok) assert.deepEqual(r.counts, { alerts: 1, trades: 1, snapshots: 0 });
assert.equal(checkBackup(null).ok, false);
assert.equal(checkBackup({ ...good, format: "x" }).ok, false);
assert.equal(checkBackup({ ...good, paper_trades: undefined }).ok, false);
assert.equal(checkBackup({ ...good, settings: [] }).ok, false);
assert.equal(checkBackup({ ...good, paper_trades: [{ id: "2", symbol: "BTC-USD", direction: "up" }] }).ok, false);
assert.equal(checkBackup({ ...good, range_alerts: [{ symbol: "BTC-USD" }] }).ok, false);
console.log("backup tests passed");

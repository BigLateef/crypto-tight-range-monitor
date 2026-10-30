import assert from "node:assert/strict";
import { DEFAULTS, validateSettings, parseSymbols } from "../lib/config.ts";

assert.ok(validateSettings({}).ok);
const r = validateSettings({ feePct: "0.2", symbols: "btc-usd, eth-usd", timeframeMin: "15", paperEnabled: false });
assert.ok(r.ok);
assert.equal(r.settings.feePct, 0.2);
assert.deepEqual(r.settings.symbols, ["BTC-USD", "ETH-USD"]);
assert.equal(r.settings.timeframeMin, 15);
assert.equal(r.settings.paperEnabled, false);
// invalid values keep the base value and report an error
const bad = validateSettings({ feePct: -1, rangeLookback: 12.5, stopMode: "nope", timeframeMin: 7 });
assert.equal(bad.ok, false);
assert.equal(bad.errors.length, 4);
assert.equal(bad.settings.feePct, DEFAULTS.feePct);
// cross-field rules
assert.equal(validateSettings({ stopMode: "off", sizingMode: "risk_pct" }).ok, false);
assert.equal(validateSettings({ stopMode: "off", targetMode: "r_multiple" }).ok, false);
assert.equal(validateSettings({ allowLong: false, allowShort: false }).ok, false);
assert.equal(parseSymbols("BTCUSD"), null);
assert.equal(parseSymbols(Array.from({ length: 11 }, (_, i) => `A${i}-USD`)), null);
console.log("config tests passed");
assert.equal(validateSettings({ tickIntervalMin: 5 }).ok, true);
assert.equal(validateSettings({ tickIntervalMin: 0 }).ok, false);
console.log("tick interval tests passed");
assert.equal(validateSettings({ lockEnabled: true, lockTriggerPct: 1.5, lockProfitPct: 0.5 }).ok, true);
assert.equal(validateSettings({ lockEnabled: true, lockTriggerPct: 1, lockProfitPct: 1 }).ok, false);
assert.equal(validateSettings({ lockEnabled: false, lockTriggerPct: 1, lockProfitPct: 1 }).ok, true);
console.log("lock config tests passed");
assert.equal(validateSettings({ timeframeMin: 1 }).ok, true);
assert.equal(validateSettings({ timeframeMin: 3 }).ok, false);
console.log("timeframe tests passed");
assert.equal(validateSettings({ detectionMode: "swing_pattern", swingMinPct: 0.3, swingBandTolPct: 40 }).ok, true);
assert.equal(validateSettings({ swingMinPct: 0 }).ok, false);
assert.equal(validateSettings({ swingBandTolPct: 1000 }).ok, false);
assert.equal(validateSettings({ detectionMode: "nope" }).ok, false);
console.log("detection mode tests passed");

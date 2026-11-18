import assert from "node:assert/strict";
import { DEFAULTS, validateSettings, parseSymbols } from "../lib/config.ts";

assert.ok(validateSettings({}).ok);
const r = validateSettings({ takerFeePct: "0.2", symbols: "btc-usd, eth-usd", timeframeMin: "15", paperEnabled: false });
assert.ok(r.ok);
assert.equal(r.settings.takerFeePct, 0.2);
assert.deepEqual(r.settings.symbols, ["BTC-USD", "ETH-USD"]);
assert.equal(r.settings.timeframeMin, 15);
assert.equal(r.settings.paperEnabled, false);
// invalid values keep the base value and report an error
const bad = validateSettings({ takerFeePct: -1, minPriorBounces: 1.5, targetFill: "nope", timeframeMin: 7 });
assert.equal(bad.ok, false);
assert.equal(bad.errors.length, 4);
assert.equal(bad.settings.takerFeePct, DEFAULTS.takerFeePct);
assert.equal(validateSettings({ allowLong: false, allowShort: false }).ok, false);
assert.equal(parseSymbols("BTCUSD"), null);
assert.equal(parseSymbols(Array.from({ length: 11 }, (_, i) => `A${i}-USD`)), null);
// old removed fields are ignored, never an error (stored settings from the range-rule version)
assert.ok(validateSettings({ rangeLookback: 24, detectionMode: "tight_range", feePct: 0.1 }).ok);
console.log("config tests passed");
assert.equal(validateSettings({ tickIntervalMin: 5 }).ok, true);
assert.equal(validateSettings({ tickIntervalMin: 0 }).ok, false);
assert.equal(DEFAULTS.tickIntervalMin, 1);
console.log("tick interval tests passed");
assert.equal(validateSettings({ lockEnabled: true, lockTriggerPct: 1.5, lockProfitPct: 0.5 }).ok, true);
assert.equal(validateSettings({ lockEnabled: true, lockTriggerPct: 1, lockProfitPct: 1 }).ok, false);
console.log("lock config tests passed");
assert.equal(validateSettings({ timeframeMin: 1 }).ok, true);
assert.equal(validateSettings({ timeframeMin: 3 }).ok, false);
assert.equal(validateSettings({ timeframeMin: 15, zoneTfMin: 60 }).ok, true);
assert.equal(validateSettings({ zoneTfMin: 120 }).ok, false);
console.log("timeframe tests passed");
// retest settings
assert.equal(DEFAULTS.costsConfirmed, false, "fees start as unconfirmed placeholders");
assert.equal(validateSettings({ minStopPct: 2, maxStopPct: 1 }).ok, false);
assert.equal(DEFAULTS.riskConfirmed, false, "risk values start as unconfirmed placeholders");
assert.equal(validateSettings({ riskPct: 10 }).ok, true);
assert.equal(validateSettings({ riskPct: 30 }).ok, false);
assert.equal(validateSettings({ riskPct: 1.5, dailyLossLimitPct: 3, minPriorBounces: 3, zoneTfMin: 240 }).ok, true);
console.log("retest settings tests passed");

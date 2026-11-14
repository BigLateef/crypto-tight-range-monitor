import assert from "node:assert/strict";
import { buildForecast, logForecast, loadDueForecasts, saveOutcome } from "../lib/forecast.ts";
import { DEFAULTS, parseHorizons, validateSettings } from "../lib/config.ts";

const base = {
  symbol: "BTC-USD",
  timeframeMin: 5,
  horizonMin: 60,
  issuedT: 1_000_000,
  now: 1_000_000 + 45_000,
  model: "range_breakout_v1",
  direction: "UP" as const,
  probs: null,
  refPrice: 100,
  costPct: 0.3,
  invalidationPrice: 99.5,
  features: { rangeHigh: 99.5 },
  evidence: "Observed: close beyond range edge.",
};

// freshness is recorded; probabilities may be absent for an uncalibrated rule
{
  const f = buildForecast(base);
  assert.equal(f.dataAgeSec, 45);
  assert.equal(f.pUp, null);
  assert.equal(f.direction, "UP");
  assert.equal(f.invalidationPrice, 99.5);
}
// probabilities must be a valid distribution
assert.throws(() => buildForecast({ ...base, probs: { up: 0.5, down: 0.5, sideways: 0.5 } }));
assert.throws(() => buildForecast({ ...base, probs: { up: 1.2, down: -0.2, sideways: 0 } }));
assert.equal(buildForecast({ ...base, probs: { up: 0.2, down: 0.3, sideways: 0.5 } }).pSideways, 0.5);
assert.throws(() => buildForecast({ ...base, refPrice: 0 }));
// a built forecast cannot be mutated
{
  const f = buildForecast(base);
  assert.throws(() => {
    "use strict";
    (f as any).direction = "DOWN";
  });
}

// fake db: records SQL text and parameters
function fakeDb(rows: Record<string, any>[][] = []) {
  const calls: { sql: string; values: any[] }[] = [];
  const db = (async (strings: TemplateStringsArray, ...values: any[]) => {
    calls.push({ sql: strings.join("?"), values });
    return rows.shift() ?? [];
  }) as any;
  return { db, calls };
}

(async () => {
  // new forecast -> true; duplicate (db returns no row) -> false; and the SQL can never overwrite
  {
    const { db, calls } = fakeDb([[{ id: 1 }], []]);
    assert.equal(await logForecast(db, buildForecast(base)), true);
    assert.equal(await logForecast(db, buildForecast({ ...base, direction: "DOWN" })), false);
    for (const c of calls) {
      assert.match(c.sql, /insert into forecasts/);
      assert.match(c.sql, /on conflict \(symbol, timeframe_min, horizon_min, model, issued_t\) do nothing/);
      assert.doesNotMatch(c.sql, /update forecasts|delete from forecasts|do update/i);
    }
    assert.equal(calls[0].values[2], 60);
  }
  // outcomes go to their own table, also never overwritten
  {
    const { db, calls } = fakeDb();
    await saveOutcome(db, 7, { actual: "UP", endT: 1, endPrice: 2, returnPct: 3, thresholdPct: 0.3 });
    assert.match(calls[0].sql, /insert into forecast_outcomes/);
    assert.match(calls[0].sql, /on conflict \(forecast_id\) do nothing/);
    assert.doesNotMatch(calls[0].sql, /update forecasts/i);
  }
  // due query only returns forecasts that have no outcome yet
  {
    const { db, calls } = fakeDb([[]]);
    await loadDueForecasts(db, "BTC-USD", 5, 123);
    assert.match(calls[0].sql, /o\.forecast_id is null/);
  }

  // horizon config
  assert.deepEqual(parseHorizons("240, 60", 5), [60, 240]);
  assert.equal(parseHorizons([7], 5), null); // not a multiple of the candle
  assert.equal(parseHorizons([], 5), null);
  assert.equal(parseHorizons([5, 10, 15, 20, 25, 30], 5), null); // too many
  assert.deepEqual(DEFAULTS.forecastHorizonsMin, [60, 240]);
  assert.ok(validateSettings({}).ok);
  assert.equal(validateSettings({ forecastHorizonsMin: "30,120" }).settings.forecastHorizonsMin.join(), "30,120");
  assert.equal(validateSettings({ forecastHorizonsMin: [7] }).ok, false);
  // changing the candle length so that existing horizons no longer fit is rejected, not silently accepted
  assert.equal(validateSettings({ timeframeMin: 60, forecastHorizonsMin: [60, 240] }).ok, true);
  assert.equal(validateSettings({ forecastHorizonsMin: [60, 240] }, { ...DEFAULTS, timeframeMin: 15 }).ok, true);
  assert.equal(validateSettings({ timeframeMin: 15 }, { ...DEFAULTS, forecastHorizonsMin: [20] }).ok, false);
  console.log("forecast tests passed");
})();

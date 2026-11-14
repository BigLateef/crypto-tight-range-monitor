// Forecast records. Append-only by design: the only write path here is INSERT ... ON CONFLICT DO NOTHING, and
// sql/004 adds a trigger that rejects UPDATE/DELETE. Outcomes are stored in a separate table.
// Only type imports, so this file can be unit-tested with plain node and a fake `db`.
export type Direction4 = "UP" | "DOWN" | "SIDEWAYS" | "NO_SIGNAL";

export interface ForecastInput {
  symbol: string;
  timeframeMin: number;
  horizonMin: number;
  issuedT: number; // ms: close time of the newest closed candle used
  now: number; // ms: when the forecast is made
  model: string;
  direction: Direction4;
  probs: { up: number; down: number; sideways: number } | null; // null = this model has no calibrated probabilities
  refPrice: number;
  costPct: number;
  invalidationPrice: number | null;
  features: Record<string, number | string | boolean | null>;
  evidence: string;
}

export interface ForecastRow extends Omit<ForecastInput, "now" | "probs"> {
  dataAgeSec: number;
  pUp: number | null;
  pDown: number | null;
  pSideways: number | null;
}

export function buildForecast(i: ForecastInput): ForecastRow {
  if (i.probs) {
    const { up, down, sideways } = i.probs;
    const sum = up + down + sideways;
    if (![up, down, sideways].every((x) => x >= 0 && x <= 1) || Math.abs(sum - 1) > 1e-6) throw new Error("forecast probabilities must be in [0,1] and sum to 1");
  }
  if (!(i.refPrice > 0)) throw new Error("forecast needs a positive reference price");
  const { now, probs, ...rest } = i;
  return Object.freeze({
    ...rest,
    dataAgeSec: Math.max(0, Math.round((now - i.issuedT) / 1000)),
    pUp: probs ? probs.up : null,
    pDown: probs ? probs.down : null,
    pSideways: probs ? probs.sideways : null,
  });
}

type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<Record<string, any>[]>;

// Returns true if a NEW row was written, false if this exact forecast was already logged (never overwritten).
export async function logForecast(db: Sql, f: ForecastRow): Promise<boolean> {
  const r = await db`insert into forecasts (symbol, timeframe_min, horizon_min, issued_t, model, direction, p_up, p_down, p_sideways, ref_price, data_age_sec, invalidation_price, cost_pct, features, evidence)
    values (${f.symbol}, ${f.timeframeMin}, ${f.horizonMin}, ${f.issuedT}, ${f.model}, ${f.direction}, ${f.pUp}, ${f.pDown}, ${f.pSideways}, ${f.refPrice}, ${f.dataAgeSec}, ${f.invalidationPrice}, ${f.costPct}, ${JSON.stringify(f.features)}::jsonb, ${f.evidence})
    on conflict (symbol, timeframe_min, horizon_min, model, issued_t) do nothing returning id`;
  return r.length > 0;
}

// Forecasts that have no outcome row yet and whose horizon is over.
export async function loadDueForecasts(db: Sql, symbol: string, timeframeMin: number, nowMs: number) {
  return db`select f.id, f.horizon_min, f.issued_t, f.ref_price, f.cost_pct
    from forecasts f left join forecast_outcomes o on o.forecast_id = f.id
    where o.forecast_id is null and f.symbol = ${symbol} and f.timeframe_min = ${timeframeMin}
      and f.issued_t + f.horizon_min * 60000 <= ${nowMs}
    order by f.issued_t limit 500`;
}

export async function saveOutcome(
  db: Sql,
  forecastId: number,
  r: { actual: string; endT: number | null; endPrice: number | null; returnPct: number | null; thresholdPct: number | null },
): Promise<void> {
  await db`insert into forecast_outcomes (forecast_id, end_t, end_price, return_pct, actual, threshold_pct)
    values (${forecastId}, ${r.endT}, ${r.endPrice}, ${r.returnPct}, ${r.actual}, ${r.thresholdPct})
    on conflict (forecast_id) do nothing`;
}

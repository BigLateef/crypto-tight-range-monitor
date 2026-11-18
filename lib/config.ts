// Pure settings model + validation. No imports, so it can be tested with plain node.

export type Provider = "coinbase" | "binance";
export type TargetFill = "maker" | "taker";

export interface Settings {
  paperEnabled: boolean;
  provider: Provider;
  symbols: string[];
  timeframeMin: number; // trigger candle (confirmation) timeframe
  zoneTfMin: number; // zone timeframe: 60 or 240 (4h is built from 1h candles)
  minPriorBounces: number;
  minWickFrac: number;
  maxChasePct: number;
  stopBufferPct: number;
  minStopPct: number;
  maxStopPct: number;
  targetPct: number;
  minNetRR: number;
  cooldownMin: number;
  allowLong: boolean;
  allowShort: boolean;
  maxEntryDelaySec: number;
  tickIntervalMin: number;
  startingBalance: number;
  riskPct: number; // equity lost if the stop is hit, INCLUDING costs
  dailyLossLimitPct: number; // no new entries once today's realized loss reaches this % of equity
  maxOpenPositions: number;
  takerFeePct: number;
  makerFeePct: number;
  slippagePct: number;
  spreadPct: number;
  fundingPctPer8h: number; // perps only; 0 for spot
  targetFill: TargetFill;
  riskConfirmed: boolean; // false = riskPct and dailyLossLimitPct are placeholders, so no paper entry opens
  costsConfirmed: boolean; // false = fees are still placeholders and every alert says so
  maxHoldMinutes: number;
  lockEnabled: boolean;
  lockTriggerPct: number;
  lockProfitPct: number;
  forecastHorizonsMin: number[];
  minMovePct: number;
}

export const DEFAULTS: Settings = {
  paperEnabled: true,
  provider: "coinbase",
  symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
  timeframeMin: 5,
  zoneTfMin: 60,
  minPriorBounces: 2,
  minWickFrac: 0.35,
  maxChasePct: 0.35,
  stopBufferPct: 0.1,
  minStopPct: 0.25,
  maxStopPct: 1.0,
  targetPct: 1.0,
  minNetRR: 1.0,
  cooldownMin: 60,
  allowLong: true,
  allowShort: true,
  maxEntryDelaySec: 240,
  tickIntervalMin: 1,
  startingBalance: 10000,
  // PLACEHOLDERS, not your choice. Paper entries stay off until you set your own values and confirm them.
  riskPct: 1,
  dailyLossLimitPct: 3,
  maxOpenPositions: 3,
  // PLACEHOLDERS, not your real fees. Replace them with the numbers on your exchange's fee page, then confirm.
  takerFeePct: 0.1,
  makerFeePct: 0.1,
  slippagePct: 0.03,
  spreadPct: 0.01,
  fundingPctPer8h: 0,
  targetFill: "taker",
  riskConfirmed: false,
  costsConfirmed: false,
  maxHoldMinutes: 240,
  lockEnabled: false,
  lockTriggerPct: 1.5,
  lockProfitPct: 0.5,
  forecastHorizonsMin: [60, 240],
  minMovePct: 0,
};

// [min, max, integer?]
const NUM: Record<string, [number, number, boolean]> = {
  minPriorBounces: [0, 6, true],
  minWickFrac: [0, 1, false],
  maxChasePct: [0.02, 5, false],
  stopBufferPct: [0, 2, false],
  minStopPct: [0.02, 10, false],
  maxStopPct: [0.05, 20, false],
  targetPct: [0.05, 20, false],
  minNetRR: [0.2, 10, false],
  cooldownMin: [0, 1440, true],
  maxEntryDelaySec: [30, 3600, true],
  tickIntervalMin: [1, 30, true],
  startingBalance: [100, 1e9, false],
  riskPct: [0.1, 25, false],
  dailyLossLimitPct: [0.1, 25, false],
  maxOpenPositions: [1, 20, true],
  takerFeePct: [0, 2, false],
  makerFeePct: [0, 2, false],
  slippagePct: [0, 2, false],
  spreadPct: [0, 2, false],
  fundingPctPer8h: [-1, 1, false],
  maxHoldMinutes: [0, 1440, true],
  lockTriggerPct: [0.1, 100, false],
  lockProfitPct: [0, 50, false],
  minMovePct: [0, 20, false],
};
const BOOL = ["paperEnabled", "allowLong", "allowShort", "lockEnabled", "costsConfirmed", "riskConfirmed"];
const ENUM: Record<string, string[]> = {
  provider: ["coinbase", "binance"],
  targetFill: ["maker", "taker"],
};
const ZONE_TFS = [60, 240];
const TIMEFRAMES = [1, 5, 15, 60];
const SYMBOL_RE = /^[A-Z0-9]{2,10}-[A-Z]{3,5}$/;

// Horizons are configured in minutes and must be whole multiples of the candle length.
export function parseHorizons(v: unknown, timeframeMin: number): number[] | null {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : null;
  if (!raw) return null;
  const out: number[] = [];
  for (const x of raw) {
    if (x === "" || x === null) continue;
    const n = Number(x);
    if (!Number.isInteger(n) || n < timeframeMin || n > 10080 || n % timeframeMin !== 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.length >= 1 && out.length <= 5 ? out.sort((a, b) => a - b) : null;
}

export function parseSymbols(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : null;
  if (!raw) return null;
  const out: string[] = [];
  for (const x of raw) {
    const s = String(x).trim().toUpperCase();
    if (!s) continue;
    if (!SYMBOL_RE.test(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out.length >= 1 && out.length <= 10 ? out : null;
}

// Merge `input` over `base`. Invalid fields keep the base value and are reported in `errors`.
export function validateSettings(input: Record<string, unknown>, base: Settings = DEFAULTS) {
  const s: any = { ...base };
  const errors: string[] = [];
  for (const [k, v] of Object.entries(input || {})) {
    if (k in NUM) {
      const [min, max, int] = NUM[k];
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
        errors.push(`${k} must be ${int ? "a whole number " : "a number "}between ${min} and ${max}`);
      } else s[k] = n;
    } else if (BOOL.includes(k)) {
      if (typeof v === "boolean") s[k] = v;
      else errors.push(`${k} must be true or false`);
    } else if (k in ENUM) {
      if (typeof v === "string" && ENUM[k].includes(v)) s[k] = v;
      else errors.push(`${k} must be one of ${ENUM[k].join(", ")}`);
    } else if (k === "timeframeMin") {
      const n = Number(v);
      if (TIMEFRAMES.includes(n)) s.timeframeMin = n;
      else errors.push(`timeframeMin must be one of ${TIMEFRAMES.join(", ")}`);
    } else if (k === "zoneTfMin") {
      const n = Number(v);
      if (ZONE_TFS.includes(n)) s.zoneTfMin = n;
      else errors.push(`zoneTfMin must be one of ${ZONE_TFS.join(", ")}`);
    } else if (k === "symbols") {
      const p = parseSymbols(v);
      if (p) s.symbols = p;
      else errors.push("symbols must be 1-10 pairs like BTC-USD (BTC-USDT on binance)");
    }
    // unknown keys are ignored
  }
  if ("forecastHorizonsMin" in (input || {})) {
    const p = parseHorizons((input as any).forecastHorizonsMin, s.timeframeMin);
    if (p) s.forecastHorizonsMin = p;
    else errors.push(`forecastHorizonsMin must be 1-5 whole-minute horizons that are multiples of the ${s.timeframeMin}m candle (max 10080)`);
  } else if (parseHorizons(s.forecastHorizonsMin, s.timeframeMin) === null) {
    errors.push(`forecast horizons ${s.forecastHorizonsMin.join(",")} are not multiples of the ${s.timeframeMin}m candle`);
  }
  if (!s.allowLong && !s.allowShort) errors.push("allow at least one of long / short");
  if (!(s.minStopPct < s.maxStopPct)) errors.push("min stop must be smaller than max stop");
  if (s.timeframeMin >= s.zoneTfMin) errors.push("the trigger candle must be shorter than the zone candle");
  if (s.lockEnabled && !(s.lockProfitPct < s.lockTriggerPct)) errors.push("profit lock: the locked profit must be smaller than the trigger");
  return { settings: s as Settings, errors, ok: errors.length === 0 };
}

// Pure settings model + validation. No imports, so it can be tested with plain node.

export type Provider = "coinbase" | "binance";
export type SizingMode = "fixed_usd" | "pct_equity" | "risk_pct";
export type StopMode = "off" | "pct" | "range_edge";
export type TargetMode = "off" | "pct" | "r_multiple";
export type DetectionMode = "tight_range" | "swing_pattern";

export interface Settings {
  paperEnabled: boolean;
  provider: Provider;
  symbols: string[];
  timeframeMin: number;
  detectionMode: DetectionMode;
  swingMinPct: number;
  swingBandTolPct: number;
  swingMaxCandles: number;
  rangeLookback: number;
  rangeMaxWidthPct: number;
  rangeMinTouches: number;
  rangeTouchTolPct: number;
  rangeExpireCandles: number;
  breakoutBufferPct: number;
  confirmCloses: number;
  allowLong: boolean;
  allowShort: boolean;
  maxEntryDelaySec: number;
  tickIntervalMin: number;
  startingBalance: number;
  sizingMode: SizingMode;
  fixedUsd: number;
  pctEquity: number;
  riskPct: number;
  maxOpenPositions: number;
  feePct: number;
  slippagePct: number;
  stopMode: StopMode;
  stopPct: number;
  targetMode: TargetMode;
  targetPct: number;
  targetR: number;
  maxHoldMinutes: number;
  lockEnabled: boolean;
  lockTriggerPct: number;
  lockProfitPct: number;
}

export const DEFAULTS: Settings = {
  paperEnabled: true,
  provider: "coinbase",
  symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
  timeframeMin: 5,
  detectionMode: "tight_range",
  swingMinPct: 0.5,
  swingBandTolPct: 50,
  swingMaxCandles: 120,
  rangeLookback: 24,
  rangeMaxWidthPct: 2.5,
  rangeMinTouches: 2,
  rangeTouchTolPct: 20,
  rangeExpireCandles: 48,
  breakoutBufferPct: 0.05,
  confirmCloses: 1,
  allowLong: true,
  allowShort: true,
  maxEntryDelaySec: 240,
  tickIntervalMin: 5,
  startingBalance: 10000,
  sizingMode: "fixed_usd",
  fixedUsd: 500,
  pctEquity: 10,
  riskPct: 1,
  maxOpenPositions: 3,
  feePct: 0.1,
  slippagePct: 0.05,
  stopMode: "pct",
  stopPct: 1.5,
  targetMode: "pct",
  targetPct: 3,
  targetR: 2,
  maxHoldMinutes: 240,
  lockEnabled: false,
  lockTriggerPct: 1.5,
  lockProfitPct: 0.5,
};

// [min, max, integer?]
const NUM: Record<string, [number, number, boolean]> = {
  swingMinPct: [0.05, 20, false],
  swingBandTolPct: [5, 300, false],
  swingMaxCandles: [20, 250, true],
  rangeLookback: [8, 100, true],
  rangeMaxWidthPct: [0.1, 20, false],
  rangeMinTouches: [1, 10, true],
  rangeTouchTolPct: [5, 50, false],
  rangeExpireCandles: [4, 150, true],
  breakoutBufferPct: [0, 5, false],
  confirmCloses: [1, 3, true],
  maxEntryDelaySec: [30, 3600, true],
  tickIntervalMin: [1, 30, true],
  startingBalance: [100, 1e9, false],
  fixedUsd: [10, 1e9, false],
  pctEquity: [0.1, 100, false],
  riskPct: [0.1, 25, false],
  maxOpenPositions: [1, 20, true],
  feePct: [0, 5, false],
  slippagePct: [0, 5, false],
  stopPct: [0.05, 50, false],
  targetPct: [0.05, 500, false],
  targetR: [0.1, 50, false],
  maxHoldMinutes: [0, 1440, true],
  lockTriggerPct: [0.1, 100, false],
  lockProfitPct: [0, 50, false],
};
const BOOL = ["paperEnabled", "allowLong", "allowShort", "lockEnabled"];
const ENUM: Record<string, string[]> = {
  provider: ["coinbase", "binance"],
  detectionMode: ["tight_range", "swing_pattern"],
  sizingMode: ["fixed_usd", "pct_equity", "risk_pct"],
  stopMode: ["off", "pct", "range_edge"],
  targetMode: ["off", "pct", "r_multiple"],
};
const TIMEFRAMES = [1, 5, 15, 60];
const SYMBOL_RE = /^[A-Z0-9]{2,10}-[A-Z]{3,5}$/;

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
    } else if (k === "symbols") {
      const p = parseSymbols(v);
      if (p) s.symbols = p;
      else errors.push("symbols must be 1-10 pairs like BTC-USD (BTC-USDT on binance)");
    }
    // unknown keys are ignored
  }
  if (!s.allowLong && !s.allowShort) errors.push("allow at least one of long / short");
  if (s.sizingMode === "risk_pct" && s.stopMode === "off") errors.push("risk-based sizing needs a stop (stop is off)");
  if (s.targetMode === "r_multiple" && s.stopMode === "off") errors.push("R-multiple target needs a stop (stop is off)");
  if (s.lockEnabled && !(s.lockProfitPct < s.lockTriggerPct)) errors.push("profit lock: the locked profit must be smaller than the trigger");
  return { settings: s as Settings, errors, ok: errors.length === 0 };
}

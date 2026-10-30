// Public market-data only (no keys, no accounts, no orders). Data is real; trading is simulated.
import type { Candle } from "./types";
import type { Provider } from "./config";

const TIMEOUT_MS = 3500;
const HEADERS = { "User-Agent": "crypto-tight-range-monitor/0.1", Accept: "application/json" };

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`market data ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

const binSym = (s: string) => s.replace("-", "");
const BIN_INT: Record<number, string> = { 1: "1m", 5: "5m", 15: "15m", 60: "1h" };
const CB = "https://api.exchange.coinbase.com";
const BN = "https://data-api.binance.vision";

export async function fetchPrice(p: Provider, symbol: string): Promise<number> {
  const j = p === "coinbase" ? await getJson(`${CB}/products/${symbol}/ticker`) : await getJson(`${BN}/api/v3/ticker/price?symbol=${binSym(symbol)}`);
  const n = Number(j.price);
  if (!(n > 0)) throw new Error(`bad price for ${symbol}`);
  return n;
}

// Latest candles (ascending). May include the still-forming candle; callers filter for closed ones.
export async function fetchLatestCandles(p: Provider, symbol: string, granMin: number, limit = 300): Promise<Candle[]> {
  if (p === "coinbase") {
    const rows = await getJson(`${CB}/products/${symbol}/candles?granularity=${granMin * 60}`);
    return cbRows(rows).slice(-limit);
  }
  const rows = await getJson(`${BN}/api/v3/klines?symbol=${binSym(symbol)}&interval=${BIN_INT[granMin]}&limit=${Math.min(limit, 1000)}`);
  return bnRows(rows);
}

// Candles in [startMs, endMs). Returns how far it actually covered, so callers can resume.
export async function fetchCandlesRange(
  p: Provider,
  symbol: string,
  granMin: number,
  startMs: number,
  endMs: number,
): Promise<{ candles: Candle[]; coveredEnd: number }> {
  const step = granMin * 60000;
  const perCall = p === "coinbase" ? 300 : 1000;
  const maxCalls = 4;
  const out: Candle[] = [];
  let cur = startMs;
  for (let i = 0; i < maxCalls && cur < endMs; i++) {
    const winEnd = Math.min(endMs, cur + perCall * step);
    let rows: Candle[];
    if (p === "coinbase") {
      const q = `granularity=${granMin * 60}&start=${new Date(cur).toISOString()}&end=${new Date(winEnd).toISOString()}`;
      rows = cbRows(await getJson(`${CB}/products/${symbol}/candles?${q}`));
    } else {
      rows = bnRows(await getJson(`${BN}/api/v3/klines?symbol=${binSym(symbol)}&interval=${BIN_INT[granMin]}&startTime=${cur}&endTime=${winEnd - 1}&limit=1000`));
    }
    out.push(...rows);
    cur = winEnd;
  }
  return { candles: out.filter((c) => c.t >= startMs && c.t < endMs), coveredEnd: cur };
}

function cbRows(rows: any[]): Candle[] {
  // Coinbase: [time(sec), low, high, open, close, volume], newest first
  return (rows || [])
    .map((r) => ({ t: Number(r[0]) * 1000, l: Number(r[1]), h: Number(r[2]), o: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
    .filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)
    .sort((a, b) => a.t - b.t);
}
function bnRows(rows: any[]): Candle[] {
  return (rows || [])
    .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
    .filter((c) => c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

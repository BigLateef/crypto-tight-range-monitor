// Reproducible evaluation command:  npm run eval -- --symbols BTC-USD,ETH-USD,SOL-USD --days 60
// Research only. Reads public candles (or CSV files), writes nothing but local cache/output/lock files.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fetchCandlesRange } from "../lib/provider.ts";
import type { Candle } from "../lib/types";
import { DEFAULT_EVAL, chooseHoldoutStart, renderReport, runEval, type EvalConfig } from "./core.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const num = (n: string, d: number) => {
  const v = Number(opt(n, String(d)));
  if (!Number.isFinite(v)) throw new Error(`--${n} must be a number`);
  return v;
};

const ROOT = path.resolve(import.meta.dirname, "..");
const symbols = opt("symbols", "BTC-USD,ETH-USD,SOL-USD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const tfMin = num("tf", 5);
const horizons = opt("horizons", "60,240").split(",").map(Number);
const days = num("days", 60);
const provider = opt("provider", "coinbase") as "coinbase" | "binance";
const csvDir = opt("csv-dir", "");
const lockPath = path.resolve(ROOT, opt("lock", "eval/holdout.lock.json"));
const final = flag("final");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadFromProvider(symbol: string): Promise<Candle[]> {
  const tfMs = tfMin * 60000;
  const end = Math.floor(Date.now() / tfMs) * tfMs; // closed candles only
  const start = end - days * 86400000;
  const cacheFile = path.join(ROOT, "eval/cache", `${provider}_${symbol}_${tfMin}m.json`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  let have: Candle[] = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : [];
  let cur = have.length && have[0].t <= start ? have[have.length - 1].t + tfMs : start;
  if (have.length && have[0].t > start) have = [];
  while (cur < end) {
    let got: { candles: Candle[]; coveredEnd: number } | null = null;
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      try {
        got = await fetchCandlesRange(provider, symbol, tfMin, cur, end);
      } catch (e) {
        if (attempt === 3) throw new Error(`${symbol}: data fetch failed after 3 tries: ${(e as Error).message}`);
        await sleep(1000 * attempt);
      }
    }
    have.push(...got!.candles);
    if (got!.coveredEnd <= cur) throw new Error(`${symbol}: provider made no progress at ${new Date(cur).toISOString()}`);
    cur = got!.coveredEnd;
    await sleep(300);
  }
  const byT = new Map<number, Candle>();
  for (const c of have) byT.set(c.t, c);
  const out = [...byT.values()].filter((c) => c.t >= start && c.t + tfMs <= end).sort((a, b) => a.t - b.t);
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

function loadFromCsv(symbol: string): Candle[] {
  const file = path.resolve(csvDir, `${symbol}.csv`);
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const head = rows[0].toLowerCase().split(",").map((s) => s.trim());
  const ix = (n: string) => head.indexOf(n);
  if (["t", "o", "h", "l", "c"].some((n) => ix(n) < 0)) throw new Error(`${file}: header must include t,o,h,l,c (v optional); t = open time, ms epoch or ISO`);
  return rows.slice(1).map((r) => {
    const x = r.split(",");
    const tRaw = x[ix("t")].trim();
    const t = /^\d+$/.test(tRaw) ? Number(tRaw) : Date.parse(tRaw);
    return { t, o: +x[ix("o")], h: +x[ix("h")], l: +x[ix("l")], c: +x[ix("c")], v: ix("v") >= 0 ? +x[ix("v")] : 0 };
  }).filter((c) => Number.isFinite(c.t) && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0).sort((a, b) => a.t - b.t);
}

async function main() {
  const data = [];
  for (const s of symbols) {
    const candles = csvDir ? loadFromCsv(s) : await loadFromProvider(s);
    const gaps = candles.reduce((n, c, i) => n + (i && c.t - candles[i - 1].t !== tfMin * 60000 ? 1 : 0), 0);
    console.log(`${s}: ${candles.length} candles, ${candles.length ? new Date(candles[0].t).toISOString() : "-"} -> ${candles.length ? new Date(candles[candles.length - 1].t).toISOString() : "-"}, ${gaps} gap(s) (samples spanning a gap are dropped)`);
    if (candles.length) data.push({ symbol: s, candles });
  }
  if (!data.length) throw new Error("no data loaded");
  const firstT = Math.min(...data.map((d) => d.candles[0].t));
  const lastT = Math.max(...data.map((d) => d.candles[d.candles.length - 1].t));

  // Holdout lock: fixed the first time you run, then never moves. New data after it extends the holdout.
  let lock: any = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : null;
  if (lock && lock.tfMin !== tfMin) throw new Error(`lock file was made for ${lock.tfMin}m candles; use --lock <other file> for a different timeframe`);
  if (!lock) {
    if (final) throw new Error("no holdout lock yet: run the development evaluation first so the holdout is fixed before you look at anything");
    lock = { version: 1, tfMin, holdoutStartT: chooseHoldoutStart(firstT, lastT, num("holdout", 0.2)), createdAt: new Date().toISOString(), finalRuns: 0, finalLog: [] };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    console.log(`holdout locked from ${new Date(lock.holdoutStartT).toISOString()} (written to ${path.relative(ROOT, lockPath)}; commit this file)`);
  }
  if (final && lock.finalRuns >= 1 && !flag("accept-reuse")) {
    throw new Error(`the holdout was already scored ${lock.finalRuns} time(s). Scoring it again means it is no longer untouched. Re-run with --final --accept-reuse only if you accept that.`);
  }

  const cfg: EvalConfig = {
    ...DEFAULT_EVAL,
    tfMin,
    horizonsMin: horizons,
    costs: { feePct: num("fee", 0.1), slippagePct: num("slip", 0.05), delayCandles: num("delay", 1) },
    minMovePct: num("min-move", 0),
    holdoutStartT: lock.holdoutStartT,
    mode: final ? "final" : "dev",
    folds: num("folds", 4),
    minTrades: num("min-trades", 100),
    alpha: num("alpha", 0.05),
  };
  const results = runEval(data, cfg);
  console.log("\n" + renderReport(results, cfg, { symbols, firstT, lastT }));

  fs.mkdirSync(path.join(ROOT, "eval/out"), { recursive: true });
  const json = JSON.stringify({ cfg, results }, null, 2);
  fs.writeFileSync(path.join(ROOT, "eval/out/latest.json"), json);
  if (final) {
    lock.finalRuns++;
    lock.finalLog.push({ at: new Date().toISOString(), resultSha256: crypto.createHash("sha256").update(json).digest("hex"), horizons });
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    console.log(`\nholdout scored (run #${lock.finalRuns}); recorded in ${path.relative(ROOT, lockPath)}`);
  }
}
main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});

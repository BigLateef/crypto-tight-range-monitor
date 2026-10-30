// One tick = detect ranges, confirm breakouts, manage simulated exits, open simulated entries.
// SIMULATION ONLY. Market data is read-only; nothing here can place an order anywhere.
import { sql, type Row } from "./db";
import { loadSettings } from "./settings";
import type { Settings } from "./config";
import type { Candle, Direction } from "./types";
import { fetchLatestCandles, fetchCandlesRange, fetchPrice } from "./provider";
import { detectRange, scanBreakout } from "./range";
import { detectSwingPattern } from "./swing";
import { slipPrice, levels, sizePosition, replayCandles, closeMath } from "./paper";
import { loadAccount, markOpen } from "./account";
import { sendTelegram } from "./telegram";
import { fmtPrice, fmtUsd } from "./format";

const MIN = 60000;
type Db = ReturnType<typeof sql>;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runTick(now = Date.now()) {
  const db = sql();
  const lease = await db`update engine_state set lease_until = now() + interval '25 seconds' where id = 1 and lease_until < now() returning id`;
  if (!lease.length) return { ok: true, skipped: "another tick is still running" };

  const notes: string[] = [];
  const msgs: string[] = [];
  let ok = true;
  try {
    const s = await loadSettings();
    const openAtStart = await db`select *, (extract(epoch from opened_at) * 1000)::bigint as opened_ms from paper_trades where status = 'open' order by id`;
    const openSyms: string[] = Array.from(new Set<string>(openAtStart.map((t: Row) => String(t.symbol))));
    const endBoundary = Math.floor(now / MIN) * MIN;

    // Stage A: all network reads in parallel (read-only public market data)
    const [tfRes, exitRes] = await Promise.all([
      Promise.allSettled(s.symbols.map((sym) => fetchLatestCandles(s.provider, sym, s.timeframeMin))),
      Promise.all(
        openSyms.map(async (sym) => {
          const mine = openAtStart.filter((t: Row) => t.symbol === sym);
          const start = Math.min(...mine.map((t: Row) => Number(t.checked_through)));
          const [rng, price] = await Promise.all([
            endBoundary > start ? fetchCandlesRange(s.provider, sym, 1, start, endBoundary).catch((e) => { notes.push(`${sym} 1m: ${errMsg(e)}`); return null; }) : Promise.resolve({ candles: [] as Candle[], coveredEnd: start }),
            fetchPrice(s.provider, sym).catch(() => null),
          ]);
          return { sym, rng, price };
        }),
      ),
    ]);
    const prices: Record<string, number> = {};
    const scans: Record<string, { candles: Candle[]; coveredEnd: number } | null> = {};
    for (const x of exitRes) {
      if (x.price) prices[x.sym] = x.price;
      scans[x.sym] = x.rng;
    }

    // Stage B1: range discovery + breakout confirmation (closed candles only)
    for (let i = 0; i < s.symbols.length; i++) {
      const sym = s.symbols[i];
      const r = tfRes[i];
      if (r.status === "rejected") {
        notes.push(`${sym}: ${errMsg(r.reason)}`);
        continue;
      }
      try {
        await detectForSymbol(db, s, sym, r.value, now, msgs);
      } catch (e) {
        ok = false;
        notes.push(`${sym} detect: ${errMsg(e)}`);
      }
    }

    // Stage B2: manage open simulated positions (exits are always managed, even if paper entries are off)
    for (const t of openAtStart) {
      try {
        await manageTrade(db, s, t, scans[t.symbol], prices[t.symbol], now, endBoundary, msgs, notes);
      } catch (e) {
        ok = false;
        notes.push(`trade ${t.id}: ${errMsg(e)}`);
      }
    }

    // Stage B3: simulated entries for confirmed breakouts
    const pending = await db`select * from range_alerts where status = 'broken' and paper_state = 'pending' order by id`;
    for (const a of pending) {
      try {
        await tryEnter(db, s, a, prices, now, msgs);
      } catch (e) {
        ok = false;
        notes.push(`entry ${a.id}: ${errMsg(e)}`);
      }
    }

    // Stage B4: equity snapshot (for the drawdown stat) + housekeeping
    const open = await db`select * from paper_trades where status = 'open'`;
    const acct = await loadAccount(s.startingBalance);
    const mtm = markOpen(open, prices);
    const equity = acct.cash + mtm.value;
    if (open.length) await db`insert into equity_snapshots (equity) values (${equity}) on conflict (ts) do nothing`;
    else await db`insert into equity_snapshots (equity) select ${equity} where not exists (select 1 from equity_snapshots where ts > now() - interval '15 minutes')`;
    await db`delete from equity_snapshots where ts < now() - interval '90 days'`;

    await Promise.allSettled(msgs.slice(0, 8).map((m) => sendTelegram(m)));
  } catch (e) {
    ok = false;
    notes.push(errMsg(e));
  }
  await db`update engine_state set last_tick_at = now(), last_tick_ok = ${ok}, last_tick_note = ${notes.join("; ").slice(0, 500)}, lease_until = 'epoch'::timestamptz where id = 1`;
  return { ok, notes };
}

async function detectForSymbol(db: Db, s: Settings, sym: string, all: Candle[], now: number, msgs: string[]) {
  const tfMs = s.timeframeMin * MIN;
  const closed = all.filter((c) => c.t + tfMs <= now);
  const swing = s.detectionMode === "swing_pattern";
  if (closed.length < (swing ? 10 : s.rangeLookback)) return;

  const active = await db`select * from range_alerts where symbol = ${sym} and timeframe_min = ${s.timeframeMin} and status = 'active'`;
  let stillActive = 0;
  for (const a of active) {
    const range = { high: Number(a.range_high), low: Number(a.range_low), endT: Number(a.window_end_t) };
    const after = closed.filter((c) => c.t > range.endT);
    const b = scanBreakout(after, range, tfMs, s.breakoutBufferPct, s.confirmCloses);
    if (b) {
      const state = s.paperEnabled ? "pending" : "skipped";
      const note = s.paperEnabled ? null : "Paper trading was off";
      await db`update range_alerts set status = 'broken', breakout_direction = ${b.direction}, breakout_confirm_t = ${b.confirmT}, breakout_close = ${b.close}, broken_at = now(), paper_state = ${state}, paper_note = ${note} where id = ${a.id} and status = 'active'`;
      const above = b.direction === "up";
      msgs.push(
        above
          ? `🟢 LONG SIGNAL: ${sym} ${s.timeframeMin}m\nPrice closed ABOVE the range high (${fmtPrice(range.high)}) at ${fmtPrice(b.close)}.\nDirection: LONG (buy).\n${s.paperEnabled ? "Paper trading: checking for a simulated LONG entry." : "Paper trading is off: no simulated entry."}`
          : `🔴 SHORT SIGNAL: ${sym} ${s.timeframeMin}m\nPrice closed BELOW the range low (${fmtPrice(range.low)}) at ${fmtPrice(b.close)}.\nDirection: SHORT (sell).\n${s.paperEnabled ? "Paper trading: checking for a simulated SHORT entry." : "Paper trading is off: no simulated entry."}`,
      );
    } else if (after.length >= s.rangeExpireCandles) {
      await db`update range_alerts set status = 'expired' where id = ${a.id} and status = 'active'`;
    } else stillActive++;
  }
  if (stillActive > 0) return;

  const last = (await db`select window_end_t, breakout_confirm_t from range_alerts where symbol = ${sym} and timeframe_min = ${s.timeframeMin} order by id desc limit 1`)[0];
  const minStartT = last ? Number(last.breakout_confirm_t ?? last.window_end_t) + 1 : 0;
  const r = swing
    ? detectSwingPattern(closed, { minPct: s.swingMinPct, bandTolPct: s.swingBandTolPct, maxCandles: s.swingMaxCandles }, minStartT)
    : detectRange(closed, { lookback: s.rangeLookback, maxWidthPct: s.rangeMaxWidthPct, minTouches: s.rangeMinTouches, touchTolPct: s.rangeTouchTolPct }, minStartT);
  if (!r) return;
  const ins = await db`insert into range_alerts (symbol, timeframe_min, range_high, range_low, width_pct, touches_high, touches_low, window_candles, window_start_t, window_end_t)
    values (${sym}, ${s.timeframeMin}, ${r.high}, ${r.low}, ${r.widthPct}, ${r.touchesHigh}, ${r.touchesLow}, ${r.candles}, ${r.startT}, ${r.endT})
    on conflict (symbol, timeframe_min, window_end_t) do nothing returning id`;
  if (ins.length) {
    msgs.push(
      swing
        ? `🟡 SWING PATTERN FOUND: ${sym} ${s.timeframeMin}m\n${r.touchesHigh} back-and-forth swing cycles in a row inside a band (each swing at least ${s.swingMinPct}%; the cycle count is found automatically).\nRange: ${fmtPrice(r.low)} - ${fmtPrice(r.high)} (${r.widthPct.toFixed(2)}% wide)\nDirection: NOT KNOWN YET. No trade. Wait for a LONG or SHORT signal.`
        : `🟡 RANGE FOUND: ${sym} ${s.timeframeMin}m\nRange: ${fmtPrice(r.low)} - ${fmtPrice(r.high)} (${r.widthPct.toFixed(2)}% wide)\nDirection: NOT KNOWN YET. No trade. Wait for a LONG or SHORT signal.`,
    );
  }
}

async function tryEnter(db: Db, s: Settings, a: Row, prices: Record<string, number>, now: number, msgs: string[]) {
  const skip = async (why: string) => {
    await db`update range_alerts set paper_state = 'skipped', paper_note = ${why} where id = ${a.id}`;
    if (why !== "Paper trading was off") msgs.push(`⚪ NO SIMULATED ${a.breakout_direction === "up" ? "LONG" : "SHORT"} ENTRY: ${a.symbol}\nReason: ${why}.`);
  };
  if (!s.paperEnabled) return skip("Paper trading was off");
  const dir: Direction = a.breakout_direction === "up" ? "long" : "short";
  if (dir === "long" && !s.allowLong) return skip("Long entries are disabled");
  if (dir === "short" && !s.allowShort) return skip("Short entries are disabled");
  const closeTime = Number(a.breakout_confirm_t) + Number(a.timeframe_min) * MIN;
  const lateSec = Math.round((now - closeTime) / 1000);
  const maxDelaySec = Math.max(s.maxEntryDelaySec, s.tickIntervalMin * 60 + 60); // a slow cron must not make every entry "late"
  if (lateSec > maxDelaySec) return skip(`Entry window missed (${lateSec}s after the confirming close, limit ${maxDelaySec}s)`);
  const open = await db`select symbol from paper_trades where status = 'open'`;
  if (open.length >= s.maxOpenPositions) return skip("Max open positions reached");
  if (open.some((o: Row) => o.symbol === a.symbol)) return skip("Already holding this symbol");

  let price = prices[a.symbol];
  if (!price) {
    try {
      price = await fetchPrice(s.provider, a.symbol);
    } catch {
      return; // leave pending; retried next tick until the entry window closes
    }
  }
  const high = Number(a.range_high);
  const low = Number(a.range_low);
  if (dir === "long" ? price <= high : price >= low) return skip("Price was back inside the range at entry time");

  const fill = slipPrice(price, dir, "entry", s.slippagePct);
  const lv = levels(dir, fill, { high, low }, s);
  if (lv.error) return skip(lv.error);

  const acct = await loadAccount(s.startingBalance);
  const openRows = await db`select * from paper_trades where status = 'open'`;
  const equity = acct.cash + markOpen(openRows, prices).value;
  const sz = sizePosition({ mode: s.sizingMode, equity, cash: acct.cash, entry: fill, stop: lv.stop, fixedUsd: s.fixedUsd, pctEquity: s.pctEquity, riskPct: s.riskPct, feePct: s.feePct });
  if (!sz.units) return skip("Not enough virtual cash, or size too small");

  const g = dir === "long" ? 1 : -1;
  const lockTrigger = s.lockEnabled ? fill * (1 + (g * s.lockTriggerPct) / 100) : null;
  const lockStop = s.lockEnabled ? fill * (1 + (g * s.lockProfitPct) / 100) : null;
  const fee = (sz.notional * s.feePct) / 100;
  const slipUsd = Math.abs(fill - price) * sz.units;
  const checked = Math.ceil(now / MIN) * MIN; // the entry minute is never scanned for exits
  const ins = await db`insert into paper_trades (alert_id, symbol, direction, units, notional, ref_entry_price, entry_price, entry_slippage_usd, entry_fee, stop_price, initial_stop_price, target_price, lock_trigger_price, lock_stop_price, max_hold_minutes, opened_at, checked_through, last_price, last_price_at)
    values (${a.id}, ${a.symbol}, ${dir}, ${sz.units}, ${sz.notional}, ${price}, ${fill}, ${slipUsd}, ${fee}, ${lv.stop}, ${lv.stop}, ${lv.target}, ${lockTrigger}, ${lockStop}, ${s.maxHoldMinutes}, to_timestamp(${now / 1000}), ${checked}, ${price}, now())
    returning id`;
  await db`update range_alerts set paper_state = 'entered', paper_note = null, trade_id = ${ins[0].id} where id = ${a.id}`;
  msgs.push(`${dir === "long" ? "🟢" : "🔴"} SIMULATED ${dir.toUpperCase()} OPENED: ${a.symbol} @ ${fmtPrice(fill)}\nDirection: ${dir.toUpperCase()} (${dir === "long" ? "buy" : "sell"}), size ${fmtUsd(sz.notional)}.\nWhy: price closed ${dir === "long" ? "above" : "below"} the range.\nStop ${lv.stop === null ? "off" : fmtPrice(lv.stop)} / Target ${lv.target === null ? "off" : fmtPrice(lv.target)}.${lockTrigger === null ? "" : `\nProfit lock: at ${fmtPrice(lockTrigger)} the stop moves to ${fmtPrice(lockStop)}.`}\nSimulation only: not a real order.`);
}

async function manageTrade(db: Db, s: Settings, t: Row, scan: { candles: Candle[]; coveredEnd: number } | null | undefined, livePrice: number | undefined, now: number, endBoundary: number, msgs: string[], notes: string[]) {
  const dir = t.direction as Direction;
  const state = {
    direction: dir,
    stop: t.stop_price == null ? null : Number(t.stop_price),
    target: t.target_price == null ? null : Number(t.target_price),
    lockTrigger: t.lock_trigger_price == null ? null : Number(t.lock_trigger_price),
    lockStop: t.lock_stop_price == null ? null : Number(t.lock_stop_price),
    locked: !!t.stop_locked,
  };
  const from = Number(t.checked_through);
  let newChecked = from;
  let scanDone = false;
  if (scan) {
    const r = replayCandles(state, scan.candles, from); // uses only candles that already closed
    if (r.exit) {
      await closeTrade(db, s, t, r.exit.price, r.exit.reason, r.exit.closeT, msgs);
      return;
    }
    if (r.locked && !state.locked && r.stop !== null && r.lockedT !== null) {
      await db`update paper_trades set stop_price = ${r.stop}, stop_locked = true, locked_at = to_timestamp(${r.lockedT / 1000}) where id = ${t.id} and status = 'open'`;
      msgs.push(`🔒 PROFIT LOCK: ${dir.toUpperCase()} ${t.symbol} reached +${(Math.abs((state.lockTrigger as number) / Number(t.entry_price) - 1) * 100).toFixed(2)}%.\nStop moved to ${fmtPrice(r.stop)} (in profit). If price falls back to it, the simulated trade closes with a gain.`);
    }
    newChecked = Math.max(from, scan.coveredEnd);
    scanDone = scan.coveredEnd >= endBoundary;
  }
  // Time limit: does not depend on the candle scan succeeding. If the scan is incomplete we wait up to
  // 10 minutes (so a stop/target hit is not missed), then close anyway at the live price.
  const hold = Number(t.max_hold_minutes);
  const deadline = hold > 0 ? Number(t.opened_ms) + hold * MIN : Infinity;
  if (now >= deadline) {
    if (livePrice && (scanDone || now >= deadline + 10 * MIN)) {
      await closeTrade(db, s, t, livePrice, "time", now, msgs);
      return;
    }
    notes.push(`trade ${t.id} (${t.symbol}): time limit reached but exit deferred (${livePrice ? "candle scan incomplete" : "no live price"})`);
  }
  if (livePrice) await db`update paper_trades set checked_through = ${newChecked}, last_price = ${livePrice}, last_price_at = now() where id = ${t.id} and status = 'open'`;
  else if (newChecked > from) await db`update paper_trades set checked_through = ${newChecked} where id = ${t.id} and status = 'open'`;
}

// Shared by the engine and the manual-close endpoint. Guarded so a position can only close once.
export async function closeTrade(db: Db, s: Settings, t: Row, refExit: number, reason: string, closedAtMs: number, msgs?: string[]): Promise<boolean> {
  const dir = t.direction as Direction;
  const units = Number(t.units);
  const fill = slipPrice(refExit, dir, "exit", s.slippagePct);
  const m = closeMath(dir, Number(t.entry_price), fill, units, Number(t.entry_fee), s.feePct);
  const slipUsd = Math.abs(fill - refExit) * units;
  const res = await db`update paper_trades set status = 'closed', ref_exit_price = ${refExit}, exit_price = ${fill}, exit_slippage_usd = ${slipUsd}, exit_fee = ${m.exitFee},
      closed_at = to_timestamp(${closedAtMs / 1000}), exit_reason = ${reason}, gross_pnl = ${m.gross}, realized_pnl = ${m.net}, last_price = ${refExit}, last_price_at = now()
    where id = ${t.id} and status = 'open' returning id`;
  if (!res.length) return false;
  const why = ({ stop: "stop hit", profit_lock: "profit lock hit", target: "target hit", time: "time limit", manual: "closed manually" } as Record<string, string>)[reason] || reason;
  msgs?.push(`${m.net >= 0 ? "✅" : "❌"} SIMULATED ${dir.toUpperCase()} CLOSED: ${t.symbol} @ ${fmtPrice(fill)} (${why})\nSimulated P&L: ${fmtUsd(m.net, true)} after fees and slippage.\nSimulation only: not a real order.`);
  return true;
}

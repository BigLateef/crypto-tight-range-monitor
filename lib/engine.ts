// One tick = find retest-zone setups, alert once per setup, manage simulated exits, open simulated entries.
// SIMULATION ONLY. Market data is read-only; nothing here can place an order anywhere.
import { sql, type Row } from "./db";
import { loadSettings } from "./settings";
import type { Settings } from "./config";
import type { Candle, Direction } from "./types";
import { fetchLatestCandles, fetchCandlesRange, fetchPrice } from "./provider";
import { slipPrice, replayCandles, closeMath } from "./paper";
import { ZONE_DEFAULTS, TRIGGER_DEFAULTS, buildZones, evaluateTrigger, inCooldown, planEntry, costsFromSettings, resample, type Setup } from "./retest";
import { loadAccount, markOpen } from "./account";
import { sendTelegram } from "./telegram";
import { fmtPrice, fmtUsd } from "./format";
import { checkCandles, nextHealthState } from "./dataquality";
import { buildForecast, logForecast, loadDueForecasts, saveOutcome, type Direction4 } from "./forecast";
import { resolveForecast } from "./outcome";

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
    const [tfRes, htfRes, exitRes] = await Promise.all([
      Promise.allSettled(s.symbols.map((sym) => fetchLatestCandles(s.provider, sym, s.timeframeMin))),
      Promise.allSettled(s.symbols.map((sym) => fetchLatestCandles(s.provider, sym, 60))), // zones are built from 1h (4h is resampled from it)
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

    // Stage B1: retest-zone setups on the newest closed trigger candle (closed candles only)
    for (let i = 0; i < s.symbols.length; i++) {
      const sym = s.symbols[i];
      const r = tfRes[i];
      if (r.status === "rejected") {
        notes.push(`${sym}: ${errMsg(r.reason)}`);
        await recordHealth(db, s, sym, [`data fetch failed: ${errMsg(r.reason)}`], msgs).catch((e) => notes.push(`${sym} health: ${errMsg(e)}`));
        continue;
      }
      const h = htfRes[i];
      if (h.status === "rejected") {
        notes.push(`${sym} 1h: ${errMsg(h.reason)}`);
        await recordHealth(db, s, sym, [`zone-timeframe data fetch failed: ${errMsg(h.reason)}`], msgs).catch((e) => notes.push(`${sym} health: ${errMsg(e)}`));
        continue;
      }
      try {
        await detectForSymbol(db, s, sym, r.value, h.value, now, msgs);
      } catch (e) {
        ok = false;
        notes.push(`${sym} detect: ${errMsg(e)}`);
      }
      try {
        await resolveDue(db, s, sym, r.value, now);
      } catch (e) {
        notes.push(`${sym} outcomes: ${errMsg(e)}`);
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

    // Stage B3: simulated entries for fresh setups
    const pending = await db`select * from retest_setups where paper_state = 'pending' order by id`;
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

async function detectForSymbol(db: Db, s: Settings, sym: string, all: Candle[], htfAll: Candle[], now: number, msgs: string[]) {
  const tfMs = s.timeframeMin * MIN;
  const HOUR = 60 * MIN;
  // Data-quality gate on BOTH timeframes: stale, gapped or inconsistent candles never reach zone building,
  // the trigger, or forecasts. A failed gate means "no signal", never a normal-looking one.
  const q = checkCandles(all, { tfMs, now, window: 60, maxLagMs: Math.max(2 * tfMs + MIN, 6 * MIN), maxJumpPct: 20 });
  const qh = checkCandles(htfAll, { tfMs: HOUR, now, window: 48, maxLagMs: 2 * HOUR + 5 * MIN, maxJumpPct: 30 });
  const reasons = [...(q.ok ? [] : q.reasons.map((r) => `${s.timeframeMin}m: ${r}`)), ...(qh.ok ? [] : qh.reasons.map((r) => `1h: ${r}`))];
  await recordHealth(db, s, sym, reasons, msgs);
  if (reasons.length) return;
  const closed = q.closed;

  const zoneMs = s.zoneTfMin * MIN;
  const htf = s.zoneTfMin === 60 ? qh.closed : resample(qh.closed, zoneMs, now);
  const zp = { ...ZONE_DEFAULTS, minPriorBounces: s.minPriorBounces };
  const tp = { ...TRIGGER_DEFAULTS, minWickFrac: s.minWickFrac, maxChasePct: s.maxChasePct, stopBufferPct: s.stopBufferPct, minStopPct: s.minStopPct, maxStopPct: s.maxStopPct, targetPct: s.targetPct, minNetRR: s.minNetRR, cooldownMin: s.cooldownMin };
  const costs = costsFromSettings(s);
  const built = buildZones(htf, zp);
  const ev = built.zones.length ? evaluateTrigger(built.zones, built.atrNow, closed.slice(-(Math.max(tp.approachBars, tp.volLookback) + 2)), tfMs, zp, tp, costs) : { setup: null as Setup | null, skipped: [] };

  await logForecasts(db, s, sym, closed, ev.setup, now);
  const st = ev.setup;
  if (!st) return; // "no clear edge": silence is the normal outcome
  if (st.dir === "long" ? !s.allowLong : !s.allowShort) return;

  // Cooldown: the same direction on an overlapping zone is not re-alerted within cooldownMin.
  const recent = await db`select dir, close_t, zone_low, zone_high from retest_setups where symbol = ${sym} and close_t > ${st.closeT - s.cooldownMin * MIN} order by id desc limit 50`;
  const prev = recent.map((r: Row) => ({ dir: String(r.dir), closeT: Number(r.close_t), zoneLow: Number(r.zone_low), zoneHigh: Number(r.zone_high) }));
  if (inCooldown(prev, st, s.cooldownMin)) return;

  const ins = await db`insert into retest_setups (symbol, trigger_tf_min, zone_tf_min, dir, trigger_t, close_t, ref_price, zone_low, zone_high, prior_bounces, stop_price, target_price, stop_pct, target_pct, net_rr, break_even_win_rate, invalidation_price, evidence, costs, costs_confirmed)
    values (${sym}, ${s.timeframeMin}, ${s.zoneTfMin}, ${st.dir}, ${st.triggerT}, ${st.closeT}, ${st.refPrice}, ${st.zoneLow}, ${st.zoneHigh}, ${st.priorBounces}, ${st.stopPrice}, ${st.targetPrice}, ${st.stopPct}, ${st.targetPct}, ${st.economics.netRR}, ${st.economics.breakEvenWinRate}, ${st.invalidationPrice}, ${st.evidence}, ${JSON.stringify(costs)}::jsonb, ${s.costsConfirmed})
    on conflict (symbol, trigger_tf_min, dir, trigger_t) do nothing returning id`;
  if (!ins.length) return; // already alerted for this candle (repeat tick or retried cron)
  const e = st.economics;
  const long = st.dir === "long";
  msgs.push(
    `${long ? "🟢" : "🔴"} RETEST ${long ? "LONG" : "SHORT"} SETUP: ${sym} (${s.zoneTfMin === 60 ? "1h" : "4h"} zone, ${s.timeframeMin}m trigger)\n` +
      `Zone ${fmtPrice(st.zoneLow)} - ${fmtPrice(st.zoneHigh)}: ${st.priorBounces} earlier bounce(s) counted from price behavior, then a confirmed rejection on the last closed ${s.timeframeMin}m candle at ${fmtPrice(st.refPrice)}.\n` +
      `Stop ${fmtPrice(st.stopPrice)} (${st.stopPct.toFixed(2)}%) / Target ${fmtPrice(st.targetPrice)} (${st.targetPct.toFixed(2)}%).\n` +
      `After costs: a win keeps ${e.netWinPct.toFixed(2)}%, a loss costs ${e.netLossPct.toFixed(2)}% (net R:R ${e.netRR.toFixed(2)}). Needs a win rate above ${(e.breakEvenWinRate * 100).toFixed(0)}% to break even. No proven edge: this is a hypothesis under test.\n` +
      `Invalid if a ${s.timeframeMin}m candle closes beyond ${fmtPrice(st.invalidationPrice)}. Do not chase: skip it if price has already run ${s.maxChasePct}% from ${fmtPrice(st.refPrice)}.\n` +
      `Data: ${s.timeframeMin}m and 1h candles fresh, checked this minute.${s.costsConfirmed ? "" : "\n⚠️ Fees are still PLACEHOLDERS. Enter your real fees in Settings and tick 'confirmed'."}${s.riskConfirmed ? "" : "\n⚠️ Risk per trade and daily loss limit are unconfirmed: no paper entry will open."}\n` +
      `${s.paperEnabled ? "Paper trading: checking for a simulated entry." : "Paper trading is off: alert only."}\nAlert only: not a real order, not financial advice.`,
  );
}

async function tryEnter(db: Db, s: Settings, a: Row, prices: Record<string, number>, now: number, msgs: string[]) {
  const dir: Direction = a.dir === "long" ? "long" : "short";
  const skip = async (why: string) => {
    await db`update retest_setups set paper_state = 'skipped', paper_note = ${why} where id = ${a.id}`;
    if (why !== "Paper trading was off") msgs.push(`⚪ NO SIMULATED ${dir.toUpperCase()} ENTRY: ${a.symbol}\nReason: ${why}.`);
  };
  if (!s.paperEnabled) return skip("Paper trading was off");
  if (s.haltEntries) return skip("Kill switch is on: new paper entries are halted");
  if (!s.riskConfirmed) return skip("Risk per trade and daily loss limit are not confirmed yet. Set your own values in Settings and tick confirmed; no paper entry opens until then");
  if (dir === "long" && !s.allowLong) return skip("Long entries are disabled");
  if (dir === "short" && !s.allowShort) return skip("Short entries are disabled");
  const open = await db`select symbol from paper_trades where status = 'open'`;
  if (open.length >= s.maxOpenPositions) return skip("Max open positions reached");
  if (open.some((o: Row) => o.symbol === a.symbol)) return skip("Already holding this symbol");

  let price = prices[a.symbol];
  if (!price) {
    try {
      price = await fetchPrice(s.provider, a.symbol);
    } catch {
      if (now - Number(a.close_t) > s.maxEntryDelaySec * 1000) return skip("Entry window missed and no live price");
      return; // leave pending; retried next tick until the entry window closes
    }
  }
  const acct = await loadAccount(s.startingBalance);
  const openRows = await db`select * from paper_trades where status = 'open'`;
  const equity = acct.cash + markOpen(openRows, prices).value;

  // Daily loss limit: realized loss since 00:00 UTC. Reached = no new entries until tomorrow.
  const day = new Date(now);
  const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const lost = (await db`select coalesce(sum(realized_pnl), 0) as p from paper_trades where status = 'closed' and closed_at >= to_timestamp(${dayStart / 1000})`)[0];
  const limitUsd = (equity * s.dailyLossLimitPct) / 100;
  if (Number(lost.p) <= -limitUsd) return skip(`Daily loss limit reached (${fmtUsd(Number(lost.p), true)} today, limit ${s.dailyLossLimitPct}% = ${fmtUsd(-limitUsd)})`);

  const maxDelaySec = Math.max(s.maxEntryDelaySec, s.tickIntervalMin * 60 + 60); // a slow cron must not make every entry "late"
  const costs = costsFromSettings(s);
  const plan = planEntry({
    setup: { dir, closeT: Number(a.close_t), refPrice: Number(a.ref_price), stopPrice: Number(a.stop_price), targetPrice: Number(a.target_price) },
    livePrice: price, now, equity, cash: acct.cash, costs, riskPct: s.riskPct, minStopPct: s.minStopPct, maxStopPct: s.maxStopPct, minNetRR: s.minNetRR, maxChasePct: s.maxChasePct, maxDelaySec,
  });
  if (!plan.ok) return skip(plan.why);

  const g = dir === "long" ? 1 : -1;
  const lockTrigger = s.lockEnabled ? plan.fill * (1 + (g * s.lockTriggerPct) / 100) : null;
  const lockStop = s.lockEnabled ? plan.fill * (1 + (g * s.lockProfitPct) / 100) : null;
  const slipUsd = Math.abs(plan.fill - price) * plan.units;
  const stop = Number(a.stop_price);
  const target = Number(a.target_price);
  const checked = Math.ceil(now / MIN) * MIN; // the entry minute is never scanned for exits
  const ins = await db`insert into paper_trades (setup_id, symbol, direction, units, notional, ref_entry_price, entry_price, entry_slippage_usd, entry_fee, stop_price, initial_stop_price, target_price, lock_trigger_price, lock_stop_price, max_hold_minutes, opened_at, checked_through, last_price, last_price_at)
    values (${a.id}, ${a.symbol}, ${dir}, ${plan.units}, ${plan.notional}, ${price}, ${plan.fill}, ${slipUsd}, ${plan.entryFee}, ${stop}, ${stop}, ${target}, ${lockTrigger}, ${lockStop}, ${s.maxHoldMinutes}, to_timestamp(${now / 1000}), ${checked}, ${price}, now())
    returning id`;
  await db`update retest_setups set paper_state = 'entered', paper_note = null, trade_id = ${ins[0].id} where id = ${a.id}`;
  msgs.push(`${dir === "long" ? "🟢" : "🔴"} SIMULATED ${dir.toUpperCase()} OPENED: ${a.symbol} @ ${fmtPrice(plan.fill)} (market order, taker)\nSize ${fmtUsd(plan.notional)}; a stop-out loses about ${fmtUsd(plan.riskUsd)} (${((plan.riskUsd / equity) * 100).toFixed(2)}% of equity) including costs${plan.cappedBy ? `; size capped by ${plan.cappedBy}` : ""}.\nStop ${fmtPrice(stop)} / Target ${fmtPrice(target)}, net R:R ${plan.eco.netRR.toFixed(2)} at this price.${lockTrigger === null ? "" : `\nProfit lock: at ${fmtPrice(lockTrigger)} the stop moves to ${fmtPrice(lockStop)}.`}${s.costsConfirmed ? "" : "\n⚠️ Fees are PLACEHOLDERS."}\nSimulation only: not a real order.`);
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
  // A target that is a resting limit order fills at the target with the maker fee and no slippage; everything else is a market exit.
  const limit = reason === "target" && s.targetFill === "maker";
  const fill = limit ? refExit : slipPrice(refExit, dir, "exit", s.slippagePct + s.spreadPct / 2);
  const m = closeMath(dir, Number(t.entry_price), fill, units, Number(t.entry_fee), limit ? s.makerFeePct : s.takerFeePct);
  const heldH = Math.max(0, closedAtMs - Number(t.opened_ms ?? (t.opened_at ? new Date(t.opened_at).getTime() : closedAtMs))) / 3600000;
  const funding = (Number(t.notional) * s.fundingPctPer8h * (heldH / 8)) / 100 * (dir === "long" ? 1 : -1);
  const net = m.net - funding;
  const slipUsd = Math.abs(fill - refExit) * units;
  const res = await db`update paper_trades set status = 'closed', ref_exit_price = ${refExit}, exit_price = ${fill}, exit_slippage_usd = ${slipUsd}, exit_fee = ${m.exitFee}, funding_usd = ${funding}, exit_fill = ${limit ? "limit" : "market"},
      closed_at = to_timestamp(${closedAtMs / 1000}), exit_reason = ${reason}, gross_pnl = ${m.gross}, realized_pnl = ${net}, last_price = ${refExit}, last_price_at = now()
    where id = ${t.id} and status = 'open' returning id`;
  if (!res.length) return false;
  const why = ({ stop: "stop hit", profit_lock: "profit lock hit", target: "target hit", time: "time limit", manual: "closed manually" } as Record<string, string>)[reason] || reason;
  msgs?.push(`${net >= 0 ? "✅" : "❌"} SIMULATED ${dir.toUpperCase()} CLOSED: ${t.symbol} @ ${fmtPrice(fill)} (${why})\nSimulated P&L: ${fmtUsd(net, true)} after fees, slippage${funding ? " and funding" : ""}.\nSimulation only: not a real order.`);
  return true;
}

const roundTripCostPct = (s: Settings) => 2 * (s.takerFeePct + s.slippagePct + s.spreadPct / 2);

// One forecast per horizon for the newest closed candle, including NO_SIGNAL, so every call (and every
// non-call) can be scored later against baselines. Rows are append-only; a repeat tick for the same candle is a no-op.
// This rule has NO calibrated probabilities (probs = null): it says only "a confirmed retest rejection happened".
async function logForecasts(db: Db, s: Settings, sym: string, closed: Candle[], st: Setup | null, now: number) {
  const last = closed[closed.length - 1];
  const issuedT = last.t + s.timeframeMin * MIN;
  const direction: Direction4 = st ? (st.dir === "long" ? "UP" : "DOWN") : "NO_SIGNAL";
  for (const h of s.forecastHorizonsMin) {
    const f = buildForecast({
      symbol: sym,
      timeframeMin: s.timeframeMin,
      horizonMin: h,
      issuedT,
      now,
      model: "retest_zone_v1",
      direction,
      probs: null,
      refPrice: last.c,
      costPct: roundTripCostPct(s),
      invalidationPrice: st ? st.invalidationPrice : null,
      features: st ? { zoneLow: st.zoneLow, zoneHigh: st.zoneHigh, priorBounces: st.priorBounces, stopPct: st.stopPct, targetPct: st.targetPct, netRR: st.economics.netRR } : {},
      evidence: st ? `Observed: ${st.evidence} Inference: none calibrated yet; this rule has no measured edge.` : "No confirmed retest setup on the newest closed candle.",
    });
    await logForecast(db, f);
  }
}

// Scores forecasts whose horizon is over, using only candles that closed at/before the horizon end.
async function resolveDue(db: Db, s: Settings, sym: string, latest: Candle[], now: number) {
  const tfMs = s.timeframeMin * MIN;
  const due = await loadDueForecasts(db, sym, s.timeframeMin, now);
  if (!due.length) return;
  let candles = latest;
  const oldest = Math.min(...due.map((d: Row) => Number(d.issued_t) + Number(d.horizon_min) * MIN - tfMs));
  if (latest.length && oldest < latest[0].t) {
    // rare: the app was down longer than the latest-candles window; fetch the missing stretch once
    const r = await fetchCandlesRange(s.provider, sym, s.timeframeMin, oldest, latest[0].t);
    candles = [...r.candles, ...latest];
  }
  for (const d of due) {
    const res = resolveForecast(
      { issuedT: Number(d.issued_t), horizonMin: Number(d.horizon_min), refPrice: Number(d.ref_price) },
      candles,
      now,
      { tfMs, costPct: Number(d.cost_pct), minMovePct: s.minMovePct },
    );
    if (res.status === "resolved") await saveOutcome(db, Number(d.id), { actual: res.actual, endT: res.endT, endPrice: res.endPrice, returnPct: res.returnPct, thresholdPct: res.thresholdPct });
    else if (res.status === "unresolvable") await saveOutcome(db, Number(d.id), { actual: "UNRESOLVABLE", endT: null, endPrice: null, returnPct: null, thresholdPct: null });
  }
}

// Health is stored per symbol. A problem is announced only after DATA_ALERT_AFTER consecutive bad ticks, and
// recovery only if a problem was announced, so a single slow poll never messages you.
const DATA_ALERT_AFTER = 3;
async function recordHealth(db: Db, s: Settings, sym: string, reasons: string[], msgs: string[]) {
  const text = reasons.join("; ").slice(0, 400);
  const row = (await db`select bad_streak, alerted from data_health where symbol = ${sym} and timeframe_min = ${s.timeframeMin}`)[0];
  const { state, send } = nextHealthState(row ? { badStreak: Number(row.bad_streak), alerted: !!row.alerted } : null, reasons.length > 0, DATA_ALERT_AFTER);
  await db`insert into data_health (symbol, timeframe_min, ok, reasons, bad_streak, alerted) values (${sym}, ${s.timeframeMin}, ${reasons.length === 0}, ${text}, ${state.badStreak}, ${state.alerted})
    on conflict (symbol, timeframe_min) do update set ok = excluded.ok, reasons = excluded.reasons, bad_streak = excluded.bad_streak, alerted = excluded.alerted, updated_at = now()`;
  if (send === "recovered") msgs.push(`✅ DATA OK AGAIN: ${sym} ${s.timeframeMin}m. Signals and forecasts have resumed.`);
  else if (send === "problem") msgs.push(`⚠️ DATA PROBLEM: ${sym} ${s.timeframeMin}m (bad for ${DATA_ALERT_AFTER} checks in a row)\n${text}\nNo signals or forecasts for this symbol until the data is healthy.`);
}

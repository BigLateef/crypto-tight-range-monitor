"use client";
import { useCallback, useEffect, useState } from "react";
import Nav from "@/components/Nav";
import { api } from "@/components/api";
import { fmtDuration, fmtPct, fmtPrice, fmtUnits, fmtUsd, fmtWhen } from "@/lib/format";

const REASON: Record<string, string> = { stop: "Stop hit", profit_lock: "Profit lock hit", target: "Target hit", time: "Time limit", manual: "Closed manually" };
const cls = (n: number) => (n > 0 ? "gain" : n < 0 ? "loss" : "");

export default function Portfolio() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");
  const [confirmId, setConfirmId] = useState("");
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(Date.now());
  const [updated, setUpdated] = useState(0);

  const load = useCallback(async () => {
    try {
      setD(await api("/api/portfolio"));
      setUpdated(Date.now());
      setErr("");
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const a = setInterval(load, 20000);
    const b = setInterval(() => setTick(Date.now()), 30000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [load]);

  async function closePos(id: string) {
    if (confirmId !== id) {
      setConfirmId(id);
      setRowMsg((m) => ({ ...m, [id]: "" }));
      setTimeout(() => setConfirmId((c) => (c === id ? "" : c)), 6000);
      return;
    }
    setConfirmId("");
    setBusyId(id);
    try {
      await api(`/api/trades/${id}/close`, { method: "POST", body: "{}" });
      setRowMsg((m) => ({ ...m, [id]: "" }));
    } catch (e: any) {
      setRowMsg((m) => ({ ...m, [id]: `Could not close: ${e.message}` }));
    }
    await load();
    setBusyId("");
  }

  if (!d) {
    return (
      <div className="wrap">
        <div className="top"><h1>Paper portfolio</h1><div className="stamp">SIMULATION ONLY</div></div>
        <p className="muted">{err ? `Could not load: ${err}` : "Loading..."}</p>
        <Nav />
      </div>
    );
  }
  const a = d.account;
  const st = d.stats;
  const tickAge = d.engine.lastTickMs ? d.now - d.engine.lastTickMs : null;
  const stale = tickAge === null || tickAge > (d.tickIntervalMin * 2 + 1) * 60000;

  return (
    <div className="wrap">
      <div className="top">
        <h1>Paper portfolio</h1>
        <div className="stamp">SIMULATION ONLY</div>
      </div>
      <div className="status">
        <span className={`pill ${d.paperEnabled ? "on" : "off"}`}>{d.paperEnabled ? "Paper trading ON" : "Paper trading OFF"}</span>
        <span className="pill">Setups in last 24h: {d.activeRanges}</span>
        <span className="pill">{d.timeframeMin}m candles</span>
      </div>
      {d.haltEntries && <div className="banner">Kill switch is ON: no new paper entries open. Alerts keep running and open positions are still managed to their exits.</div>}
      {(!d.riskConfirmed || !d.costsConfirmed) && <div className="banner">{!d.riskConfirmed ? "Risk settings are unconfirmed placeholders, so no paper entry opens. " : ""}{!d.costsConfirmed ? "Fees are unconfirmed placeholders, so results below are not meaningful. " : ""}Set and confirm them in Settings.</div>}
      {!d.paperEnabled && <div className="banner">Paper trading is off: no new simulated positions open. Setup alerts keep running, and open simulated positions are still managed to their exits.</div>}
      {stale && (
        <div className="banner">
          {tickAge === null ? "The engine has not run yet. Set up the cron-job.org job (see README)." : `The engine last ran ${fmtDuration(tickAge)} ago, so exits, entries and alerts may be late.`}
        </div>
      )}
      {err && <div className="banner">Could not refresh: {err}. The numbers below may be out of date.</div>}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Updated {updated ? new Date(updated).toLocaleTimeString() : "-"}</div>

      <div className="hero">
        <div className="muted">Total equity (simulated)</div>
        <div className="big num">{fmtUsd(a.equity)}</div>
        <div className={`sub num ${cls(a.equity - a.startingBalance)}`}>
          {fmtUsd(a.equity - a.startingBalance, true)} ({fmtPct(a.equityChangePct, 2, true)}) since the virtual start
        </div>
      </div>
      <div className="grid2">
        <Cell k="Starting balance" v={fmtUsd(a.startingBalance)} />
        <Cell k="Available virtual cash" v={fmtUsd(a.cash)} />
        <Cell k="Open positions: cost" v={fmtUsd(a.openCost)} />
        <Cell k="Open positions: value" v={fmtUsd(a.openValue)} />
        <Cell k="Unrealized P&L" v={fmtUsd(a.unrealized, true)} c={cls(a.unrealized)} />
        <Cell k="Realized P&L" v={fmtUsd(a.realized, true)} c={cls(a.realized)} />
      </div>
      <div className="stats">
        <div className="stat"><div className="k">Win rate</div><div className="v num">{st.winRatePct === null ? "-" : fmtPct(st.winRatePct, 0)}</div></div>
        <div className="stat"><div className="k">Closed trades</div><div className="v num">{st.closedCount}</div></div>
        <div className="stat"><div className="k">Largest drawdown</div><div className="v num">{st.closedCount || st.maxDrawdownUsd ? fmtPct(st.maxDrawdownPct, 1) : "-"}</div></div>
      </div>

      <h2>Scorecard (paper results vs break-even)</h2>
      <div className="banner">{d.report.verdict}</div>
      <div className="kv num">
        <div><span>Closed trades from setups</span><span>{d.report.n} (need {d.report.minTrades})</span></div>
        <div><span>Win rate</span><span>{d.report.winRate === null ? "-" : `${(d.report.winRate * 100).toFixed(1)}% (95% range ${(d.report.winRateLow * 100).toFixed(0)}-${(d.report.winRateHigh * 100).toFixed(0)}%)`}</span></div>
        <div><span>Break-even win rate (after costs)</span><span>{d.report.avgBreakEven === null ? "-" : `${(d.report.avgBreakEven * 100).toFixed(0)}%`}</span></div>
        <div><span>Average win / loss</span><span>{fmtUsd(d.report.avgWin)} / {fmtUsd(d.report.avgLoss)}</span></div>
        <div><span>Expectancy per trade (after costs)</span><span>{fmtUsd(d.report.expectancy, true)}</span></div>
        <div><span>Setups: entered / skipped / pending</span><span>{d.report.setups.entered} / {d.report.setups.skipped} / {d.report.setups.pending}</span></div>
      </div>
      {d.report.setups.topSkipReasons.length > 0 && (
        <div className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
          Signals not traded, by reason: {d.report.setups.topSkipReasons.map((r: any) => `${r.reason} (${r.count})`).join("; ")}
        </div>
      )}
      <div className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
        {d.report.bySymbol.map((x: any) => `${x.key}: ${x.n} trades`).join(" | ")}{d.report.byDirection.length ? " || " : ""}{d.report.byDirection.map((x: any) => `${x.key}: ${x.n} trades`).join(" | ")}. Slices are descriptive only; a good-looking slice is a hypothesis for fresh data.
      </div>

      <h2>Open positions (simulated)</h2>
      {d.open.length === 0 && <div className="empty">No open simulated positions. One opens only after a confirmed rejection candle at a retest zone, and only if it still clears the cost and no-chase checks.</div>}
      {d.open.map((p: any) => (
        <div className="row" key={p.id}>
          <div className="head">
            <div><span className="sym">{p.symbol}</span><span className={`chip ${p.direction}`}>{p.direction === "long" ? "Long" : "Short"}</span></div>
            <div className={`num ${cls(p.pnl)}`}><b>{fmtUsd(p.pnl, true)}</b> <span>({fmtPct(p.pnlPct, 2, true)})</span></div>
          </div>
          <div className="kv num">
            <div><span>Entry (sim)</span><span>{fmtPrice(p.entryPrice)}</span></div>
            <div><span>{p.priceIsLive ? "Price now" : "Last known"}</span><span>{fmtPrice(p.currentPrice)}</span></div>
            <div><span>Size</span><span>{fmtUnits(p.units)} ({fmtUsd(p.notional)})</span></div>
            <div><span>Open for</span><span>{fmtDuration(tick - p.openedMs)}</span></div>
            <div><span>{p.stopLocked ? "Stop (locked)" : "Stop (sim)"}</span><span>{p.stop === null ? "off" : fmtPrice(p.stop)}</span></div>
            <div><span>Target (sim)</span><span>{p.target === null ? "off" : fmtPrice(p.target)}</span></div>
            {p.lockTrigger !== null && <div><span>Profit lock</span><span>{p.stopLocked ? "ACTIVE" : `at ${fmtPrice(p.lockTrigger)}`}</span></div>}
            {p.maxHoldMinutes > 0 && <div><span>Time limit</span><span>{fmtDuration(p.maxHoldMinutes * 60000)}</span></div>}
          </div>
          <button className={confirmId === p.id ? "danger" : "ghost"} disabled={busyId === p.id} onClick={() => closePos(p.id)}>
            {busyId === p.id ? "Closing..." : confirmId === p.id ? "Tap again to confirm (simulated)" : "Close simulated position"}
          </button>
          {rowMsg[p.id] && <div className="err">{rowMsg[p.id]}</div>}
        </div>
      ))}

      <h2>Trade history (simulated)</h2>
      {d.closed.length === 0 && <div className="empty">No closed simulated trades yet.</div>}
      {d.closed.map((t: any) => (
        <div className="row" key={t.id}>
          <div className="head">
            <div><span className="sym">{t.symbol}</span><span className={`chip ${t.direction}`}>{t.direction === "long" ? "Long" : "Short"}</span></div>
            <div className={`num ${cls(t.pnl)}`}><b>{fmtUsd(t.pnl, true)}</b></div>
          </div>
          <div className="kv num">
            <div><span>Entry (sim)</span><span>{fmtPrice(t.entryPrice)}</span></div>
            <div><span>Exit (sim)</span><span>{fmtPrice(t.exitPrice)}</span></div>
            <div><span>Fees</span><span>{fmtUsd(t.fees)}</span></div>
            <div><span>Slippage</span><span>{fmtUsd(t.slippageUsd)}</span></div>
            <div><span>Exit reason</span><span>{REASON[t.exitReason] || t.exitReason}</span></div>
            <div><span>Held</span><span>{fmtDuration(t.closedMs - t.openedMs)}</span></div>
            <div><span>Opened</span><span>{fmtWhen(t.openedMs)}</span></div>
            <div><span>Closed</span><span>{fmtWhen(t.closedMs)}</span></div>
          </div>
        </div>
      ))}
      <p className="note">
        Everything on this page is simulated with virtual money, using real public market prices plus modelled fees and slippage. It is not live trading, results are not a forecast, and past simulated
        performance does not guarantee anything. Largest drawdown comes from recorded equity snapshots and can miss moves between snapshots.
      </p>
      <Nav />
    </div>
  );
}

function Cell({ k, v, c }: { k: string; v: string; c?: string }) {
  return (
    <div className="cell">
      <div className="k">{k}</div>
      <div className={`v num ${c || ""}`}>{v}</div>
    </div>
  );
}

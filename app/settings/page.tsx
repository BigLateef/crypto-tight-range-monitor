"use client";
import { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import { api } from "@/components/api";

type S = Record<string, any>;

type HP = { s: S; set: (k: string, v: any) => void; k: string; label: string };
function Num({ s, set, k, label, step = "any" }: HP & { step?: string }) {
  return (
    <label className="f">{label}
      <input type="number" inputMode="decimal" step={step} value={s[k]} onChange={(e) => set(k, e.target.value === "" ? "" : Number(e.target.value))} />
    </label>
  );
}
function Sel({ s, set, k, label, opts }: HP & { opts: [string | number, string][] }) {
  return (
    <label className="f">{label}
      <select value={s[k]} onChange={(e) => set(k, typeof s[k] === "number" ? Number(e.target.value) : e.target.value)}>
        {opts.map(([v, t]) => <option key={String(v)} value={v}>{t}</option>)}
      </select>
    </label>
  );
}
function Tog({ s, set, k, label }: HP) {
  return <label className="tog"><span>{label}</span><input type="checkbox" checked={!!s[k]} onChange={(e) => set(k, e.target.checked)} /></label>;
}

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [symbolsText, setSymbolsText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [backupText, setBackupText] = useState("");
  const [backupInfo, setBackupInfo] = useState("");
  const [restoreText, setRestoreText] = useState("");
  const [resetText, setResetText] = useState("");

  useEffect(() => {
    api("/api/settings").then((r) => {
      setS(r.settings);
      setSymbolsText(r.settings.symbols.join(", "));
    }).catch((e) => setMsg({ ok: false, text: e.message }));
  }, []);

  if (!s) return <div className="wrap"><h1>Settings</h1><p className="muted">{msg ? msg.text : "Loading..."}</p><Nav /></div>;
  const set = (k: string, v: any) => setS({ ...s, [k]: v });

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ ...s, symbols: symbolsText }) });
      setS(r.settings);
      setSymbolsText(r.settings.symbols.join(", "));
      setMsg({ ok: true, text: "Saved. Changes apply from the next engine run; exit rules apply to new simulated positions only." });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
    setBusy(false);
  }
  async function reset() {
    try {
      await api("/api/reset", { method: "POST", body: JSON.stringify({ confirm: "RESET" }) });
      setMsg({ ok: true, text: "Simulated account reset." });
      setShowReset(false);
      setResetText("");
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  }
  async function pickBackup(f: File | undefined) {
    setBackupText("");
    setBackupInfo("");
    if (!f) return;
    try {
      const text = await f.text();
      const b = JSON.parse(text);
      if (b?.format !== "ctrm-backup-v1") throw new Error("not a backup from this app");
      setBackupText(text);
      setBackupInfo(`Loaded: ${b.paper_trades.length} trades, ${(b.retest_setups || []).length} setups, ${b.equity_snapshots.length} equity points`);
    } catch (e: any) {
      setBackupInfo(`Could not read that file: ${e.message}`);
    }
  }
  async function restore() {
    try {
      const r = await api("/api/import", { method: "POST", body: JSON.stringify({ confirm: "RESTORE", backup: JSON.parse(backupText) }) });
      setMsg({ ok: true, text: `Restored ${r.restored.trades} trades, ${r.restored.alerts} alerts and ${r.restored.setups ?? 0} setups, ${r.restored.snapshots} equity points. Reload this page to see your restored settings.` });
      setBackupText("");
      setBackupInfo("");
      setRestoreText("");
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  }
  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div className="wrap">
      <div className="top"><h1>Settings</h1><div className="stamp">SIMULATION ONLY</div></div>

      <fieldset>
        <legend>Paper trading</legend>
        <Tog s={s} set={set} k="paperEnabled" label="Paper trading enabled (alerts keep running when off)" />
        <Num s={s} set={set} k="startingBalance" label="Starting balance (virtual USD)" />
        <p className="muted" style={{ fontSize: 13 }}>Changing the starting balance re-bases the whole simulated account. Use Reset below for a clean start.</p>
      </fieldset>

      <fieldset>
        <legend>Market data</legend>
        <Sel s={s} set={set} k="provider" label="Public price source" opts={[["coinbase", "Coinbase (pairs like BTC-USD)"], ["binance", "Binance public data (pairs like BTC-USDT)"]]} />
        <label className="f">Pairs to watch (up to 10, comma separated)
          <input type="text" value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} autoCapitalize="characters" />
        </label>
        <Num s={s} set={set} k="tickIntervalMin" label="Cron interval (minutes): must match your cron-job.org schedule" step="1" />
        <Sel s={s} set={set} k="timeframeMin" label="Trigger candle (confirmation)" opts={[[1, "1 minute"], [5, "5 minutes"], [15, "15 minutes"]]} />
      </fieldset>

      <fieldset>
        <legend>Retest zones</legend>
        <p className="muted" style={{ fontSize: 13 }}>Zones come from past swing highs and lows on the zone timeframe. A bounce is counted only when price left the zone and came back; a break resets the count. Two bounces are a setting to test, not proof a level is stronger.</p>
        <Sel s={s} set={set} k="zoneTfMin" label="Zone timeframe" opts={[[60, "1 hour"], [240, "4 hours (built from 1h)"]]} />
        <div className="two">
          <Num s={s} set={set} k="minPriorBounces" label="Earlier bounces required" step="1" />
          <Num s={s} set={set} k="minWickFrac" label="Min rejection wick (fraction of candle)" />
          <Num s={s} set={set} k="maxChasePct" label="Do not chase beyond (%)" />
          <Num s={s} set={set} k="cooldownMin" label="Cooldown per zone and direction (min)" step="1" />
        </div>
        <Tog s={s} set={set} k="allowLong" label="Allow longs (bounce off support)" />
        <Tog s={s} set={set} k="allowShort" label="Allow shorts (rejection at resistance)" />
      </fieldset>

      <fieldset>
        <legend>Entry, stop and target</legend>
        <p className="muted" style={{ fontSize: 13 }}>Entry is a market order after the confirming candle closes. The stop sits beyond the far edge of the zone. A setup is dropped if the trade does not clear the minimum net reward-to-risk after costs.</p>
        <div className="two">
          <Num s={s} set={set} k="stopBufferPct" label="Stop buffer beyond zone (%)" />
          <Num s={s} set={set} k="minStopPct" label="Min stop distance (%)" />
          <Num s={s} set={set} k="maxStopPct" label="Max stop distance (%)" />
          <Num s={s} set={set} k="targetPct" label="Target (%)" />
          <Num s={s} set={set} k="minNetRR" label="Min net reward : risk" />
          <Num s={s} set={set} k="maxHoldMinutes" label="Time limit (minutes, 0 = none)" step="1" />
          <Num s={s} set={set} k="maxEntryDelaySec" label="Skip if later than (sec)" step="1" />
          <Num s={s} set={set} k="maxOpenPositions" label="Max open positions" step="1" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Risk</legend>
        <p className="muted" style={{ fontSize: 13 }}>The values shown are placeholders, not a recommendation. Size is set so a stop-out loses this share of equity including all costs, capped at your available virtual cash (spot style; margin and leverage are not simulated yet).</p>
        <div className="two">
          <Num s={s} set={set} k="riskPct" label="Risk per trade (% of equity)" />
          <Num s={s} set={set} k="dailyLossLimitPct" label="Daily loss limit (% of equity)" />
        </div>
        <Tog s={s} set={set} k="riskConfirmed" label="I chose these risk values (no paper entries open until ticked)" />
      </fieldset>

      <fieldset>
        <legend>Costs (applied to every simulated fill)</legend>
        <p className="muted" style={{ fontSize: 13 }}>The numbers below are placeholders, not your real fees. Look up your taker and maker rates on your exchange's fee page, enter them, then tick confirmed. Until then every alert carries a warning.</p>
        <div className="two">
          <Num s={s} set={set} k="takerFeePct" label="Taker fee per fill (%)" />
          <Num s={s} set={set} k="makerFeePct" label="Maker fee per fill (%)" />
          <Num s={s} set={set} k="slippagePct" label="Slippage per market fill (%)" />
          <Num s={s} set={set} k="spreadPct" label="Typical spread (%)" />
          <Num s={s} set={set} k="fundingPctPer8h" label="Funding per 8h (%, perps; 0 for spot)" />
        </div>
        <Sel s={s} set={set} k="targetFill" label="Profit target fills as" opts={[["taker", "Market order (taker)"], ["maker", "Resting limit order (maker)"]]} />
        <Tog s={s} set={set} k="costsConfirmed" label="I have entered my real fees" />
      </fieldset>

      <fieldset>
        <legend>Profit lock</legend>
        <p className="muted" style={{ fontSize: 13 }}>When a simulated position reaches the trigger profit, its stop moves past entry into profit. If price then falls back, it closes with a gain instead of break-even or a loss. Applies to new positions only.</p>
        <Tog s={s} set={set} k="lockEnabled" label="Profit lock enabled" />
        <div className="two">
          <Num s={s} set={set} k="lockTriggerPct" label="Trigger: profit reached (%)" />
          <Num s={s} set={set} k="lockProfitPct" label="Stop moves to profit of (%)" />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Keep the locked profit above your round-trip fees and slippage (about 2x fee + 2x slippage), or the "gain" can net to zero.</p>
      </fieldset>

      <fieldset>
        <legend>Backup and move</legend>
        <p className="muted" style={{ fontSize: 13 }}>Download everything (trades, history, alerts, settings) as one file. To move to another database, download here, switch DATABASE_URL, then restore the file below.</p>
        <div style={{ marginTop: 10 }}><a className="btn" href="/api/export" download>Download backup</a></div>
        <label className="f">Restore from a backup file (replaces ALL current data)
          <input type="file" accept="application/json,.json" onChange={(e) => pickBackup(e.target.files?.[0])} />
        </label>
        {backupInfo && <p className="muted" style={{ fontSize: 13 }}>{backupInfo}</p>}
        {backupText && (
          <>
            <label className="f">Type RESTORE to confirm
              <input type="text" value={restoreText} onChange={(e) => setRestoreText(e.target.value)} autoCapitalize="characters" />
            </label>
            <div style={{ marginTop: 10 }}><button className="danger" disabled={restoreText !== "RESTORE"} onClick={restore}>Restore backup</button></div>
          </>
        )}
      </fieldset>

      {msg && <div className={msg.ok ? "ok" : "err"}>{msg.text}</div>}
      <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={save} disabled={busy}>{busy ? "Saving..." : "Save settings"}</button>
        <button className="danger" onClick={() => setShowReset(!showReset)}>Reset simulated account</button>
        <button className="ghost" onClick={logout}>Sign out</button>
      </div>
      {showReset && (
        <fieldset>
          <legend>Confirm reset</legend>
          <p className="muted" style={{ fontSize: 13 }}>Deletes all simulated trades and equity history (setup history is kept). Type RESET to confirm.</p>
          <input type="text" value={resetText} onChange={(e) => setResetText(e.target.value)} autoCapitalize="characters" />
          <div style={{ marginTop: 10 }}>
            <button className="danger" disabled={resetText !== "RESET"} onClick={reset}>Delete simulated history</button>
          </div>
        </fieldset>
      )}
      <p className="note">All fills are simulated from real public prices. This app has no exchange, wallet or order code.</p>
      <Nav />
    </div>
  );
}

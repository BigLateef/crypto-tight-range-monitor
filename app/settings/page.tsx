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
      setBackupInfo(`Loaded: ${b.paper_trades.length} trades, ${b.range_alerts.length} alerts, ${b.equity_snapshots.length} equity points`);
    } catch (e: any) {
      setBackupInfo(`Could not read that file: ${e.message}`);
    }
  }
  async function restore() {
    try {
      const r = await api("/api/import", { method: "POST", body: JSON.stringify({ confirm: "RESTORE", backup: JSON.parse(backupText) }) });
      setMsg({ ok: true, text: `Restored ${r.restored.trades} trades, ${r.restored.alerts} alerts, ${r.restored.snapshots} equity points. Reload this page to see your restored settings.` });
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
        <Sel s={s} set={set} k="timeframeMin" label="Candle size" opts={[[1, "1 minute"], [5, "5 minutes"], [15, "15 minutes"], [60, "1 hour"]]} />
      </fieldset>

      <fieldset>
        <legend>Range discovery</legend>
        <Sel s={s} set={set} k="detectionMode" label="Detection design" opts={[["tight_range", "Tight range + breakout (original design)"], ["swing_pattern", "Swing pattern + breakout (your design)"]]} />
        <p className="muted" style={{ fontSize: 13 }}>Only the section for the chosen design is used. Either way, a LONG or SHORT signal needs a candle close beyond the edge of the range.</p>
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}><b>Swing pattern settings</b> (used when "Swing pattern" is chosen): price swings back and forth inside a band for at least 2 cycles in a row; the engine decides how many cycles. Use any swing size you like, small for scalping.</p>
        <div className="two">
          <Num s={s} set={set} k="swingMinPct" label="Smallest swing (%)" />
          <Num s={s} set={set} k="swingBandTolPct" label="Band looseness (%)" />
          <Num s={s} set={set} k="swingMaxCandles" label="Look back (candles)" step="1" />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Band looseness: how far the swing highs (and the swing lows) may drift from each other, as a % of the swing height. Lower = a flatter, stricter band. 50 is a good start; raise it to allow slow drift.</p>
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}><b>Tight range settings</b> (used when "Tight range" is chosen):</p>
        <div className="two">
          <Num s={s} set={set} k="rangeLookback" label="Candles in range" step="1" />
          <Num s={s} set={set} k="rangeMaxWidthPct" label="Max width (%)" />
          <Num s={s} set={set} k="rangeMinTouches" label="Min touches per edge" step="1" />
          <Num s={s} set={set} k="rangeTouchTolPct" label="Edge zone (% of height)" />
          <Num s={s} set={set} k="rangeExpireCandles" label="Expire after (candles)" step="1" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Entry rule</legend>
        <p className="muted" style={{ fontSize: 13 }}>A simulated position opens only after a candle closes outside the range, in that direction. A range alert alone never opens one.</p>
        <div className="two">
          <Num s={s} set={set} k="breakoutBufferPct" label="Close beyond edge by (%)" />
          <Num s={s} set={set} k="confirmCloses" label="Confirming closes" step="1" />
          <Num s={s} set={set} k="maxEntryDelaySec" label="Skip if later than (sec)" step="1" />
          <Num s={s} set={set} k="maxOpenPositions" label="Max open positions" step="1" />
        </div>
        <Tog s={s} set={set} k="allowLong" label="Allow simulated longs (close above range)" />
        <Tog s={s} set={set} k="allowShort" label="Allow simulated shorts (close below range)" />
      </fieldset>

      <fieldset>
        <legend>Position size</legend>
        <Sel s={s} set={set} k="sizingMode" label="Sizing" opts={[["fixed_usd", "Fixed USD per trade"], ["pct_equity", "% of equity"], ["risk_pct", "Risk % of equity (needs a stop)"]]} />
        <div className="two">
          <Num s={s} set={set} k="fixedUsd" label="Fixed USD" />
          <Num s={s} set={set} k="pctEquity" label="% of equity" />
          <Num s={s} set={set} k="riskPct" label="Risk % per trade" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Costs (applied to every simulated fill)</legend>
        <div className="two">
          <Num s={s} set={set} k="feePct" label="Fee per side (%)" />
          <Num s={s} set={set} k="slippagePct" label="Slippage per side (%)" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Exits</legend>
        <Sel s={s} set={set} k="stopMode" label="Stop" opts={[["pct", "Percent from entry"], ["range_edge", "Back at the broken range edge"], ["off", "No stop"]]} />
        <Num s={s} set={set} k="stopPct" label="Stop distance (%)" />
        <Sel s={s} set={set} k="targetMode" label="Target" opts={[["pct", "Percent from entry"], ["r_multiple", "Multiple of stop distance"], ["off", "No target"]]} />
        <div className="two">
          <Num s={s} set={set} k="targetPct" label="Target (%)" />
          <Num s={s} set={set} k="targetR" label="Target (R multiple)" />
        </div>
        <Num s={s} set={set} k="maxHoldMinutes" label="Time limit (minutes, 0 = none)" step="1" />
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
          <p className="muted" style={{ fontSize: 13 }}>Deletes all simulated trades and equity history (range alerts are kept). Type RESET to confirm.</p>
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

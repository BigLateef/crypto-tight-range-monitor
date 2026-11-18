"use client";
import { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import { api } from "@/components/api";
import { fmtPrice, fmtWhen } from "@/lib/format";

function paperText(a: any): string {
  if (a.paperState === "entered") return "Simulated position opened";
  if (a.paperState === "pending") return "Checking simulated entry";
  if (a.paperState === "skipped") return `No simulated entry: ${a.paperNote || "skipped"}`;
  return "No simulated entry";
}

export default function Alerts() {
  const [alerts, setAlerts] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const go = () => api("/api/alerts").then((r) => setAlerts(r.alerts)).catch((e) => setErr(e.message));
    go();
    const i = setInterval(go, 30000);
    return () => clearInterval(i);
  }, []);
  return (
    <div className="wrap">
      <div className="top"><h1>Retest setups</h1><div className="stamp">SIMULATION ONLY</div></div>
      <p className="muted">A setup is a confirmed rejection at a zone price has bounced from before. It is a hypothesis under test, not a prediction. Most of the time there is no setup, and that is the intended behaviour.</p>
      {err && <div className="err">{err}</div>}
      {alerts && alerts.length === 0 && <div className="empty">No setups yet. The engine checks every minute once the cron job is running; silence means no clear setup or unhealthy data.</div>}
      {(alerts || []).map((a) => (
        <div className="row" key={a.id}>
          <div className="head">
            <span className="sym">{a.dir === "long" ? "LONG" : "SHORT"} {a.symbol} <span className="muted" style={{ fontSize: 14 }}>{a.zoneTfMin === 60 ? "1h" : "4h"} zone / {a.triggerTfMin}m trigger</span></span>
            <span className="muted" style={{ fontSize: 13 }}>{fmtWhen(a.detectedMs)}</span>
          </div>
          <div className="kv num">
            <div><span>Zone</span><span>{fmtPrice(a.zoneLow)} - {fmtPrice(a.zoneHigh)}</span></div>
            <div><span>Earlier bounces</span><span>{a.priorBounces}</span></div>
            <div><span>Signal price</span><span>{fmtPrice(a.refPrice)}</span></div>
            <div><span>Stop / target</span><span>{fmtPrice(a.stop)} ({a.stopPct.toFixed(2)}%) / {fmtPrice(a.target)} ({a.targetPct.toFixed(2)}%)</span></div>
            <div><span>Net R:R after costs</span><span>{a.netRR.toFixed(2)}</span></div>
            <div><span>Break-even win rate</span><span>{(a.breakEven * 100).toFixed(0)}%</span></div>
            <div><span>Invalid if closed beyond</span><span>{fmtPrice(a.invalidation)}</span></div>
          </div>
          <div className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>{a.evidence}</div>
          <div className="muted" style={{ fontSize: 13.5 }}>{paperText(a)}{a.costsConfirmed ? "" : " (fees were placeholders)"}</div>
        </div>
      ))}
      <Nav />
    </div>
  );
}

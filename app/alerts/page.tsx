"use client";
import { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import { api } from "@/components/api";
import { fmtPrice, fmtWhen } from "@/lib/format";

const STATUS: Record<string, string> = { active: "Watching for a breakout", broken: "Breakout confirmed", expired: "Expired without a breakout" };

function paperText(a: any): string {
  if (a.paperState === "entered") return "Simulated position opened";
  if (a.paperState === "pending") return "Checking simulated entry";
  if (a.paperState === "skipped") return `No simulated entry: ${a.paperNote || "skipped"}`;
  return "No simulated entry: a range alert alone never opens one";
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
      <div className="top"><h1>Range alerts</h1><div className="stamp">SIMULATION ONLY</div></div>
      <p className="muted">A range alert says price has been moving sideways. It does not say which way price will go.</p>
      {err && <div className="err">{err}</div>}
      {alerts && alerts.length === 0 && <div className="empty">No ranges discovered yet. The engine checks every minute once the cron job is running.</div>}
      {(alerts || []).map((a) => (
        <div className="row" key={a.id}>
          <div className="head">
            <span className="sym">{a.symbol} <span className="muted" style={{ fontSize: 14 }}>{a.timeframeMin}m</span></span>
            <span className="muted" style={{ fontSize: 13 }}>{fmtWhen(a.detectedMs)}</span>
          </div>
          <div className="kv num">
            <div><span>High</span><span>{fmtPrice(a.high)}</span></div>
            <div><span>Low</span><span>{fmtPrice(a.low)}</span></div>
            <div><span>Width</span><span>{a.widthPct.toFixed(2)}%</span></div>
            <div><span>Edge touches / cycles</span><span>{a.touchesHigh} / {a.touchesLow}</span></div>
          </div>
          <div style={{ marginTop: 8, fontSize: 14 }}>
            {STATUS[a.status]}
            {a.status === "broken" && <> ({a.direction === "up" ? "closed above" : "closed below"} at {fmtPrice(a.breakoutClose)})</>}
          </div>
          <div className="muted" style={{ fontSize: 13.5 }}>{paperText(a)}</div>
        </div>
      ))}
      <Nav />
    </div>
  );
}

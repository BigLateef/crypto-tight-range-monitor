"use client";
import { useState } from "react";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (res.ok) window.location.href = "/portfolio";
    else {
      setErr("Wrong password");
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <div className="stamp" style={{ display: "inline-block" }}>SIMULATION ONLY</div>
      <h1>Crypto Tight Range Monitor</h1>
      <p className="muted">Virtual money only. This app never connects to an exchange or wallet.</p>
      <label className="f">
        Password
        <input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && pw && submit()} />
      </label>
      {err && <div className="err">{err}</div>}
      <div style={{ marginTop: 14 }}>
        <button onClick={submit} disabled={busy || !pw}>Sign in</button>
      </div>
    </div>
  );
}

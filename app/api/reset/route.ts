import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
export const dynamic = "force-dynamic";

// Wipes the SIMULATED account (trades + equity history). Range alerts are kept.
export async function POST(req: Request) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) return NextResponse.json({ error: "json required" }, { status: 415 });
  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== "RESET") return NextResponse.json({ error: 'send {"confirm":"RESET"}' }, { status: 400 });
  const db = sql();
  await db`delete from paper_trades`;
  await db`delete from equity_snapshots`;
  return NextResponse.json({ ok: true });
}

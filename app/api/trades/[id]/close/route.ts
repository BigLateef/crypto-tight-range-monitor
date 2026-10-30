import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { loadSettings } from "@/lib/settings";
import { fetchPrice } from "@/lib/provider";
import { closeTrade } from "@/lib/engine";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// Manual SIMULATED close at the current public market price (+ configured slippage and fee).
export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!/^\d+$/.test(params.id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const db = sql();
    const rows = await db`select * from paper_trades where id = ${params.id}`;
    if (!rows.length) return NextResponse.json({ error: `Position #${params.id} does not exist` }, { status: 404 });
    if (rows[0].status !== "open") {
      return NextResponse.json({ error: `Already closed (${rows[0].exit_reason || "closed"}). Refreshing.`, alreadyClosed: true }, { status: 409 });
    }
    const s = await loadSettings();
    const price = await fetchPrice(s.provider, rows[0].symbol);
    const done = await closeTrade(db, s, rows[0], price, "manual", Date.now());
    if (!done) return NextResponse.json({ error: "Position was already closed" }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

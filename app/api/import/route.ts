import { NextResponse } from "next/server";
import { restoreAll } from "@/lib/backup";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// Replaces the simulated account with a backup file. Needs {"confirm":"RESTORE","backup":{...}}.
export async function POST(req: Request) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) return NextResponse.json({ error: "json required" }, { status: 415 });
  const body = await req.json().catch(() => null);
  if (body?.confirm !== "RESTORE") return NextResponse.json({ error: 'send {"confirm":"RESTORE","backup":{...}}' }, { status: 400 });
  try {
    const counts = await restoreAll(body.backup);
    return NextResponse.json({ ok: true, restored: counts });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

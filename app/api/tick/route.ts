import { NextResponse } from "next/server";
import { cronCheck } from "@/lib/auth";
import { runTick } from "@/lib/engine";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// Called every minute by cron-job.org with "Authorization: Bearer <CRON_SECRET>".
async function handle(req: Request) {
  const why = cronCheck(req);
  if (why) return NextResponse.json({ error: "unauthorized", reason: why }, { status: 401 });
  try {
    return NextResponse.json(await runTick());
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;

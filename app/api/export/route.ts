import { NextResponse } from "next/server";
import { exportAll } from "@/lib/backup";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

// Session-protected (middleware). Downloads the whole simulated account as one JSON file.
export async function GET() {
  try {
    const data = await exportAll();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    return new NextResponse(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="range-monitor-backup-${stamp}.json"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

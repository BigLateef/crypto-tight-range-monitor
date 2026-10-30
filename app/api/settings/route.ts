import { NextResponse } from "next/server";
import { loadSettings, saveSettings } from "@/lib/settings";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ settings: await loadSettings() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) return NextResponse.json({ error: "json required" }, { status: 415 });
  try {
    const body = await req.json();
    const r = await saveSettings(body && typeof body === "object" ? body : {});
    if (!r.ok) return NextResponse.json({ errors: r.errors }, { status: 400 });
    return NextResponse.json({ settings: r.settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { buildPortfolio } from "@/lib/portfolio";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET() {
  try {
    return NextResponse.json(await buildPortfolio());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

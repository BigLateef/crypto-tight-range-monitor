import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await sql()`select id, symbol, timeframe_min, range_high, range_low, width_pct, touches_high, touches_low, window_candles, status, breakout_direction, breakout_close, paper_state, paper_note, trade_id,
      (extract(epoch from detected_at) * 1000)::bigint as detected_ms, (extract(epoch from broken_at) * 1000)::bigint as broken_ms
      from range_alerts order by id desc limit 60`;
    return NextResponse.json({
      alerts: rows.map((r) => ({
        id: String(r.id), symbol: r.symbol, timeframeMin: Number(r.timeframe_min), high: Number(r.range_high), low: Number(r.range_low), widthPct: Number(r.width_pct),
        touchesHigh: Number(r.touches_high), touchesLow: Number(r.touches_low), status: r.status, direction: r.breakout_direction, breakoutClose: r.breakout_close == null ? null : Number(r.breakout_close),
        paperState: r.paper_state, paperNote: r.paper_note, tradeId: r.trade_id == null ? null : String(r.trade_id),
        detectedMs: Number(r.detected_ms), brokenMs: r.broken_ms == null ? null : Number(r.broken_ms),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

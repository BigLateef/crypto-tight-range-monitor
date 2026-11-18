import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await sql()`select id, symbol, trigger_tf_min, zone_tf_min, dir, ref_price, zone_low, zone_high, prior_bounces, stop_price, target_price, stop_pct, target_pct, net_rr, break_even_win_rate, invalidation_price, evidence, costs_confirmed, paper_state, paper_note, trade_id,
      (extract(epoch from detected_at) * 1000)::bigint as detected_ms
      from retest_setups order by id desc limit 60`;
    return NextResponse.json({
      alerts: rows.map((r) => ({
        id: String(r.id), symbol: r.symbol, triggerTfMin: Number(r.trigger_tf_min), zoneTfMin: Number(r.zone_tf_min), dir: r.dir,
        refPrice: Number(r.ref_price), zoneLow: Number(r.zone_low), zoneHigh: Number(r.zone_high), priorBounces: Number(r.prior_bounces),
        stop: Number(r.stop_price), target: Number(r.target_price), stopPct: Number(r.stop_pct), targetPct: Number(r.target_pct),
        netRR: Number(r.net_rr), breakEven: Number(r.break_even_win_rate), invalidation: Number(r.invalidation_price), evidence: r.evidence,
        costsConfirmed: !!r.costs_confirmed, paperState: r.paper_state, paperNote: r.paper_note, tradeId: r.trade_id == null ? null : String(r.trade_id),
        detectedMs: Number(r.detected_ms),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

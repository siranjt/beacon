/**
 * Diagnostic endpoint — dumps the customer's current row + last 100 events.
 *
 * Use this to figure out exactly which stage of the analyze pipeline failed.
 * Hit GET /api/diag/<customer_id> and you'll get a JSON document with:
 *   - the customer's current status / verdict / scope / blob URLs
 *   - the full event log (one row per logEvent call)
 *
 * Events are inserted by every stage with `kind` like:
 *   stage1_started, stage1_done, out_of_scope,
 *   stage2_started, stage2_done, stage2_failed,
 *   stage3a_started, llm_eval_done, stage3a_done, stage3a_failed,
 *   stage3b_started, docx_rendered, render_failed,
 *   slack_posted, slack_failed, stage3b_done
 * Whichever sequence stops is exactly where the pipeline broke.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { sql } from "@/lib/post-payment/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(_req: NextRequest, ctx: { params: { customer_id: string } }) {
  const authFail = await requireAuth();
  if (authFail) return authFail;
  const customerId = ctx.params.customer_id;
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });
  }

  try {
    const { rows: custRows } = await sql`
      SELECT
        cb_customer_id, biz_name, am_name, scope, status, failure_reason,
        verdict, verdict_one_line, key_flags, needs_am_call,
        report_blob_docx_url, report_blob_json_url, report_blob_md_url,
        slack_channel_id, slack_ts,
        created_at, updated_at
      FROM customers
      WHERE cb_customer_id = ${customerId}
      LIMIT 1
    `;
    const { rows: eventRows } = await sql`
      SELECT id, kind, detail, created_at
      FROM events
      WHERE cb_customer_id = ${customerId}
      ORDER BY created_at DESC
      LIMIT 100
    `;

    return NextResponse.json({
      ok: true,
      customer: custRows[0] ?? null,
      events: eventRows,
      hints: {
        last_event_kind: eventRows[0]?.kind ?? null,
        // If you see "stage3a_started" but no "stage3a_done", the LLM call is
        // probably timing out. Switch ANTHROPIC_MODEL to claude-sonnet-4-6 or
        // claude-haiku-4-5-20251001 and confirm Vercel Fluid Compute is enabled
        // for >60s functions.
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

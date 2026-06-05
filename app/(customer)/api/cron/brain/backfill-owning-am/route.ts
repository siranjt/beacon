import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/customer/cron-auth";
import { getSql } from "@/lib/customer/postgres";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { buildAmNameToEmail } from "@/lib/brain/extract-from-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-shot backfill: populate owning_am_email on existing
 * beacon_ai_extracted candidates that were created with a buggy mapping
 * helper (read snapshot.am_email which doesn't exist).
 *
 * Logic per row:
 *   1. Read the candidate's customer_id
 *   2. Look up am_name from snapshot.customers[customer_id]
 *   3. Look up email from buildAmNameToEmail() (now correct)
 *   4. UPDATE owning_am_email if found
 *
 * Idempotent: re-running is safe. Only touches rows where owning_am_email
 * IS NULL and source_type = 'beacon_ai_extracted'.
 *
 * GET /api/cron/brain/backfill-owning-am
 *   → Returns { ok, updated, unmatched, total_scanned, errors }
 */
export async function GET(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (auth) return auth;

  const sql = getSql();
  if (!sql) {
    return NextResponse.json(
      { ok: false, error: "no postgres" },
      { status: 500 },
    );
  }

  const startedAt = Date.now();

  // Build the two maps:
  //   1. customer_id → am_name (from snapshot)
  //   2. am_name → email (from auth-mapping over all allowlists)
  const snap = await readLatestSnapshotV2();
  type SnapCustomer = {
    customer_id?: string | null;
    am_name?: string | null;
  };
  const customerIdToAmName = new Map<string, string>();
  for (const c of (snap?.customers ?? []) as SnapCustomer[]) {
    if (c.customer_id && c.am_name) {
      customerIdToAmName.set(c.customer_id, c.am_name);
    }
  }

  const amNameToEmail = await buildAmNameToEmail();

  // Scan candidates with NULL owning_am_email.
  const rows = (await sql`
    SELECT fact_id, customer_id
    FROM beacon_brain_facts
    WHERE confidence_state = 'candidate'
      AND source_type = 'beacon_ai_extracted'
      AND owning_am_email IS NULL
      AND soft_deleted_at IS NULL
  `) as Array<{ fact_id: string; customer_id: string }>;

  let updated = 0;
  let unmatched_no_am_name = 0;
  let unmatched_no_email = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const amName = customerIdToAmName.get(row.customer_id);
    if (!amName) {
      unmatched_no_am_name++;
      continue;
    }
    const email = amNameToEmail.get(amName);
    if (!email) {
      unmatched_no_email++;
      continue;
    }
    try {
      await sql`
        UPDATE beacon_brain_facts
        SET owning_am_email = ${email}
        WHERE fact_id = ${row.fact_id}
          AND owning_am_email IS NULL
      `;
      updated++;
    } catch (e) {
      errors.push(
        `${row.fact_id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  return NextResponse.json(
    {
      ok: true,
      total_scanned: rows.length,
      updated,
      unmatched_no_am_name,
      unmatched_no_email,
      errors,
      elapsed_ms,
      maps: {
        customer_id_to_am_name_size: customerIdToAmName.size,
        am_name_to_email_size: amNameToEmail.size,
        am_name_to_email_keys: [...amNameToEmail.keys()],
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

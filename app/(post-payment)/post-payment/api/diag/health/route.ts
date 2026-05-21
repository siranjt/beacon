/**
 * DB health-check — verifies the runtime can actually read AND write to the
 * customers/events tables, and reports which env var supplied the connection.
 *
 * GET /api/diag/health
 *
 * If POSTGRES_URL is wired up correctly, returns counts + a successful test
 * insert/delete cycle. If anything is wrong (env var missing, table missing,
 * permissions), the error surfaces in the response instead of being silently
 * swallowed by logEvent's try/catch.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { sql, getDbHost } from "@/lib/post-payment/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET() {
  const authFail = await requireAuth();
  if (authFail) return authFail;
  const out: any = {
    ok: true,
    // Build fingerprint — proves WHICH deployment is serving traffic. If the
    // commit_sha here doesn't match your latest git push, the new code is not
    // live yet (Vercel build still in progress, or production alias hasn't
    // moved to the latest deployment).
    deploy: {
      commit_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "(unset)",
      commit_msg: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "(unset)",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? "(unset)",
      env_name: process.env.VERCEL_ENV ?? "(unset)",
      deployment_url: process.env.VERCEL_URL ?? "(unset)",
      region: process.env.VERCEL_REGION ?? "(unset)",
    },
    env: {
      // Which env var actually provided the connection string. Don't leak
      // the URL itself — just which name was used.
      postgres_url_set: !!process.env.POSTGRES_URL,
      database_url_set: !!process.env.DATABASE_URL,
      storage_url_set: !!process.env.STORAGE_URL,
      storage_database_url_set: !!process.env.STORAGE_DATABASE_URL,
      postgres_prisma_url_set: !!process.env.POSTGRES_PRISMA_URL,
      // Hostname only — proves WHICH Neon branch the function is talking to
      // without leaking the password. If this hostname differs between calls,
      // we're hitting different databases.
      postgres_url_host: (() => {
        try { return new URL(process.env.POSTGRES_URL ?? "").host || "(empty)"; }
        catch { return "(invalid)"; }
      })(),
      // Effective host the Neon driver is actually using (after -pooler strip).
      // Should NOT contain "-pooler" if our fix is working.
      effective_db_host: getDbHost(),
      anthropic_model: process.env.ANTHROPIC_MODEL ?? "(unset → default)",
      next_public_app_url: process.env.NEXT_PUBLIC_APP_URL ?? "(unset)",
      vercel_url: process.env.VERCEL_URL ?? "(unset)",
      slack_channel_id: process.env.SLACK_CHANNEL_ID ?? "(unset)",
      slack_token_set: !!process.env.SLACK_BOT_TOKEN,
      blob_token_set: !!process.env.BLOB_READ_WRITE_TOKEN,
    },
    checks: {} as Record<string, any>,
  };

  // Identify the database the connection actually landed on. Postgres exposes
  // current_database() (logical DB name) and inet_server_addr() (host IP).
  try {
    const { rows } = await sql`
      SELECT current_database()::text AS db_name,
             inet_server_addr()::text AS server_addr,
             current_setting('server_version') AS pg_version
    `;
    out.db_identity = rows[0] ?? null;
  } catch (e: any) {
    out.db_identity_error = e?.message ?? String(e);
  }

  // 1. Can we SELECT from customers?
  try {
    const { rows } = await sql`SELECT COUNT(*)::int AS n FROM customers`;
    out.checks.customers_count = rows[0]?.n ?? null;
  } catch (e: any) {
    out.ok = false;
    out.checks.customers_count_error = e?.message ?? String(e);
  }

  // 2. Can we SELECT from events?
  try {
    const { rows } = await sql`SELECT COUNT(*)::int AS n, MAX(id)::int AS max_id FROM events`;
    out.checks.events_count = rows[0]?.n ?? null;
    out.checks.events_max_id = rows[0]?.max_id ?? null;
  } catch (e: any) {
    out.ok = false;
    out.checks.events_count_error = e?.message ?? String(e);
  }

  // 3. Can we INSERT into events without an FK target?
  // We use a sentinel customer id that we'll create + clean up so the FK is satisfied.
  const sentinelId = `__health_${Date.now()}`;
  try {
    await sql`
      INSERT INTO customers (cb_customer_id, cb_created_at, status, scope)
      VALUES (${sentinelId}, NOW(), 'pending', 'pending')
      ON CONFLICT DO NOTHING
    `;
    const { rows } = await sql`
      INSERT INTO events (cb_customer_id, kind, detail)
      VALUES (${sentinelId}, 'health_test', '{"probe":true}'::jsonb)
      RETURNING id
    `;
    out.checks.test_event_id = rows[0]?.id ?? null;
    // Cleanup
    await sql`DELETE FROM events WHERE cb_customer_id = ${sentinelId}`;
    await sql`DELETE FROM customers WHERE cb_customer_id = ${sentinelId}`;
    out.checks.cleanup = "ok";
  } catch (e: any) {
    out.ok = false;
    out.checks.test_insert_error = e?.message ?? String(e);
    // Best-effort cleanup
    try { await sql`DELETE FROM events WHERE cb_customer_id = ${sentinelId}`; } catch {}
    try { await sql`DELETE FROM customers WHERE cb_customer_id = ${sentinelId}`; } catch {}
  }

  return NextResponse.json(out);
}

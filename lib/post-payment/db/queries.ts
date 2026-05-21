/**
 * Postgres queries — one module so the rest of the app stays SQL-free.
 *
 * Uses @neondatabase/serverless's HTTP driver directly instead of
 * @vercel/postgres. Each query is one stateless HTTP request to Neon's
 * primary — no connection pool, no PgBouncer routing, no read-replica
 * lag. That cures the "diag/all sees events 21-37 but diag/health sees
 * max_id=30 on the same DB" inconsistency we were hitting with the
 * pooled driver.
 *
 * The `sql` template-tag API is identical, so existing call sites work
 * unchanged.
 */

import { neon } from "@neondatabase/serverless";

// Pick the unpooled URL by preference — it's a direct connection to Neon's
// primary compute endpoint, which is what we want for read-after-write
// consistency.
const RAW_URL =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.STORAGE_DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.POSTGRES_URL ??
  process.env.DATABASE_URL ??
  process.env.STORAGE_DATABASE_URL ??
  process.env.STORAGE_URL ??
  process.env.POSTGRES_PRISMA_URL ??
  "";

/**
 * Strip the `-pooler` segment from the Neon hostname so we connect to the
 * direct compute endpoint instead of the PgBouncer pooler. The pooler can
 * route subsequent queries to different backends, which causes our writes
 * to appear committed in one HTTP request but invisible in the next.
 *
 * Neon URL format:
 *   pooled:   postgres://user:pwd@ep-xyz-pooler.region.aws.neon.tech/db
 *   unpooled: postgres://user:pwd@ep-xyz.region.aws.neon.tech/db
 *
 * If the env already pointed to the unpooled variant, this is a no-op.
 */
function ensureDirectCompute(url: string): string {
  if (!url) return url;
  return url.replace(/-pooler(\.[^.]+\.[^.]+\.aws\.neon\.tech)/, "$1");
}

const CONNECTION_URL = ensureDirectCompute(RAW_URL);

if (!CONNECTION_URL) {
  console.error("[db] No connection URL found in env. Set DATABASE_URL_UNPOOLED or POSTGRES_URL.");
}

// neon() returns a tagged template function. With `fullResults: true` it
// returns `{ rows, rowCount, ... }` matching @vercel/postgres's shape, so
// existing destructuring like `const { rows } = await sql\`...\`` works.
//
// fetchOptions: { cache: "no-store" } — defense-in-depth against any HTTP
// caching layer (Cloudflare, regional proxies) sitting between Vercel and
// Neon's compute endpoint. We want every query to hit the database fresh.
export const sql = neon(CONNECTION_URL, {
  fullResults: true,
  fetchOptions: { cache: "no-store" },
}) as any;

// Export for diag — lets the health endpoint show which hostname we're hitting
// without leaking credentials.
export function getDbHost(): string {
  try { return new URL(CONNECTION_URL).host; }
  catch { return "(invalid)"; }
}

export type CustomerScope =
  | "discovery_first_pay"
  | "discovery_addon"
  | "other_subscription"
  | "no_subscription"
  | "pre_floor"
  | "pending";

export type CustomerStatus =
  | "pending"          // never analyzed yet (initial state after webhook)
  | "processing"       // analyze pipeline currently running
  | "ready"            // LLM eval complete, report rendered + Slack posted
  | "failed"           // pipeline error — see failure_reason for stage + message
  | "out_of_scope"     // skipped: pre-floor, no subs, or first sub not discovery
  | "pending_entity";  // deferred: BaseSheet hasn't synced entity_id yet — retry hourly via cron

export type Customer = {
  cb_customer_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  biz_name: string | null;
  primary_category: string | null;
  locality: string | null;
  state_code: string | null;
  country: string | null;

  cb_created_at: string;
  cb_channel: string | null;
  cb_payment_method: string | null;

  stripe_customer_id: string | null;
  stripe_created_at: string | null;
  timestamp_mismatch_h: number | null;
  timestamp_mismatch_flag: boolean;

  sub_id: string | null;
  sub_status: string | null;
  sub_item_price_ids: string[] | null;
  sub_billing_period: number | null;
  sub_billing_period_unit: string | null;
  sub_total_cents: number | null;

  entity_id: string | null;
  ae_name: string | null;
  am_name: string | null;
  lead_source_group: string | null;
  lead_source: string | null;
  predicted_6_month_leads: number | null;
  open_tickets_30d: number | null;
  churn_potential_flag: string | null;
  total_monthly_revenue: number | null;

  total_reviews_at_onb: number | null;
  avg_rating_at_onb: number | null;
  five_star_reviews: number | null;

  booking_platform: string | null;
  booking_platform_url: string | null;
  booking_platform_active: boolean | null;

  scope: CustomerScope;
  verdict: "icp" | "review" | "not_icp" | null;
  needs_am_call: boolean;
  verdict_one_line: string | null;
  key_flags: string[] | null;

  report_blob_docx_url: string | null;
  report_blob_pdf_url: string | null;
  report_blob_json_url: string | null;
  report_blob_md_url: string | null;

  slack_channel_id: string | null;
  slack_ts: string | null;

  status: CustomerStatus;
  failure_reason: string | null;
  failure_attempts: number;

  created_at: string;
  updated_at: string;
};

export async function listCustomersSinceFloor(): Promise<Customer[]> {
  const floor = process.env.CUSTOMER_FLOOR_DATE ?? "2026-05-01";
  const { rows } = await sql<Customer>`
    SELECT * FROM customers
    WHERE cb_created_at >= ${floor}::timestamptz
    ORDER BY cb_created_at DESC
    LIMIT 1000
  `;
  return rows;
}

export async function getCustomer(cbCustomerId: string): Promise<Customer | null> {
  const { rows } = await sql<Customer>`
    SELECT * FROM customers WHERE cb_customer_id = ${cbCustomerId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function upsertCustomerStub(args: {
  cb_customer_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  biz_name?: string;
  cb_created_at: string;
  cb_channel?: string;
  cb_payment_method?: string;
}) {
  await sql`
    INSERT INTO customers (
      cb_customer_id, email, first_name, last_name, biz_name,
      cb_created_at, cb_channel, cb_payment_method, status, scope
    ) VALUES (
      ${args.cb_customer_id}, ${args.email ?? null}, ${args.first_name ?? null}, ${args.last_name ?? null}, ${args.biz_name ?? null},
      ${args.cb_created_at}, ${args.cb_channel ?? null}, ${args.cb_payment_method ?? null}, 'pending', 'pending'
    )
    ON CONFLICT (cb_customer_id) DO UPDATE
      SET email             = COALESCE(EXCLUDED.email, customers.email),
          first_name        = COALESCE(EXCLUDED.first_name, customers.first_name),
          last_name         = COALESCE(EXCLUDED.last_name, customers.last_name),
          biz_name          = COALESCE(EXCLUDED.biz_name, customers.biz_name),
          cb_channel        = COALESCE(EXCLUDED.cb_channel, customers.cb_channel),
          cb_payment_method = COALESCE(EXCLUDED.cb_payment_method, customers.cb_payment_method)
  `;
}

export async function setCustomerStatus(
  cbCustomerId: string,
  status: CustomerStatus,
  failureReason?: string,
) {
  await sql`
    UPDATE customers
    SET status = ${status},
        failure_reason = ${failureReason ?? null},
        failure_attempts = CASE WHEN ${status} = 'failed' THEN failure_attempts + 1 ELSE failure_attempts END
    WHERE cb_customer_id = ${cbCustomerId}
  `;
}

export async function logEvent(
  cbCustomerId: string,
  kind: string,
  detail?: Record<string, unknown>,
) {
  try {
    await sql`
      INSERT INTO events (cb_customer_id, kind, detail)
      VALUES (${cbCustomerId}, ${kind}, ${JSON.stringify(detail ?? {})}::jsonb)
    `;
  } catch (e: any) {
    // Events are best-effort audit; never let a failed insert block the pipeline.
    // Most common cause: FK violation when customer row doesn't exist yet.
    console.error(`[logEvent] failed for ${cbCustomerId}/${kind}:`, e?.message ?? e);
  }
}

/**
 * Update writeable customer columns. Uses the tagged-template `sql` call so it
 * works against @vercel/postgres v0.10 (which doesn't reliably honor sql.query()).
 *
 * Pattern: COALESCE(<provided value>, <existing column>). If a field is
 * undefined in `fields`, it gets passed as null and COALESCE preserves the
 * existing value. If it's explicitly null in `fields`, the column gets
 * overwritten with null (we lose that "explicit-null" intent — but we don't
 * actually need it for this app's writes).
 *
 * To force-null a column, use `setCustomerNull(cbCustomerId, ["col"])`.
 */
export async function setCustomerReport(cbCustomerId: string, fields: Partial<Customer>) {
  const f = fields;
  try {
    await sql`
      UPDATE customers SET
        stripe_customer_id      = COALESCE(${f.stripe_customer_id ?? null}, stripe_customer_id),
        stripe_created_at       = COALESCE(${(f.stripe_created_at ?? null) as any}::timestamptz, stripe_created_at),
        timestamp_mismatch_h    = COALESCE(${f.timestamp_mismatch_h ?? null}, timestamp_mismatch_h),
        timestamp_mismatch_flag = COALESCE(${f.timestamp_mismatch_flag ?? null}, timestamp_mismatch_flag),
        sub_id                  = COALESCE(${f.sub_id ?? null}, sub_id),
        sub_status              = COALESCE(${f.sub_status ?? null}, sub_status),
        sub_item_price_ids      = COALESCE(${(f.sub_item_price_ids ?? null) as any}::text[], sub_item_price_ids),
        sub_billing_period      = COALESCE(${f.sub_billing_period ?? null}, sub_billing_period),
        sub_billing_period_unit = COALESCE(${f.sub_billing_period_unit ?? null}, sub_billing_period_unit),
        sub_total_cents         = COALESCE(${f.sub_total_cents ?? null}, sub_total_cents),
        entity_id               = COALESCE(${f.entity_id ?? null}, entity_id),
        biz_name                = COALESCE(${(f as any).biz_name ?? null}, biz_name),
        ae_name                 = COALESCE(${f.ae_name ?? null}, ae_name),
        am_name                 = COALESCE(${f.am_name ?? null}, am_name),
        lead_source_group       = COALESCE(${f.lead_source_group ?? null}, lead_source_group),
        lead_source             = COALESCE(${f.lead_source ?? null}, lead_source),
        predicted_6_month_leads = COALESCE(${f.predicted_6_month_leads ?? null}, predicted_6_month_leads),
        open_tickets_30d        = COALESCE(${f.open_tickets_30d ?? null}, open_tickets_30d),
        churn_potential_flag    = COALESCE(${f.churn_potential_flag ?? null}, churn_potential_flag),
        total_monthly_revenue   = COALESCE(${f.total_monthly_revenue ?? null}, total_monthly_revenue),
        total_reviews_at_onb    = COALESCE(${f.total_reviews_at_onb ?? null}, total_reviews_at_onb),
        avg_rating_at_onb       = COALESCE(${f.avg_rating_at_onb ?? null}, avg_rating_at_onb),
        five_star_reviews       = COALESCE(${f.five_star_reviews ?? null}, five_star_reviews),
        booking_platform        = COALESCE(${f.booking_platform ?? null}, booking_platform),
        booking_platform_url    = COALESCE(${f.booking_platform_url ?? null}, booking_platform_url),
        booking_platform_active = COALESCE(${f.booking_platform_active ?? null}, booking_platform_active),
        primary_category        = COALESCE(${f.primary_category ?? null}, primary_category),
        locality                = COALESCE(${f.locality ?? null}, locality),
        state_code              = COALESCE(${f.state_code ?? null}, state_code),
        country                 = COALESCE(${f.country ?? null}, country),
        scope                   = COALESCE(${f.scope ?? null}, scope),
        verdict                 = COALESCE(${f.verdict ?? null}, verdict),
        needs_am_call           = COALESCE(${f.needs_am_call ?? null}, needs_am_call),
        verdict_one_line        = COALESCE(${f.verdict_one_line ?? null}, verdict_one_line),
        key_flags               = COALESCE(${(f.key_flags ?? null) as any}::text[], key_flags),
        report_blob_docx_url    = COALESCE(${f.report_blob_docx_url ?? null}, report_blob_docx_url),
        report_blob_pdf_url     = COALESCE(${f.report_blob_pdf_url ?? null}, report_blob_pdf_url),
        report_blob_json_url    = COALESCE(${f.report_blob_json_url ?? null}, report_blob_json_url),
        report_blob_md_url      = COALESCE(${f.report_blob_md_url ?? null}, report_blob_md_url),
        slack_channel_id        = COALESCE(${f.slack_channel_id ?? null}, slack_channel_id),
        slack_ts                = COALESCE(${f.slack_ts ?? null}, slack_ts),
        status                  = COALESCE(${f.status ?? null}, status),
        failure_reason          = COALESCE(${f.failure_reason ?? null}, failure_reason)
      WHERE cb_customer_id = ${cbCustomerId}
    `;
  } catch (e: any) {
    console.error(`[setCustomerReport] failed for ${cbCustomerId}:`, e?.message ?? e);
    throw e;
  }
}

import { BILLING_THRESHOLDS } from "./config";
import type { ChargebeeInvoice, ChargebeeTransaction, BillingMetrics, ChargebeeSub } from "./types";

const DAY_MS = 86400 * 1000;
const SECONDS_TO_MS = 1000;

/**
 * Chargebee API extensions for v2:
 *   - GET /invoices?status[in]=payment_due,not_paid
 *   - GET /transactions?status[in]=in_progress,failure&date[after]=<90 days ago>
 *
 * Match transactions back to invoices via linked_invoices[].invoice_id.
 * Same paginated pattern as fetchAllLiveSubs (100/page, 80 page safety cap).
 */

function chargebeeAuth(): { base: string; authHeader: string } {
  const site = process.env.CHARGEBEE_SITE || "zoca";
  const key = process.env.CHARGEBEE_API_KEY;
  if (!key) throw new Error("CHARGEBEE_API_KEY is not set");
  return {
    base: `https://${site}.chargebee.com/api/v2`,
    authHeader: "Basic " + Buffer.from(`${key}:`).toString("base64"),
  };
}

export async function fetchUnpaidInvoices(): Promise<ChargebeeInvoice[]> {
  const { base, authHeader } = chargebeeAuth();
  const out: ChargebeeInvoice[] = [];
  const nowMs = Date.now();

  for (const status of ["payment_due", "not_paid"] as const) {
    let offset: string | undefined;
    let page = 0;
    do {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("status[is]", status);
      if (offset) params.set("offset", offset);

      const res = await fetch(`${base}/invoices?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: authHeader },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Chargebee invoices ${status} ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { list: { invoice: any }[]; next_offset?: string };
      for (const item of data.list || []) {
        const inv = item.invoice || {};
        const dateSec = inv.date ?? 0;
        const dueSec = inv.due_date ?? null;
        const referenceSec = dueSec ?? dateSec;
        const daysOverdue = referenceSec
          ? Math.max(0, Math.floor((nowMs - referenceSec * SECONDS_TO_MS) / DAY_MS))
          : 0;
        out.push({
          invoice_id: inv.id || "",
          customer_id: inv.customer_id || "",
          subscription_id: inv.subscription_id || null,
          status,
          amount_due: Number(inv.amount_due || 0),
          date: Number(dateSec) || 0,
          due_date: dueSec ? Number(dueSec) : null,
          days_overdue: daysOverdue,
        });
      }
      offset = data.next_offset;
      page++;
      if (page > 80) break;
    } while (offset);
  }
  return out;
}

export async function fetchRecentTransactions(daysBack: number = 90): Promise<ChargebeeTransaction[]> {
  const { base, authHeader } = chargebeeAuth();
  const out: ChargebeeTransaction[] = [];
  const afterSec = Math.floor((Date.now() - daysBack * DAY_MS) / SECONDS_TO_MS);

  for (const status of ["in_progress", "failure"] as const) {
    let offset: string | undefined;
    let page = 0;
    do {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("status[is]", status);
      params.set("date[after]", String(afterSec));
      if (offset) params.set("offset", offset);

      const res = await fetch(`${base}/transactions?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: authHeader },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Chargebee transactions ${status} ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { list: { transaction: any }[]; next_offset?: string };
      for (const item of data.list || []) {
        const tx = item.transaction || {};
        const linked = (tx.linked_invoices || []).map((li: any) => String(li.invoice_id || "")).filter(Boolean);
        out.push({
          id: tx.id || "",
          customer_id: tx.customer_id || "",
          status,
          amount: Number(tx.amount || 0),
          date: Number(tx.date || 0),
          linked_invoice_ids: linked,
        });
      }
      offset = data.next_offset;
      page++;
      if (page > 80) break;
    } while (offset);
  }
  return out;
}

/**
 * Build per-entity billing metrics by joining:
 *   - Unpaid invoices (Chargebee)
 *   - Recent transactions (Chargebee, in_progress + failure)
 *   - Customer → entity_id map (built from Chargebee subs cf_entity_id)
 *   - Auto-debit status (from Chargebee customer or sub)
 *
 * @param invoices       Output of fetchUnpaidInvoices()
 * @param transactions   Output of fetchRecentTransactions()
 * @param subs           Output of fetchAllLiveSubs()
 * @param customerToEntities  Map of customer_id → entity_ids (built from subs.cf_entity_id)
 */
export function buildBillingMetrics(
  invoices: ChargebeeInvoice[],
  transactions: ChargebeeTransaction[],
  subs: ChargebeeSub[],
  customerToEntities: Map<string, string[]>,
): Map<string, BillingMetrics> {
  // Group invoices by customer
  const invByCustomer = new Map<string, ChargebeeInvoice[]>();
  for (const inv of invoices) {
    if (!inv.customer_id) continue;
    const arr = invByCustomer.get(inv.customer_id) || [];
    arr.push(inv);
    invByCustomer.set(inv.customer_id, arr);
  }

  // Group transactions by customer
  const txByCustomer = new Map<string, ChargebeeTransaction[]>();
  for (const tx of transactions) {
    if (!tx.customer_id) continue;
    const arr = txByCustomer.get(tx.customer_id) || [];
    arr.push(tx);
    txByCustomer.set(tx.customer_id, arr);
  }

  // Build per-customer auto-debit lookup from subs (any sub with auto_collection=off → off)
  const autoDebitOffByCustomer = new Map<string, boolean>();
  for (const s of subs) {
    if (!s.customer_id) continue;
    const prev = autoDebitOffByCustomer.get(s.customer_id) || false;
    const isOff = (s.auto_collection || "").toLowerCase() === "off";
    autoDebitOffByCustomer.set(s.customer_id, prev || isOff);
  }

  // For each (customer, entity) pair, fan out one BillingMetrics row
  const out = new Map<string, BillingMetrics>();
  for (const [customerId, entities] of customerToEntities) {
    const customerInvoices = invByCustomer.get(customerId) || [];
    const customerTxs = txByCustomer.get(customerId) || [];
    const failedTxs = customerTxs.filter((t) => t.status === "failure");
    const inProgressInvoiceIds = new Set<string>();
    for (const t of customerTxs.filter((x) => x.status === "in_progress")) {
      for (const iid of t.linked_invoice_ids) inProgressInvoiceIds.add(iid);
    }

    const totalDue = customerInvoices.reduce((a, i) => a + i.amount_due, 0);
    const oldestOverdue = customerInvoices.reduce((m, i) => Math.max(m, i.days_overdue), 0);
    const autoOff = autoDebitOffByCustomer.get(customerId) || false;
    const autoOffWithFailures = autoOff && failedTxs.length > 0;
    const anyInProgress = customerInvoices.some((i) => inProgressInvoiceIds.has(i.invoice_id));

    for (const entityId of entities) {
      out.set(entityId, {
        entity_id: entityId,
        customer_id: customerId,
        unpaid_invoice_count: customerInvoices.length,
        total_amount_due_cents: totalDue,
        days_past_oldest_unpaid: oldestOverdue,
        has_ach_in_progress: anyInProgress,
        auto_debit_off_with_failures: autoOffWithFailures,
        recent_failed_transaction_count: failedTxs.length,
      });
    }
  }
  return out;
}

/**
 * Convert billing metrics → 0-100 risk score for the composite.
 * Sub-components:
 *   - Unpaid invoice count           (40% of signal)
 *   - Days past oldest unpaid        (30%)
 *   - Auto-debit-off-with-failures   (20%)
 *   - Total amount due as % of MRR   (10%)   — TODO: needs plan_amount, deferred
 *
 * ACH in-progress → -15 modifier (payment is on the way).
 */
export function scoreBilling(m: BillingMetrics | null): number {
  if (!m) return 0;

  // Sub-component: unpaid count (40%)
  let unpaidScore = 0;
  if (m.unpaid_invoice_count >= BILLING_THRESHOLDS.unpaidCount.high) unpaidScore = 100;
  else if (m.unpaid_invoice_count >= BILLING_THRESHOLDS.unpaidCount.med) unpaidScore = 70;
  else if (m.unpaid_invoice_count >= BILLING_THRESHOLDS.unpaidCount.low) unpaidScore = 40;

  // Sub-component: days overdue (30%)
  let overdueScore = 0;
  if (m.days_past_oldest_unpaid >= BILLING_THRESHOLDS.daysOverdue.high) overdueScore = 100;
  else if (m.days_past_oldest_unpaid >= BILLING_THRESHOLDS.daysOverdue.med) overdueScore = 70;
  else if (m.days_past_oldest_unpaid >= BILLING_THRESHOLDS.daysOverdue.low) overdueScore = 40;

  // Sub-component: auto-debit off + recent failure (20%) → boolean
  const autoFailScore = m.auto_debit_off_with_failures ? 100 : 0;

  // Base composite (40 + 30 + 20 = 90, leaves 10% for future amt-due/MRR ratio)
  let score = (unpaidScore * 0.4) + (overdueScore * 0.3) + (autoFailScore * 0.2);

  // ACH-in-progress discount
  if (m.has_ach_in_progress) score -= BILLING_THRESHOLDS.achInProgressDiscount;

  return Math.max(0, Math.min(100, Math.round(score)));
}

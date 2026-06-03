/**
 * get_chargebee_billing — Beacon AI tool. Phase F-ai-context L3b.
 *
 * Pulls a customer's billing state from Chargebee:
 *   - customer record (email, name, auto_collection)
 *   - subscriptions (active + recently cancelled)
 *   - last 20 invoices (any status — paid, unpaid, overdue)
 *   - last 20 transactions (success + in-progress + failures)
 *
 * Resolves entity_id → customer_id via the latest snapshot. Then hits the
 * Chargebee API directly with basic auth.
 *
 * READ-ONLY. No approval card. Audit-logged. Per-call rate limit handled
 * upstream by the executor.
 */

import "server-only";
import { readLatestSnapshotV2 } from "@/lib/customer/postgres";
import { logUmbrellaActivity } from "@/lib/activity/log";
import type { BeaconTool, ToolExecutionContext, ToolResult } from "./index";

const CB_SITE = process.env.CHARGEBEE_SITE || "zoca";
const CB_KEY = process.env.CHARGEBEE_API_KEY || "";
const CB_BASE = `https://${CB_SITE}.chargebee.com/api/v2`;
const CB_TIMEOUT_MS = 12_000;

function authHeader() {
  const token = Buffer.from(`${CB_KEY}:`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function cbGet<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  if (!CB_KEY) throw new Error("CHARGEBEE_API_KEY not set");
  const qs = new URLSearchParams(params).toString();
  const url = `${CB_BASE}${path}${qs ? "?" + qs : ""}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CB_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: authHeader(), signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Chargebee ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function fmtUnix(t: number | null | undefined): string | null {
  if (!t || !Number.isFinite(t)) return null;
  return new Date(t * 1000).toISOString();
}

function dollars(cents: number | null | undefined): number {
  if (!cents || !Number.isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

export const getChargebeeBillingTool: BeaconTool = {
  name: "get_chargebee_billing",
  description:
    "Pull a customer's billing state from Chargebee — customer record, subscriptions, last 20 invoices (any status), last 20 transactions. Use when the user asks about billing: 'is X paid up?', 'any failed payments?', 'what's their billing history?', 'why is X disputed?', 'auto-debit status?'. " +
    "Resolves entity_id → Chargebee customer_id via the snapshot. Hits Chargebee live; rate-limited by the executor. " +
    "READ-ONLY tool — no approval card. Reach for this whenever billing comes up.",
  input_schema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description:
          "The customer's entity_id (UUID). Resolve via lookup_customer or from CONTEXT first.",
        minLength: 8,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },

  async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
    const entityId =
      typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    if (!entityId) {
      return { ok: false, error: "entity_id is required" };
    }

    if (!CB_KEY) {
      return { ok: false, error: "CHARGEBEE_API_KEY not configured" };
    }

    try {
      // Step 1 — resolve entity_id → Chargebee customer_id from the snapshot.
      const snap = await readLatestSnapshotV2();
      const customer = snap?.customers?.find((c) => c.entity_id === entityId);
      if (!customer) {
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} not on the active book — Chargebee handle is unknown.`,
          data: { entity_id: entityId, found: false },
        };
      }
      const cbCustomerId = customer.customer_id;
      if (!cbCustomerId) {
        return {
          ok: true,
          summary: `Entity ${entityId.slice(0, 8)} (${customer.company ?? "?"}) has no Chargebee customer_id on the snapshot row.`,
          data: { entity_id: entityId, found: false, bizname: customer.company ?? null },
        };
      }

      // Step 2 — pull customer + subs + invoices + transactions in parallel.
      const [custRes, subsRes, invRes, txnRes] = await Promise.all([
        cbGet<{ customer: Record<string, unknown> }>(`/customers/${cbCustomerId}`),
        cbGet<{ list: Array<{ subscription: Record<string, unknown> }> }>(
          `/subscriptions`,
          { "customer_id[is]": cbCustomerId, limit: "20" },
        ),
        cbGet<{ list: Array<{ invoice: Record<string, unknown> }> }>(`/invoices`, {
          "customer_id[is]": cbCustomerId,
          limit: "20",
          "sort_by[desc]": "date",
        }),
        cbGet<{ list: Array<{ transaction: Record<string, unknown> }> }>(
          `/transactions`,
          { "customer_id[is]": cbCustomerId, limit: "20", "sort_by[desc]": "date" },
        ),
      ]);

      const cust = custRes.customer as {
        id: string;
        email?: string;
        first_name?: string;
        last_name?: string;
        company?: string;
        auto_collection?: string;
        phone?: string;
        net_term_days?: number;
        created_at?: number;
      };

      const subs = (subsRes.list ?? []).map(({ subscription: s }) => {
        const sub = s as {
          id: string;
          status: string;
          plan_id?: string;
          plan_amount?: number;
          mrr?: number;
          activated_at?: number;
          cancelled_at?: number;
          current_term_end?: number;
          auto_collection?: string;
        };
        return {
          subscription_id: sub.id,
          status: sub.status,
          plan: sub.plan_id ?? null,
          plan_amount: dollars(sub.plan_amount),
          mrr: dollars(sub.mrr),
          activated_at: fmtUnix(sub.activated_at),
          cancelled_at: fmtUnix(sub.cancelled_at),
          current_term_end: fmtUnix(sub.current_term_end),
          auto_collection: sub.auto_collection ?? null,
        };
      });

      const invoices = (invRes.list ?? []).map(({ invoice: i }) => {
        const inv = i as {
          id: string;
          status: string;
          amount_due?: number;
          amount_paid?: number;
          total?: number;
          date?: number;
          due_date?: number;
          paid_at?: number;
        };
        const dueMs = inv.due_date ? inv.due_date * 1000 : null;
        const daysOverdue =
          dueMs && inv.status !== "paid"
            ? Math.max(0, Math.floor((Date.now() - dueMs) / (24 * 60 * 60 * 1000)))
            : 0;
        return {
          invoice_id: inv.id,
          status: inv.status,
          total: dollars(inv.total),
          amount_due: dollars(inv.amount_due),
          amount_paid: dollars(inv.amount_paid),
          date: fmtUnix(inv.date),
          due_date: fmtUnix(inv.due_date),
          paid_at: fmtUnix(inv.paid_at),
          days_overdue: daysOverdue,
        };
      });

      const transactions = (txnRes.list ?? []).map(({ transaction: t }) => {
        const txn = t as {
          id: string;
          status: string;
          type?: string;
          amount?: number;
          date?: number;
          error_code?: string;
          error_text?: string;
          linked_invoices?: Array<{ invoice_id: string }>;
        };
        return {
          transaction_id: txn.id,
          status: txn.status,
          type: txn.type ?? null,
          amount: dollars(txn.amount),
          date: fmtUnix(txn.date),
          error_code: txn.error_code ?? null,
          error_text: txn.error_text ?? null,
          linked_invoice_ids:
            txn.linked_invoices?.map((l) => l.invoice_id) ?? [],
        };
      });

      const unpaid = invoices.filter((i) => i.status !== "paid" && i.amount_due > 0);
      const totalUnpaid = unpaid.reduce((s, i) => s + i.amount_due, 0);
      const failedTxns = transactions.filter((t) => t.status === "failure");
      const activeSub = subs.find((s) => s.status === "active") ?? null;

      const summary =
        `${customer.company ?? cbCustomerId} (${cbCustomerId}): ` +
        `${activeSub ? `active sub $${activeSub.mrr}/mo` : "no active sub"}, ` +
        `auto_collection=${cust.auto_collection ?? "?"}, ` +
        `${unpaid.length} unpaid invoice${unpaid.length === 1 ? "" : "s"} ($${totalUnpaid.toFixed(2)} due), ` +
        `${failedTxns.length} failed txn${failedTxns.length === 1 ? "" : "s"} in last 20.`;

      void logUmbrellaActivity({
        email: ctx.amEmail,
        role: ctx.role,
        am_name: ctx.amName,
        agent: "customer",
        event_name: "beacon_ai:action:get_chargebee_billing",
        surface: "customer-360",
        entity_id: entityId,
        metadata: {
          tool: "get_chargebee_billing",
          customer_id: cbCustomerId,
          unpaid_count: unpaid.length,
          unpaid_total: totalUnpaid,
          failed_txn_count: failedTxns.length,
        },
      });

      return {
        ok: true,
        summary,
        data: {
          entity_id: entityId,
          customer_id: cbCustomerId,
          bizname: customer.company ?? null,
          customer: {
            email: cust.email ?? null,
            first_name: cust.first_name ?? null,
            last_name: cust.last_name ?? null,
            phone: cust.phone ?? null,
            auto_collection: cust.auto_collection ?? null,
            net_term_days: cust.net_term_days ?? null,
            created_at: fmtUnix(cust.created_at),
          },
          subscriptions: subs,
          invoices,
          transactions,
          summary_stats: {
            unpaid_count: unpaid.length,
            unpaid_total_usd: totalUnpaid,
            failed_txn_count_last_20: failedTxns.length,
            has_active_sub: !!activeSub,
          },
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Chargebee fetch failed: ${msg}` };
    }
  },
};

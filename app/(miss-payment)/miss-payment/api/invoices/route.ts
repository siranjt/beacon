/**
 * Miss Payment Beacon — GET /miss-payment/api/invoices
 *
 * Streams unpaid invoice rows as NDJSON. Two phases:
 *  1. `partial` — invoices + ACH transactions + BaseSheet + tickets,
 *     no per-customer Chargebee details yet. Lands in ~2-3s.
 *  2. `complete` — full rows with auto-debit / first-name / email /
 *     subscription status / cancellation date merged in.
 *
 * Cache hit (5 min by default, override via INVOICES_CACHE_TTL) emits
 * a single `complete` line and closes immediately. `?refresh=1` busts
 * the cache.
 *
 * Each line is JSON: `{ type: "partial" | "complete" | "error", ... }`.
 *
 * Auth: requires admin or manager role (via api-auth.ts). AMs are not
 * granted access since the missed-invoice view is a Finance-ops surface
 * — line-level rep involvement happens via the annotations API.
 */

import { NextRequest } from "next/server";
import {
  fetchOpenInvoices,
  fetchInProgressTransactions,
  fetchCustomers,
  fetchSubscriptions,
} from "@/lib/miss-payment/chargebee";
import { fetchBaseSheet, indexBaseSheet } from "@/lib/miss-payment/basesheet";
import {
  fetchActiveTickets,
  indexTicketsByEntity,
  type Ticket,
} from "@/lib/miss-payment/tickets";
import { buildInvoiceRows } from "@/lib/miss-payment/enrich";
import type { InvoicesResponse } from "@/lib/miss-payment/types";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const TTL_MS = Number(process.env.INVOICES_CACHE_TTL || 300) * 1000;

let cache: { data: InvoicesResponse; ts: number } | null = null;

export async function GET(req: NextRequest) {
  // Allow the cron warmer (bearer auth) to refresh without a session by
  // checking for the CRON_SECRET header before falling back to the
  // session-based gate. Same dual-auth pattern as Customer Beacon's
  // cron-triggered routes.
  const cronAuth = req.headers.get("authorization") || "";
  const cronSecret = process.env.CRON_SECRET;
  const isCronCaller = !!cronSecret && cronAuth === `Bearer ${cronSecret}`;

  if (!isCronCaller) {
    const user = await getApiUser();
    const denied = requireRole(user, "admin", "manager");
    if (denied) return denied;
  }

  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const now = Date.now();

  const enc = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, obj: unknown) => {
    controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
  };

  // Cache hit — emit a single `complete` line and close.
  if (!refresh && cache && now - cache.ts < TTL_MS) {
    const stream = new ReadableStream({
      start(controller) {
        send(controller, { type: "complete", ...cache!.data, cached: true });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // Cache miss / refresh — stream partial then complete.
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Phase 0 — invoices + transactions + BaseSheet + Linear tickets in parallel.
        // Linear is fault-tolerant: if it errors (timeout, schema change,
        // missing question), we skip ticket enrichment rather than fail
        // the whole pipeline.
        const [invoices, achTx, baseRows, tickets] = await Promise.all([
          fetchOpenInvoices(),
          fetchInProgressTransactions(),
          fetchBaseSheet(),
          fetchActiveTickets().catch((e) => {
            console.warn("[miss-payment] tickets fetch failed:", e?.message || e);
            return [] as Ticket[];
          }),
        ]);
        const baseSheet = indexBaseSheet(baseRows);
        const ticketsByEntity = indexTicketsByEntity(tickets);

        console.log(
          `[miss-payment] tickets fetched=${tickets.length} indexed_entities=${ticketsByEntity.size}`,
        );

        // Phase 1 — emit partial rows enriched from BaseSheet + tickets.
        const partial = buildInvoiceRows({
          invoices,
          customers: {},
          subs: {},
          achTransactions: achTx,
          baseSheet,
          ticketsByEntity,
        });
        send(controller, { type: "partial", rows: partial });

        // Phase 2 — per-customer and per-subscription Chargebee calls
        // (batched concurrent fetches — see chunked() in chargebee.ts).
        const customerIds = invoices.map((i: any) => i.customer_id).filter(Boolean);
        const subIds = invoices.map((i: any) => i.subscription_id).filter(Boolean);
        const [customers, subs] = await Promise.all([
          fetchCustomers(customerIds),
          fetchSubscriptions(subIds),
        ]);

        const rows = buildInvoiceRows({
          invoices,
          customers,
          subs,
          achTransactions: achTx,
          baseSheet,
          ticketsByEntity,
        });

        const fetchedAt = new Date().toISOString();
        cache = { data: { rows, fetchedAt, cached: false }, ts: Date.now() };

        send(controller, { type: "complete", rows, fetchedAt, cached: false });
      } catch (e: any) {
        send(controller, { type: "error", error: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Hint to proxies (Vercel etc.) not to buffer.
      "X-Accel-Buffering": "no",
    },
  });
}

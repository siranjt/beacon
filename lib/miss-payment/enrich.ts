/**
 * Miss Payment Beacon — invoice row builder.
 *
 * Joins Chargebee invoices to:
 *  - ACH in-progress transactions (for "ACH status")
 *  - Per-customer Chargebee details (auto-debit, first name, email)
 *  - Per-subscription details (status, cancellation date)
 *  - BaseSheet entity/AM/phone mapping (entity_id, bizname, am_name,
 *    phone_number, app_email fallback)
 *  - Active Linear tickets keyed by entity_id (most-recent only)
 *
 * Output sorted by invoice date desc, then amount desc.
 */

import "server-only";
import type { InvoiceRow, InvoiceStatus, LatestTicket } from "./types";
import type { Ticket } from "./tickets";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(unix?: number) {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return MONTH_NAMES[d.getUTCMonth()];
}

function dateLabel(unix?: number) {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return `${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function buildInvoiceRows(args: {
  invoices: any[];
  customers: Record<string, any>;
  subs: Record<string, any>;
  achTransactions: any[];
  baseSheet: { byCustomerId: Map<string, any>; byEntityId: Map<string, any> };
  /** Map<entity_id (lowercased), Ticket> — most-recent active ticket per entity. */
  ticketsByEntity?: Map<string, Ticket>;
}): InvoiceRow[] {
  const { invoices, customers, subs, achTransactions, baseSheet, ticketsByEntity } = args;

  const achInvoiceIds = new Set<string>();
  for (const tx of achTransactions) {
    const t = tx.transaction || tx;
    const li = t?.linked_invoices || [];
    for (const link of li) {
      if (link?.invoice_id) achInvoiceIds.add(link.invoice_id);
    }
  }

  const rows: InvoiceRow[] = invoices.map((inv) => {
    const customerId = inv.customer_id || "";
    const subId = inv.subscription_id || "";
    const customer = customers[customerId] || {};
    const sub = subs[subId] || {};
    const bs = baseSheet.byCustomerId.get(customerId) || {};

    const amountDue = (inv.amount_due ?? 0) / 100;
    const status = (inv.status as InvoiceStatus) || "payment_due";

    const cancellingAt = sub?.cancelled_at
      ? dateLabel(sub.cancelled_at)
      : sub?.cancel_schedule_created_at
      ? dateLabel(sub.cancel_schedule_created_at)
      : "";

    const autoDebit = (() => {
      if (typeof customer.auto_collection === "string") {
        return customer.auto_collection === "on" ? "On" : "Off";
      }
      return "";
    })();

    const entityId = bs.entity_id || "";
    const ticket = ticketsByEntity && entityId
      ? ticketsByEntity.get(entityId.toLowerCase())
      : undefined;
    const latestTicket: LatestTicket | undefined = ticket
      ? { id: ticket.identifier, title: ticket.title, url: ticket.url }
      : undefined;

    return {
      customerId,
      entityId,
      bizName: bs.bizname || customer.company || "",
      amName: bs.am_name || "",
      subscriptionStatus: sub?.status || "",
      cancellingAt,
      invoiceNumber: inv.id || "",
      achStatus: achInvoiceIds.has(inv.id) ? "In Progress" : "",
      autoDebit,
      invoiceDate: dateLabel(inv.date),
      invoiceMonth: monthLabel(inv.date),
      customerFirstName: customer.first_name || "",
      customerEmail: customer.email || bs.app_email || "",
      phoneNumber: bs.phone_number || customer.phone || "",
      customerCompany: customer.company || bs.bizname || "",
      amountDue,
      status,
      latestTicket,
    };
  });

  rows.sort((a, b) => {
    const da = new Date(a.invoiceDate).getTime() || 0;
    const db = new Date(b.invoiceDate).getTime() || 0;
    if (db !== da) return db - da;
    return b.amountDue - a.amountDue;
  });

  return rows;
}

export function multiMonthCustomerIds(rows: InvoiceRow[]): Set<string> {
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.entityId || r.customerId;
    if (!key) continue;
    if (!map.has(key)) map.set(key, new Set());
    if (r.invoiceMonth) map.get(key)!.add(r.invoiceMonth);
  }
  const ids = new Set<string>();
  for (const [k, set] of map) if (set.size >= 2) ids.add(k);
  return ids;
}

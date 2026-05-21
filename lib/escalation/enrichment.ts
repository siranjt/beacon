// Pulls together a CustomerContext from a hint (id / email / business name)
// or, failing that, by scraping the escalation text.

import type { CustomerContext, EscalationInput } from "./types";
import {
  findCustomerByEmail,
  getActiveSubscription,
  getCustomer,
  getUnpaidInvoices,
  markInProgressACH,
} from "./chargebee";
import { fetchCommsForEntity, findBaseSheetRow } from "./metabase";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function num(s?: string): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function deriveSignals(ctx: CustomerContext): string[] {
  const signals: string[] = [];
  if (ctx.unpaidInvoices.length) {
    const total = ctx.unpaidInvoices.reduce((a, b) => a + b.amountDue, 0);
    signals.push(`${ctx.unpaidInvoices.length} unpaid invoice(s), $${total.toFixed(2)} due`);
    if (ctx.unpaidInvoices.some((i) => i.ach === "in_progress")) {
      signals.push("ACH attempt in progress for at least one invoice");
    }
  }
  if (ctx.subscription?.status && ctx.subscription.status !== "active") {
    signals.push(`Subscription status: ${ctx.subscription.status}`);
  }
  if (ctx.subscription?.autoCollection === "off") {
    signals.push("Auto-debit is OFF");
  }
  if (ctx.subscription?.cancellingAt) {
    signals.push(`Subscription cancelling at ${ctx.subscription.cancellingAt}`);
  }
  if (ctx.customer.churnDate) {
    signals.push(`Churn date on file: ${ctx.customer.churnDate}`);
  }
  // Comms volume signals
  const last30 = ctx.recentComms.filter(
    (m) => Date.parse(m.createdAt) > Date.now() - 30 * 24 * 3600 * 1000
  );
  if (last30.length === 0) signals.push("No comms in the last 30 days");
  else signals.push(`${last30.length} message(s) across all channels in last 30 days`);

  const clientLast30 = last30.filter((m) => m.sender === "client").length;
  const teamLast30 = last30.filter((m) => m.sender === "team").length;
  if (clientLast30 > 5 && teamLast30 < clientLast30 / 2) {
    signals.push("Client outpacing team replies (possible neglect)");
  }
  return signals;
}

export async function buildContext(input: EscalationInput): Promise<CustomerContext> {
  const lookupNotes: string[] = [];
  const hint = input.customerHint || {};

  // 1. Try BaseSheet to resolve {entityId, customerId, AM, etc.}
  let baseRow = await findBaseSheetRow(hint);
  if (!baseRow && !hint.email) {
    const m = input.text.match(EMAIL_RE);
    if (m) {
      baseRow = await findBaseSheetRow({ email: m[0] });
      if (baseRow) lookupNotes.push(`Resolved customer via email "${m[0]}" found in escalation text.`);
    }
  }

  let customerId = hint.customerId || baseRow?.customer_id || "";
  let entityId = hint.entityId || baseRow?.entity_id || "";

  // 2. If we still have no Chargebee customerId but have an email, try Chargebee directly.
  if (!customerId && (hint.email || input.text.match(EMAIL_RE))) {
    const email = hint.email || input.text.match(EMAIL_RE)![0];
    const cb = await findCustomerByEmail(email);
    if (cb) {
      customerId = cb.id;
      lookupNotes.push(`Resolved Chargebee customer by email "${email}".`);
    }
  }

  if (!customerId && !entityId) {
    lookupNotes.push("Could not resolve to a known Chargebee customer or Zoca entity. Returning text-only context.");
    return {
      customer: { email: hint.email, bizName: hint.bizName },
      unpaidInvoices: [],
      recentComms: [],
      signals: ["Customer not identified — agent will rely on the message text alone."],
      lookupNotes,
    };
  }

  // 3. Pull Chargebee details + invoices + active subscription in parallel.
  const [cbCustomer, sub, invoicesRaw] = await Promise.all([
    customerId ? getCustomer(customerId) : Promise.resolve(null),
    customerId ? getActiveSubscription(customerId) : Promise.resolve(undefined),
    customerId ? getUnpaidInvoices(customerId) : Promise.resolve([]),
  ]);
  const invoices = await markInProgressACH(invoicesRaw);

  // 4. Comms history (last 90 days, all channels) — only if we have entityId.
  // The agent endpoint runs under tighter latency than the history view, so
  // we cap per-channel at 25 messages and 12s timeout per channel.
  const recentComms = entityId
    ? (
        await fetchCommsForEntity(entityId, {
          sinceDays: 90,
          perChannelLimit: 25,
          perChannelTimeoutMs: 12000,
        })
      ).messages
    : [];

  const ctx: CustomerContext = {
    customer: {
      customerId: customerId || undefined,
      entityId: entityId || undefined,
      bizName: baseRow?.bizname || cbCustomer?.company || hint.bizName,
      firstName: cbCustomer?.first_name,
      lastName: cbCustomer?.last_name,
      email: cbCustomer?.email || baseRow?.app_email || hint.email,
      phone: cbCustomer?.phone || baseRow?.phone_number,
      amName: baseRow?.am_name,
      spName: baseRow?.sp_name,
      aeName: baseRow?.ae_name,
      status: baseRow?.chrone_zoca_status,
      churnDate: baseRow?.churn_date,
      totalMonthlyRevenue: num(baseRow?.total_monthly_revenue),
    },
    subscription: sub || (cbCustomer
      ? { autoCollection: cbCustomer.auto_collection }
      : undefined),
    unpaidInvoices: invoices,
    recentComms,
    signals: [],
    lookupNotes,
  };
  ctx.signals = deriveSignals(ctx);
  return ctx;
}

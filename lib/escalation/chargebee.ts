// Thin Chargebee REST client. We avoid the official SDK to keep the bundle
// small and to control timeouts on Vercel serverless.

import type { InvoiceState, SubscriptionState } from "./types";

const SITE = process.env.CHARGEBEE_SITE || "zoca";
const API_KEY = process.env.CHARGEBEE_API_KEY || "";

function authHeader(): string {
  // Chargebee uses HTTP basic with the API key as the username, blank password.
  const token = Buffer.from(`${API_KEY}:`).toString("base64");
  return `Basic ${token}`;
}

function baseUrl(): string {
  return `https://${SITE}.chargebee.com/api/v2`;
}

async function cbGet(path: string, params: Record<string, string> = {}): Promise<any> {
  if (!API_KEY) throw new Error("CHARGEBEE_API_KEY is not set");
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
    },
    // Vercel serverless has its own timeout; keep client-side simple.
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chargebee ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export interface CbCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  auto_collection?: "on" | "off";
  created_at?: number;
}

export async function findCustomerByEmail(email: string): Promise<CbCustomer | null> {
  const data = await cbGet("/customers", { "email[is]": email, limit: "1" });
  const list: any[] = data.list || [];
  if (!list.length) return null;
  return list[0].customer as CbCustomer;
}

export async function getCustomer(customerId: string): Promise<CbCustomer | null> {
  try {
    const data = await cbGet(`/customers/${encodeURIComponent(customerId)}`);
    return data.customer as CbCustomer;
  } catch (e) {
    return null;
  }
}

export async function getActiveSubscription(customerId: string): Promise<SubscriptionState | undefined> {
  const data = await cbGet("/subscriptions", {
    "customer_id[is]": customerId,
    "status[in]": '["active","non_renewing","paused","in_trial","future"]',
    limit: "1",
    "sort_by[desc]": "created_at",
  });
  const sub = (data.list || [])[0]?.subscription;
  if (!sub) return undefined;
  return {
    subscriptionId: sub.id,
    status: sub.status,
    cancellingAt: sub.cancelled_at ? new Date(sub.cancelled_at * 1000).toISOString() : undefined,
    autoCollection: sub.auto_collection,
    planId: sub.plan_id || sub.subscription_items?.[0]?.item_price_id,
    mrr: typeof sub.mrr === "number" ? sub.mrr / 100 : undefined,
  };
}

export async function getUnpaidInvoices(customerId: string): Promise<InvoiceState[]> {
  const data = await cbGet("/invoices", {
    "customer_id[is]": customerId,
    "status[in]": '["payment_due","not_paid"]',
    limit: "20",
    "sort_by[desc]": "date",
  });
  const list: any[] = data.list || [];
  return list.map((row) => {
    const inv = row.invoice;
    return {
      invoiceId: inv.id,
      status: inv.status,
      amountDue: (inv.amount_due ?? 0) / 100,
      date: inv.date ? new Date(inv.date * 1000).toISOString() : "",
      dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : undefined,
      ach: "none",
    } as InvoiceState;
  });
}

export async function markInProgressACH(invoices: InvoiceState[]): Promise<InvoiceState[]> {
  if (!invoices.length) return invoices;
  const data = await cbGet("/transactions", {
    "status[is]": "in_progress",
    limit: "100",
    "sort_by[desc]": "date",
  });
  const inProgressInvoiceIds = new Set<string>();
  for (const row of data.list || []) {
    const t = row.transaction;
    for (const linked of t.linked_invoices || []) {
      if (linked.invoice_id) inProgressInvoiceIds.add(linked.invoice_id);
    }
  }
  return invoices.map((inv) =>
    inProgressInvoiceIds.has(inv.invoiceId) ? { ...inv, ach: "in_progress" as const } : inv
  );
}

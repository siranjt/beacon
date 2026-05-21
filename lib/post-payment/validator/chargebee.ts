/**
 * Chargebee REST client — minimal subset needed by the validator.
 * All calls auth via HTTP Basic with API key as username.
 */

const SITE = process.env.CHARGEBEE_SITE ?? "zoca";
const KEY = process.env.CHARGEBEE_API_KEY ?? "";
const BASE = `https://${SITE}.chargebee.com/api/v2`;

function authHeader() {
  return "Basic " + Buffer.from(KEY + ":").toString("base64");
}

async function get(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { authorization: authHeader() },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`chargebee ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function getCustomer(customerId: string): Promise<any> {
  const data = await get(`/customers/${customerId}`);
  return data.customer;
}

export async function listSubscriptionsForCustomer(customerId: string): Promise<any[]> {
  const data = await get(`/subscriptions`, { "customer_id[is]": customerId, limit: 100, "sort_by[asc]": "created_at" });
  return (data.list ?? []).map((e: any) => e.subscription);
}

export async function listInvoicesForSubscription(subId: string): Promise<any[]> {
  const data = await get(`/invoices`, { "subscription_id[is]": subId, limit: 20, "sort_by[asc]": "date" });
  return (data.list ?? []).map((e: any) => e.invoice);
}

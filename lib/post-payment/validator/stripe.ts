/**
 * Stripe REST client — read-only customer lookup by email.
 * Falls back from /customers/search → /customers?email=… if the restricted key
 * lacks the search scope.
 */

const KEY = process.env.STRIPE_API_KEY ?? "";
const BASE = "https://api.stripe.com/v1";

async function get(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${KEY}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`stripe ${path} ${res.status}: ${body.slice(0, 200)}`) as any;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function findCustomerByEmail(email: string): Promise<any | null> {
  if (!email) return null;
  try {
    const data = await get(`/customers/search`, { query: `email:'${email}'`, limit: 5 });
    const items = data.data ?? [];
    if (!items.length) return null;
    items.sort((a: any, b: any) => (a.created ?? 0) - (b.created ?? 0));
    return items[0];
  } catch (e: any) {
    if (e.status === 403) {
      const data = await get(`/customers`, { email, limit: 5 });
      const items = data.data ?? [];
      return items[0] ?? null;
    }
    throw e;
  }
}

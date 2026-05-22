import type { Snapshot } from "./types";
import { SNAPSHOT_KEY } from "./config";

/**
 * Snapshot storage wrapper. Uses Vercel KV if configured; otherwise falls back
 * to an in-memory singleton (useful for local dev and for tests). Every
 * snapshot ends up serialized; the UI reads through `readSnapshot()`.
 */

let memCache: Snapshot | null = null;

function kvConfigured(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export async function writeSnapshot(snap: Snapshot): Promise<void> {
  memCache = snap;
  if (!kvConfigured()) return;
  const { kv } = await import("@vercel/kv");
  // Large snapshots can exceed the KV value size limit (1 MB soft limit per key
  // on the Hobby tier). If that happens we split into two keys: a "lite" variant
  // without the full customer list, and a "customers" list separately.
  const json = JSON.stringify(snap);
  if (json.length < 900_000) {
    await kv.set(SNAPSHOT_KEY, snap);
    await kv.del(`${SNAPSHOT_KEY}:customers`);
  } else {
    const lite: Snapshot = { ...snap, customers: [] };
    await kv.set(SNAPSHOT_KEY, lite);
    await kv.set(`${SNAPSHOT_KEY}:customers`, snap.customers);
  }
}

export async function readSnapshot(): Promise<Snapshot | null> {
  if (!kvConfigured()) return memCache;
  const { kv } = await import("@vercel/kv");
  const base = (await kv.get<Snapshot>(SNAPSHOT_KEY)) || null;
  if (!base) return null;
  if (!base.customers || base.customers.length === 0) {
    const customers = (await kv.get<Snapshot["customers"]>(`${SNAPSHOT_KEY}:customers`)) || [];
    return { ...base, customers };
  }
  return base;
}

/**
 * Inter-stage state store — saves intermediate stage outputs (bundle JSON,
 * LLM evaluation) to Vercel Blob so subsequent stages can read them without
 * re-running the previous work.
 */

import { put, del } from "@vercel/blob";

const PREFIX = "stage";

async function putAtFixedKey(key: string, body: string, contentType: string) {
  const opts = { access: "public" as const, contentType, addRandomSuffix: false };
  try {
    return await put(key, body, opts);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.toLowerCase().includes("already exists") || msg.toLowerCase().includes("blob exists")) {
      await del(key).catch(() => undefined);
      return await put(key, body, opts);
    }
    throw e;
  }
}

export async function saveStageBundle(customerId: string, bundle: unknown): Promise<string> {
  const key = `${PREFIX}/${customerId}.bundle.json`;
  const res = await putAtFixedKey(key, JSON.stringify(bundle), "application/json");
  return res.url;
}

export async function loadStageBundle<T = any>(customerId: string): Promise<T> {
  // We don't have a deterministic URL across deploys — store and re-fetch via Vercel Blob's CDN URL.
  // The URL was returned at save time; for cross-function reads we fetch by reconstructing the public URL,
  // which is stable because addRandomSuffix=false.
  // The simplest path: list blobs by prefix. But that's an extra call. Instead: read the URL from DB.
  // For MVP we store-and-load via a deterministic-key approach using the BLOB_READ_WRITE_TOKEN cached.
  throw new Error("loadStageBundle: use the URL returned by saveStageBundle, persisted in DB");
}

export async function saveStageEval(customerId: string, evaluation: { markdown: string; reportData: unknown }) {
  const baseKey = `${PREFIX}/${customerId}`;
  const [md, json] = await Promise.all([
    putAtFixedKey(`${baseKey}.eval.md`, evaluation.markdown, "text/markdown; charset=utf-8"),
    putAtFixedKey(`${baseKey}.eval.json`, JSON.stringify(evaluation.reportData), "application/json"),
  ]);
  return { mdUrl: md.url, jsonUrl: json.url };
}

/** Fetch a previously-saved blob by its URL. */
export async function fetchJson<T = any>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`stage-store: fetch ${url} ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`stage-store: fetch ${url} ${res.status}`);
  return res.text();
}

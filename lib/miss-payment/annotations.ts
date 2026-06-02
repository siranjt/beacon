/**
 * Miss Payment Beacon — invoice annotations store.
 *
 * Persists manual edits (caller, connection status, comments) per
 * invoice number into the `miss_payment_annotations` Postgres table
 * (see migrations/2026-06-02-miss-payment-annotations.sql).
 *
 * Reuses the umbrella's shared Neon client. The standalone tracker
 * had a filesystem fallback for local-dev-without-DATABASE_URL — we
 * drop that here. Local dev always points at a real Postgres in the
 * umbrella; Vercel auto-injects DATABASE_URL/POSTGRES_URL.
 */

import "server-only";
import { neon } from "@neondatabase/serverless";
import type { AnnotationsMap, InvoiceAnnotation } from "./types";

function getDbUrl(): string | null {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    null
  );
}

let _sql: ReturnType<typeof neon> | null = null;
function getSql() {
  if (_sql) return _sql;
  const url = getDbUrl();
  if (!url) return null;
  _sql = neon(url);
  return _sql;
}

export async function getAllAnnotations(): Promise<AnnotationsMap> {
  const sql = getSql();
  if (!sql) return {};
  const rows = (await sql`
    SELECT invoice_number, data FROM miss_payment_annotations
  `) as { invoice_number: string; data: InvoiceAnnotation }[];
  const out: AnnotationsMap = {};
  for (const r of rows) out[r.invoice_number] = r.data || {};
  return out;
}

export async function setAnnotation(invoiceNumber: string, patch: InvoiceAnnotation) {
  const sql = getSql();
  if (!sql) {
    // No DB URL — refuse silently rather than scribbling to a tmpfile that
    // disappears on next deploy. Caller surfaces a 500 if it cares.
    throw new Error("POSTGRES_URL not set — annotations cannot be persisted");
  }
  const rows = (await sql`
    SELECT data FROM miss_payment_annotations WHERE invoice_number = ${invoiceNumber}
  `) as { data: InvoiceAnnotation }[];
  const existing: InvoiceAnnotation = rows[0]?.data || {};
  const merged: InvoiceAnnotation = { ...existing, ...patch };
  await sql`
    INSERT INTO miss_payment_annotations (invoice_number, data, updated_at)
    VALUES (${invoiceNumber}, ${JSON.stringify(merged)}::jsonb, now())
    ON CONFLICT (invoice_number)
    DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
  return merged;
}

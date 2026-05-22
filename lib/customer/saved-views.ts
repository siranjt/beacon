import { getSql } from "./postgres";

/**
 * Phase 18.C: per-AM saved filter/search/sort combinations.
 *
 * A "saved view" captures the active filter pill + search query + sort
 * dropdown on V2AMTriage so AMs can return to a familiar slice of their
 * book with one click. Keyed on (am_name, name) — duplicate-name attempts
 * surface as a conflict result so the API can return HTTP 409.
 *
 * Self-heals via ensureViewsSchema() — CREATE TABLE IF NOT EXISTS runs
 * once per cold start, gated by the _viewsReady cached boolean. Mirrors
 * the lazy-migration pattern used by lib/pinned-customers.ts (Phase 18.A)
 * and lib/customer-notes.ts (Phase 18.B).
 */

export type SavedView = {
  id: number;
  name: string;
  filter_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CreateViewResult =
  | { ok: true; view: SavedView }
  | { ok: false; conflict: true }
  | { ok: false; error: string };

let _viewsReady = false;

async function ensureViewsSchema(): Promise<boolean> {
  if (_viewsReady) return true;
  const sql = getSql();
  if (!sql) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS saved_views (
      id SERIAL PRIMARY KEY,
      am_name TEXT NOT NULL,
      name TEXT NOT NULL,
      filter_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(am_name, name)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_saved_views_am ON saved_views(am_name)`;
  _viewsReady = true;
  return true;
}

function rowToView(r: {
  id: number;
  name: string;
  filter_config: Record<string, unknown> | string | null;
  created_at: string | Date;
  updated_at: string | Date;
}): SavedView {
  const cfg =
    typeof r.filter_config === "string"
      ? (JSON.parse(r.filter_config) as Record<string, unknown>)
      : r.filter_config && typeof r.filter_config === "object"
        ? r.filter_config
        : {};
  return {
    id: Number(r.id),
    name: r.name,
    filter_config: cfg,
    created_at:
      typeof r.created_at === "string"
        ? r.created_at
        : r.created_at.toISOString(),
    updated_at:
      typeof r.updated_at === "string"
        ? r.updated_at
        : r.updated_at.toISOString(),
  };
}

/** List all saved views for an AM, oldest first (stable pill order). */
export async function listViews(amName: string): Promise<SavedView[]> {
  const ready = await ensureViewsSchema();
  if (!ready) return [];
  const sql = getSql();
  if (!sql) return [];
  const rows = await sql`
    SELECT id, name, filter_config, created_at, updated_at
    FROM saved_views
    WHERE am_name = ${amName}
    ORDER BY created_at ASC
  `;
  return (rows as Array<Parameters<typeof rowToView>[0]>).map(rowToView);
}

/**
 * Insert a new saved view for an AM. Duplicate-name attempts surface as
 * { ok: false, conflict: true } so the API layer can return HTTP 409.
 */
export async function createView(
  amName: string,
  name: string,
  filterConfig: Record<string, unknown>,
): Promise<CreateViewResult> {
  const ready = await ensureViewsSchema();
  if (!ready) {
    return {
      ok: false,
      error:
        "POSTGRES_URL not configured — cannot persist saved view",
    };
  }
  const sql = getSql();
  if (!sql) {
    return {
      ok: false,
      error:
        "POSTGRES_URL not configured — cannot persist saved view",
    };
  }
  try {
    const rows = await sql`
      INSERT INTO saved_views (am_name, name, filter_config)
      VALUES (${amName}, ${name}, ${JSON.stringify(filterConfig)}::jsonb)
      RETURNING id, name, filter_config, created_at, updated_at
    `;
    const row = (rows as Array<Parameters<typeof rowToView>[0]>)[0];
    return { ok: true, view: rowToView(row) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("duplicate key") ||
      msg.toLowerCase().includes("unique")
    ) {
      return { ok: false, conflict: true };
    }
    return { ok: false, error: msg };
  }
}

/** Delete a saved view by (am_name, id). No-op if not found. */
export async function deleteView(
  amName: string,
  viewId: number,
): Promise<{ ok: boolean }> {
  const ready = await ensureViewsSchema();
  if (!ready) return { ok: false };
  const sql = getSql();
  if (!sql) return { ok: false };
  await sql`
    DELETE FROM saved_views
    WHERE am_name = ${amName} AND id = ${viewId}
  `;
  return { ok: true };
}

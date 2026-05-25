/**
 * Activity log admin viewer endpoint. Phase E-9.
 *
 * GET /api/admin/activity
 *
 * Read-only paginated query over the `am_activity_log` table with filters
 * for user / agent / event / surface / time range. Admin role only.
 *
 * Filters are passed as a single JSONB blob so we stay under the neon
 * tagged-template arity limit. From/to bounds + limit/offset are still
 * individual placeholders.
 *
 * Query params (all optional):
 *   user      — exact email match (case-insensitive)
 *   agent     — customer | performance | escalation | post-payment | umbrella
 *   event     — exact event_name
 *   surface   — exact surface
 *   from      — ISO date/datetime, inclusive lower bound (default: 30d ago)
 *   to        — ISO date/datetime, exclusive upper bound (default: none)
 *   page      — 1-indexed (default 1)
 *   limit     — page size, max 500 (default 50)
 *   format    — "json" (default) | "csv" — CSV ignores pagination, caps at 500 rows
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSql } from "@/lib/customer/postgres";
import { getRoleForEmail } from "@/lib/customer/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const VALID_AGENTS = new Set([
  "customer",
  "performance",
  "escalation",
  "post-payment",
  "umbrella",
]);

interface ActivityRow {
  id: number;
  ts: string;
  email: string;
  role: string | null;
  am_name: string | null;
  agent: string;
  event_name: string;
  surface: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows: ActivityRow[]): string {
  const header = [
    "ts",
    "email",
    "role",
    "am_name",
    "agent",
    "event_name",
    "surface",
    "entity_id",
    "metadata",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.ts,
        r.email,
        r.role ?? "",
        r.am_name ?? "",
        r.agent,
        r.event_name,
        r.surface ?? "",
        r.entity_id ?? "",
        r.metadata ? JSON.stringify(r.metadata) : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!session || !email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = getRoleForEmail(email);
  if (role !== "admin") {
    return NextResponse.json({ error: "forbidden — admin only" }, { status: 403 });
  }

  const sql = getSql();
  if (!sql) {
    return NextResponse.json(
      { error: "POSTGRES_URL not configured" },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const userFilter = url.searchParams.get("user")?.toLowerCase().trim() || null;
  const agentFilter = url.searchParams.get("agent")?.toLowerCase().trim() || null;
  const eventFilter = url.searchParams.get("event")?.trim() || null;
  const surfaceFilter = url.searchParams.get("surface")?.trim() || null;
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );
  const format = (url.searchParams.get("format") || "json").toLowerCase();

  const safeAgent = agentFilter && VALID_AGENTS.has(agentFilter) ? agentFilter : null;

  // Default to last 30 days to keep the query bounded.
  const defaultFrom = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const fromIso = fromParam || defaultFrom;
  const toIso = toParam || null;

  const offset = (pageNum - 1) * limit;
  const isCsv = format === "csv";
  const queryLimit = isCsv ? MAX_LIMIT : limit;
  const queryOffset = isCsv ? 0 : offset;

  // Pack all the optional string filters into a single JSONB object so we
  // only consume one placeholder slot. Each filter is either a string or
  // absent (we never store empty strings).
  const filterObj: Record<string, string> = {};
  if (userFilter) filterObj.user = userFilter;
  if (safeAgent) filterObj.agent = safeAgent;
  if (eventFilter) filterObj.event = eventFilter;
  if (surfaceFilter) filterObj.surface = surfaceFilter;
  const filterJson = JSON.stringify(filterObj);

  try {
    // ---- Rows -----------------------------------------------------------
    const rowsRaw = await sql`
      SELECT id,
             ts::text AS ts,
             email,
             role,
             am_name,
             agent,
             event_name,
             surface,
             entity_id,
             metadata
        FROM am_activity_log
       WHERE ts >= ${fromIso}::timestamptz
         AND (${toIso}::text IS NULL OR ts < (${toIso}::text)::timestamptz)
         AND (
           (${filterJson}::jsonb ->> 'user') IS NULL
           OR LOWER(email) = (${filterJson}::jsonb ->> 'user')
         )
         AND (
           (${filterJson}::jsonb ->> 'agent') IS NULL
           OR agent = (${filterJson}::jsonb ->> 'agent')
         )
         AND (
           (${filterJson}::jsonb ->> 'event') IS NULL
           OR event_name = (${filterJson}::jsonb ->> 'event')
         )
         AND (
           (${filterJson}::jsonb ->> 'surface') IS NULL
           OR surface = (${filterJson}::jsonb ->> 'surface')
         )
       ORDER BY ts DESC
       LIMIT ${queryLimit} OFFSET ${queryOffset}
    `;
    const rows = rowsRaw as unknown as ActivityRow[];

    if (isCsv) {
      const csv = toCsv(rows);
      const filename = `beacon-activity-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // ---- Total count ---------------------------------------------------
    const totalRaw = await sql`
      SELECT COUNT(*)::int AS n
        FROM am_activity_log
       WHERE ts >= ${fromIso}::timestamptz
         AND (${toIso}::text IS NULL OR ts < (${toIso}::text)::timestamptz)
         AND (
           (${filterJson}::jsonb ->> 'user') IS NULL
           OR LOWER(email) = (${filterJson}::jsonb ->> 'user')
         )
         AND (
           (${filterJson}::jsonb ->> 'agent') IS NULL
           OR agent = (${filterJson}::jsonb ->> 'agent')
         )
         AND (
           (${filterJson}::jsonb ->> 'event') IS NULL
           OR event_name = (${filterJson}::jsonb ->> 'event')
         )
         AND (
           (${filterJson}::jsonb ->> 'surface') IS NULL
           OR surface = (${filterJson}::jsonb ->> 'surface')
         )
    `;
    const total = (totalRaw as unknown as Array<{ n: number }>)[0]?.n ?? 0;

    // ---- Facets (only on page 1; client retains them across pages) ----
    const facets: {
      agent_counts: Record<string, number>;
      event_counts: Record<string, number>;
      user_counts: Record<string, number>;
    } = {
      agent_counts: {},
      event_counts: {},
      user_counts: {},
    };

    if (pageNum === 1) {
      const facetRaw = await sql`
        SELECT agent, event_name, email, COUNT(*)::int AS cnt
          FROM am_activity_log
         WHERE ts >= ${fromIso}::timestamptz
           AND (${toIso}::text IS NULL OR ts < (${toIso}::text)::timestamptz)
           AND (
             (${filterJson}::jsonb ->> 'user') IS NULL
             OR LOWER(email) = (${filterJson}::jsonb ->> 'user')
           )
           AND (
             (${filterJson}::jsonb ->> 'agent') IS NULL
             OR agent = (${filterJson}::jsonb ->> 'agent')
           )
           AND (
             (${filterJson}::jsonb ->> 'event') IS NULL
             OR event_name = (${filterJson}::jsonb ->> 'event')
           )
           AND (
             (${filterJson}::jsonb ->> 'surface') IS NULL
             OR surface = (${filterJson}::jsonb ->> 'surface')
           )
         GROUP BY agent, event_name, email
      `;
      const facetRows = facetRaw as unknown as Array<{
        agent: string;
        event_name: string;
        email: string;
        cnt: number;
      }>;
      for (const r of facetRows) {
        facets.agent_counts[r.agent] = (facets.agent_counts[r.agent] ?? 0) + r.cnt;
        facets.event_counts[r.event_name] =
          (facets.event_counts[r.event_name] ?? 0) + r.cnt;
        facets.user_counts[r.email] = (facets.user_counts[r.email] ?? 0) + r.cnt;
      }
    }

    return NextResponse.json(
      {
        rows,
        total,
        facets,
        range: { from: fromIso, to: toIso },
        page: pageNum,
        limit,
        total_pages: Math.max(1, Math.ceil(total / limit)),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

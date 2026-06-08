/**
 * Negative Keyword Beacon — list alerts. Phase NK-4.2.
 *
 * GET /negative-keyword/api/alerts
 *
 * Auth: session-gated (any role).
 *   - role=am          → filtered to owning_am_email = session email
 *   - role=manager     → all alerts
 *   - role=admin       → all alerts
 *
 * Query params (all optional):
 *   - status=all|open|ticketed|dismissed   (default: all)
 *   - source=App Chat|Email|SMS|Phone|Video
 *   - category=Cancellation|Billing|Lead quality|Technical|Disappointed|Flagged
 *   - since=YYYY-MM-DD                     (default: 14 days ago)
 *   - limit=1..2000                        (default: 500)
 *
 * Response:
 *   { ok: true, alerts: AlertItem[], scope: "am" | "all", total: number,
 *     fetchedAt: ISO }
 *
 * The dashboard hydrates this endpoint on initial load (Overview KPIs +
 * Alerts table both read the same payload to avoid double-fetching).
 * Charts derive aggregates client-side from the same alerts array.
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";
import { listForAm, listForManager } from "@/lib/negative-keyword/repo";
import {
  ALERT_SOURCES,
  RISK_CATEGORIES,
  type AlertSource,
  type RiskCategory,
} from "@/lib/negative-keyword/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STATUS_VALUES = new Set<"all" | "open" | "ticketed" | "dismissed">([
  "all",
  "open",
  "ticketed",
  "dismissed",
]);

function parseSource(v: string | null): AlertSource | undefined {
  if (!v) return undefined;
  return (ALERT_SOURCES as readonly string[]).includes(v) ? (v as AlertSource) : undefined;
}

function parseCategory(v: string | null): RiskCategory | undefined {
  if (!v) return undefined;
  return (RISK_CATEGORIES as readonly string[]).includes(v)
    ? (v as RiskCategory)
    : undefined;
}

function parseStatus(
  v: string | null,
): "all" | "open" | "ticketed" | "dismissed" {
  if (v && STATUS_VALUES.has(v as "all" | "open" | "ticketed" | "dismissed")) {
    return v as "all" | "open" | "ticketed" | "dismissed";
  }
  return "all";
}

function parseLimit(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(2000, Math.floor(n)));
}

function parseSince(v: string | null): string | undefined {
  if (!v) return undefined;
  // YYYY-MM-DD only — anything else falls through to default.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  return v;
}

export async function GET(req: NextRequest) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager", "am");
  if (denied) return denied;
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const filter = {
    status: parseStatus(url.searchParams.get("status")),
    source: parseSource(url.searchParams.get("source")),
    category: parseCategory(url.searchParams.get("category")),
    since: parseSince(url.searchParams.get("since")),
    limit: parseLimit(url.searchParams.get("limit")),
  };

  const alerts =
    user.role === "am"
      ? await listForAm(user.email, filter)
      : await listForManager(filter);

  return NextResponse.json(
    {
      ok: true,
      scope: user.role === "am" ? "am" : "all",
      alerts,
      total: alerts.length,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

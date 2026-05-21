// GET /api/queue
//
// Returns the full cross-customer escalation queue, ranked by transparent
// rule-based scoring (see lib/escalation-score.ts). Used by /queue.
//
//   ?limit=50       — cap, default 50, max 500
//   ?minScore=15    — drop entries below this score, default 0
//   ?am=<name>      — filter to one AM
//   ?tier=critical  — critical | high | medium | watch
//
// Cached at the edge for 5 min via the underlying tickets CSV cache. Cheap to
// hit repeatedly.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchAllTickets } from "@/lib/escalation/tickets";
import { scoreCustomers, scoreTier } from "@/lib/escalation/escalation-score";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  return session ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

const TIERS = new Set(["critical", "high", "medium", "watch"]);

export async function GET(req: NextRequest) {
  const authFail = await requireAuth();
  if (authFail) return authFail;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 500);
  const minScore = Number(url.searchParams.get("minScore") ?? "0");
  const am = (url.searchParams.get("am") || "").trim().toLowerCase();
  const tier = (url.searchParams.get("tier") || "").trim().toLowerCase();

  try {
    const tickets = await fetchAllTickets();
    const all = scoreCustomers(tickets);

    const filtered = all.filter((e) => {
      if (e.score < minScore) return false;
      if (am && !e.amName.toLowerCase().includes(am)) return false;
      if (tier && TIERS.has(tier)) {
        if (scoreTier(e.score).label.toLowerCase() !== tier) return false;
      }
      return true;
    });

    // Aggregate counts for the AM filter dropdown + tier summary chips.
    const byTier: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Watch: 0 };
    const amCounts = new Map<string, number>();
    for (const e of all) {
      const t = scoreTier(e.score).label;
      byTier[t] = (byTier[t] || 0) + 1;
      if (e.amName) amCounts.set(e.amName, (amCounts.get(e.amName) || 0) + 1);
    }

    return NextResponse.json({
      ok: true,
      total: all.length,
      shown: Math.min(filtered.length, limit),
      byTier,
      ams: Array.from(amCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      entries: filtered.slice(0, limit),
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Internal error" },
      { status: 500 }
    );
  }
}

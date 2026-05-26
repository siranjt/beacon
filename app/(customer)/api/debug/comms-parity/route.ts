// Phase E-19 Wave 1 — comms-parity diagnostic endpoint.
//
// Reads the latest Stage B snapshot, diffs V1 (5-CSV pipeline) vs V2
// (bulk-events Metabase + comms_events Postgres) CustomerMetrics for
// every entity that has both. Returns a summary + per-entity divergence
// list sorted by total absolute delta.
//
// Use during the dual-source window to decide when V2 is ready to flip
// over. Once all 13 metric fields are within tolerance for ≥95% of
// entities, we can ship Wave 3 (retire V1).
//
// Manager+admin only.

import { NextResponse } from "next/server";
import { readPipelineStage } from "@/lib/customer/pipeline-state";
import { todaySnapshotDate } from "@/lib/customer/pipeline-state";
import type { StageBData } from "@/lib/customer/refresh";
import type { CustomerMetrics } from "@/lib/customer/types";
import { getApiUser, requireRole } from "@/lib/customer/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Numeric metric fields we diff across. Strings (channels_used_*d) and
 *  timestamps (last_*_iso) are reported as match/no-match, not numeric. */
const NUMERIC_FIELDS: Array<keyof CustomerMetrics> = [
  "total_7d",  "in_7d",  "out_7d",  "channels_7d",
  "total_14d", "in_14d", "out_14d", "channels_14d",
  "total_30d", "in_30d", "out_30d", "channels_30d",
  "total_60d", "in_60d", "out_60d", "channels_60d",
  "total_90d", "in_90d", "out_90d", "channels_90d",
  "days_since_in", "days_since_out",
];

const STRING_FIELDS: Array<keyof CustomerMetrics> = [
  "channels_used_30d",
  "channels_used_90d",
  "last_any_iso",
  "last_in_iso",
  "last_out_iso",
];

interface EntityDiff {
  entity_id: string;
  total_abs_delta: number;
  numeric_diffs: Record<string, { v1: number; v2: number; delta: number }>;
  string_diffs: Record<string, { v1: string | null; v2: string | null }>;
}

export async function GET(req: Request) {
  const user = await getApiUser();
  const denied = requireRole(user, "admin", "manager");
  if (denied) return denied;

  const url = new URL(req.url);
  const snapshotDate = url.searchParams.get("date") || todaySnapshotDate();
  const topN = Number(url.searchParams.get("top") || "30");
  const sampleEntity = url.searchParams.get("entity") || null;

  const stage = await readPipelineStage<StageBData>("B", snapshotDate);
  if (!stage || !stage.data) {
    return NextResponse.json(
      { ok: false, error: `no Stage B snapshot for date=${snapshotDate}` },
      { status: 404 },
    );
  }
  const v1 = stage.data.commsMetricsByEntity || {};
  const v2 = stage.data.commsMetricsByEntityV2 || {};
  const diag = stage.data.v2Diagnostics;

  if (!diag || !diag.enabled) {
    return NextResponse.json({
      ok: true,
      snapshot_date: snapshotDate,
      v2_enabled: false,
      v2_diagnostics: diag,
      hint:
        "V2 was not enabled for this Stage B run. Re-run Stage B (e.g., /api/cron/refresh) to populate V2 metrics.",
    });
  }

  const v1Entities = new Set(Object.keys(v1));
  const v2Entities = new Set(Object.keys(v2));
  const both = [...v1Entities].filter((e) => v2Entities.has(e));
  const onlyV1 = [...v1Entities].filter((e) => !v2Entities.has(e));
  const onlyV2 = [...v2Entities].filter((e) => !v1Entities.has(e));

  // Per-entity diff
  const diffs: EntityDiff[] = [];
  let perfectMatchCount = 0;

  for (const eid of both) {
    const m1 = v1[eid];
    const m2 = v2[eid];
    let total_abs_delta = 0;
    const numeric_diffs: EntityDiff["numeric_diffs"] = {};
    for (const f of NUMERIC_FIELDS) {
      const a = Number(m1[f] ?? 0);
      const b = Number(m2[f] ?? 0);
      const d = b - a;
      if (d !== 0) {
        numeric_diffs[f as string] = { v1: a, v2: b, delta: d };
        total_abs_delta += Math.abs(d);
      }
    }
    const string_diffs: EntityDiff["string_diffs"] = {};
    for (const f of STRING_FIELDS) {
      const a = (m1[f] ?? null) as string | null;
      const b = (m2[f] ?? null) as string | null;
      if (a !== b) string_diffs[f as string] = { v1: a, v2: b };
    }
    if (total_abs_delta === 0 && Object.keys(string_diffs).length === 0) {
      perfectMatchCount++;
    } else {
      diffs.push({ entity_id: eid, total_abs_delta, numeric_diffs, string_diffs });
    }
  }

  // Sort by largest divergence
  diffs.sort((a, b) => b.total_abs_delta - a.total_abs_delta);

  // Per-field aggregated divergence (which fields drift most across the book)
  const fieldDriftCount: Record<string, number> = {};
  for (const d of diffs) {
    for (const f of Object.keys(d.numeric_diffs)) {
      fieldDriftCount[f] = (fieldDriftCount[f] || 0) + 1;
    }
    for (const f of Object.keys(d.string_diffs)) {
      fieldDriftCount[f] = (fieldDriftCount[f] || 0) + 1;
    }
  }
  const fieldDriftRanked = Object.entries(fieldDriftCount)
    .sort((a, b) => b[1] - a[1])
    .map(([field, count]) => ({ field, divergent_entities: count }));

  // Sample single-entity comparison if requested
  let sample: { entity_id: string; v1: CustomerMetrics | null; v2: CustomerMetrics | null } | null = null;
  if (sampleEntity) {
    sample = {
      entity_id: sampleEntity,
      v1: v1[sampleEntity] || null,
      v2: v2[sampleEntity] || null,
    };
  }

  const matchRate = both.length === 0 ? 0 : perfectMatchCount / both.length;

  return NextResponse.json({
    ok: true,
    snapshot_date: snapshotDate,
    v2_enabled: true,
    v2_diagnostics: diag,
    summary: {
      v1_entities: v1Entities.size,
      v2_entities: v2Entities.size,
      both: both.length,
      only_in_v1: onlyV1.length,
      only_in_v2: onlyV2.length,
      perfect_match: perfectMatchCount,
      divergent: diffs.length,
      match_rate_pct: Math.round(matchRate * 1000) / 10,
    },
    field_drift_ranked: fieldDriftRanked,
    top_divergent_entities: diffs.slice(0, topN),
    only_in_v1_sample: onlyV1.slice(0, 10),
    only_in_v2_sample: onlyV2.slice(0, 10),
    sample,
  });
}

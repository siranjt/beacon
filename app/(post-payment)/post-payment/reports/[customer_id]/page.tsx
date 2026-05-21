/**
 * /reports/<cb_customer_id> — single report viewer.
 *
 * Layout (themed to match zoca-dispute-dashboard):
 *   - Back link
 *   - Customer header + Preview/JSON action buttons
 *   - Verdict callout banner (status-coloured)
 *   - Key facts grid (animated cards)
 *   - Interactive visual analysis (tabbed ReportVisual component)
 *
 * Animation language mirrors the dashboard: anim-rise / anim-cascade for the
 * entrance wave, chart-card hover lifts, count-up numbers, donut fade-in.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCustomer } from "@/lib/post-payment/db/queries";
import Link from "next/link";
import BeaconPageShell from "@/components/BeaconPageShell";
import { DocxPreviewButton } from "../../_components/DocxPreviewButton";
import ReportVisual from "../../_components/ReportVisual";

export const dynamic = "force-dynamic";

function VerdictBlock({
  verdict,
  needsAmCall,
  oneLine,
}: {
  verdict: string | null;
  needsAmCall: boolean;
  oneLine: string | null;
}) {
  const pill =
    verdict === "icp"
      ? { text: "✅ ICP", border: "border-accent-green/40", bg: "bg-accent-green-bg", color: "text-accent-green" }
      : verdict === "review"
      ? { text: "⚠️ Review", border: "border-accent-yellow/40", bg: "bg-accent-yellow-bg", color: "text-accent-yellow" }
      : verdict === "not_icp"
      ? { text: "❌ Not ICP", border: "border-accent-red/40", bg: "bg-accent-red-bg", color: "text-accent-red" }
      : { text: "Pending", border: "border-line", bg: "bg-elevated", color: "text-ink-dim" };
  return (
    <div className={`verdict-callout rounded-2xl border ${pill.border} ${pill.bg} px-6 py-5`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 mb-2">
        <span className={`text-3xl font-bold ${pill.color}`}>{pill.text}</span>
        {needsAmCall && (
          <span className="verdict-needs-am inline-flex items-center gap-1 px-3 py-1 rounded-full text-accent-yellow font-semibold bg-accent-yellow-bg border border-accent-yellow/40">
            <span>🚨</span> Needs AM call
          </span>
        )}
      </div>
      {oneLine && <p className={`text-sm ${pill.color}/90 leading-relaxed`}>{oneLine}</p>}
    </div>
  );
}

function Stat({ label, value, fmt }: { label: string; value: any; fmt?: (v: any) => string }) {
  const display = value === null || value === undefined ? "—" : fmt ? fmt(value) : String(value);
  return (
    <div className="stat-card chart-card bg-surface border border-line rounded-2xl p-4">
      <div className="text-xs text-ink-dim uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold text-ink mt-1">{display}</div>
    </div>
  );
}

async function fetchText(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJson(url: string | null): Promise<any | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function ReportPage({ params }: { params: { customer_id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }

  const c = await getCustomer(params.customer_id);
  if (!c) {
    return (
      <BeaconPageShell>
        <div className="text-center py-12">
          <p>Customer not found in dashboard.</p>
          <Link href="/post-payment" className="mt-4 inline-block underline">
            ← Back to dashboard
          </Link>
        </div>
      </BeaconPageShell>
    );
  }

  // Pull both JSON (for the visual) and markdown (kept for any raw-text needs)
  const [reportData, _md] = await Promise.all([
    fetchJson(c.report_blob_json_url),
    fetchText(c.report_blob_md_url),
  ]);

  return (
    <BeaconPageShell>
      <div className="space-y-6">
        <div className="anim-rise">
          <Link href="/post-payment" className="text-sm underline hover:opacity-70 transition">
            ← All reports
          </Link>
        </div>

      <div className="flex flex-wrap items-start justify-between gap-3 anim-rise" style={{ animationDelay: "0.06s" }}>
        <div className="min-w-0">
          <h2 className="text-3xl font-bold text-ink leading-tight">
            {c.biz_name ?? c.cb_customer_id}
          </h2>
          <p className="text-sm text-ink-muted mt-2">
            Customer ID: <span className="font-mono text-ink">{c.cb_customer_id}</span>
            {c.email && (
              <>
                {" · "}
                <span className="text-ink-dim">{c.email}</span>
              </>
            )}
            {c.locality && (
              <>
                {" · "}
                {c.locality}
                {c.state_code ? `, ${c.state_code}` : ""}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2 text-sm flex-shrink-0">
          {c.report_blob_docx_url && (
            <DocxPreviewButton
              docxUrl={c.report_blob_docx_url}
              filename={`${(c.biz_name ?? c.cb_customer_id).replace(/[^a-zA-Z0-9_-]+/g, "_")}_Post_Payment_Review.docx`}
            />
          )}
          {c.report_blob_json_url && (
            <a
              href={c.report_blob_json_url}
              className="btn-bounce px-3 py-1.5 border border-line text-ink-muted rounded-lg hover:bg-elevated hover:border-accent-blue transition"
            >
              ↓ JSON
            </a>
          )}
        </div>
      </div>

      <div className="anim-rise" style={{ animationDelay: "0.12s" }}>
        <VerdictBlock verdict={c.verdict} needsAmCall={c.needs_am_call} oneLine={c.verdict_one_line} />
      </div>

      <div className="anim-rise" style={{ animationDelay: "0.18s" }}>
        <h3 className="text-lg font-semibold mb-3 text-ink">Key facts</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 anim-cascade">
          <Stat
            label="AE / AM"
            value={[c.ae_name, c.am_name].filter(Boolean).join(" / ") || null}
          />
          <Stat label="Primary category" value={c.primary_category} />
          <Stat label="Lead source" value={c.lead_source_group ?? c.lead_source} />
          <Stat
            label="6-month lead prediction"
            value={c.predicted_6_month_leads}
            fmt={(v) =>
              v === null
                ? "—"
                : v < 30
                ? `${v} (auto-fail)`
                : v < 60
                ? `${v} (possible)`
                : `${v} (likely)`
            }
          />
          <Stat label="Reviews at onboarding" value={c.total_reviews_at_onb} />
          <Stat label="Avg rating" value={c.avg_rating_at_onb} />
          <Stat label="Booking platform" value={c.booking_platform} />
          <Stat label="Open tickets (30d)" value={c.open_tickets_30d} />
        </div>
      </div>

      {reportData ? (
        <div className="anim-rise" style={{ animationDelay: "0.28s" }}>
          <h3 className="text-lg font-semibold mb-3 text-ink">Full analysis</h3>
          <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
            <ReportVisual data={reportData} />
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-accent-yellow/40 bg-accent-yellow-bg/40 px-5 py-4 text-sm text-accent-yellow anim-rise" style={{ animationDelay: "0.28s" }}>
          <strong className="text-ink">Visual analysis not yet available.</strong> Status:{" "}
          <code className="font-mono">{c.status}</code>
          {c.failure_reason && <p className="mt-2">Reason: {c.failure_reason}</p>}
          <p className="text-xs text-ink-muted mt-2">
            The structured JSON couldn&apos;t be fetched. Use the docx preview or the JSON download button above to view the canonical artifacts.
          </p>
        </div>
      )}
      </div>
    </BeaconPageShell>
  );
}

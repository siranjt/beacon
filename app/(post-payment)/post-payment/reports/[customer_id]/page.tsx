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
import { ReanalyzeButton } from "../../_components/ReanalyzeButton";
import ReportVisual from "../../_components/ReportVisual";
import PageViewLogger from "@/components/PageViewLogger";

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
      <PageViewLogger
        agent="post-payment"
        surface="post_payment_report"
        metadata={{ customer_id: params.customer_id }}
      />
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
        <div className="flex gap-2 text-sm flex-shrink-0 flex-wrap items-center">
          {c.report_blob_docx_url && (
            <DocxPreviewButton
              docxUrl={c.report_blob_docx_url}
              filename={`${(c.biz_name ?? c.cb_customer_id).replace(/[^a-zA-Z0-9_-]+/g, "_")}_Post_Payment_Review.docx`}
            />
          )}
          <ReanalyzeButton
            customerId={c.cb_customer_id}
            bizName={c.biz_name}
            currentStatus={c.status}
          />
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
        // Three sub-cases for the empty state. We disambiguate so the user
        // knows whether (a) the LLM never ran, (b) it ran but render
        // failed (most common — verdict + driver in DB but no blob), or
        // (c) the blob exists but couldn't be fetched.
        (() => {
          const hasBlob = !!c.report_blob_json_url;
          const renderFailed = (c.failure_reason ?? "").startsWith("render_failed:");
          const renderError = renderFailed
            ? (c.failure_reason ?? "").replace(/^render_failed:\s*/, "")
            : null;
          const hasVerdict = !!c.verdict;

          // Render-failed case: LLM data is valid (verdict pill is showing
          // above), but the docx/JSON upload broke. Most often a missing or
          // wrong BLOB_READ_WRITE_TOKEN env in Vercel.
          if (!hasBlob && renderFailed) {
            return (
              <div className="rounded-2xl border border-accent-red/40 bg-accent-red-bg/40 px-5 py-4 text-sm anim-rise" style={{ animationDelay: "0.28s" }}>
                <strong className="text-ink">Word doc + structured JSON failed to upload.</strong>
                <p className="text-ink-muted mt-1">
                  The LLM analysis succeeded — the verdict and key facts above are valid — but the
                  visual / .docx artifacts couldn&apos;t be persisted to Blob storage.
                </p>
                <p className="mt-2">
                  <span className="text-ink-muted">Error: </span>
                  <code className="font-mono text-accent-red text-xs">{renderError}</code>
                </p>
                <p className="text-xs text-ink-muted mt-2">
                  Most common cause: <code className="font-mono">BLOB_READ_WRITE_TOKEN</code> missing
                  or wrong in Vercel env vars. After fixing the env + redeploy, click <strong>↻ Re-analyze</strong> above to regenerate.
                </p>
              </div>
            );
          }

          // No blob, no render error, status not ready → still processing /
          // pending / failed for some other reason. Fall back to the
          // status-driven message.
          if (!hasBlob) {
            return (
              <div className="rounded-2xl border border-accent-yellow/40 bg-accent-yellow-bg/40 px-5 py-4 text-sm anim-rise" style={{ animationDelay: "0.28s" }}>
                <strong className="text-ink">Visual analysis not yet available.</strong>{" "}
                <span className="text-ink-muted">Status: </span>
                <code className="font-mono">{c.status}</code>
                {c.failure_reason && <p className="mt-2">Reason: {c.failure_reason}</p>}
                <p className="text-xs text-ink-muted mt-2">
                  {hasVerdict
                    ? "The verdict above came from the LLM but the structured artifacts haven't been generated. Click ↻ Re-analyze above to retry."
                    : "The analysis pipeline hasn't produced a verdict for this customer. Click ↻ Re-analyze above to run it."}
                </p>
              </div>
            );
          }

          // Blob URL exists but fetch returned null — network blip, expired
          // signature, or content gone. Suggest reload + re-analyze fallback.
          return (
            <div className="rounded-2xl border border-accent-yellow/40 bg-accent-yellow-bg/40 px-5 py-4 text-sm anim-rise" style={{ animationDelay: "0.28s" }}>
              <strong className="text-ink">Couldn&apos;t load the structured report data.</strong>
              <p className="text-ink-muted mt-1">
                The blob URL is set but the fetch failed. Try reloading; if it persists, click <strong>↻ Re-analyze</strong> above to regenerate.
              </p>
              <p className="text-xs text-ink-muted mt-2 break-all">
                {/* hasBlob check above guarantees report_blob_json_url is non-null, but TS still narrows it to string | null because the check is in an outer scope. Coalesce to undefined so <a href> accepts it. */}
                Source: <a href={c.report_blob_json_url ?? undefined} className="underline">{c.report_blob_json_url}</a>
              </p>
            </div>
          );
        })()
      )}
      </div>
    </BeaconPageShell>
  );
}

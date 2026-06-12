/**
 * /admin/keeper/enrichment-status — META-A4 ops surface.
 *
 * Read-only by default: shows the per-field roster, last cron timestamp
 * (best-effort — Vercel cron logs are the canonical source), and a
 * client "Run now" button that POSTs /api/admin/keeper/enrichment-run
 * to fire the enrichment immediately for an ad-hoc refresh.
 *
 * Manager + admin only.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail, isManagerOrAdmin } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import { ENRICHMENT_FIELDS } from "@/lib/brain/metabase-enrichment";
import EnrichmentRunButton from "./run-button-client";
import BootstrapButton from "./bootstrap-button-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Keeper enrichment status · Admin · Beacon · Zoca",
};

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/keeper/enrichment-status");
  }
  const role = getRoleForEmail(session.user.email);
  if (!isManagerOrAdmin(role)) {
    redirect("/");
  }

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Keeper enrichment" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_keeper_enrichment_status" }}
      />

      <div
        style={{
          padding: "1.5rem 2rem",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "var(--zoca-text)",
          maxWidth: 1100,
          margin: "0 auto",
        }}
      >
        {/* META-A2 one-time backfill — bootstraps every active customer's
            Keeper from BaseSheet. Idempotent (existing facts skipped). Lives
            above the weekly enrichment card because it's a one-time setup
            step that should be done first. */}
        <div
          style={{
            padding: "1.25rem 1.5rem",
            borderRadius: 10,
            background: "var(--zoca-bg-soft)",
            border: "1px solid var(--zoca-border)",
            marginBottom: "1.5rem",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "0.8rem",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  color: "var(--zoca-text-3)",
                  marginBottom: "0.3rem",
                }}
              >
                One-time backfill
              </div>
              <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>
                Bootstrap Keeper from BaseSheet
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "var(--zoca-text-2)",
                  maxWidth: 540,
                  lineHeight: 1.5,
                  marginTop: 4,
                }}
              >
                Pre-populates every active customer&apos;s Keeper with their
                BaseSheet facts (AE name, MRR, integration state, sold-at).
                Idempotent — already-present facts are skipped. ~2-3 min for
                ~900 customers.
              </div>
            </div>
            <BootstrapButton />
          </div>
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <h1
            style={{
              fontSize: "1.75rem",
              fontWeight: 700,
              margin: 0,
              marginBottom: "0.4rem",
            }}
          >
            Weekly enrichment
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "0.95rem",
              color: "var(--zoca-text-2)",
              maxWidth: 720,
              lineHeight: 1.5,
            }}
          >
            Slow-changing Metabase fields land in Keeper every Sunday at
            06:00 UTC. Pure CSV → Postgres pipeline — zero LLM calls.
            Re-runs are idempotent: identical values skip the write and
            count as <em>unchanged</em>.
          </p>
        </div>

        <div
          style={{
            padding: "1.25rem 1.5rem",
            borderRadius: 10,
            background: "var(--zoca-bg-soft)",
            border: "1px solid var(--zoca-border)",
            marginBottom: "1.5rem",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "0.8rem",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  color: "var(--zoca-text-3)",
                  marginBottom: "0.3rem",
                }}
              >
                Schedule
              </div>
              <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>
                Sundays · 06:00 UTC
              </div>
              <div style={{ fontSize: "0.85rem", color: "var(--zoca-text-2)" }}>
                ≈ 11:30 AM IST · cron <code>0 6 * * 0</code>
              </div>
            </div>
            <EnrichmentRunButton />
          </div>
        </div>

        <h2
          style={{
            fontSize: "1.2rem",
            fontWeight: 700,
            margin: "0 0 0.75rem 0",
          }}
        >
          Fields enriched
        </h2>
        <p
          style={{
            margin: "0 0 1rem 0",
            fontSize: "0.85rem",
            color: "var(--zoca-text-3)",
          }}
        >
          Each row writes to one Keeper subcategory/field per active customer.
          Source is the lean BaseSheet CSV (e9005a5c).
        </p>

        <div
          style={{
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid var(--zoca-border)",
            background: "var(--zoca-bg-soft)",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9rem",
            }}
          >
            <thead>
              <tr
                style={{
                  background: "var(--zoca-bg-tint)",
                  color: "var(--zoca-text)",
                  textAlign: "left",
                }}
              >
                <th style={thStyle}>Field label</th>
                <th style={thStyle}>Keeper landing slot</th>
                <th style={thStyle}>Source column</th>
              </tr>
            </thead>
            <tbody>
              {ENRICHMENT_FIELDS.map((f) => (
                <tr
                  key={f.label}
                  style={{ borderTop: "1px solid var(--zoca-border)" }}
                >
                  <td style={tdStyle}>
                    <strong>{f.label}</strong>
                  </td>
                  <td style={tdStyle}>
                    <code>
                      {f.topic_category}/{f.topic_subcategory}/{f.field_name}
                    </code>
                  </td>
                  <td style={{ ...tdStyle, color: "var(--zoca-text-2)" }}>
                    {sourceColumnFor(f.label)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p
          style={{
            margin: "1.5rem 0 0 0",
            fontSize: "0.8rem",
            color: "var(--zoca-text-3)",
            lineHeight: 1.5,
          }}
        >
          Last-run telemetry lives in the Vercel cron log for{" "}
          <code>/api/cron/keeper/enrich-from-metabase</code>. Hit “Run now”
          for an interactive run that returns the full envelope here.
        </p>
      </div>
    </BeaconPageShell>
  );
}

// Hardcoded source-column documentation. Kept in sync with the
// extract() functions in lib/brain/metabase-enrichment.ts. If we add a
// field there, add a case here.
function sourceColumnFor(label: string): string {
  switch (label) {
    case "business_type":
      return "updated_primary_category, primary_category";
    case "lead_source":
      return "lead_source";
    case "integration_state":
      return "chrone_zoca_status";
    default:
      return "—";
  }
}

const thStyle: React.CSSProperties = {
  padding: "0.65rem 0.9rem",
  fontSize: "0.75rem",
  fontWeight: 700,
  letterSpacing: "1px",
  textTransform: "uppercase",
};

const tdStyle: React.CSSProperties = {
  padding: "0.6rem 0.9rem",
  color: "var(--zoca-text)",
};

/**
 * Beacon AI Failure Inbox — admin view. Phase F-polish-AI Tier 3.
 *
 * Lists every `<gap: ...>` marker the model has emitted across the
 * umbrella, grouped by (scope, category). Admins use this to rank
 * Tier 4+ work — the cluster with the highest open count is usually
 * worth one structured fix (new context field / new tool / prompt
 * tweak).
 *
 * The page is server-rendered (admin-only auth gate, then a single
 * DB read). No client interactivity beyond a "mark resolved" button
 * which posts to a tiny inline API.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRoleForEmail } from "@/lib/customer/config";
import BeaconPageShell from "@/components/BeaconPageShell";
import AgentHeader from "@/components/AgentHeader";
import PageViewLogger from "@/components/PageViewLogger";
import { listGapRows, gapRollup, type GapLogRow, type GapRollup } from "@/lib/ai/gaps";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Beacon AI gaps · Admin · Beacon · Zoca",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function categoryColor(cat: string): string {
  switch (cat) {
    case "data_missing":
      return "#C8431D"; // ember
    case "tool_insufficient":
      return "#B8841F"; // brass
    case "out_of_scope":
      return "#6B7280"; // grey
    case "assumption_unclear":
      return "#1F3B47"; // lapis
    default:
      return "#374151";
  }
}

export default async function Page() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/auth/signin?callbackUrl=/admin/beacon-ai-gaps");
  }
  const role = getRoleForEmail(session.user.email);
  if (role !== "admin") redirect("/");

  const [rollup, rows] = await Promise.all([
    gapRollup(),
    listGapRows({ includeResolved: false, limit: 200 }),
  ]);

  return (
    <BeaconPageShell>
      <AgentHeader agentName="Admin · Beacon AI gaps" homeHref="/" />
      <PageViewLogger
        agent="umbrella"
        surface="auth"
        metadata={{ kind: "admin_beacon_ai_gaps" }}
      />

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 1rem" }}>
        <div style={{ marginBottom: 24 }}>
          <h1
            style={{
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 28,
              fontWeight: 500,
              letterSpacing: "-0.015em",
              color: "var(--zoca-text)",
              margin: 0,
            }}
          >
            Beacon AI failure inbox
          </h1>
          <p style={{ color: "var(--zoca-text-2)", fontSize: 13, margin: "4px 0 0" }}>
            Every time Beacon AI tagged itself with a gap. {rows.length} open · sorted newest first.
          </p>
        </div>

        {/* Rollup by (scope, category) */}
        <RollupTable rollup={rollup} />

        {/* Full list */}
        <div
          style={{
            background: "rgba(248, 239, 215, 0.85)",
            border: "1px solid #D4C29B",
            borderRadius: 14,
            overflow: "hidden",
            marginTop: 24,
          }}
        >
          {rows.length === 0 ? (
            <div
              style={{
                padding: 40,
                textAlign: "center",
                color: "var(--zoca-text-2)",
                fontSize: 14,
              }}
            >
              No open gaps. 🎉 Either Beacon AI is killing it or nobody asked anything yet.
            </div>
          ) : (
            <GapTable rows={rows} />
          )}
        </div>
      </div>
    </BeaconPageShell>
  );
}

function RollupTable({ rollup }: { rollup: GapRollup[] }) {
  if (rollup.length === 0) return null;
  return (
    <div
      style={{
        background: "rgba(248, 239, 215, 0.85)",
        border: "1px solid #D4C29B",
        borderRadius: 14,
        overflow: "hidden",
        marginBottom: 24,
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr
            style={{
              background: "#EBE0C2",
              color: "var(--zoca-text-2)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Scope</th>
            <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Category</th>
            <th style={{ textAlign: "right", padding: "12px 16px", fontWeight: 700 }}>Open</th>
            <th style={{ textAlign: "right", padding: "12px 16px", fontWeight: 700 }}>Total ever</th>
          </tr>
        </thead>
        <tbody>
          {rollup.map((r) => (
            <tr key={`${r.scope}::${r.category}`} style={{ borderTop: "1px solid #EBE0C2" }}>
              <td style={{ padding: "10px 16px", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {r.scope}
              </td>
              <td style={{ padding: "10px 16px" }}>
                <span
                  style={{
                    background: categoryColor(r.category) + "22",
                    color: categoryColor(r.category),
                    padding: "2px 8px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontFamily: "ui-monospace, monospace",
                    fontWeight: 600,
                  }}
                >
                  {r.category}
                </span>
              </td>
              <td
                style={{
                  padding: "10px 16px",
                  textAlign: "right",
                  fontWeight: 600,
                  color: r.open_count > 0 ? "var(--zoca-text)" : "var(--zoca-text-2)",
                }}
              >
                {r.open_count}
              </td>
              <td style={{ padding: "10px 16px", textAlign: "right", color: "var(--zoca-text-2)" }}>
                {r.total_count}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GapTable({ rows }: { rows: GapLogRow[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr
          style={{
            background: "#EBE0C2",
            color: "var(--zoca-text-2)",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>When</th>
          <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Scope</th>
          <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Category</th>
          <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Description</th>
          <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Question</th>
          <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>User</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: "1px solid #EBE0C2", verticalAlign: "top" }}>
            <td
              style={{
                padding: "10px 16px",
                color: "var(--zoca-text-2)",
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              {fmtDate(r.occurred_at)}
            </td>
            <td style={{ padding: "10px 16px", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
              {r.scope}
            </td>
            <td style={{ padding: "10px 16px" }}>
              <span
                style={{
                  background: categoryColor(r.category) + "22",
                  color: categoryColor(r.category),
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontFamily: "ui-monospace, monospace",
                  fontWeight: 600,
                }}
              >
                {r.category}
              </span>
            </td>
            <td style={{ padding: "10px 16px", color: "var(--zoca-text)" }}>{r.description}</td>
            <td
              style={{
                padding: "10px 16px",
                color: "var(--zoca-text-2)",
                fontStyle: "italic",
                maxWidth: 280,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={r.question}
            >
              {r.question}
            </td>
            <td style={{ padding: "10px 16px", color: "var(--zoca-text-2)", fontSize: 11 }}>
              {r.user_email.split("@")[0]}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

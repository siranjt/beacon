"use client";

import type { AgentResult } from "@/lib/escalation/types";

interface Props {
  loading: boolean;
  response: { ok: boolean; result?: AgentResult; context?: any; error?: string } | null;
}

const SEVERITY_COLOR: Record<string, string> = {
  P0: "bg-err/20 text-err border-err/40",
  P1: "bg-warn/20 text-warn border-warn/40",
  P2: "bg-accent/20 text-accent border-accent/40",
  P3: "bg-panel2 text-muted border-border",
};

export default function ResultPanel({ loading, response }: Props) {
  if (loading) {
    return (
      <div className="rounded-2xl border border-border bg-panel p-6">
        <p className="text-muted">Looking up customer, pulling 90 days of comms, calling agent…</p>
      </div>
    );
  }
  if (!response) {
    return (
      <div className="rounded-2xl border border-border bg-panel p-6">
        <p className="text-muted">Result will appear here.</p>
      </div>
    );
  }
  if (!response.ok || !response.result) {
    return (
      <div className="rounded-2xl border border-err/40 bg-err/10 p-6">
        <p className="text-err font-medium">Error</p>
        <p className="text-sm mt-2 text-text whitespace-pre-wrap">{response.error || "Unknown error"}</p>
      </div>
    );
  }

  const r = response.result;
  const ctx = response.context || {};

  return (
    <div className="rounded-2xl border border-border bg-panel p-6 space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Agent report</h2>
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${
            SEVERITY_COLOR[r.severity] || ""
          }`}
        >
          {r.severity}
        </span>
      </header>

      {/* Customer chip */}
      {ctx.customer && (
        <section className="text-sm">
          <p className="text-muted mb-1">Customer</p>
          <p>
            <span className="font-medium">{ctx.customer.bizName ?? "(unknown business)"}</span>
            {ctx.customer.email ? (
              <span className="text-muted"> · {ctx.customer.email}</span>
            ) : null}
            {ctx.customer.amName ? (
              <span className="text-muted"> · AM {ctx.customer.amName}</span>
            ) : null}
          </p>
        </section>
      )}

      {/* Triage */}
      <section>
        <p className="text-muted text-sm mb-1">Category</p>
        <p className="capitalize">{r.category.replace(/_/g, " ")}</p>
      </section>

      {/* Owner */}
      <section>
        <p className="text-muted text-sm mb-1">Suggested owner</p>
        <p className="text-sm">
          <span className="font-medium">
            {r.ownerSuggestion.namedPerson || r.ownerSuggestion.role}
          </span>
          {r.ownerSuggestion.namedPerson ? (
            <span className="text-muted"> · {r.ownerSuggestion.role}</span>
          ) : null}
        </p>
        <p className="text-sm text-muted mt-1">{r.ownerSuggestion.rationale}</p>
      </section>

      {/* Summary */}
      <section>
        <p className="text-muted text-sm mb-1">Summary</p>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{r.summary}</p>
      </section>

      {/* Draft reply */}
      <section>
        <p className="text-muted text-sm mb-1">
          Draft reply ({r.draftReply.channel}
          {r.draftReply.subject ? ` · "${r.draftReply.subject}"` : ""})
        </p>
        <pre className="text-sm leading-relaxed whitespace-pre-wrap rounded-lg border border-border bg-panel2 p-3">
{r.draftReply.body}
        </pre>
      </section>

      {/* Auto resolve */}
      <section className="text-sm">
        <p className="text-muted mb-1">Auto-resolve</p>
        <p>
          <span
            className={
              r.autoResolvable.eligible
                ? "text-ok font-medium"
                : "text-muted font-medium"
            }
          >
            {r.autoResolvable.eligible ? "Eligible" : "Not eligible"}
          </span>{" "}
          <span className="text-muted">
            ({(r.autoResolvable.confidence * 100).toFixed(0)}% confidence)
          </span>
        </p>
        <p className="text-muted mt-1">{r.autoResolvable.reason}</p>
      </section>

      {/* Routing actions */}
      <section>
        <p className="text-muted text-sm mb-1">Routing actions</p>
        <ul className="text-sm space-y-2">
          {r.routing.actions.map((a, i) => (
            <li key={i} className="rounded-lg border border-border bg-panel2 p-3">
              <p className="text-xs uppercase text-muted">{a.type}</p>
              {a.type === "slack_dm" && (
                <p>
                  <strong>{a.to}</strong>: {a.message}
                </p>
              )}
              {a.type === "slack_channel" && (
                <p>
                  <strong>#{a.channel}</strong>: {a.message}
                </p>
              )}
              {a.type === "linear_issue" && (
                <>
                  <p>
                    <strong>{a.team ? `${a.team} · ` : ""}{a.title}</strong>
                  </p>
                  <p className="text-muted whitespace-pre-wrap mt-1">{a.body}</p>
                  {a.labels?.length ? (
                    <p className="text-xs text-muted mt-1">labels: {a.labels.join(", ")}</p>
                  ) : null}
                </>
              )}
              {a.type === "email" && (
                <>
                  <p>
                    <strong>{a.to}</strong> — {a.subject}
                  </p>
                  <p className="text-muted whitespace-pre-wrap mt-1">{a.body}</p>
                </>
              )}
              {a.type === "noop" && <p className="text-muted">{a.reason}</p>}
            </li>
          ))}
        </ul>
      </section>

      {/* Signals used */}
      {r.signalsUsed?.length ? (
        <section>
          <p className="text-muted text-sm mb-1">Signals used</p>
          <ul className="text-sm list-disc list-inside text-muted">
            {r.signalsUsed.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Lookup notes */}
      {ctx.lookupNotes?.length ? (
        <section className="text-xs text-muted">
          <p className="mb-1">Lookup notes</p>
          <ul className="list-disc list-inside">
            {ctx.lookupNotes.map((n: string, i: number) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

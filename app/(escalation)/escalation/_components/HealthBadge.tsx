"use client";

import { useEffect, useState } from "react";

interface Check {
  ok: boolean;
  detail: string;
  hint?: string;
}

interface HealthResponse {
  ok: boolean;
  checks: {
    anthropic: Check;
    chargebee: Check;
    tickets: Check;
  };
}

const SERVICES: { key: keyof HealthResponse["checks"]; label: string; usedFor: string }[] = [
  { key: "anthropic", label: "Anthropic", usedFor: "Triage, summary, draft reply" },
  { key: "chargebee", label: "Chargebee", usedFor: "Subscription, invoices, ACH" },
  { key: "tickets", label: "Tickets", usedFor: "Per-customer tickets" },
];

export default function HealthBadge() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      const res = await fetch("/escalation/api/health", { cache: "no-store" });
      const data = (await res.json()) as HealthResponse;
      setHealth(data);
      if (!data.ok) setOpen(true);
    } catch (e: any) {
      setError(e?.message || "Network error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading) {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-panel text-xs text-muted">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted live-dot" />
        Checking…
      </span>
    );
  }
  if (error) {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-err/40 bg-errSoft text-xs text-err">
        Health: {error}
      </span>
    );
  }
  if (!health) return null;

  const downCount = SERVICES.filter((s) => !health.checks[s.key]?.ok).length;
  const ok = downCount === 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-panel text-xs hover:border-border2 transition-colors"
        aria-label="Integration health"
      >
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full live-dot ${ok ? "bg-ok" : "bg-err"}`}
        />
        <span className="text-muted2">
          {ok ? "All systems OK" : `${downCount} ${downCount === 1 ? "issue" : "issues"}`}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[340px] rounded-xl border border-border bg-panel p-3 shadow-xl z-20">
          <div className="space-y-2 text-xs">
            {SERVICES.map((s) => {
              const c = health.checks[s.key];
              const okCls = c?.ok ? "text-ok" : "text-err";
              return (
                <div key={s.key} className="rounded-lg border border-border bg-panel2 p-2.5">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-full ${c?.ok ? "bg-ok" : "bg-err"} translate-y-[1px]`}
                    />
                    <strong className="font-semibold text-text">{s.label}</strong>
                    <span className="text-muted">· {s.usedFor}</span>
                  </div>
                  <p className={`mt-1 ${okCls}`}>{c?.detail}</p>
                  {c?.hint && <p className="mt-1 text-muted2">Hint: {c.hint}</p>}
                </div>
              );
            })}
            <div className="flex justify-between items-center pt-1">
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted hover:text-text">
                Close
              </button>
              <button
                type="button"
                disabled={refreshing}
                onClick={() => { setRefreshing(true); load(); }}
                className="rounded-md border border-border bg-panel2 px-2 py-1 text-xs text-muted2 hover:text-text disabled:opacity-50"
              >
                {refreshing ? "Re-checking…" : "Re-check"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

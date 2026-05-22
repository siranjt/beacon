"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AmSummary = {
  am_name: string;
  pod: string | null;
  last_one_on_one_date: string | null;
  red_count: number;
  mrr_at_risk_cents: number;
};

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; ams: AmSummary[] };

function fmtMoney(cents: number): string {
  if (!cents) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

function daysSince(iso: string | null): { label: string; tone: string } {
  if (!iso) return { label: "Never", tone: "var(--zoca-text-soft)" };
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return { label: "Never", tone: "var(--zoca-text-soft)" };
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return { label: "Today", tone: "#047857" };
  if (days === 1) return { label: "1 day ago", tone: "#047857" };
  if (days < 14) return { label: `${days} days ago`, tone: "#047857" };
  if (days < 30) return { label: `${days} days ago`, tone: "#b45309" };
  return { label: `${days} days ago`, tone: "#e11d48" };
}

export default function V2OneOnOnePickerClient() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v2/manager/1on1", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) {
          setState({
            status: "error",
            message: data.error || `HTTP ${res.status}`,
          });
          return;
        }
        setState({ status: "ready", ams: (data.ams ?? []) as AmSummary[] });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-6">
        <a
          href="/customer/manager"
          className="text-[12px] text-zoca-text-2 hover:text-zoca-blue"
        >
          ← Back to Manager view
        </a>
        <h1
          className="mt-2 font-extrabold text-zoca-text"
          style={{ fontSize: "24px", letterSpacing: "-0.02em" }}
        >
          1:1 prep — pick an AM
        </h1>
        <p className="mt-1 text-[12px] text-zoca-text-2">
          Auto-generated agendas per AM. Click an AM to see their book summary,
          coaching signals, wins, and rule-based talking points.
        </p>
      </header>

      {state.status === "loading" && (
        <div className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-6 text-center text-[12px] text-zoca-text-2">
          Loading AMs…
        </div>
      )}

      {state.status === "error" && (
        <div
          className="rounded-zoca-lg border bg-zoca-bg-soft p-6 text-center text-[12px]"
          style={{ borderColor: "rgba(244,63,94,0.22)", color: "var(--zoca-pink)" }}
        >
          Could not load AM list: {state.message}
        </div>
      )}

      {state.status === "ready" && state.ams.length === 0 && (
        <div className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-6 text-center text-[12px] text-zoca-text-2">
          No AMs found.
        </div>
      )}

      {state.status === "ready" && state.ams.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {state.ams.map((am) => {
            const d = daysSince(am.last_one_on_one_date);
            return (
              <button
                key={am.am_name}
                type="button"
                onClick={() =>
                  router.push(`/customer/manager/1on1/${encodeURIComponent(am.am_name)}`)
                }
                className="rounded-zoca-lg bg-zoca-bg-soft p-4 text-left transition hover:shadow-zoca-sm"
                style={{
                  border: "0.5px solid var(--zoca-border)",
                  cursor: "pointer",
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div
                      className="font-extrabold text-zoca-text"
                      style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
                    >
                      {am.am_name}
                    </div>
                    {am.pod && (
                      <div
                        className="mt-0.5 text-[10.5px] uppercase tracking-wider text-zoca-text-2"
                        style={{ letterSpacing: "0.04em" }}
                      >
                        {am.pod}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: "0.85em", opacity: 0.5 }}>→</span>
                </div>

                <div className="mt-3 flex items-baseline gap-2">
                  <span
                    className="tabular-nums font-extrabold"
                    style={{ fontSize: "18px", color: "var(--zoca-pink)" }}
                  >
                    {am.red_count}
                  </span>
                  <span className="text-[11px] text-zoca-text-2">Needs call</span>
                  <span className="text-zoca-text-soft">·</span>
                  <span
                    className="tabular-nums font-semibold"
                    style={{ fontSize: "13px", color: "var(--zoca-pink)" }}
                  >
                    {fmtMoney(am.mrr_at_risk_cents)}
                  </span>
                  <span className="text-[11px] text-zoca-text-2">at risk</span>
                </div>

                <div className="mt-2 text-[11.5px]" style={{ color: d.tone }}>
                  Last 1:1: {d.label}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

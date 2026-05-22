"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (10 hex/rgba + 0 tailwind-rose swept)

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { SnapshotV2 } from "@/lib/customer/types";
import { POD_MAP } from "@/lib/customer/config";
import {
  SIGNAL_LABELS,
  type SignalKey as TaxonomySignalKey,
} from "@/lib/customer/signal-taxonomy";
import { useToast } from "./Toast";

const POD_ORDER = ["Pod 1", "Pod 2", "Pod 3", "Pod 4", "Pod 5", "Floating"];

const POD_COLOR_DOT: Record<string, string> = {
  "Pod 1": "bg-violet-500",
  "Pod 2": "bg-cyan-500",
  "Pod 3": "bg-emerald-500",
  "Pod 4": "bg-amber-500",
  "Pod 5": "bg-pink-500",
  Floating: "bg-slate-500",
};

type SignalKey = "we" | "client" | "drop" | "vol" | "usage" | "billing" | "perf";

// Phase 22.B.3 — bridge from the heatmap's internal short keys to the canonical
// signal-taxonomy union used elsewhere in the app (V2AMTriage, V2CustomerCard,
// V2Dashboard URL state). Kept at the click-handler boundary so the heatmap's
// internal compact keys can stay as they are.
const TAXONOMY_KEY: Record<SignalKey, TaxonomySignalKey> = {
  we: "we_silent",
  client: "client_silent",
  drop: "resp_drop",
  vol: "vol_collapse",
  usage: "usage_low",
  billing: "billing",
  perf: "perf_flag",
};

const SIGNALS: { key: SignalKey; label: string; help: string }[] = [
  { key: "we", label: "We silent", help: "We haven't reached out (sig_we_silent ≥ 70)" },
  { key: "client", label: "Client silent", help: "Customer has gone dark (sig_client_silent ≥ 70)" },
  { key: "drop", label: "Resp drop", help: "Response rate has fallen sharply (sig_response_drop ≥ 70)" },
  { key: "vol", label: "Vol collapse", help: "Conversation volume tanked vs baseline (sig_volume_collapse ≥ 70)" },
  { key: "usage", label: "Usage low", help: "Zoca app usage tanked or non-existent (sig_usage ≥ 70)" },
  { key: "billing", label: "Billing", help: "Stacked unpaid invoices (sig_billing ≥ 70)" },
  { key: "perf", label: "Perf flag", help: "Performance trajectory flagged (GBP drop, zero-review weeks, or YTD lead decline)" },
];

type Props = {
  snapshot: SnapshotV2;
};

export default function V2SignalHeatmap({ snapshot }: Props) {
  const router = useRouter();
  const { showToast } = useToast();

  const { matrix, max, totalsByPod, totalsBySignal } = useMemo(() => {
    const matrix: Record<string, Record<SignalKey, number>> = {};
    const totalsByPod: Record<string, number> = {};
    const totalsBySignal: Record<SignalKey, number> = {
      we: 0,
      client: 0,
      drop: 0,
      vol: 0,
      usage: 0,
      billing: 0,
      perf: 0,
    };
    for (const pod of POD_ORDER) {
      matrix[pod] = { we: 0, client: 0, drop: 0, vol: 0, usage: 0, billing: 0, perf: 0 };
      totalsByPod[pod] = 0;
    }
    for (const c of snapshot.customers) {
      const pod = POD_MAP[c.am_name] || "Floating";
      if (!matrix[pod]) continue;
      const s = c.signals_v2;
      totalsByPod[pod] += 1;
      if (s.sig_we_silent >= 70) {
        matrix[pod].we += 1;
        totalsBySignal.we += 1;
      }
      if (s.sig_client_silent >= 70) {
        matrix[pod].client += 1;
        totalsBySignal.client += 1;
      }
      if (s.sig_response_drop >= 70) {
        matrix[pod].drop += 1;
        totalsBySignal.drop += 1;
      }
      if (s.sig_volume_collapse >= 70) {
        matrix[pod].vol += 1;
        totalsBySignal.vol += 1;
      }
      if (s.sig_usage >= 70) {
        matrix[pod].usage += 1;
        totalsBySignal.usage += 1;
      }
      if (s.sig_billing >= 70) {
        matrix[pod].billing += 1;
        totalsBySignal.billing += 1;
      }
      if (c.performance?.flag) {
        matrix[pod].perf += 1;
        totalsBySignal.perf += 1;
      }
    }
    let max = 0;
    for (const pod of POD_ORDER) {
      for (const sig of SIGNALS) {
        if (matrix[pod][sig.key] > max) max = matrix[pod][sig.key];
      }
    }
    return { matrix, max, totalsByPod, totalsBySignal };
  }, [snapshot]);

  // Phase 22.B.3 — clicking a heatmap cell with count > 0 navigates to
  // /customer?pod=X&signal=Y for an instant pod × signal drilldown.
  function handleCellClick(podLabel: string, signal: SignalKey) {
    const taxonomyKey = TAXONOMY_KEY[signal];
    const params = new URLSearchParams();
    params.set("pod", podLabel);
    params.set("signal", taxonomyKey);
    router.push(`/customer?${params.toString()}`);
    showToast(`Filtered to ${podLabel} · ${SIGNAL_LABELS[taxonomyKey]}`, {
      type: "info",
      icon: "filter",
    });
  }

  return (
    <section aria-label="Pod-signal heatmap">
      <header className="mt-2 mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            className="font-extrabold text-zoca-text"
            style={{ fontSize: "17px", letterSpacing: "-0.015em" }}
          >
            Signal heatmap
          </h3>
          <p className="mt-0.5 text-[11px] text-zoca-text-2">
            Customers per pod carrying each strong signal (≥70). Darker = more concentrated. Click a cell to drill in.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-zoca-text-2">
          <span>0</span>
          <div className="flex h-2 w-24 overflow-hidden rounded-full">
            <div className="flex-1" style={{ background: "rgba(124, 45, 18, 0.10)" }} />
            <div className="flex-1" style={{ background: "rgba(124, 45, 18, 0.25)" }} />
            <div className="flex-1" style={{ background: "rgba(200, 67, 29, 0.45)" }} />
            <div className="flex-1" style={{ background: "rgba(200, 67, 29, 0.65)" }} />
            <div className="flex-1" style={{ background: "rgba(200, 67, 29, 0.85)" }} />
          </div>
          <span>{max || "—"}</span>
        </div>
      </header>

      <div
        className="overflow-x-auto rounded-2xl"
        style={{
          // Phase 33.brand-watchfire-T6 — heatmap table on Light Parchment.
          background: "var(--zoca-bg-soft)",
          border: "1px solid var(--zoca-border)",
          boxShadow: "0 1px 2px rgba(11,5,29,0.03)",
        }}
      >
        <table className="min-w-full text-[12px]">
          <thead
            className="text-[10px] uppercase tracking-wider text-zoca-text-2"
            style={{ background: "var(--zoca-bg-soft)" }}
          >
            <tr>
              <th className="px-3 py-2 text-left font-semibold" scope="col">
                Pod
              </th>
              {SIGNALS.map((s) => (
                <th
                  key={s.key}
                  scope="col"
                  className="px-2 py-2 text-center font-semibold"
                  title={s.help}
                >
                  {s.label}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-semibold" scope="col">
                Customers
              </th>
            </tr>
          </thead>
          <tbody className="divide-y" style={{ borderColor: "var(--zoca-border)" }}>
            {POD_ORDER.map((pod) => {
              const row = matrix[pod];
              const total = totalsByPod[pod];
              return (
                <tr
                  key={pod}
                  className="transition"
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "rgba(252, 228, 214, 0.55)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                >
                  <th
                    scope="row"
                    className="px-3 py-2 text-left text-[12px] font-medium text-zoca-text"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${POD_COLOR_DOT[pod] || "bg-slate-500"}`}
                        aria-hidden
                      />
                      {pod}
                    </span>
                  </th>
                  {SIGNALS.map((s) => {
                    const v = row[s.key];
                    const intensity = max ? v / max : 0;
                    const cellBg =
                      v === 0
                        ? "var(--zoca-bg-soft)"
                        : intensity <= 0.2
                          ? "rgba(124, 45, 18, 0.10)"
                          : intensity <= 0.4
                            ? "rgba(124, 45, 18, 0.25)"
                            : intensity <= 0.6
                              ? "rgba(200, 67, 29, 0.45)"
                              : intensity <= 0.8
                                ? "rgba(200, 67, 29, 0.65)"
                                : "rgba(200, 67, 29, 0.85)";
                    const cellTextColor =
                      v === 0
                        ? "var(--zoca-text-3)"
                        : intensity > 0.6
                          ? "var(--zoca-bg-soft)"
                          : "var(--zoca-text)";
                    const pct = total ? ((v / total) * 100).toFixed(0) : "0";
                    const taxonomyLabel = SIGNAL_LABELS[TAXONOMY_KEY[s.key]];
                    const cellTitle =
                      v > 0
                        ? `${pod} · ${s.label}: ${v} of ${total} (${pct}%). Click to drill into the ${taxonomyLabel} signal for ${pod}.`
                        : `${pod} · ${s.label}: 0 of ${total}`;
                    return (
                      <td
                        key={s.key}
                        className="px-2 py-1.5 text-center"
                        title={cellTitle}
                      >
                        {v > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleCellClick(pod, s.key)}
                            className="block w-full rounded px-2 py-1.5 font-semibold transition focus:outline-none focus-visible:ring-2"
                            style={{
                              background: cellBg,
                              color: cellTextColor,
                              cursor: "pointer",
                            }}
                            onMouseEnter={(e) => {
                              (e.currentTarget as HTMLElement).style.filter = "brightness(1.08)";
                              (e.currentTarget as HTMLElement).style.transform = "scale(1.02)";
                            }}
                            onMouseLeave={(e) => {
                              (e.currentTarget as HTMLElement).style.filter = "";
                              (e.currentTarget as HTMLElement).style.transform = "";
                            }}
                            aria-label={`${pod} ${s.label}: ${v} customers (${pct}%). Click to drill.`}
                          >
                            {v}
                          </button>
                        ) : (
                          <div
                            className="block w-full rounded px-2 py-1.5 font-semibold"
                            style={{
                              background: cellBg,
                              color: cellTextColor,
                            }}
                          >
                            <span className="opacity-40">·</span>
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right tabular-nums text-zoca-text-2">
                    {total || <span className="text-zoca-text-3">·</span>}
                  </td>
                </tr>
              );
            })}
            {/* totals row */}
            <tr
              className="text-[11px] uppercase tracking-wider text-zoca-text-2"
              style={{ background: "var(--zoca-bg-soft)" }}
            >
              <th scope="row" className="px-3 py-2 text-left font-semibold">
                All pods
              </th>
              {SIGNALS.map((s) => (
                <td
                  key={s.key}
                  className="px-2 py-2 text-center font-semibold text-zoca-text tabular-nums"
                >
                  {totalsBySignal[s.key]}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-semibold text-zoca-text tabular-nums">
                {Object.values(totalsByPod).reduce((a, b) => a + b, 0)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

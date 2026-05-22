"use client";
import type { TalkingPoint, TalkingPointKind } from "@/lib/customer/one-on-one";

type KindStyle = { fg: string; bg: string; border: string; icon: string; label: string };

const KIND_STYLES: Record<TalkingPointKind, KindStyle> = {
  celebrate: {
    fg: "#047857",
    bg: "rgba(16,185,129,0.08)",
    border: "rgba(16,185,129,0.22)",
    icon: "✓",
    label: "Celebrate",
  },
  constructive: {
    fg: "#b45309",
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.22)",
    icon: "⚠",
    label: "Constructive",
  },
  warning: {
    fg: "#e11d48",
    bg: "rgba(244,63,94,0.08)",
    border: "rgba(244,63,94,0.22)",
    icon: "⚑",
    label: "Warning",
  },
  ask: {
    fg: "#0284c7",
    bg: "rgba(2,132,199,0.08)",
    border: "rgba(2,132,199,0.22)",
    icon: "?",
    label: "Ask",
  },
};

type Props = {
  points: TalkingPoint[];
  onEnrich: () => void;
  enriching: boolean;
  enrichedAlready: boolean;
  onToggleUsed: (id: string) => void;
  usedIds: Set<string>;
};

export default function V2OneOnOneTalkingPoints({
  points,
  onEnrich,
  enriching,
  enrichedAlready,
  onToggleUsed,
  usedIds,
}: Props) {
  const buttonDisabled = enriching || points.length === 0;
  const buttonLabel = enriching
    ? "Enriching…"
    : enrichedAlready
    ? "Re-enrich with AI"
    : "Enrich with AI";

  return (
    <section
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            className="font-extrabold text-zoca-text"
            style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
          >
            Talking points
          </h2>
          <p className="mt-0.5 text-[11px] text-zoca-text-2">
            Rule-generated agenda. Mark each as discussed as you go.
          </p>
        </div>
        <button
          type="button"
          onClick={onEnrich}
          disabled={buttonDisabled}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition focus:outline-none focus-visible:ring-2"
          style={{
            background: buttonDisabled
              ? "var(--zoca-bg-soft)"
              : "rgba(200, 67, 29, 0.08)",
            color: buttonDisabled ? "var(--zoca-text-soft)" : "var(--zoca-blue)",
            border: `1px solid ${
              buttonDisabled ? "var(--zoca-border)" : "rgba(200, 67, 29, 0.22)"
            }`,
            cursor: buttonDisabled ? "default" : "pointer",
          }}
        >
          {enriching ? (
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: "1.5px solid currentColor",
                borderTopColor: "transparent",
                animation: "zoca-spin 0.8s linear infinite",
              }}
            />
          ) : (
            <span aria-hidden>✨</span>
          )}
          <span>{buttonLabel}</span>
        </button>
      </header>

      {points.length === 0 ? (
        <div className="rounded-lg bg-[color:var(--zoca-bg-soft)] px-3 py-3 text-[12px] text-zoca-text-2">
          No talking points generated — book may be all-green or data missing.
        </div>
      ) : (
        <ul className="space-y-2">
          {points.map((p) => {
            const style = KIND_STYLES[p.kind];
            const used = usedIds.has(p.id);
            return (
              <li
                key={p.id}
                className="rounded-lg p-3 transition"
                style={{
                  background: style.bg,
                  border: `1px solid ${style.border}`,
                  opacity: used ? 0.55 : 1,
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
                    style={{
                      background: "var(--zoca-bg-soft)",
                      color: style.fg,
                      border: `1px solid ${style.border}`,
                    }}
                  >
                    {style.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[9.5px] font-semibold uppercase tracking-wider"
                        style={{ color: style.fg, letterSpacing: "0.06em" }}
                      >
                        {style.label}
                      </span>
                      {p.supporting_metric && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] tabular-nums"
                          style={{
                            background: "var(--zoca-bg-soft)",
                            color: style.fg,
                            border: `1px solid ${style.border}`,
                          }}
                        >
                          <span className="opacity-70">{p.supporting_metric.label}:</span>{" "}
                          <span className="font-extrabold">
                            {p.supporting_metric.value}
                          </span>
                        </span>
                      )}
                    </div>
                    <div
                      className="mt-0.5 font-extrabold text-zoca-text"
                      style={{ fontSize: "13.5px", letterSpacing: "-0.005em" }}
                    >
                      {p.headline}
                    </div>
                    <p className="mt-1 text-[12px] text-zoca-text">{p.detail}</p>
                  </div>
                  <label
                    className="flex shrink-0 items-center gap-1.5 text-[11px] text-zoca-text-2"
                    style={{ cursor: "pointer", userSelect: "none" }}
                  >
                    <input
                      type="checkbox"
                      checked={used}
                      onChange={() => onToggleUsed(p.id)}
                      style={{ cursor: "pointer" }}
                    />
                    <span>{used ? "Discussed" : "Mark"}</span>
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <style jsx>{`
        @keyframes zoca-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </section>
  );
}

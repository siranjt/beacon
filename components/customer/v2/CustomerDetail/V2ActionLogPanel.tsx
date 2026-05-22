"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 2 tailwind-rose swept)

import type { AmActionRow, AmActionType, ContactReasonCode } from "@/lib/customer/types";

type Props = {
  actions: AmActionRow[];
};

const ACTION_META: Record<
  AmActionType,
  { icon: string; label: string; tone: string }
> = {
  contacted_connected: {
    icon: "✓",
    label: "Connected",
    tone: "text-emerald-700 bg-emerald-500/14",
  },
  contacted_vm: {
    icon: "📞",
    label: "Voicemail",
    tone: "text-amber-700 bg-amber-500/14",
  },
  contacted_noreach: {
    icon: "×",
    label: "No reach",
    tone: "text-zoca-pink-bright bg-zoca-pink/14",
  },
  escalated: {
    icon: "↗",
    label: "Escalated",
    tone: "text-sky-700 bg-sky-500/14",
  },
};

const REASON_LABEL: Record<ContactReasonCode, string> = {
  renewal: "Renewal",
  performance: "Performance",
  billing: "Billing",
  complaint: "Complaint",
  check_in: "Check-in",
  onboarding: "Onboarding",
  other: "Other",
};

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function V2ActionLogPanel({ actions }: Props) {
  const visible = actions.slice(0, 50);
  return (
    <section
      className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
      aria-label="AM action log"
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Action log
        </h3>
        <span className="text-[11px] text-zoca-text-2 tabular-nums">
          {actions.length} {actions.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-zoca border border-dashed border-zoca-border bg-zoca-bg-tint/50 px-3 py-3 text-[12px] text-zoca-text-2">
          No actions logged yet for this customer.
        </div>
      ) : (
        <ol className="space-y-3 border-l border-zoca-border pl-4">
          {visible.map((a, i) => {
            const type = (a.action_type as AmActionType) || "contacted_connected";
            const meta =
              ACTION_META[type] || {
                icon: "•",
                label: type,
                tone: "text-zoca-text-2 bg-zoca-bg-tint",
              };
            const reason = a.reason_code
              ? REASON_LABEL[a.reason_code]
              : null;
            return (
              <li
                key={a.id ?? i}
                className="relative -ml-[21px] pl-[21px]"
              >
                <span
                  className="absolute left-0 top-1.5 inline-block h-2 w-2 rounded-full bg-zoca-border"
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span
                    className="text-[11px] font-medium text-zoca-text-2 tabular-nums"
                    title={a.created_at || ""}
                  >
                    {fmtDate(a.created_at)}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-zoca-pill px-1.5 py-0.5 text-[11px] font-semibold ${meta.tone}`}
                    title={meta.label}
                  >
                    <span aria-hidden>{meta.icon}</span>
                    {meta.label}
                  </span>
                  {reason && (
                    <span
                      className="rounded-zoca-pill border border-zoca-border bg-zoca-bg-tint px-1.5 py-0.5 text-[10px] font-medium text-zoca-text-2"
                      title="Reason code"
                    >
                      {reason}
                    </span>
                  )}
                  {a.follow_up_date && (
                    <span
                      className="rounded-zoca-pill bg-violet-500/14 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                      title="Follow-up scheduled"
                    >
                      ↻ Follow-up {fmtDate(a.follow_up_date)}
                    </span>
                  )}
                  {a.escalated_to && (
                    <span
                      className="rounded-zoca-pill bg-sky-500/14 px-1.5 py-0.5 text-[10px] font-medium text-sky-700"
                      title="Escalation target"
                    >
                      → {a.escalated_to}
                    </span>
                  )}
                  {typeof a.composite_at_action === "number" && (
                    <span
                      className="text-[10px] text-zoca-text-2 tabular-nums"
                      title="Composite score at the moment this action was logged"
                    >
                      composite was {a.composite_at_action}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-zoca-text-2">
                    {a.am_name}
                  </span>
                </div>
                {a.note && (
                  <p className="mt-1 text-[12px] italic leading-relaxed text-zoca-text-2">
                    “{a.note}”
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {actions.length > visible.length && (
        <div className="mt-3 text-[11px] text-zoca-text-2">
          Showing first {visible.length} of {actions.length}.
        </div>
      )}
    </section>
  );
}

export default V2ActionLogPanel;

"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 9 tailwind-rose swept)

import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { Stoplight } from "@/lib/customer/config";
import { buildMailto, buildTelLink, buildHubspotLocationUrl} from "@/lib/customer/contact-links";
import V2SnapshotTimeline from "./V2SnapshotTimeline";

import { normalizeHealthTier, HEALTH_TIER_COLORS, HEALTH_TIER_LABELS } from "@/lib/customer/config";
type TrendPoint = { date: string; composite: number };

type Props = {
  customer: ScoredCustomerV2;
  trend: TrendPoint[];
};

const STOPLIGHT_LABEL: Record<Stoplight, string> = {
  RED: "Needs attention",
  YELLOW: "Keep an eye on",
  GREEN: "Doing fine",
};

const STOPLIGHT_TONE: Record<Stoplight, string> = {
  RED: "bg-zoca-pink/18 text-zoca-pink-bright border-zoca-pink/60",
  YELLOW: "bg-amber-500/18 text-amber-700 border-amber-300/60",
  GREEN: "bg-emerald-500/18 text-emerald-700 border-emerald-300/60",
};

const STOPLIGHT_BORDER: Record<Stoplight, string> = {
  RED: "border-zoca-pink/60",
  YELLOW: "border-amber-300/60",
  GREEN: "border-emerald-300/60",
};

function trajectoryArrow(t: ScoredCustomerV2["signals_v2"]["trajectory_7d"]): {
  symbol: string;
  className: string;
  title: string;
} {
  if (t === "improving") {
    return {
      symbol: "▲",
      className: "text-emerald-700",
      title: "Composite improving vs. 7 days ago",
    };
  }
  if (t === "worsening") {
    return {
      symbol: "▼",
      className: "text-zoca-pink-bright",
      title: "Composite worsening vs. 7 days ago",
    };
  }
  if (t === "stable") {
    return {
      symbol: "•",
      className: "text-zoca-text-2",
      title: "Composite stable vs. 7 days ago",
    };
  }
  return {
    symbol: "—",
    className: "text-zoca-text-2",
    title: "No prior composite to compare",
  };
}

function daysSinceIso(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400_000));
}

function V2DetailHeader({ customer, trend }: Props) {
  const s = customer.signals_v2;
  const traj = trajectoryArrow(s.trajectory_7d);
  const recentlyContacted = (() => {
    const d = daysSinceIso(customer.metrics?.last_out_iso ?? null);
    return d !== null && d <= 7;
  })();

  // The trend prop is still accepted for backward compatibility with the
  // existing client wrapper, but the rich timeline now drives the visual.
  void trend;

  return (
    <section
      className={`rounded-zoca-lg border bg-zoca-bg-soft p-5 md:p-6 ${STOPLIGHT_BORDER[s.stoplight]}`}
      style={(() => {
        const _ht = normalizeHealthTier((customer as any).metabase_health?.health_tier);
        return _ht ? { borderColor: HEALTH_TIER_COLORS[_ht] } : undefined;
      })()}
      aria-label="Customer detail header"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            {(() => {
              const loc = (customer.hubspot as any)?.hubspot_location_record_id as string | undefined;
              const label = customer.company || customer.entity_id.slice(0, 8);
              const titleText = `Open ${label} in HubSpot Locations (new tab)`;
              if (!loc) {
                return (
                  <h1 className="text-2xl font-semibold text-zoca-text">{label}</h1>
                );
              }
              return (
                <a
                  href={buildHubspotLocationUrl(loc)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={titleText}
                  className="group/biztitle inline-flex items-baseline gap-1 text-2xl font-semibold text-zoca-text no-underline hover:text-zoca-pink-cta"
                >
                  <h1 className="m-0 inline">{label}</h1>
                  <i
                    className="ti ti-external-link opacity-0 transition-opacity group-hover/biztitle:opacity-100"
                    aria-hidden
                    style={{ fontSize: "14px" }}
                  />
                </a>
              );
            })()}
            {(() => {
              const _ht = normalizeHealthTier((customer as any).metabase_health?.health_tier);
              if (_ht) {
                const color = HEALTH_TIER_COLORS[_ht];
                const label = HEALTH_TIER_LABELS[_ht];
                return (
                  <span
                    className="rounded-zoca-pill border px-2 py-0.5 text-[11px] font-semibold"
                    style={{ borderColor: color, color: color, background: `${color}22` }}
                    title={label}
                  >
                    {_ht} · {label}
                  </span>
                );
              }
              return (
                <span
                  className={`rounded-zoca-pill border px-2 py-0.5 text-[11px] font-semibold ${STOPLIGHT_TONE[s.stoplight]}`}
                  title={STOPLIGHT_LABEL[s.stoplight]}
                >
                  {s.stoplight} · {STOPLIGHT_LABEL[s.stoplight]}
                </span>
              );
            })()}
            {customer.hubspot?.icp_tier && (
              <span
                className={`rounded-zoca-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  customer.hubspot.icp_tier === "Tier 1"
                    ? "bg-emerald-500/18 text-emerald-700"
                    : customer.hubspot.icp_tier === "Tier 2"
                      ? "bg-amber-500/18 text-amber-700"
                      : "bg-zoca-pink/18 text-zoca-pink-bright"
                }`}
                title={`HubSpot ICP rating: ${customer.hubspot.icp_tier}`}
              >
                ICP {customer.hubspot.icp_tier.replace("Tier ", "")}
              </span>
            )}
            {customer.hubspot?.open_deal_count !== undefined &&
              customer.hubspot.open_deal_count > 0 && (
                <span
                  className="rounded-zoca-pill bg-violet-500/18 px-2 py-0.5 text-[10px] font-medium text-violet-700"
                  title={`${customer.hubspot.open_deal_count} open deal${
                    customer.hubspot.open_deal_count === 1 ? "" : "s"
                  }${
                    customer.hubspot.open_deal_stages
                      ? ` · ${customer.hubspot.open_deal_stages.join(", ")}`
                      : ""
                  }`}
                >
                  💼 {customer.hubspot.open_deal_count} deal
                  {customer.hubspot.open_deal_count === 1 ? "" : "s"}
                </span>
              )}
            {recentlyContacted && (
              <span
                className="rounded-zoca-pill bg-emerald-500/18 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                title="An outbound contact has been logged in the last 7 days"
              >
                ✓ Contacted recently
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-zoca-text-2">
            {customer.am_name && (
              <a
                href={`/customer?am=${encodeURIComponent(customer.am_name)}`}
                className="font-medium text-zoca-text hover:text-zoca-pink-cta"
                title={`Filter dashboard to ${customer.am_name}'s book`}
              >
                {customer.am_name}
              </a>
            )}
            {customer.plan_amount > 0 && (
              <span className="tabular-nums">
                ${customer.plan_amount.toFixed(0)}/mo
              </span>
            )}
            {customer.pod && <span>· {customer.pod}</span>}
            {customer.performance && (customer.performance.active_ranking_count ?? 0) > 0 && (
              <span
                data-keyword-meta="1"
                className="inline-flex items-center gap-1"
                title={`Active local-SEO keywords. Distribution: ${customer.performance.rankings_top_3 ?? 0} top-3 / ${customer.performance.rankings_top_10 ?? 0} top-10 / ${customer.performance.rankings_outside_10 ?? 0} outside top-10`}
              >
                <span aria-hidden>🔑</span>
                <span className="font-semibold tabular-nums text-zoca-text">
                  {(customer.performance.active_ranking_count ?? 0).toLocaleString()}
                </span>
                keywords
                <span className="text-zoca-text-3" aria-hidden>·</span>
                <span className="tabular-nums text-emerald-700 font-semibold">
                  {customer.performance.rankings_top_3 ?? 0}
                </span>
                <span className="text-zoca-text-3">top-3</span>
              </span>
            )}
            {customer.entity_id && (
              <span
                className="inline-flex items-center gap-1 font-mono text-[10px] text-zoca-text-2"
                title="Location entity_id (BaseSheet / HubSpot Locations record link)"
              >
                · <span className="select-all">{customer.entity_id}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (typeof navigator !== "undefined" && navigator.clipboard) {
                      void navigator.clipboard.writeText(customer.entity_id);
                    }
                  }}
                  className="rounded-zoca-pill border border-zoca-border bg-zoca-bg-soft px-1.5 py-0 text-[9px] font-medium text-zoca-text-2 hover:bg-zoca-bg-tint hover:text-zoca-text"
                  title="Copy entity_id"
                  aria-label="Copy entity_id"
                >
                  copy
                </button>
              </span>
            )}
          </div>

          {s.reason_one_line && (
            <p className="mt-3 text-[13px] leading-relaxed text-zoca-text">
              {stripBold(s.reason_one_line)}
            </p>
          )}

          {/* Contact direct actions */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {customer.email && (
              <a
                href={buildMailto(customer.email, {
                  bizname: customer.company || undefined,
                  amName: customer.am_name || undefined,
                })}
                className="inline-flex items-center gap-1 rounded-zoca-pill border border-zoca-border bg-zoca-bg-soft px-2.5 py-1 text-[11px] font-medium text-zoca-text hover:bg-zoca-bg-tint"
                title={`Email ${customer.email}`}
              >
                <i className="ti ti-mail" aria-hidden />
                Email
              </a>
            )}
            {customer.phone && (
              <a
                href={buildTelLink(customer.phone)}
                className="inline-flex items-center gap-1 rounded-zoca-pill border border-zoca-border bg-zoca-bg-soft px-2.5 py-1 text-[11px] font-medium text-zoca-text hover:bg-zoca-bg-tint"
                title={`Call ${customer.phone}`}
              >
                <i className="ti ti-phone" aria-hidden />
                Call
              </a>
            )}
          </div>
        </div>

        {/* Right-side composite cluster */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-baseline gap-2">
            <span
              className="text-3xl font-semibold tabular-nums text-zoca-text"
              title="Composite score (Metabase Customer Health when available)"
            >
              {(() => {
                const mc = (customer as any).metabase_health?.composite_health_score;
                if (mc !== null && mc !== undefined && Number.isFinite(Number(mc))) {
                  return Math.round(Number(mc));
                }
                return s.composite;
              })()}
            </span>
            <span
              className={`text-[14px] font-semibold ${traj.className}`}
              title={traj.title}
            >
              {traj.symbol}
              {s.composite_7d_ago !== null && s.composite_7d_ago !== undefined
                ? ` ${Math.abs(s.composite - s.composite_7d_ago)}`
                : ""}
            </span>
          </div>
          <div
            className="text-[10px] uppercase tracking-wider text-zoca-text-2"
            title="Composite score weights comms · usage · billing with performance/tickets modifiers"
          >
            composite · 0–100
          </div>
        </div>
      </div>

      {/* Phase 33.E.4 — Metabase health sub-scores + reasons + recommended action */}
      {(() => {
        const mh: any = (customer as any).metabase_health;
        if (!mh) return null;
        const subScores: Array<{ label: string; value: number | null }> = [
          { label: "Engagement", value: mh.score_engagement !== undefined && mh.score_engagement !== null ? Number(mh.score_engagement) : null },
          { label: "Value", value: mh.score_value_realization !== undefined && mh.score_value_realization !== null ? Number(mh.score_value_realization) : null },
          { label: "Product", value: mh.score_product_stability !== undefined && mh.score_product_stability !== null ? Number(mh.score_product_stability) : null },
        ];
        const hasAnySubScore = subScores.some(sc => sc.value !== null && Number.isFinite(sc.value as number));
        const reasonNames = typeof mh.health_tier_reason_names === "string" ? mh.health_tier_reason_names.trim() : "";
        const reasonChips = reasonNames ? reasonNames.split(",").map((str: string) => str.trim()).filter(Boolean) : [];
        const recommended = typeof mh.recommended_action === "string" ? mh.recommended_action.trim() : "";
        if (!hasAnySubScore && reasonChips.length === 0 && !recommended) return null;
        return (
          <div data-detail-subscores="1" className="mt-4 flex flex-col gap-3">
            {hasAnySubScore && (
              <div className="grid grid-cols-3 gap-3">
                {subScores.map((sc, i) => {
                  const v = sc.value !== null && Number.isFinite(sc.value as number) ? Math.max(0, Math.min(100, sc.value as number)) : null;
                  const pct = v === null ? 0 : v;
                  const barColor = v === null ? "#cbd5e1" : (v >= 70 ? "#10b981" : v >= 40 ? "#f59e0b" : "#dc2626");
                  return (
                    <div key={i} className="rounded-zoca border border-zoca-border bg-zoca-bg-soft px-3 py-2">
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-zoca-text-2 font-semibold">{sc.label}</span>
                        <span className="text-[12px] font-semibold tabular-nums text-zoca-text" title={`${sc.label} sub-score`}>
                          {v === null ? "—" : Math.round(v)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-zoca-bg-tint overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: barColor }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {reasonChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-zoca-text-2 font-semibold mr-1">Why flagged</span>
                {reasonChips.map((r: string, i: number) => (
                  <span key={i} className="rounded-zoca-pill border border-zoca-border bg-zoca-bg-tint/60 px-2 py-0.5 text-[11px] text-zoca-text-2">
                    {r}
                  </span>
                ))}
              </div>
            )}
            {recommended && (
              <div className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft px-3 py-2 text-[12px] leading-snug text-zoca-text">
                <span className="font-semibold text-zoca-text">→ Recommended action: </span>
                <span className="text-zoca-text-2">{recommended}</span>
              </div>
            )}
          </div>
        );
      })()}
      {/* Phase G5 — incoming comms by channel (90d) */}
      {(() => {
        const comms: any = (customer as any).metabase_health?.comms;
        if (!comms) return null;
        const fmtDaysAgo = (iso: string | null | undefined): string => {
          if (!iso || typeof iso !== "string") return "—";
          const ms = Date.parse(iso);
          if (!Number.isFinite(ms)) return "—";
          const days = Math.max(0, Math.floor((Date.now() - ms) / 86400_000));
          if (days === 0) return "today";
          if (days === 1) return "1d ago";
          if (days < 30) return `${days}d ago`;
          const months = Math.floor(days / 30);
          return months === 1 ? "1mo ago" : `${months}mo ago`;
        };
        const channels: Array<{ label: string; count: number; last: string | null }> = [
          { label: "SMS",   count: Number(comms.sms_count ?? 0),   last: comms.last_sms_date   ?? null },
          { label: "Call",  count: Number(comms.calls_count ?? 0), last: comms.last_call_date  ?? null },
          { label: "Chat",  count: Number(comms.chat_count ?? 0),  last: comms.last_chat_date  ?? null },
          { label: "Email", count: Number(comms.email_count ?? 0), last: comms.last_email_date ?? null },
        ];
        const total = Number(comms.total_incoming ?? channels.reduce((s, c) => s + (Number.isFinite(c.count) ? c.count : 0), 0));
        const allZero = channels.every((c) => !Number.isFinite(c.count) || c.count === 0);
        return (
          <div data-detail-comms="1" className="mt-3 rounded-zoca border border-zoca-border bg-zoca-bg-soft px-3 py-2">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-zoca-text-2 font-semibold">
                Incoming comms · 90d
              </span>
              <span className={`text-[11px] tabular-nums font-semibold ${allZero ? "text-zoca-pink-bright" : "text-zoca-text"}`}>
                {total} total{allZero ? " — no incoming activity" : ""}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {channels.map((ch, i) => {
                const hasActivity = Number.isFinite(ch.count) && ch.count > 0;
                return (
                  <div
                    key={i}
                    className={`rounded-zoca border px-2 py-1.5 ${hasActivity ? "border-zoca-border bg-zoca-bg-soft" : "border-zoca-border bg-zoca-bg-tint/50"}`}
                  >
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-zoca-text-2">{ch.label}</span>
                      <span className={`text-[11px] font-semibold tabular-nums ${hasActivity ? "text-zoca-text" : "text-zoca-text-3"}`}>
                        {ch.count}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-zoca-text-2">
                      {hasActivity ? fmtDaysAgo(ch.last) : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
      {/* Phase G7 — Win Agent stats (for the ~2.8% of customers with it enabled) */}
      {(() => {
        const wa: any = (customer as any).metabase_health?.win_agent;
        if (!wa || wa.enabled !== true) return null;
        const total = Number(wa.total_leads_30d ?? 0);
        const booked = Number(wa.booked_leads_30d ?? 0);
        const rate = Number(wa.booking_rate_pct ?? 0);
        return (
          <div data-detail-winagent="1" className="mt-3 rounded-zoca border border-violet-300/60 bg-violet-500/5 px-3 py-2">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-violet-700 font-semibold">
                Win Agent · 30d
              </span>
              <span className="text-[10px] text-zoca-text-3">Booking automation</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-zoca border border-zoca-border bg-zoca-bg-soft px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-zoca-text-2 font-semibold">Leads</div>
                <div className="text-[14px] font-semibold tabular-nums text-zoca-text">{total}</div>
              </div>
              <div className="rounded-zoca border border-zoca-border bg-zoca-bg-soft px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-zoca-text-2 font-semibold">Booked</div>
                <div className="text-[14px] font-semibold tabular-nums text-zoca-text">{booked}</div>
              </div>
              <div className="rounded-zoca border border-zoca-border bg-zoca-bg-soft px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-zoca-text-2 font-semibold">Rate</div>
                <div className={`text-[14px] font-semibold tabular-nums ${rate >= 60 ? "text-emerald-700" : rate >= 30 ? "text-amber-700" : "text-zoca-pink-bright"}`}>
                  {Number.isFinite(rate) ? `${Math.round(rate)}%` : "—"}
                </div>
              </div>
            </div>
          </div>
        );
      })()}



      {/* Phase 30 — Inline snapshot timeline (replaces the tiny sparkline). */}
      <div className="mt-4 rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-3 md:p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-zoca-text-2 font-semibold">
            Composite over last 90 days
          </span>
          <a
            href={`/customer/customer/${encodeURIComponent(customer.entity_id)}/timeline`}
            className="text-[11px] font-medium text-zoca-pink-cta hover:underline"
            title="Open the full-page timeline view"
          >
            Expand ↗
          </a>
        </div>
        <V2SnapshotTimeline
          entityId={customer.entity_id}
          variant="inline"
          days={90}
          bizname={customer.company ?? undefined}
        />
      </div>
    </section>
  );
}

/** Strip <b>...</b> markup down to plain text for the header summary line. */
function stripBold(text: string): string {
  if (!text) return "";
  return text
    .replace(/<\s*\/?\s*b\s*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export default V2DetailHeader;

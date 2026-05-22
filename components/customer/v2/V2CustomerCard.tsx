"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (0 hex/rgba + 1 tailwind-rose swept)
// Phase 33.brand-watchfire-pink-sweep-customercard (6 hardcoded + 21 tailwind-rose swept).

import * as React from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import type { Stoplight, EngagementTier } from "@/lib/customer/config";
import V2Sparkline from "./V2Sparkline";
import V2PerformancePanel from "./V2PerformancePanel";
import NotesField from "./NotesField";
import { AmLink } from "./AmLink";
import {
  buildMailto,
  buildTelLink,
  buildHubspotCompanyUrl, buildHubspotLocationUrl} from "@/lib/customer/contact-links";
import type { SignalKey } from "@/lib/customer/signal-taxonomy";
import { useMagnetic } from "@/lib/customer/hooks/useMagnetic";

import { useActivityLogger } from "@/hooks/use-activity-logger";
import { normalizeHealthTier, HEALTH_TIER_COLORS, HEALTH_TIER_LABELS } from "@/lib/customer/config";
type CompositeTrendPoint = { date: string; composite: number };

type Props = {
  customer: ScoredCustomerV2;
  trend?: CompositeTrendPoint[];
  recentlyContacted?: boolean;
  isPinned?: boolean;
  onTogglePinned?: () => void;
  /** Phase 18.B — selected AM threaded from V2Dashboard for per-AM notes. */
  amName?: string;
  /** Phase 19 — snooze state + handlers threaded from V2Dashboard. */
  isSnoozed?: boolean;
  snoozedUntil?: string | null;
  onSnooze?: (days: number) => void;
  onUnsnooze?: () => void;
  /** Phase 22.A — render index for staggered entrance animation. */
  index?: number;
  /** Phase 22.B.1 — chip click handler for signal-based filtering. */
  onSignalChipClick?: (key: SignalKey) => void;
};

const STOPLIGHT_TITLE: Record<Stoplight, string> = {
  RED: "Needs attention",
  YELLOW: "Keep an eye on",
  GREEN: "Doing fine",
};

const ENGAGEMENT_COLOR: Record<EngagementTier, string> = {
  Active: "text-emerald-700",
  Light: "text-zoca-text-2",
  Cold: "text-amber-700",
  Dormant: "text-zoca-pink-bright",
};
const ENGAGEMENT_FALLBACK = "text-zoca-text-2";

function V2CustomerCardInner({
 customer, trend, recentlyContacted, isPinned, onTogglePinned, amName, isSnoozed, snoozedUntil, onSnooze, onUnsnooze, index, onSignalChipClick }: Props) {
  // Phase 33.B.8 — usage tracking
  const logEvent = useActivityLogger();
  const primaryCtaRef = useMagnetic<HTMLButtonElement>({ strength: 0.18, radius: 80 });
  // Phase 18.B — selected AM from parent, fall back to the card's own AM if not passed.
  const notesAmName = amName ?? customer.am_name;
  const { signals_v2: s, metrics } = customer;
  const trajectoryBadge = computeTrend(s.trajectory_7d);
  const planText = customer.plan_amount > 0 ? `$${customer.plan_amount.toFixed(0)}/mo` : "";
  const podText = customer.pod ? ` · ${customer.pod}` : "";

  // ---------------------------------------------------------------------------
  // Phase 22.C — card-level animation state.
  // ---------------------------------------------------------------------------
  const [snoozing, setSnoozing] = useState(false);
  const [popping, setPopping] = useState(false);
  const prevPinnedRef = useRef<boolean>(!!isPinned);

  useEffect(() => {
    if (isPinned && !prevPinnedRef.current) {
      setPopping(true);
      const t = setTimeout(() => setPopping(false), 500);
      prevPinnedRef.current = !!isPinned;
      return () => clearTimeout(t);
    }
    prevPinnedRef.current = !!isPinned;
  }, [isPinned]);

  // Phase 33.brand-watchfire-PR9 — extended localStorage diff: tracks tier,
  // last_touch_at, and churn open_count per entity. Fires four animations:
  //   #44 .beacon-card-arrival       — new (non-RED) customer
  //   #49 .beacon-new-customer-halo  — new high-priority (RED) customer
  //   #46 .beacon-tier-change-{TIER} — tier flipped since last view
  //   #51 .beacon-comm-spark         — last_touch_at advanced (new comm)
  //   #54 .beacon-churn-shake        — churn ticket newly open
  const [arrivalState, setArrivalState] = useState<"new" | "new-priority" | "tier-changed" | null>(null);
  const [arrivalTier, setArrivalTier] = useState<"RED" | "YELLOW" | "GREEN" | null>(null);
  const [commSparkActive, setCommSparkActive] = useState(false);
  const [churnShakeActive, setChurnShakeActive] = useState(false);
  useEffect(() => {
    type SeenRecord = {
      tier: string;
      last_touch_at?: string | null;
      churn_open?: number;
    };
    const am = amName || customer.am_name || "default";
    const key = `beacon_seen_v2_${am}`;
    const eid = customer.entity_id;
    if (!eid) return;
    let seen: Record<string, SeenRecord> = {};
    try {
      if (typeof window === "undefined") {
        seen = {};
      } else {
        let raw = window.localStorage.getItem(key);
        // Phase 33.brand-watchfire-T3-migration — first post-deploy: promote
        // PR 8 legacy `beacon_seen_<am>` map (entity_id → tier string) into
        // the v2 schema (entity_id → { tier, last_touch_at?, churn_open? }).
        // Avoids the mass-arrival animation storm on first load per AM.
        if (!raw) {
          const legacyKey = `beacon_seen_${am}`;
          const legacyRaw = window.localStorage.getItem(legacyKey);
          if (legacyRaw) {
            try {
              const legacy = JSON.parse(legacyRaw) as Record<string, string>;
              const migrated: Record<string, SeenRecord> = {};
              for (const [legacyEid, legacyTier] of Object.entries(legacy)) {
                if (typeof legacyTier === "string") {
                  migrated[legacyEid] = { tier: legacyTier };
                }
              }
              window.localStorage.setItem(key, JSON.stringify(migrated));
              raw = JSON.stringify(migrated);
            } catch {
              /* legacy parse failed, treat as no prior history */
            }
          }
        }
        if (raw) seen = JSON.parse(raw);
      }
    } catch {
      seen = {};
    }

    const prev = seen[eid];
    const currTier = s.stoplight;
    const currLastTouch = customer.metrics?.last_any_iso ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mh = (customer as any).metabase_health;
    const currChurnOpen: number = mh?.churn?.open_count ?? 0;

    const timers: ReturnType<typeof setTimeout>[] = [];

    if (!prev) {
      // New customer.
      if (currTier === "RED") {
        // #49 — high-priority arrival gets the 3s ember halo.
        setArrivalState("new-priority");
        timers.push(setTimeout(() => setArrivalState(null), 3000));
      } else {
        // #44 — generic new-arrival brass flash, 600ms.
        setArrivalState("new");
        timers.push(setTimeout(() => setArrivalState(null), 600));
      }
    } else {
      // #46 — tier flipped between views.
      if (prev.tier !== currTier) {
        setArrivalTier(currTier as "RED" | "YELLOW" | "GREEN");
        setArrivalState("tier-changed");
        timers.push(setTimeout(() => setArrivalState(null), 2000));
      }
      // #51 — last_touch advanced (new comm landed since last visit).
      if (
        currLastTouch != null &&
        prev.last_touch_at != null &&
        new Date(currLastTouch).getTime() >
          new Date(prev.last_touch_at).getTime()
      ) {
        setCommSparkActive(true);
        timers.push(setTimeout(() => setCommSparkActive(false), 1300));
      }
      // #54 — churn ticket newly opened.
      const prevChurn = prev.churn_open ?? 0;
      if (prevChurn === 0 && currChurnOpen > 0) {
        setChurnShakeActive(true);
        timers.push(setTimeout(() => setChurnShakeActive(false), 220));
      }
    }

    // Update the stored snapshot for this entity.
    seen[eid] = {
      tier: currTier,
      last_touch_at: currLastTouch,
      churn_open: currChurnOpen,
    };
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(key, JSON.stringify(seen));
      }
    } catch {
      /* localStorage may be full or disabled; safe to swallow */
    }
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSnoozeWithAnimation(days: number) {
    if (!onSnooze) return;
    setSnoozing(true);
    await new Promise((r) => setTimeout(r, 250));
    onSnooze(days);
      // Phase 33.B.9 — fire deeper event for admin/usage funnels
      logEvent("snooze_set", {
        surface: "v2_dashboard",
        entity_id: customer.entity_id,
        // Phase 33.scope-slack — bizname for Slack channel.
        metadata: { days, am: customer.am_name, bizname: customer.company || null },
      });
  }

  // Feedback flow ("this signal is wrong" report)
  type FeedbackState =
    | { kind: "idle" }
    | { kind: "open"; comment: string }
    | { kind: "submitting" }
    | { kind: "done" }
    | { kind: "error"; message: string };
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({ kind: "idle" });

  async function submitFeedback(comment: string) {
    setFeedbackState({ kind: "submitting" });
    try {
      const res = await fetch("/api/v2/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: customer.entity_id,
          signal_name: "overall",
          am_name: customer.am_name,
          comment: comment.trim() || null,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        setFeedbackState({ kind: "error", message: `${res.status}: ${txt.slice(0, 120)}` });
        return;
      }
      setFeedbackState({ kind: "done" });
    } catch (e) {
      setFeedbackState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 26 — unified card. All three tiers now render the SAME rich body.
  // Differences are confined to:
  //   1) the wrapper `tierStyle` (border + bg tint)
  //   2) the narrative pill tint
  //   3) the primary CTA button style
  //   4) auto-expand defaults
  //   5) the signal chip row tone (and the GREEN positive chips)
  //   6) whether the "Escalate" link appears (RED only)
  // ---------------------------------------------------------------------------

  // Auto-expand defaults per tier
  // Phase 33.E.3.3 — auto-expand triggers on the new tier model (CRITICAL or
  // AT-RISK from Metabase health card) in addition to the legacy stoplight
  // conditions. Both paths kept so the ~13 orphans without metabase_health
  // still auto-expand on old-RED via the fallback.
  const _ht_for_expand = normalizeHealthTier((customer as any).metabase_health?.health_tier);
  const autoExpand =
    _ht_for_expand === "CRITICAL" ||
    _ht_for_expand === "AT-RISK" ||
    s.stoplight === "RED" ||
    (s.stoplight === "YELLOW" && !!customer.performance?.flag);
  const [expanded, setExpanded] = useState<boolean>(autoExpand);

  // Action-button state machine
  type ReasonCode = "renewal" | "performance" | "billing" | "complaint" | "check_in" | "onboarding" | "other";
  type ActionState =
    | { kind: "idle" }
    | { kind: "selecting" }
    | { kind: "tagging"; choice: ActionChoice; reason: ReasonCode | ""; followUp: boolean }
    | { kind: "submitting"; choice: ActionChoice }
    | { kind: "done"; choice: ActionChoice; at: number }
    | { kind: "escalating"; note: string }
    | { kind: "submittingEscalation" }
    | { kind: "escalated"; to: string | null }
    | { kind: "error"; message: string };
  const [actionState, setActionState] = useState<ActionState>({ kind: "idle" });

  async function submitTaggedAction(choice: ActionChoice, reason: ReasonCode | "", followUp: boolean) {
    setActionState({ kind: "submitting", choice });
    try {
      const followUpDate = followUp
        ? (() => {
            const d = new Date();
            d.setDate(d.getDate() + 7);
            return d.toISOString().slice(0, 10);
          })()
        : null;
      const res = await fetch("/api/v2/actions/contacted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          am_name: customer.am_name,
          entity_id: customer.entity_id,
          action_type: `contacted_${choice}`,
          composite_at_action: customer.signals_v2.composite,
          reason_code: reason || null,
          follow_up_date: followUpDate,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        setActionState({ kind: "error", message: `${res.status}: ${txt.slice(0, 200)}` });
        return;
      }
      setActionState({ kind: "done", choice, at: Date.now() });
      // Phase 33.B.9 — fire deeper event for admin/usage funnels
      logEvent("mark_contacted", {
        surface: "v2_dashboard",
        entity_id: customer.entity_id,
        // Phase 33.scope-slack — bizname for Slack channel.
        metadata: { choice, reason: reason || null, am: customer.am_name, bizname: customer.company || null },
      });
    } catch (e) {
      setActionState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function submitEscalation(note: string) {
    setActionState({ kind: "submittingEscalation" });
    try {
      const res = await fetch("/api/v2/actions/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          am_name: customer.am_name,
          entity_id: customer.entity_id,
          composite_at_action: customer.signals_v2.composite,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        setActionState({ kind: "error", message: `${res.status}: ${txt.slice(0, 200)}` });
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { escalated_to?: string };
      setActionState({ kind: "escalated", to: json.escalated_to ?? null });
    } catch (e) {
      setActionState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 26 — tier-specific style maps
  // ---------------------------------------------------------------------------

  const tierStyle: {
    borderColor: string;
    background: string;
    boxShadow: string;
  } = (() => {
    if (s.stoplight === "RED") {
      return {
        borderColor: isSnoozed
          ? "rgba(245, 158, 11, 0.35)"
          : "rgba(200, 67, 29, 0.22)",
        background: isSnoozed
          ? "linear-gradient(180deg, rgba(254, 243, 199, 0.55) 0%, #ffffff 100%)"
          : "linear-gradient(180deg, rgba(200, 67, 29, 0.03) 0%, #ffffff 100%)",
        boxShadow: isSnoozed
          ? "0 1px 3px rgba(11, 5, 29, 0.04), 0 0 0 1px rgba(245, 158, 11, 0.18)"
          : "0 1px 3px rgba(11, 5, 29, 0.04), 0 0 0 1px rgba(200, 67, 29, 0.08)",
      };
    }
    if (s.stoplight === "YELLOW") {
      return {
        borderColor: isSnoozed
          ? "rgba(245, 158, 11, 0.40)"
          : "rgba(245, 158, 11, 0.28)",
        background: isSnoozed
          ? "linear-gradient(180deg, rgba(254, 243, 199, 0.55) 0%, #ffffff 100%)"
          : "linear-gradient(180deg, rgba(254, 243, 199, 0.25) 0%, #ffffff 100%)",
        boxShadow:
          "0 1px 3px rgba(11, 5, 29, 0.04), 0 0 0 1px rgba(245, 158, 11, 0.10)",
      };
    }
    // GREEN
    return {
      borderColor: isSnoozed
        ? "rgba(245, 158, 11, 0.35)"
        : "rgba(16, 185, 129, 0.22)",
      background: isSnoozed
        ? "linear-gradient(180deg, rgba(254, 243, 199, 0.45) 0%, #ffffff 100%)"
        : "linear-gradient(180deg, rgba(16, 185, 129, 0.03) 0%, #ffffff 100%)",
      boxShadow:
        "0 1px 3px rgba(11, 5, 29, 0.04), 0 0 0 1px rgba(16, 185, 129, 0.08)",
    };
  })();

  // Tier-tinted narrative pill (background + border)
  const reasonPillStyle: React.CSSProperties = (() => {
    if (s.stoplight === "RED") {
      return {
        background: "rgba(200, 67, 29, 0.06)",
        border: "1px solid rgba(200, 67, 29, 0.18)",
      };
    }
    if (s.stoplight === "YELLOW") {
      return {
        background: "rgba(245, 158, 11, 0.08)",
        border: "1px solid rgba(245, 158, 11, 0.22)",
      };
    }
    return {
      background: "rgba(16, 185, 129, 0.06)",
      border: "1px solid rgba(16, 185, 129, 0.18)",
    };
  })();

  // Primary CTA button class per tier
  const primaryCtaClass = (() => {
    if (s.stoplight === "RED") {
      return "max-w-[260px] rounded-zoca-lg bg-zoca-pink-cta px-3.5 py-2 text-left text-[12px] font-semibold leading-snug text-white shadow-zoca-sm transition hover:shadow-zoca-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zoca-bg-0 md:max-w-[300px] md:px-4 md:text-[13px]";
    }
    if (s.stoplight === "YELLOW") {
      return "max-w-[260px] rounded-zoca-lg bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 px-3.5 py-2 text-left text-[12px] font-semibold leading-snug transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:ring-offset-2 md:max-w-[300px] md:px-4 md:text-[13px]";
    }
    // GREEN
    return "max-w-[260px] rounded-zoca-lg bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 px-3.5 py-2 text-left text-[12px] font-semibold leading-snug transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 md:max-w-[300px] md:px-4 md:text-[13px]";
  })();

  // Fallback narrative text when reason_one_line is empty / "No action needed."
  const narrativeText = (() => {
    if (s.reason_one_line && s.reason_one_line.trim() !== "") {
      return s.reason_one_line;
    }
    if (s.stoplight === "GREEN") {
      return "All systems healthy — keep doing what you're doing.";
    }
    if (s.stoplight === "YELLOW") {
      return "Watch this one — signal mix is mixed.";
    }
    return "";
  })();

  // Expand toggle label per tier (GREEN uses positive framing)
  const expandToggleLabel = (collapsed: boolean) => {
    if (s.stoplight === "GREEN") {
      return collapsed ? "Show details" : "Hide";
    }
    return collapsed ? "Why?" : "Hide";
  };

  return (
    <article
      role="article"
      aria-label={(() => {
        const _ht = normalizeHealthTier((customer as any).metabase_health?.health_tier);
        const _tl = _ht ? HEALTH_TIER_LABELS[_ht] : STOPLIGHT_TITLE[s.stoplight];
        return `${customer.company} — ${_tl}${recentlyContacted ? " (contacted recently)" : ""}${isSnoozed ? " (snoozed)" : ""}`;
      })()}
      data-entity-id={customer.entity_id}
      // Phase 33.brand-PR4b — card border pink-ring pulse for RED-tier cards only.
      className={`zoca-card group v2-card-enter${snoozing ? " v2-card-snoozing" : ""}${s.stoplight === "RED" && !isSnoozed ? " b-card-pulse" : ""}${arrivalState === "new" ? " beacon-card-arrival" : ""}${arrivalState === "tier-changed" && arrivalTier ? ` beacon-tier-change-${arrivalTier}` : ""}`}
      style={{
        borderColor: tierStyle.borderColor,
        background: tierStyle.background,
        boxShadow: tierStyle.boxShadow,
        opacity: isSnoozed ? 0.95 : 1,
        animationDelay: `${Math.min((index ?? 0) * 70, 600)}ms`,
      }}
    >
      <div className="grid grid-cols-[auto,1fr,auto] items-start gap-3 p-4 md:gap-4 md:p-5">
        {/* Stoplight dot — with hover title */}
        <StoplightDot light={s.stoplight} healthTier={(customer as any).metabase_health?.health_tier} />

        {/* Body */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <BiznameLink
              bizname={customer.company || customer.entity_id.slice(0, 8)}
              hubspotLocationRecordId={customer.hubspot?.hubspot_location_record_id}
            >
              <h3 className="text-[15px] font-semibold text-zoca-text md:text-base">
                {customer.company || customer.entity_id.slice(0, 8)}
              </h3>
            </BiznameLink>
            {/* Phase 28 — Open detail page link */}
            <a
              href={`/customer/customer/${encodeURIComponent(customer.entity_id)}`}
              className="text-[10px] font-medium text-zoca-text-2 hover:text-zoca-pink-cta transition-colors"
              title="Open full detail page for this customer"
              onClick={(e) => {
                e.stopPropagation();
                // Phase 33.brand-watchfire-PR7-38 — flare the nav BeaconMark on detail open.
                if (typeof window !== "undefined") {
                  window.dispatchEvent(new CustomEvent("beacon:mark-flare"));
                }
                logEvent("customer_opened", {
                  surface: "v2_dashboard",
                  entity_id: customer.entity_id,
                  metadata: {
                    tier: customer.signals_v2?.stoplight,
                    am_name: customer.am_name,
                  },
                });
              }}
              aria-label={`Open detail page for ${customer.company || customer.entity_id.slice(0, 8)}`}
            >
              ↗ Open detail
            </a>
          {/* Phase 33.scope — lifecycle pill (recently_churned | newly_onboarded | resurrected) */}
          {customer.lifecycle_state && customer.lifecycle_state !== "active" && (() => {
            const lc = customer.lifecycle_state;
            const dayMs = 24 * 60 * 60 * 1000;
            const sourceIso = lc === "recently_churned" ? customer.churned_on : customer.onboarded_on;
            const daysAgo = sourceIso ? Math.max(0, Math.floor((Date.now() - Date.parse(sourceIso)) / dayMs)) : null;
            const cls =
              lc === "recently_churned"
                ? "bg-zoca-pink/18 text-zoca-pink-bright"
                : lc === "newly_onboarded"
                  ? "bg-emerald-500/18 text-emerald-700"
                  : "bg-sky-500/18 text-sky-700";
            const label =
              lc === "recently_churned"
                ? `Churned ${daysAgo ?? "?"} day${daysAgo === 1 ? "" : "s"} ago`
                : lc === "newly_onboarded"
                  ? `New customer · ${daysAgo ?? "?"} day${daysAgo === 1 ? "" : "s"}`
                  : `Resurrected · ${daysAgo ?? "?"} day${daysAgo === 1 ? "" : "s"}`;
            return (
              <span
                className={`rounded-zoca-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
                title={`Lifecycle state: ${lc.replace(/_/g, " ")}.`}
              >
                {label}
              </span>
            );
          })()}
            {s.pre_launch && (
              <span
                className="rounded-zoca-pill bg-sky-500/18 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700"
                title={
                  customer.activated_at
                    ? `Pre-launch — contract signed, activation scheduled ${new Date(customer.activated_at).toLocaleDateString()}.`
                    : "Pre-launch — contract signed, not yet activated."
                }
              >
                🚀 Pre-launch
              </span>
            )}
            {customer.hubspot?.icp_tier && (
              <span
                className={`rounded-zoca-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  customer.hubspot.icp_tier === "Tier 1"
                    ? "bg-emerald-500/18 text-emerald-700"
                    : customer.hubspot.icp_tier === "Tier 2"
                      ? "bg-amber-500/18 text-amber-700"
                      : "bg-zoca-pink/18 text-zoca-pink-bright"
                }`}
                title={`HubSpot ICP rating: ${customer.hubspot.icp_tier}. Tier 1 = strong fit · Tier 2 = workable · Tier 3 = low priority.`}
              >
                ICP {customer.hubspot.icp_tier.replace("Tier ", "")}
              </span>
            )}
            {customer.hubspot?.open_deal_count !== undefined &&
              customer.hubspot.open_deal_count > 0 && (
                <span
                  className="rounded-zoca-pill bg-violet-500/18 px-2 py-0.5 text-[10px] font-medium text-violet-700"
                  title={`${customer.hubspot.open_deal_count} open deal${customer.hubspot.open_deal_count === 1 ? "" : "s"}: ${customer.hubspot.open_deal_stages?.join(", ")}. Total $${customer.hubspot.total_open_amount?.toLocaleString()}`}
                >
                  💼 {customer.hubspot.open_deal_count} deal{customer.hubspot.open_deal_count === 1 ? "" : "s"}
                </span>
              )}
            {/* Phase 31.v2 — Tickets chip. Two states only: neutral if all
                open tickets are fresh, amber if any are stale (>7d). No
                priority-based rose chip since the Metabase CSV has no
                priority column. Deep-links into the detail page #tickets. */}
            {customer.tickets?.open_count !== undefined && customer.tickets.open_count > 0 && (
              <a
                href={`/customer/customer/${encodeURIComponent(customer.entity_id)}#tickets`}
                onClick={(e) => e.stopPropagation()}
                className={`rounded-zoca-pill inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium ${
                  (customer.tickets.open_stale_count ?? 0) > 0
                    ? "bg-amber-500/18 text-amber-700 border border-amber-500/30"
                    : "bg-zoca-bg-tint text-zoca-text-2 border border-zoca-border"
                }`}
                title={`${customer.tickets.open_count} open ticket${customer.tickets.open_count === 1 ? "" : "s"}${
                  (customer.tickets.open_stale_count ?? 0) > 0
                    ? ` · ${customer.tickets.open_stale_count} stale >7d`
                    : ""
                }`}
              >
                🎫 {customer.tickets.open_count} ticket{customer.tickets.open_count === 1 ? "" : "s"}
                {(customer.tickets.open_stale_count ?? 0) > 0 && (
                  <span className="text-[9px] uppercase tracking-wider">
                    · {customer.tickets.open_stale_count} stale
                  </span>
                )}
              </a>
            )}
            {/* Phase 14B (Tier C): HubSpot vs. Metabase calls drift */}
            {customer.hubspot?.comms_drift && (
              <span
                className={`rounded-zoca-pill px-2 py-0.5 text-[10px] font-medium ${
                  customer.hubspot.comms_drift.delta > 0
                    ? "bg-amber-500/18 text-amber-700"
                    : "bg-sky-500/18 text-sky-700"
                }`}
                title={`HubSpot logged ${customer.hubspot.comms_drift.hubspot_calls_30d} calls in 30d; Metabase phone CSV shows ${customer.hubspot.comms_drift.metabase_calls_30d}. Data hygiene flag.`}
              >
                {customer.hubspot.comms_drift.delta > 0
                  ? `📞 +${customer.hubspot.comms_drift.delta} missing`
                  : `📞 ${customer.hubspot.comms_drift.delta} extra`}
              </span>
            )}
            {recentlyContacted && (
              <span
                className="rounded-zoca-pill bg-emerald-500/18 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                title="You've already logged a contact attempt against this customer in the last 7 days — avoid double-calling."
              >
                ✓ Contacted recently
              </span>
            )}
            {trajectoryBadge.label && (
              <span
                className={`rounded-zoca-sm px-1.5 py-0.5 text-[10px] font-semibold ${trajectoryBadge.className}`}
                title={trajectoryBadge.title}
              >
                {trajectoryBadge.label}
              </span>
            )}
            {trend && trend.length > 1 && (
              <span
                // Phase 33.brand-watchfire-PR9-50 — Deep Crimson flash + scale 1.05
                // when this customer just crossed into the critical (RED) tier.
                className={`text-zoca-text-2${
                  arrivalState === "tier-changed" && arrivalTier === "RED"
                    ? " beacon-score-flash"
                    : ""
                }`}
                title={`Composite score over last ${trend.length} days, latest ${s.composite}`}
              >
                <V2Sparkline
                  values={trend.map((p) => p.composite)}
                  width={56}
                  height={16}
                  color={
                    s.stoplight === "RED"
                      ? "rgb(251 113 133)"
                      : s.stoplight === "YELLOW"
                        ? "rgb(252 211 77)"
                        : "rgb(110 231 183)"
                  }
                  gradient
                  label="Composite score trend"
                />
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-zoca-text-2" style={{ fontVariantNumeric: "tabular-nums" }}>
            {planText}
            {podText}
            {customer.am_name && (
              <>
                {" · "}
                <AmLink amName={customer.am_name} showArrow={false}>{customer.am_name}</AmLink>
              </>
            )}
          </div>
          {/* Phase 20 — one-click contact launchers */}
          {(customer.email || customer.phone) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              {customer.email && (
                <a
                  href={buildMailto(customer.email, {
                    bizname: customer.company ?? undefined,
                    amName: customer.am_name ?? undefined,
                  })}
                  className="inline-flex items-center gap-1 hover:underline"
                  style={{ color: "var(--zoca-blue, #2563eb)", textDecoration: "none" }}
                  title={`Email ${customer.company || "customer"} — opens your mail client with a pre-filled draft`}
                >
                  <i className="ti ti-mail" aria-hidden style={{ fontSize: "11px", lineHeight: 1 }} />
                  {customer.email}
                </a>
              )}
              {customer.phone && (
                <a
                  href={buildTelLink(customer.phone)}
                  className="inline-flex items-center gap-1 hover:underline"
                  style={{ color: "var(--zoca-blue, #2563eb)", textDecoration: "none" }}
                  title={`Call ${customer.company || "customer"}`}
                >
                  <i className="ti ti-phone" aria-hidden style={{ fontSize: "11px", lineHeight: 1 }} />
                  {customer.phone}
                </a>
              )}
            </div>
          )}
          {/* Phase 26 — tier-tinted narrative pill (replaces bare <p>) */}
          {narrativeText && (
            <div
              className="mt-2 rounded-zoca px-3 py-2 text-[13px] leading-relaxed text-zoca-text md:text-sm"
              style={reasonPillStyle}
            >
              {renderReason(narrativeText)}
              <FeedbackButton state={feedbackState} setState={setFeedbackState} submit={submitFeedback} />
            </div>
          )}
          {/* Phase 33.E.3 — Metabase recommended action callout */}
          {(customer as any).metabase_health?.recommended_action && (
            <div
              data-recommended-action="1"
              // Phase 33.brand-PR4b — escalation blink for RED-tier customers.
              className={`mt-2 rounded-zoca border border-zoca-border bg-zoca-bg-tint/40 px-3 py-1.5 text-[11px] leading-snug text-zoca-text-2${s.stoplight === "RED" && !isSnoozed ? " b-escalation-blink" : ""}`}
              title="Recommended next action from Metabase Customer Health"
            >
              <span className="font-semibold text-zoca-text">→ </span>
              {(customer as any).metabase_health.recommended_action}
            </div>
          )}
          {/* Modifier flag chips */}
          {(s.flag_performance || s.flag_tickets) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.flag_performance && (
                <FlagChip
                  label={customer.performance?.flag_reasons?.[0] || "Performance flag"}
                  onClick={onSignalChipClick ? () => onSignalChipClick("perf_flag") : undefined}
                />
              )}
              {s.flag_tickets && (
                <FlagChip
                  label={(() => {
                    // Phase 31.v2 — prefer the Metabase per-ticket open_count
                    // (matches the Tickets panel + chip), fall back to the
                    // BaseSheet counter when records haven't been attached.
                    if (!customer.tickets) return "Tickets flag";
                    const count =
                      customer.tickets.open_count ??
                      customer.tickets.open_tickets_30d;
                    return `${count} open ticket${count === 1 ? "" : "s"}`;
                  })()}
                />
              )}
            </div>
          )}
          {/* Phase 26 — signal chip row now renders on all tiers, tier-tinted */}
          {onSignalChipClick && (
            <SignalChipRow customer={customer} onChipClick={onSignalChipClick} tone={s.stoplight} />
          )}
          {/* Phase G6 — Refund / adjustment / promo / credits in last 60 days */}
          {(() => {
            const f60 = (customer as any).metabase_health?.finance_60d;
            if (!f60) return null;
            const fmt = (n: number | null | undefined) =>
              n !== null && n !== undefined && Number.isFinite(Number(n))
                ? `$${Math.round(Number(n)).toLocaleString()}`
                : "";
            let primary: { variant: string; icon: string; label: string; amount: string } | null = null;
            if (f60.has_refund) {
              primary = { variant: "refund", icon: "\u{1F4B0}", label: "Refund", amount: fmt(f60.refund_amount) };
            } else if (f60.has_adjustment) {
              primary = { variant: "adjustment", icon: "\u{1F4B0}", label: "Adjusted", amount: fmt(f60.adjustment_amount) };
            } else if (f60.has_promotion) {
              primary = { variant: "promo", icon: "\u{1F381}", label: "Promo applied", amount: fmt(f60.discount_amount) };
            } else if (f60.has_credits_applied) {
              primary = { variant: "credits", icon: "\u{1FA99}", label: "Credits", amount: fmt(f60.credits_applied) };
            }
            if (!primary) return null;
            const concerning = primary.variant === "refund" || primary.variant === "adjustment";
            const bg = concerning ? "rgba(245, 158, 11, 0.18)" : "rgba(200, 67, 29, 0.14)";
            const fg = concerning ? "#b45309" : "#1d4ed8";
            const titleParts: string[] = [];
            if (f60.has_refund) titleParts.push(`Refund 60d: ${fmt(f60.refund_amount) || "(amount unknown)"}`);
            if (f60.has_adjustment) titleParts.push(`Adjustment 60d: ${fmt(f60.adjustment_amount) || "(amount unknown)"}`);
            if (f60.has_promotion) titleParts.push(`Promotion 60d: ${fmt(f60.discount_amount) || "(amount unknown)"}`);
            if (f60.has_credits_applied) titleParts.push(`Credits applied 60d: ${fmt(f60.credits_applied) || "(amount unknown)"}`);
            const totalEvents =
              (f60.has_refund ? 1 : 0) +
              (f60.has_adjustment ? 1 : 0) +
              (f60.has_promotion ? 1 : 0) +
              (f60.has_credits_applied ? 1 : 0);
            return (
              <div
                data-finance-chip="1"
                className="mt-1.5 inline-flex flex-wrap items-center gap-1.5 rounded-zoca-pill px-2.5 py-0.5 text-[10px] font-semibold"
                style={{ background: bg, color: fg }}
                title={titleParts.join(" \u00b7 ")}
              >
                <span aria-hidden>{primary.icon}</span>
                <span>{primary.label}</span>
                {primary.amount && <span className="font-mono">{primary.amount}</span>}
                {totalEvents > 1 && (
                  <span className="opacity-70" aria-label="more financial events">+more</span>
                )}
              </div>
            );
          })()}
          {/* Phase 33.D.5b — always-visible keyword chip (no expansion needed) */}
          {customer.performance && (customer.performance.active_ranking_count ?? 0) > 0 && (
            <div
              data-keyword-chip="1"
              className="mt-1.5 inline-flex flex-wrap items-center gap-2 rounded-zoca-pill border border-zoca-border bg-zoca-bg-tint/60 px-2.5 py-0.5 text-[10px] text-zoca-text-2"
              title={`Active local-SEO keywords. Distribution: ${customer.performance.rankings_top_3 ?? 0} top-3 / ${customer.performance.rankings_top_10 ?? 0} top-10 / ${customer.performance.rankings_outside_10 ?? 0} outside top-10`}
            >
              <span aria-hidden>🔑</span>
              <span className="font-semibold tabular-nums text-zoca-text">
                {(customer.performance.active_ranking_count ?? 0).toLocaleString()}
          {/* Phase G9 — open churn ticket banner (top-of-funnel save signal) */}
          {(() => {
            const churn: any = (customer as any).metabase_health?.churn;
            const openCount = Number(churn?.open_count ?? 0);
            if (!Number.isFinite(openCount) || openCount <= 0) return null;
            const titles = typeof churn?.ticket_titles === "string" && churn.ticket_titles.trim()
              ? churn.ticket_titles.trim()
              : "(title unknown)";
            const ids = typeof churn?.ticket_ids === "string" && churn.ticket_ids.trim()
              ? churn.ticket_ids.trim()
              : "";
            const latest = typeof churn?.latest_ticket_date === "string" && churn.latest_ticket_date
              ? churn.latest_ticket_date.slice(0, 10)
              : "";
            const titleText = `${openCount} open churn ticket${openCount === 1 ? "" : "s"}: ${titles}${latest ? ` (latest: ${latest})` : ""}${ids ? ` [${ids}]` : ""}`;
            return (
              <div
                data-churn-banner="1"
                // Phase 33.brand-watchfire-PR9-54 — shake when churn newly opens.
                className={`mt-1.5 inline-flex flex-wrap items-center gap-1.5 rounded-zoca-pill px-2.5 py-0.5 text-[10px] font-semibold${churnShakeActive ? " beacon-churn-shake" : ""}`}
                style={{ background: "rgba(220, 38, 38, 0.15)", color: "#b91c1c", border: "1px solid rgba(220, 38, 38, 0.3)" }}
                title={titleText}
              >
                <span aria-hidden>⚠️</span>
                <span>Active churn ticket{openCount > 1 ? `s (${openCount})` : ""}</span>
                <span className="font-normal opacity-80">— review before contact</span>
              </div>
            );
          })()}
              </span>
              <span>keywords</span>
              <span className="text-zoca-text-3" aria-hidden>·</span>
              <span className="tabular-nums">
                <span className="text-emerald-700 font-semibold">{customer.performance.rankings_top_3 ?? 0}</span>
                <span className="text-zoca-text-3"> top-3</span>
                <span className="text-zoca-text-3"> · </span>
                <span className="text-amber-700 font-semibold">{customer.performance.rankings_top_10 ?? 0}</span>
                <span className="text-zoca-text-3"> top-10</span>
              </span>
            </div>
          )}
        </div>

        {/* Right side: action button (state machine) */}
        <div className="flex flex-col items-end gap-1.5">
          {onTogglePinned && (
            <PinButton isPinned={!!isPinned} onToggle={onTogglePinned} popping={popping} />
          )}
          {isSnoozed && snoozedUntil && onUnsnooze ? (
            <SnoozedBanner
              snoozedUntil={snoozedUntil}
              onUnsnooze={onUnsnooze}
            />
          ) : actionState.kind === "done" ? (
            <div
              // Phase 33.brand-watchfire-PR9 — auto-rescue ribbon (#53)
              // sweeps Patina across the panel when AM logs "Connected".
              className={`max-w-[260px] rounded-zoca-lg border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-2 text-right text-[12px] font-semibold leading-snug text-emerald-700 md:max-w-[300px] md:px-4 md:text-[13px]${actionState.choice === "connected" ? " beacon-auto-rescue" : ""}`}
              aria-live="polite"
            >
              ✓ Logged {actionState.choice === "connected" ? "as connected" : actionState.choice === "vm" ? "voicemail" : "no reach"}
              <button
                type="button"
                onClick={() => setActionState({ kind: "idle" })}
                className="ml-2 text-[10px] font-normal text-emerald-700/70 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40"
                aria-label="Undo logged action"
              >
                Undo
              </button>
            </div>
          ) : actionState.kind === "selecting" ? (
            <div className="flex flex-col items-end gap-1.5">
              <div className="text-[10px] uppercase tracking-wider text-zoca-text-2">
                How did it go?
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ActionChip
                  label="✓ Connected"
                  tone="emerald"
                  busy={false}
                  disabled={false}
                  onClick={() => setActionState({ kind: "tagging", choice: "connected", reason: "", followUp: false })}
                />
                <ActionChip
                  label="📞 VM"
                  tone="amber"
                  busy={false}
                  disabled={false}
                  onClick={() => setActionState({ kind: "tagging", choice: "vm", reason: "", followUp: true })}
                />
                <ActionChip
                  label="× No reach"
                  tone="rose"
                  busy={false}
                  disabled={false}
                  onClick={() => setActionState({ kind: "tagging", choice: "noreach", reason: "", followUp: true })}
                />
                <button
                  type="button"
                  onClick={() => setActionState({ kind: "idle" })}
                  className="text-[10px] text-zoca-text-2 underline-offset-2 hover:text-zoca-text hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
                  aria-label="Cancel logging"
                >
                  cancel
                </button>
              </div>
            </div>
          ) : actionState.kind === "tagging" || actionState.kind === "submitting" ? (
            <div className="flex max-w-[300px] flex-col items-end gap-1.5">
              <div className="text-[10px] uppercase tracking-wider text-zoca-text-2">
                {actionState.kind === "submitting" ? "Saving…" : "Tag the call"}
              </div>
              <div className="rounded-zoca border border-zoca-border bg-zoca-bg-tint p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zoca-text-2">Channel</span>
                  <span className="font-medium text-zoca-text">
                    {actionState.kind === "tagging"
                      ? actionState.choice === "connected"
                        ? "✓ Connected"
                        : actionState.choice === "vm"
                          ? "📞 Voicemail"
                          : "× No reach"
                      : "…"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <label htmlFor={`reason-${customer.entity_id}`} className="text-zoca-text-2">
                    Why
                  </label>
                  <select
                    id={`reason-${customer.entity_id}`}
                    value={actionState.kind === "tagging" ? actionState.reason : ""}
                    onChange={(e) => {
                      if (actionState.kind !== "tagging") return;
                      setActionState({
                        ...actionState,
                        reason: e.target.value as ReasonCode | "",
                      });
                    }}
                    disabled={actionState.kind === "submitting"}
                    className="rounded border border-zoca-border bg-zoca-bg-soft/80 px-1.5 py-0.5 text-[11px] text-zoca-text focus:border-zoca-pink-cta focus:outline-none"
                  >
                    <option value="">(skip)</option>
                    <option value="renewal">Renewal</option>
                    <option value="performance">Performance</option>
                    <option value="billing">Billing</option>
                    <option value="complaint">Complaint</option>
                    <option value="check_in">Check-in</option>
                    <option value="onboarding">Onboarding</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <label className="mt-1.5 flex items-center gap-1.5 text-zoca-text-2">
                  <input
                    type="checkbox"
                    checked={actionState.kind === "tagging" ? actionState.followUp : false}
                    onChange={(e) => {
                      if (actionState.kind !== "tagging") return;
                      setActionState({ ...actionState, followUp: e.target.checked });
                    }}
                    disabled={actionState.kind === "submitting"}
                    className="h-3 w-3 cursor-pointer accent-zoca-pink-cta"
                  />
                  Remind me in 7 days
                </label>
                <div className="mt-2 flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActionState({ kind: "idle" })}
                    disabled={actionState.kind === "submitting"}
                    className="text-[10px] text-zoca-text-2 underline-offset-2 hover:text-zoca-text hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 disabled:opacity-50"
                  >
                    cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (actionState.kind !== "tagging") return;
                      submitTaggedAction(actionState.choice, actionState.reason, actionState.followUp);
                    }}
                    disabled={actionState.kind === "submitting"}
                    className="rounded-zoca-pill bg-zoca-pink-cta/20 px-2 py-0.5 text-[11px] font-medium text-zoca-pink-cta transition hover:bg-zoca-pink-cta/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 disabled:opacity-50"
                  >
                    {actionState.kind === "submitting" ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          ) : actionState.kind === "escalating" || actionState.kind === "submittingEscalation" ? (
            <div className="flex max-w-[300px] flex-col items-end gap-1.5">
              <div className="text-[10px] uppercase tracking-wider text-amber-700">
                ↗ Escalate to pod lead
              </div>
              <div className="rounded-zoca border border-amber-400/30 bg-amber-500/10 p-2 text-[11px]">
                <textarea
                  rows={2}
                  autoFocus
                  placeholder="What's blocking you? (optional)"
                  value={actionState.kind === "escalating" ? actionState.note : ""}
                  disabled={actionState.kind === "submittingEscalation"}
                  onChange={(e) => {
                    if (actionState.kind !== "escalating") return;
                    setActionState({ kind: "escalating", note: e.target.value });
                  }}
                  className="w-full rounded border border-zoca-border bg-zoca-bg-soft/80 px-1.5 py-1 text-[11px] text-zoca-text placeholder:text-zoca-text-2 focus:border-zoca-pink-cta focus:outline-none"
                />
                <div className="mt-1 flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActionState({ kind: "idle" })}
                    disabled={actionState.kind === "submittingEscalation"}
                    className="text-[10px] text-zoca-text-2 underline-offset-2 hover:text-zoca-text hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 disabled:opacity-50"
                  >
                    cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const note = actionState.kind === "escalating" ? actionState.note : "";
                      submitEscalation(note);
                    }}
                    disabled={actionState.kind === "submittingEscalation"}
                    className="rounded-zoca-pill bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition hover:bg-amber-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 disabled:opacity-50"
                  >
                    {actionState.kind === "submittingEscalation" ? "Sending…" : "Escalate"}
                  </button>
                </div>
              </div>
            </div>
          ) : actionState.kind === "escalated" ? (
            <div
              className="max-w-[260px] rounded-zoca-lg border border-amber-400/30 bg-amber-500/10 px-3.5 py-2 text-right text-[12px] font-semibold leading-snug text-amber-700 md:max-w-[300px] md:px-4 md:text-[13px]"
              aria-live="polite"
            >
              ↗ Escalated{actionState.to ? ` to ${actionState.to.split(" ")[0]}` : ""}
              <button
                type="button"
                onClick={() => setActionState({ kind: "idle" })}
                className="ml-2 text-[10px] font-normal text-amber-700/70 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/40"
              >
                Undo
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-1">
              <button
                ref={primaryCtaRef}
                type="button"
                aria-label={`Action: ${actionLabel(customer)}. Click to log how it went.`}
                className={primaryCtaClass}
                onClick={() => setActionState({ kind: "selecting" })}
              >
                {actionLabel(customer)}
              </button>
              {s.stoplight === "RED" && (
                <button
                  type="button"
                  onClick={() => setActionState({ kind: "escalating", note: "" })}
                  className="text-[10px] text-zoca-text-2 underline-offset-2 hover:text-amber-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
                  aria-label="Escalate to pod lead"
                  title="Stuck on this customer? Send to your pod lead."
                >
                  ↗ Escalate
                </button>
              )}
              {onSnooze && (
                <SnoozeMenu onPick={(days) => handleSnoozeWithAnimation(days)} />
              )}
            </div>
          )}
          {actionState.kind === "error" && (
            <div
              role="alert"
              className="max-w-[260px] rounded-zoca-sm border border-zoca-pink/30 bg-zoca-pink/10 px-2 py-1 text-right text-[10px] text-zoca-pink-bright md:max-w-[300px]"
            >
              Couldn’t log: {actionState.message}
              <button
                type="button"
                onClick={() => setActionState({ kind: "idle" })}
                className="ml-1 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink/40"
                aria-label="Dismiss error and retry"
              >
                retry
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Metrics summary line — render on ALL tiers (Phase 26) */}
      {/* Phase 33.brand-watchfire-PR9-51 — comm-spark ember dot rises
          from this row when last_touch_at advanced since last view. */}
      <div
        className={`border-t border-zoca-border px-4 py-2.5 text-[11px] text-zoca-text-2 md:px-5${commSparkActive ? " beacon-comm-spark" : ""}`}
      >
        {renderMetricsSummary(customer)}
      </div>

      {/* HubSpot "last call" summary — Fireflies-derived sentiment + topics (Phase 13) */}
      {customer.hubspot?.last_call && (
        <div className="border-t border-zoca-border px-4 py-2.5 text-[11px] text-zoca-text-2 md:px-5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-medium text-zoca-text-2">📞 Last call</span>
            <span title={customer.hubspot.last_call.date}>
              {daysSince(customer.hubspot.last_call.date)}d ago
            </span>
            <span
              className={`rounded-zoca-pill px-1.5 py-0.5 text-[10px] font-medium ${
                customer.hubspot.last_call.sentiment === "frustrated"
                  ? "bg-zoca-pink/18 text-zoca-pink-bright"
                  : customer.hubspot.last_call.sentiment === "warm"
                    ? "bg-emerald-500/18 text-emerald-700"
                    : "bg-zoca-bg-tint text-zoca-text-2"
              }`}
            >
              {customer.hubspot.last_call.sentiment === "frustrated"
                ? "😟 frustrated"
                : customer.hubspot.last_call.sentiment === "warm"
                  ? "😊 warm"
                  : "— neutral"}
            </span>
            {customer.hubspot.last_call.topics.length > 0 && (
              <span className="text-zoca-text-2" title="Topics extracted from the meeting note">
                · topics: <span className="text-zoca-text-2">{customer.hubspot.last_call.topics.join(", ")}</span>
              </span>
            )}
            {customer.hubspot.last_call.fireflies_url && (
              <a
                href={customer.hubspot.last_call.fireflies_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-zoca-pink-cta underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
              >
                Fireflies →
              </a>
            )}
          </div>
          {customer.hubspot.last_call.action_items.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-[11px] text-zoca-text-2">
              {customer.hubspot.last_call.action_items.slice(0, 3).map((item, i) => (
                <li key={i} className="truncate" title={item}>
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Performance signals + Notes + Contacts (expand-on-demand; per-tier auto-expand) */}
      <div className="border-t border-zoca-border px-4 py-2.5 md:px-5">
        {customer.performance ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-zoca-text-2 transition hover:text-zoca-pink-cta focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
              aria-expanded={expanded}
              aria-controls={`perf-${customer.entity_id}`}
              title={expanded ? "Hide performance signals" : "Show performance signals (why this customer is on this stoplight)"}
            >
              <span aria-hidden>{expanded ? "▾" : "▸"}</span>
              {expandToggleLabel(!expanded)}
              {customer.performance?.flag && !expanded && (
                <span
                  className="ml-1 inline-flex items-center rounded-zoca-pill bg-zoca-pink/18 px-1.5 py-0.5 text-[10px] font-medium text-zoca-pink-bright"
                  title={(customer.performance.flag_reasons || []).join(" · ") || "Performance trajectory flagged"}
                >
                  ⚑ {performanceChipSummary(customer.performance) || "trajectory"}
                </span>
              )}
            </button>
            {expanded && (
              <div id={`perf-${customer.entity_id}`}>
                {/* Phase 18.B — private notes (AM-specific) */}
                <div style={{ marginTop: "12px", marginBottom: "16px" }}>
                  <div className="zoca-micro-label" style={{ marginBottom: "8px" }}>
                    Notes (private)
                  </div>
                  <NotesField
                    amName={notesAmName}
                    entityId={customer.entity_id}
                    customerId={customer.customer_id ?? null}
                    bizname={customer.company ?? null}
                  />
                </div>
                <V2PerformancePanel performance={customer.performance} tier={s.stoplight} />
                {customer.hubspot?.contacts && customer.hubspot.contacts.length > 0 && (
                  <ContactsSection contacts={customer.hubspot.contacts} bizname={customer.company ?? undefined} amName={notesAmName} />
                )}
              </div>
            )}
          </>
        ) : customer.hubspot?.contacts && customer.hubspot.contacts.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-zoca-text-2 transition hover:text-zoca-pink-cta focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
              aria-expanded={expanded}
              aria-controls={`contacts-${customer.entity_id}`}
              title={expanded ? "Hide contacts" : "Show contacts"}
            >
              <span aria-hidden>{expanded ? "▾" : "▸"}</span>
              {expandToggleLabel(!expanded)}
            </button>
            {expanded && (
              <div id={`contacts-${customer.entity_id}`}>
                <div style={{ marginTop: "12px", marginBottom: "16px" }}>
                  <div className="zoca-micro-label" style={{ marginBottom: "8px" }}>
                    Notes (private)
                  </div>
                  <NotesField
                    amName={notesAmName}
                    entityId={customer.entity_id}
                    customerId={customer.customer_id ?? null}
                    bizname={customer.company ?? null}
                  />
                </div>
                <ContactsSection contacts={customer.hubspot.contacts} bizname={customer.company ?? undefined} amName={notesAmName} />
              </div>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-zoca-text-2 transition hover:text-zoca-pink-cta focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
              aria-expanded={expanded}
              aria-controls={`notes-${customer.entity_id}`}
              title={expanded ? "Hide notes" : "Show notes"}
            >
              <span aria-hidden>{expanded ? "▾" : "▸"}</span>
              {expandToggleLabel(!expanded)}
            </button>
            {expanded && (
              <div id={`notes-${customer.entity_id}`}>
                <div style={{ marginTop: "12px", marginBottom: "16px" }}>
                  <div className="zoca-micro-label" style={{ marginBottom: "8px" }}>
                    Notes (private)
                  </div>
                  <NotesField
                    amName={notesAmName}
                    entityId={customer.entity_id}
                    customerId={customer.customer_id ?? null}
                    bizname={customer.company ?? null}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Stoplight dot — with hover tooltip
// ---------------------------------------------------------------------------

function StoplightDot({ light, healthTier }: { light: Stoplight; healthTier?: string | null }) {
  // Phase 33.E.3 — when the customer has a metabase_health tier, color the
  // dot with the 4-tier palette. Falls back to old 3-tier when unmapped.
  const normTier = healthTier ? normalizeHealthTier(healthTier) : null;
  const color = normTier
    ? HEALTH_TIER_COLORS[normTier]
    : (light === "RED" ? "#ef4444" : light === "YELLOW" ? "#f59e0b" : "#10b981");
  const label = normTier ? HEALTH_TIER_LABELS[normTier] : STOPLIGHT_TITLE[light];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="mt-1.5 inline-block h-3 w-3 flex-shrink-0 cursor-help rounded-full"
      style={{ backgroundColor: color, boxShadow: `0 0 12px ${color}` }}
    />
  );
}

function FlagChip({ label, onClick }: { label: string; onClick?: () => void }) {
  const base =
    "rounded-zoca-sm bg-amber-500/18 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-500/30";
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${base} v2-chip-clickable`}
        title={`Filter to: ${label}`}
        aria-label={`Filter to ${label}`}
      >
        {label}
      </button>
    );
  }
  return <span className={base}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Phase 22.B.1 + Phase 26 — SignalChipRow.
// Now tier-aware: RED/YELLOW render negative signal chips at the existing
// thresholds in their respective tones, and GREEN renders positive chips
// (ACTIVE COMMS / APP STRONG / LEADS UP / REVIEWS ON TRACK).
// ---------------------------------------------------------------------------

type ChipTone = "RED" | "YELLOW" | "GREEN";

function SignalChipRow({
  customer,
  onChipClick,
  tone,
}: {
  customer: ScoredCustomerV2;
  onChipClick: (key: SignalKey) => void;
  tone: ChipTone;
}) {
  const s = customer.signals_v2;
  const { metrics } = customer;

  // Negative signals (used on RED + YELLOW)
  const negativeActive: { key: SignalKey; label: string }[] = [];
  if ((s.sig_client_silent ?? 0) >= 65)
    negativeActive.push({ key: "client_silent", label: "Client silent" });
  if ((s.sig_we_silent ?? 0) >= 65)
    negativeActive.push({ key: "we_silent", label: "We silent" });
  if ((s.sig_response_drop ?? 0) >= 65)
    negativeActive.push({ key: "resp_drop", label: "Resp drop" });
  if ((s.sig_volume_collapse ?? 0) >= 55)
    negativeActive.push({ key: "vol_collapse", label: "Vol collapse" });
  if ((s.sig_usage ?? 0) >= 55)
    negativeActive.push({ key: "usage_low", label: "Usage low" });
  if ((s.sig_billing ?? 0) >= 40)
    negativeActive.push({ key: "billing", label: "Billing" });

  // Positive signals (used on GREEN when no negatives are active)
  const positiveActive: { label: string }[] = [];
  if (metrics.total_30d >= 8) {
    positiveActive.push({ label: "Active comms" });
  }
  if (customer.usage?.engagement_tier === "Active") {
    positiveActive.push({ label: "App strong" });
  }
  if (
    customer.performance?.ytd_leads_change_pct !== null &&
    customer.performance?.ytd_leads_change_pct !== undefined &&
    customer.performance.ytd_leads_change_pct >= 20
  ) {
    positiveActive.push({ label: "Leads up" });
  }
  if (
    customer.performance?.weeks_with_zero_reviews !== null &&
    customer.performance?.weeks_with_zero_reviews !== undefined &&
    customer.performance.weeks_with_zero_reviews <= 2
  ) {
    positiveActive.push({ label: "Reviews on track" });
  }

  // Choose what to render based on tone + activity
  let chipsToRender: React.ReactNode[] = [];
  if (tone === "GREEN") {
    // GREEN: surface positives. If none, render nothing.
    if (positiveActive.length === 0) return null;
    chipsToRender = positiveActive.map((c, i) => (
      <span
        key={`pos-${i}`}
        className="rounded-full bg-emerald-500/12 px-[11px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700 ring-1 ring-emerald-500/25"
        title={c.label}
      >
        {c.label}
      </span>
    ));
  } else {
    // RED / YELLOW: surface negatives.
    if (negativeActive.length === 0) return null;
    const chipClass =
      tone === "RED"
        ? "v2-chip-clickable rounded-full bg-zoca-pink/12 px-[11px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-zoca-pink-bright ring-1 ring-zoca-pink/25"
        : "v2-chip-clickable rounded-full bg-amber-500/12 px-[11px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-500/25";
    chipsToRender = negativeActive.map((c) => (
      <button
        key={c.key}
        type="button"
        onClick={() => onChipClick(c.key)}
        className={chipClass}
        title={`Filter book to: ${c.label}`}
        aria-label={`Filter book to ${c.label}`}
      >
        {c.label}
      </button>
    ));
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">{chipsToRender}</div>
  );
}

// ---------------------------------------------------------------------------
// Phase 18.A — Pin button. Lives top-right on every tier variant. Pink when
// pinned (glow + filled), muted when not. Parent owns the toggled state.
// ---------------------------------------------------------------------------

function PinButton({
  isPinned,
  onToggle,
  popping = false,
}: {
  isPinned: boolean;
  onToggle: () => void;
  /** Phase 22.C — when true, the icon plays the v2-pin-pop keyframe (spring + rotation). */
  popping?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex items-center justify-center transition cursor-pointer"
      style={{
        width: "28px",
        height: "28px",
        borderRadius: "8px",
        background: "transparent",
        border: "1px solid var(--zoca-border)",
        color: isPinned ? "var(--zoca-pink)" : "var(--zoca-text-2)",
        boxShadow: isPinned ? "0 0 12px rgba(252, 228, 214, 0.4)" : "none",
        flexShrink: 0,
      }}
      title={isPinned ? "Unpin" : "Pin"}
      aria-label={isPinned ? "Unpin customer" : "Pin customer"}
      aria-pressed={isPinned}
    >
      <i
        className={`ti ti-pin${popping ? " v2-pin-popping" : ""}`}
        style={{ fontSize: "15px", display: "inline-block" }}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Phase 19: SnoozeMenu — outline button that pops a small panel with day
// presets.
// ---------------------------------------------------------------------------

function SnoozeMenu({ onPick, size = "sm" }: { onPick: (days: number) => void; size?: "sm" | "xs" }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const fontSize = size === "xs" ? "10.5px" : "11px";
  const padding = size === "xs" ? "4px 10px" : "5px 12px";
  const presets: { label: string; days: number }[] = [
    { label: "1 day", days: 1 },
    { label: "3 days", days: 3 },
    { label: "7 days", days: 7 },
    { label: "14 days", days: 14 },
    { label: "30 days", days: 30 },
  ];
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="zoca-btn zoca-btn-ghost"
        style={{ fontSize, padding }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Snooze customer"
        title="Hide this customer from your triage view for N days"
      >
        Snooze ▾
      </button>
      {open && (
        <div
          role="menu"
          // Phase 33.brand-watchfire-PR7-39 — brass border draw on snooze dropdown entry.
          className="beacon-dropdown-entry absolute right-0 z-20 mt-1 rounded-zoca border border-zoca-border bg-zoca-bg-soft py-1 shadow-zoca-sm"
          style={{ minWidth: 110 }}
        >
          {presets.map((p) => (
            <button
              key={p.days}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(p.days);
              }}
              className="block w-full px-3 py-1 text-left text-[11.5px] text-zoca-text hover:bg-zoca-bg-soft"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SnoozedBanner({
  snoozedUntil,
  onUnsnooze,
}: {
  snoozedUntil: string;
  onUnsnooze: () => void;
}) {
  const dt = new Date(snoozedUntil);
  const label = isNaN(dt.getTime())
    ? snoozedUntil
    : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className="rounded-zoca-pill px-2.5 py-1 text-[11px] font-medium"
        style={{
          background: "rgba(245, 158, 11, 0.10)",
          color: "#92400e",
          border: "1px solid rgba(245, 158, 11, 0.30)",
        }}
        aria-live="polite"
      >
        💤 Snoozed until {label}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnsnooze();
        }}
        className="zoca-btn zoca-btn-ghost"
        style={{ fontSize: "10.5px", padding: "4px 10px" }}
        aria-label="Unsnooze customer"
      >
        Unsnooze
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics summary — render with channels used + app tier color + billing detail
// ---------------------------------------------------------------------------

function renderMetricsSummary(c: ScoredCustomerV2) {
  const { metrics } = c;
  const lastTouch =
    metrics.last_any_iso === null
      ? "Last touch: never"
      : `Last touch: ${daysSince(metrics.last_any_iso)}d ago`;

  const channelsUsed = (metrics.channels_used_30d || "").split(",").filter(Boolean);
  const channelText =
    metrics.total_30d === 0
      ? "0 comms in 30d"
      : channelsUsed.length === 0
        ? `${metrics.total_30d} comms in 30d`
        : `${metrics.total_30d} comms in 30d · ${channelsUsed.join("/")}`;

  const usageNode =
    c.usage != null ? (
      <span>
        App: <span className={(ENGAGEMENT_COLOR[c.usage.engagement_tier] || ENGAGEMENT_FALLBACK)}>{c.usage.engagement_tier}</span>
      </span>
    ) : (
      <span className="text-red-300">App: no data</span>
    );

  const billingNode = c.billing && c.billing.unpaid_invoice_count > 0 ? (
    <span className="text-zoca-pink-text">
      {c.billing.unpaid_invoice_count} unpaid
      {c.billing.total_amount_due_cents > 0 &&
        ` ($${Math.round(c.billing.total_amount_due_cents / 100)})`}
      {c.billing.days_past_oldest_unpaid > 0 &&
        ` · ${c.billing.days_past_oldest_unpaid}d overdue`}
    </span>
  ) : null;

  const parts: React.ReactNode[] = [
    <span key="lt">{lastTouch}</span>,
    <span key="ct">{channelText}</span>,
    <span key="us">{usageNode}</span>,
  ];
  if (billingNode) parts.push(<span key="bl">{billingNode}</span>);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {parts.map((node, i) => (
        <span key={i} className="inline-flex items-center gap-3">
          {i > 0 && <span className="opacity-60">·</span>}
          {node}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeTrend(t: "improving" | "worsening" | "stable" | "unknown"): {
  label: string;
  className: string;
  title: string;
} {
  switch (t) {
    case "worsening":
      return {
        label: "↑ Worsening",
        className: "bg-red-500/15 text-red-300",
        title: "Composite score increased vs. 7 days ago",
      };
    case "improving":
      return {
        label: "↓ Improving",
        className: "bg-green-500/15 text-green-300",
        title: "Composite score decreased vs. 7 days ago",
      };
    case "stable":
      return {
        label: "— Stable",
        className: "bg-zoca-bg-soft/60 text-zoca-text-2",
        title: "Composite score unchanged vs. 7 days ago",
      };
    case "unknown":
    default:
      return { label: "", className: "", title: "" };
  }
}

function actionLabel(c: ScoredCustomerV2): string {
  const action = c.signals_v2.suggested_action || "";
  if (!action || action === "No action needed.") return "Note · doing fine";
  return action.replace(/\.$/, "");
}

function daysSince(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400_000));
}

/**
 * Render the rationale safely: parse only <b>...</b> markers into React
 * <strong> nodes; all other markup is stripped to plain text. XSS-safe.
 */
function renderReason(text: string): React.ReactNode {
  if (!text) return null;
  const stripped = text.replace(/<(?!\/?b\b)[^>]*>/gi, "");
  const parts = stripped.split(/<b\b[^>]*>([\s\S]*?)<\/b>/gi);
  return parts.map((part, i) =>
    i % 2 === 0 ? (
      <span key={i}>{part}</span>
    ) : (
      <strong key={i} className="font-semibold text-zoca-text">
        {part}
      </strong>
    ),
  );
}

function FeedbackButton({
  state,
  setState,
  submit,
}: {
  state:
    | { kind: "idle" }
    | { kind: "open"; comment: string }
    | { kind: "submitting" }
    | { kind: "done" }
    | { kind: "error"; message: string };
  setState: React.Dispatch<React.SetStateAction<any>>;
  submit: (comment: string) => Promise<void>;
}) {
  // Phase 33.brand-watchfire-PR7-40 — chip shrinks 250ms before form opens.
  const [wrongShrinking, setWrongShrinking] = useState(false);
  if (state.kind === "done") {
    return (
      <span
        className="ml-2 inline-flex items-center rounded-zoca-pill bg-emerald-500/18 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
        aria-live="polite"
      >
        ✓ Reported — thanks
      </span>
    );
  }
  if (state.kind === "open" || state.kind === "submitting" || state.kind === "error") {
    const comment = state.kind === "open" ? state.comment : "";
    return (
      <span className="ml-2 inline-flex items-center gap-1 align-baseline">
        <input
          type="text"
          autoFocus
          placeholder="What's wrong? (optional)"
          value={comment}
          disabled={state.kind === "submitting"}
          onChange={(e) =>
            state.kind === "open" && setState({ kind: "open", comment: e.target.value })
          }
          onKeyDown={(e) => {
            if (e.key === "Escape") setState({ kind: "idle" });
            if (e.key === "Enter") submit(comment);
          }}
          className="w-44 rounded border border-zoca-border bg-zoca-bg-soft/80 px-2 py-0.5 text-[11px] text-zoca-text placeholder:text-zoca-text-2 focus:border-zoca-pink-cta focus:outline-none"
          aria-label="Feedback comment"
        />
        <button
          type="button"
          onClick={() => submit(comment)}
          disabled={state.kind === "submitting"}
          className="text-[11px] text-zoca-pink-cta underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 disabled:opacity-50"
          aria-label="Submit feedback"
        >
          {state.kind === "submitting" ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          className="text-[11px] text-zoca-text-2 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
          aria-label="Cancel feedback"
        >
          cancel
        </button>
        {state.kind === "error" && (
          <span className="text-[10px] text-zoca-pink-bright" role="alert">
            {state.message}
          </span>
        )}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        // Phase 33.brand-watchfire-PR7-40 — quick shrink before form mounts.
        setWrongShrinking(true);
        setTimeout(() => setState({ kind: "open", comment: "" }), 250);
      }}
      className={`ml-2 inline-flex items-center rounded-zoca-pill px-1.5 py-0.5 text-[10px] font-medium text-zoca-text-2 transition hover:bg-zoca-bg-tint hover:text-zoca-pink-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 align-baseline${wrongShrinking ? " beacon-wrong-shrink" : ""}`}
      aria-label="This signal looks wrong — send feedback"
      title="This signal looks wrong — let us know"
    >
      ✗ wrong?
    </button>
  );
}

type ActionChoice = "connected" | "vm" | "noreach";

function ActionChip({
  label,
  tone,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  tone: "emerald" | "amber" | "rose";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-400/40 bg-emerald-500/18 text-emerald-700 hover:bg-emerald-500/25"
      : tone === "amber"
        ? "border-amber-400/40 bg-amber-500/18 text-amber-700 hover:bg-amber-500/25"
        : "border-zoca-pink/40 bg-zoca-pink/18 text-zoca-pink-bright hover:bg-zoca-pink/25";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-zoca-pill border px-2 py-1 text-[11px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40 ${toneClass} ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      } ${busy ? "animate-pulse" : ""}`}
      aria-label={`Log contact result: ${label}`}
    >
      {label}
    </button>
  );
}

const V2CustomerCard = memo(V2CustomerCardInner, (prev, next) => {
  return (
    prev.customer.entity_id === next.customer.entity_id &&
    prev.customer.signals_v2.composite === next.customer.signals_v2.composite &&
    prev.customer.signals_v2.stoplight === next.customer.signals_v2.stoplight &&
    prev.customer.performance?.flag === next.customer.performance?.flag &&
    prev.trend === next.trend &&
    prev.recentlyContacted === next.recentlyContacted &&
    prev.isPinned === next.isPinned &&
    prev.onTogglePinned === next.onTogglePinned
  );
});

export default V2CustomerCard;

function performanceChipSummary(p: NonNullable<ScoredCustomerV2["performance"]>): string | null {
  if (!p.flag) return null;
  const parts: string[] = [];
  if (p.gbp_clicks_drop_pct !== null && p.gbp_clicks_drop_pct >= 25) {
    parts.push(`GBP ▼${Math.round(p.gbp_clicks_drop_pct)}%`);
  }
  if (p.weeks_with_zero_reviews !== null && p.weeks_with_zero_reviews >= 4) {
    parts.push(`${p.weeks_with_zero_reviews}wk zero`);
  }
  if (p.ytd_leads_change_pct !== null && p.ytd_leads_change_pct <= -20) {
    parts.push(`YTD ▼${Math.abs(Math.round(p.ytd_leads_change_pct))}%`);
  }
  if (!parts.length) return null;
  return parts.slice(0, 2).join(" · ");
}

// ---------------------------------------------------------------------------
// BiznameLink (Phase 20)
//
// Wraps the bizname text so that when the customer has a matched HubSpot
// company id we render an anchor that opens the HubSpot company page in a
// new tab. On hover, an external-link icon appears to the right. When there
// is no company id we just render the children as a plain span so layout
// stays identical.
// ---------------------------------------------------------------------------

type BiznameLinkProps = {
  bizname: string;
  /** Phase 33.D — HubSpot Locations record id (replaces hubspotCompanyId). */
  hubspotLocationRecordId?: string;
  children: React.ReactNode;
};

function BiznameLink({ bizname, hubspotLocationRecordId, children }: BiznameLinkProps) {
  if (!hubspotLocationRecordId) {
    return <>{children}</>;
  }
  return (
    <a
      href={buildHubspotLocationUrl(hubspotLocationRecordId)}
      target="_blank"
      rel="noopener noreferrer"
      className="group/biz inline-flex items-baseline gap-1"
      style={{
        color: "inherit",
        textDecoration: "none",
        cursor: "pointer",
      }}
      title={`Open ${bizname} in HubSpot Locations (new tab)`}
    >
      {children}
      <i
        className="ti ti-external-link opacity-0 transition-opacity group-hover/biz:opacity-100"
        aria-hidden
        style={{ fontSize: "12px", lineHeight: 1, color: "var(--zoca-text-3, #94a3b8)" }}
      />
    </a>
  );
}

// ---------------------------------------------------------------------------
// CONTACTS section (Phase 14C — Tier E: buyer-side org chart)
//
// Surfaces up to 5 HubSpot contacts per customer inside the "Why?" expand,
// matching the styling of the PERFORMANCE SIGNALS section in V2PerformancePanel.
// ---------------------------------------------------------------------------

type ContactsSectionProps = {
  contacts: NonNullable<NonNullable<ScoredCustomerV2["hubspot"]>["contacts"]>;
  /** Phase 20 — passed through so mailto: subject/body can be pre-filled. */
  bizname?: string;
  amName?: string;
};

function ContactsSection({ contacts, bizname, amName }: ContactsSectionProps) {
  if (!contacts || contacts.length === 0) return null;
  return (
    <div className="mt-3 rounded-zoca-sm border border-zoca-border bg-zoca-surface-soft/40 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zoca-text-2">
        Contacts
      </div>
      <ul className="space-y-1.5">
        {contacts.slice(0, 5).map((c) => {
          const sinceLabel = c.last_activity ? `${daysSince(c.last_activity)}d ago` : "—";
          return (
            <li
              key={c.contact_id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px]"
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-zoca-text">{c.name}</span>
                {c.job_title && (
                  <span className="text-[10px] text-zoca-text-2">{c.job_title}</span>
                )}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-2">
                {c.email ? (
                  <a
                    href={buildMailto(c.email, { bizname, amName })}
                    className="inline-flex items-center gap-1 hover:underline"
                    style={{ color: "var(--zoca-blue, #2563eb)", textDecoration: "none" }}
                    title={`Email ${c.name} — opens your mail client with a pre-filled draft`}
                  >
                    <i className="ti ti-mail" aria-hidden style={{ fontSize: "11px", lineHeight: 1 }} />
                    {c.email}
                  </a>
                ) : (
                  <span className="text-zoca-text-2">—</span>
                )}
                <span className="text-[10px] text-zoca-text-2" title={c.last_activity || ""}>
                  {sinceLabel}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

"use client";

/**
 * Brain Wave 2c — read-only Keeper panel on the Customer 360 page.
 *
 * Shows topic-clustered confirmed facts the AM / bootstrap have saved.
 * Each row is "field_label — value" with a small source pill + relative
 * timestamp. Beam reads from the same data when answering questions
 * about this customer; this panel makes that visible.
 *
 * Wave 2c.1 — visual polish to match Watchfire (ember + brass + char):
 *   - Category icons (Lucide) for identity / operational / behavioral /
 *     concerns / relationship leading each topic section AND each row's
 *     subcategory header.
 *   - Relative-time chips on every row (computed from updated_at, not
 *     confirmed_at — updated_at is what `ranking.ts` recency_weight uses,
 *     so it's the more honest "is this still fresh?" indicator).
 *   - Source-trust pills colored to match the `sourceTrust()` hierarchy
 *     in lib/brain/ranking.ts (basesheet/chargebee → patina-green,
 *     manual → ember, customer_note → brass, beacon_ai_extracted →
 *     muted purple, beacon_ai_conversation → smoke-gray).
 *   - "View history" affordance — small clock-icon button on each row
 *     that fetches `/api/v2/brain/fact/{fact_id}/history` and expands
 *     the version log inline (no popover/modal — keeps the panel
 *     mobile-friendly and avoids z-index gymnastics inside the
 *     Customer 360 column).
 *
 * Wave 2d (deferred): add-via-panel (manual entry without going through
 * Beam). For v1, AMs add facts by talking to Beam; this panel
 * is read-only.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Clock,
  History,
  RotateCcw,
  Settings,
  Smile,
  User,
  Users,
} from "lucide-react";
import type {
  BrainFact,
  BrainFactVersion,
  TopicCategory,
} from "@/lib/brain/types";
// WAVE-A-1 — Memory Score header chip. Lives in the panel header so AMs see
// "X% covered" the moment the Keeper panel opens.
import KeeperChip from "@/components/keeper/KeeperChip";
// WAVE-C-2 — voice-teach surface. Brass mic next to the chip lets AMs speak
// a fact for THIS customer, see a confirm card, and write through the
// existing writeBrainFact path. onSaved bumps refreshNonce so the new row
// appears immediately without page reload.
import KeeperMicButton from "@/components/keeper/KeeperMicButton";

type Props = {
  entityId: string;
};

/**
 * WAVE-A-2 — fact shape with the per-row can_revert flag the API hydrates
 * from `lib/brain/revert.ts canRevert()`. Drives the inline ↺ Revert action
 * surfaced on hover, only for facts that actually have a superseded ancestor.
 */
type FactWithRevert = BrainFact & { can_revert?: boolean };

type FetchResponse = {
  ok: boolean;
  entity_id: string;
  customer_id: string | null;
  bizname: string | null;
  /** Wave 1.1 — derived from snapshot; null when entity not on the book. */
  currently_managed: {
    current_am: string | null;
    current_ae: string | null;
    current_pod: string | null;
    current_sp: string | null;
  } | null;
  facts: FactWithRevert[];
  grouped: {
    identity: FactWithRevert[];
    operational: FactWithRevert[];
    behavioral: FactWithRevert[];
    concerns: FactWithRevert[];
    /** Wave 1.1 — new top-level category. */
    relationship: FactWithRevert[];
  };
  facts_count: number;
  reason?: string;
  error?: string;
};

type HistoryResponse = {
  ok: boolean;
  fact_id: string;
  versions?: BrainFactVersion[];
  error?: string;
};

/** Maps schema field_name → human-friendly label for panel display. */
const FIELD_LABELS: Record<string, string> = {
  // identity / owner_info
  owner_name: "Owner",
  owner_nickname: "Nickname",
  owner_role: "Role",
  decision_style: "Decision style",
  // identity / decision_makers
  secondary_contacts: "Secondary contacts",
  manager_relationships: "Manager relationships",
  // identity / sold_by
  sold_by_ae: "Sold by",
  sold_at: "Sale date",
  sales_promise: "Sales promise",
  time_to_first_value: "Time to value",
  // identity / assignment (Wave 1.1)
  transition_history: "Transition history",
  last_transition_at: "Last transition",
  transition_reason: "Transition reason",
  customer_relationship_context: "Relationship context",
  current_am: "AM",
  current_ae: "AE",
  current_pod: "Pod",
  current_sp: "SP",
  // identity / business_profile (Wave 1.1)
  service_focus: "Service focus",
  service_mix: "Service mix",
  location_count: "Locations",
  staff_count: "Staff",
  business_age: "In business",
  ownership_structure: "Ownership",
  business_model_note: "Business model",
  aesthetic_market_segment: "Market segment",
  // operational / contract
  contract_terms: "Contract terms",
  custom_pricing: "Custom pricing",
  contract_start: "Contract start",
  contract_renewal_at: "Renews",
  mrr_amount: "MRR",
  // operational / integration
  platform: "Platform",
  integration_state: "Integration state",
  integration_notes: "Integration notes",
  // operational / feature_usage
  features_active: "Features active",
  features_inactive: "Features inactive",
  feature_adoption_notes: "Feature notes",
  // operational / tech_stack (Wave 1.1)
  gbp_url: "GBP",
  website_url: "Website",
  booking_url: "Booking page",
  review_platforms: "Review platforms",
  pos_system: "POS",
  social_handles: "Social",
  email_marketing_tool: "Email marketing",
  // operational / renewal (Wave 1.1)
  renewal_advocates: "Renewal advocates",
  renewal_pull_factors: "Pull factors",
  renewal_push_factors: "Push factors",
  renewal_risk_level: "Renewal risk",
  retention_strategy: "Retention play",
  pricing_sensitivity_notes: "Pricing sensitivity",
  renewal_decision_makers: "Renewal approvers",
  // operational / onboarding (Wave 1.1)
  onboarded_by_csm: "Onboarded by",
  onboarding_completed_at: "Onboarded at",
  time_to_first_lead: "Time to first lead",
  first_value_event: "First value",
  onboarding_friction_points: "Onboarding friction",
  // operational / performance_context (Wave 1.1)
  gbp_setup_quality: "GBP setup",
  review_velocity_pattern: "Review velocity",
  seasonal_dependency_strength: "Seasonality",
  known_growth_levers: "Growth levers",
  // behavioral / payment_pattern
  payment_timing: "Payment timing",
  payment_method_preference: "Payment method",
  auto_debit_history: "Auto-debit history",
  // behavioral / comms_preference
  preferred_channel: "Preferred channel",
  channel_avoid: "Avoid channel",
  response_pattern: "Response pattern",
  best_time_to_reach: "Best time to reach",
  // behavioral / seasonal
  high_season_months: "High season",
  low_season_notes: "Low season notes",
  vacation_dates: "Vacation",
  // behavioral / demo_style
  demo_engagement: "Demo engagement",
  follow_up_pattern: "Follow-up pattern",
  // behavioral / competitive_context (Wave 1.1)
  prior_platforms: "Prior platforms",
  competing_offers_seen: "Competing offers",
  why_chose_zoca: "Why Zoca",
  switch_risks: "Switch risks",
  churn_attempt_history: "Churn attempts",
  // concerns / latent_risk
  risk_description: "Risk",
  risk_severity: "Risk severity",
  watch_until: "Watch until",
  // concerns / next_call_agenda
  agenda_item: "Next-call agenda",
  raised_by: "Raised by",
  raised_at: "Raised at",
  // concerns / soft_red_flag
  flag_description: "Red flag",
  flag_category: "Flag category",
  // relationship / advocacy (Wave 1.1)
  nps_score: "NPS",
  would_refer_likelihood: "Would refer?",
  has_referred: "Has referred",
  case_study_eligible: "Case-study eligible",
  public_quote_eligible: "Quote eligible",
  // relationship / engagement (Wave 1.1)
  meeting_cadence: "Meeting cadence",
  last_in_person_meeting: "Last in-person",
  community_events_attended: "Community events",
  // long-tail
  other: "Other",
};

function labelFor(field_name: string): string {
  return FIELD_LABELS[field_name] ?? field_name;
}

/**
 * Category icon mapping — Lucide React, sized to the row leading metric.
 * Identity = a person, operational = settings cog, behavioral = mood face,
 * concerns = warning triangle, relationship = people group. Chosen to be
 * unambiguous at 12px and to read at a glance without needing color cues.
 */
const CATEGORY_ICONS: Record<TopicCategory, typeof User> = {
  identity: User,
  operational: Settings,
  behavioral: Smile,
  concerns: AlertTriangle,
  relationship: Users,
};

/**
 * Source-trust pill colors. Maps 1:1 to the `sourceTrust()` hierarchy in
 * lib/brain/ranking.ts so the visual chip reflects ranking weight:
 *
 *   basesheet / chargebee → patina-green (system of record, 1.0)
 *   manual                → ember (warm copper, 0.95 — human typed)
 *   customer_note         → brass (0.75 — second-hand human)
 *   beacon_ai_extracted   → muted purple (0.65 — inferred by Haiku)
 *   beacon_ai_conversation → smoke-gray (0.55 — AI wrote it itself)
 *
 * Using the project palette tokens (--zoca-*) where they map cleanly;
 * falling back to literal rgb() for the Haiku-extracted purple which
 * isn't in the token table.
 */
function sourceColor(source: string): { bg: string; fg: string; border: string } {
  switch (source) {
    case "basesheet":
    case "chargebee":
      // Patina green — system of record.
      return {
        bg: "rgba(74, 124, 89, 0.12)",
        fg: "rgb(45, 72, 67)",
        border: "rgba(74, 124, 89, 0.30)",
      };
    case "manual":
      // Ember — AM typed it directly.
      return {
        bg: "rgba(200, 67, 29, 0.12)",
        fg: "rgb(124, 45, 18)",
        border: "rgba(200, 67, 29, 0.32)",
      };
    case "customer_note":
      // Brass — extracted from CS notes (second-hand human).
      return {
        bg: "rgba(217, 164, 65, 0.18)",
        fg: "rgb(120, 80, 18)",
        border: "rgba(217, 164, 65, 0.42)",
      };
    case "beacon_ai_extracted":
      // Muted purple — Haiku extraction.
      return {
        bg: "rgba(110, 80, 140, 0.12)",
        fg: "rgb(80, 55, 110)",
        border: "rgba(110, 80, 140, 0.30)",
      };
    case "beacon_ai_conversation":
      // Smoke gray — Beam conversation, lowest trust.
      return {
        bg: "rgba(110, 95, 80, 0.10)",
        fg: "rgb(85, 72, 60)",
        border: "rgba(110, 95, 80, 0.28)",
      };
    case "voice_teach":
      // Wave C — lapis-tinted; AM spoke + confirmed via card.
      return {
        bg: "rgba(48, 80, 124, 0.12)",
        fg: "rgb(30, 56, 98)",
        border: "rgba(48, 80, 124, 0.32)",
      };
    default:
      return {
        bg: "rgba(110, 95, 80, 0.08)",
        fg: "rgb(110, 95, 80)",
        border: "rgba(110, 95, 80, 0.22)",
      };
  }
}

/**
 * Short, human-readable label for the source pill. Replaces the raw
 * snake_case enum with two-letter-or-fewer-word labels so the pill stays
 * compact in the row metadata band.
 */
function sourceLabel(source: string): string {
  switch (source) {
    case "basesheet":
      return "BaseSheet";
    case "chargebee":
      return "Chargebee";
    case "manual":
      return "AM typed";
    case "customer_note":
      return "CS note";
    case "beacon_ai_extracted":
      return "AI extract";
    case "beacon_ai_conversation":
      return "Beam chat";
    case "voice_teach":
      return "Voice teach";
    default:
      return source.replace(/_/g, " ");
  }
}

/**
 * Compact relative-time formatter — "today", "yesterday", "3d ago",
 * "2mo ago", "1y ago". Mirrors the same buckets used elsewhere on the
 * Customer 360 so age chips read consistently across panels.
 */
function relativeAge(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 0) return "today";
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * One row in the version log. Renders the version number, change reason,
 * value (or "→" diff if prior_value present), and the actor.
 */
function HistoryEntry({ entry }: { entry: BrainFactVersion }) {
  return (
    <div className="flex items-start gap-2 border-t border-zoca-border/30 py-1.5 first:border-t-0 first:pt-0">
      <span className="mt-0.5 inline-flex h-4 w-6 flex-shrink-0 items-center justify-center rounded-sm bg-zoca-bg-tint text-[9px] font-semibold text-zoca-text-2">
        v{entry.version}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zoca-text-2/80">
            {entry.change_reason.replace(/_/g, " ")}
          </span>
          <span className="text-[10px] text-zoca-text-2/60">
            · {relativeAge(entry.changed_at)} · {entry.changed_by_email}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-zoca-text break-words">
          {entry.prior_value && entry.prior_value !== entry.value ? (
            <>
              <span className="text-zoca-text-2/70 line-through">
                {entry.prior_value}
              </span>
              <span className="mx-1 text-zoca-text-2">→</span>
              <span>{entry.value}</span>
            </>
          ) : (
            <span>{entry.value}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function FactRow({
  fact,
  onReverted,
}: {
  fact: FactWithRevert;
  /**
   * WAVE-A-2 — callback fired after a successful revert lands. The parent
   * refetches the panel so the cluster swap (old becomes authoritative) is
   * visible without a page reload.
   */
  onReverted?: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [versions, setVersions] = useState<BrainFactVersion[] | null>(null);

  // WAVE-A-2 — revert confirm state. Closed → idle. Open → confirm form
  // showing optional reason input + Revert button. Busy → POSTing. Error
  // → inline error message persists until next toggle.
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [revertReason, setRevertReason] = useState("");
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  const src = sourceColor(fact.source_type);
  const age = relativeAge(fact.updated_at);
  const Icon = CATEGORY_ICONS[fact.topic_category];

  async function submitRevert() {
    setRevertBusy(true);
    setRevertError(null);
    try {
      const res = await fetch("/api/admin/keeper/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factId: fact.fact_id,
          reason: revertReason.trim() || undefined,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || !json.ok) {
        setRevertError(json.message || json.error || `revert failed (${res.status})`);
        return;
      }
      setRevertConfirmOpen(false);
      setRevertReason("");
      onReverted?.();
    } catch (e) {
      setRevertError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevertBusy(false);
    }
  }

  // Only fetch on first expand; subsequent toggles reuse the cached list.
  // If `current_version <= 1`, there's no meaningful history to show — we
  // still permit expansion (will render "no prior versions") but skip the
  // fetch.
  function toggleHistory() {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (versions !== null) return;
    setHistoryLoading(true);
    setHistoryError(null);
    fetch(`/api/v2/brain/fact/${encodeURIComponent(fact.fact_id)}/history`)
      .then((r) => r.json())
      .then((json: HistoryResponse) => {
        if (!json.ok) {
          setHistoryError(json.error || "Failed to load history");
          setVersions([]);
        } else {
          setVersions(json.versions ?? []);
        }
      })
      .catch((e) => {
        setHistoryError(e instanceof Error ? e.message : String(e));
        setVersions([]);
      })
      .finally(() => setHistoryLoading(false));
  }

  return (
    <div className="group/factrow py-1.5 text-[12px] leading-snug">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex min-w-[110px] flex-shrink-0 items-center gap-1 text-zoca-text-2">
          <Icon size={11} className="flex-shrink-0 opacity-70" aria-hidden />
          <span className="truncate">{labelFor(fact.field_name)}</span>
        </div>
        <div className="min-w-0 flex-1 break-words">
          <div className="text-zoca-text">{fact.value}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span
              className="rounded-full border px-1.5 py-0.5 font-semibold uppercase tracking-wide"
              style={{
                background: src.bg,
                color: src.fg,
                borderColor: src.border,
              }}
              title={`Source: ${fact.source_type}`}
            >
              {sourceLabel(fact.source_type)}
            </span>
            {age && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full border border-zoca-border/40 bg-zoca-bg-tint/60 px-1.5 py-0.5 text-zoca-text-2"
                title={`Updated ${fact.updated_at}`}
              >
                <Clock size={9} aria-hidden />
                {age}
              </span>
            )}
            <button
              type="button"
              onClick={toggleHistory}
              className="inline-flex items-center gap-0.5 rounded-full border border-zoca-border/40 bg-zoca-bg-tint/40 px-1.5 py-0.5 text-zoca-text-2/80 hover:bg-zoca-amber-soft/60 hover:text-zoca-text"
              aria-expanded={historyOpen}
              aria-controls={`fact-history-${fact.fact_id}`}
              title="View version history"
            >
              <History size={9} aria-hidden />
              {historyOpen ? "hide history" : "history"}
              {fact.current_version > 1 && (
                <span className="ml-0.5 text-zoca-text-2/60">
                  · v{fact.current_version}
                </span>
              )}
            </button>
            {/* WAVE-A-2 — Revert action. Only renders when the server says
                this fact has a superseded ancestor (can_revert=true). The
                `group/factrow:hover` class on the wrapping <div> reveals
                it on hover; it stays accessible-on-focus via opacity-0
                focus-visible:opacity-100. */}
            {fact.can_revert && (
              <button
                type="button"
                onClick={() => {
                  setRevertConfirmOpen((v) => !v);
                  setRevertError(null);
                }}
                className="inline-flex items-center gap-0.5 rounded-full border border-zoca-brass/40 bg-zoca-amber-soft/30 px-1.5 py-0.5 text-zoca-char hover:bg-zoca-amber-soft/60 opacity-0 group-hover/factrow:opacity-100 focus-visible:opacity-100 transition-opacity"
                title="Revert this fact to its previously-superseded ancestor"
                aria-expanded={revertConfirmOpen}
              >
                <RotateCcw size={9} aria-hidden />
                Revert
              </button>
            )}
          </div>
        </div>
      </div>
      {/* WAVE-A-2 — confirm form. Inline, no modal. Mirrors the history
          panel's visual treatment so the two actions feel like siblings. */}
      {revertConfirmOpen && (
        <div className="ml-[118px] mt-1.5 rounded-md border border-zoca-brass/40 bg-zoca-amber-soft/20 px-2 py-1.5">
          <div className="text-[11px] text-zoca-char">
            Roll this fact back to the previous version of {labelFor(fact.field_name)}? Optional reason:
          </div>
          <input
            type="text"
            value={revertReason}
            onChange={(e) => setRevertReason(e.target.value)}
            placeholder="e.g. extracted the wrong owner name"
            maxLength={500}
            disabled={revertBusy}
            className="mt-1 w-full px-1.5 py-1 text-[11px] border border-zoca-border rounded bg-white text-zoca-text"
          />
          {revertError && (
            <div className="mt-1 text-[10px] text-zoca-pink-bright">{revertError}</div>
          )}
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              onClick={submitRevert}
              disabled={revertBusy}
              className="px-2 py-0.5 text-[10px] font-semibold rounded border border-zoca-char bg-zoca-char text-zoca-parchment disabled:opacity-50"
            >
              {revertBusy ? "Reverting…" : "Confirm revert"}
            </button>
            <button
              type="button"
              onClick={() => {
                setRevertConfirmOpen(false);
                setRevertReason("");
                setRevertError(null);
              }}
              disabled={revertBusy}
              className="px-2 py-0.5 text-[10px] rounded border border-zoca-border bg-transparent text-zoca-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {historyOpen && (
        <div
          id={`fact-history-${fact.fact_id}`}
          className="ml-[118px] mt-1.5 rounded-md border border-zoca-border/40 bg-zoca-bg/40 px-2 py-1.5"
        >
          {historyLoading && (
            <div className="text-[11px] italic text-zoca-text-2">
              Loading history…
            </div>
          )}
          {historyError && (
            <div className="text-[11px] text-zoca-pink-bright">
              {historyError}
            </div>
          )}
          {!historyLoading &&
            !historyError &&
            versions !== null &&
            versions.length === 0 && (
              <div className="text-[11px] italic text-zoca-text-2/70">
                No prior versions.
              </div>
            )}
          {!historyLoading &&
            !historyError &&
            versions !== null &&
            versions.length > 0 && (
              <div>
                {versions.map((v) => (
                  <HistoryEntry key={`${v.fact_id}-${v.version}`} entry={v} />
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function TopicSection({
  label,
  category,
  facts,
  onReverted,
}: {
  label: string;
  category: TopicCategory;
  facts: FactWithRevert[];
  onReverted?: () => void;
}) {
  if (facts.length === 0) return null;
  const Icon = CATEGORY_ICONS[category];
  // Group by subcategory for visual clustering within the topic.
  const bySubcategory: Record<string, FactWithRevert[]> = {};
  for (const f of facts) {
    if (!bySubcategory[f.topic_subcategory]) {
      bySubcategory[f.topic_subcategory] = [];
    }
    bySubcategory[f.topic_subcategory].push(f);
  }
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zoca-text-2/80">
        <Icon size={11} className="opacity-80" aria-hidden />
        <span>
          {label} · {facts.length}
        </span>
      </div>
      {Object.entries(bySubcategory).map(([sub, rows]) => (
        <div key={sub} className="border-t border-zoca-border/40 first:border-t-0">
          {rows.map((r) => (
            <FactRow key={r.fact_id} fact={r} onReverted={onReverted} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** WAVE-A-1 — Memory Score response shape. Mirrors the API route output. */
type CoverageResponse = {
  ok: boolean;
  coverage?: {
    percent: number;
    slotsFilled: number;
    slotsTotal: number;
    perCategory: Record<TopicCategory, number>;
  };
  confidence?: "high" | "moderate" | "low";
  error?: string;
};

export default function V2BrainPanel({ entityId }: Props) {
  const [data, setData] = useState<FetchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // WAVE-A-1 — Memory Score (fetched in parallel with the facts list).
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);

  // WAVE-A-2 — bumped on every successful revert so child rows can request a
  // panel-wide refetch. Cheap counter; useEffect dependency picks up the
  // change and refires the fetch.
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v2/brain/${encodeURIComponent(entityId)}`)
      .then((r) => r.json())
      .then((json: FetchResponse) => {
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error || "Failed to load Keeper");
          setData(null);
        } else {
          setData(json);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, refreshNonce]);

  // WAVE-A-1 — Memory Score fetch. Fires in parallel with the facts list so
  // the chip lands as soon as the score is ready, independent of facts load.
  // Soft-fails: any error here just leaves the chip hidden — the panel
  // itself stays functional.
  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/v2/customer/${encodeURIComponent(entityId)}/keeper-coverage`,
    )
      .then((r) => r.json())
      .then((json: CoverageResponse) => {
        if (cancelled) return;
        setCoverage(json);
      })
      .catch(() => {
        // Silent — chip is decorative.
      });
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  // WAVE-A-2 — handler passed down to each FactRow. Bumps the refresh nonce
  // so the panel refetches and the cluster swap (old becomes authoritative,
  // current becomes superseded) is visible without a page reload.
  const handleReverted = () => setRefreshNonce((n) => n + 1);

  // Memo to avoid re-rendering the section tree on unrelated parent re-renders.
  const sections = useMemo(() => {
    if (!data || data.facts_count === 0) return null;
    return (
      <div>
        <TopicSection
          label="Identity"
          category="identity"
          facts={data.grouped.identity}
          onReverted={handleReverted}
        />
        <TopicSection
          label="Operational"
          category="operational"
          facts={data.grouped.operational}
          onReverted={handleReverted}
        />
        <TopicSection
          label="Behavioral"
          category="behavioral"
          facts={data.grouped.behavioral}
          onReverted={handleReverted}
        />
        <TopicSection
          label="Concerns"
          category="concerns"
          facts={data.grouped.concerns}
          onReverted={handleReverted}
        />
        <TopicSection
          label="Relationship"
          category="relationship"
          facts={data.grouped.relationship}
          onReverted={handleReverted}
        />
      </div>
    );
  }, [data]);

  return (
    <section
      className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
      aria-label="Keeper — confirmed facts"
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="-m-1 mb-2 flex w-full items-center justify-between gap-2 rounded-md p-1 text-left hover:bg-zoca-border/20"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
            Keeper
            {data?.facts_count !== undefined && data.facts_count > 0 && (
              <span className="ml-1.5 text-[11px] font-normal normal-case tracking-normal text-zoca-text-2/70">
                · {data.facts_count} confirmed fact
                {data.facts_count === 1 ? "" : "s"}
              </span>
            )}
          </h3>
          {/* WAVE-A-1 — Memory Score chip. Renders once the coverage fetch
              resolves. Confidence tier comes from the API (>=80 high,
              50–79 moderate, <50 low) so the chip's brass/ember/patina
              tint tracks the score automatically. */}
          {coverage?.ok && coverage.coverage && coverage.confidence && (
            <KeeperChip
              topic={`${coverage.coverage.percent}% covered`}
              confidence={coverage.confidence}
              size="lg"
            />
          )}
          {/* WAVE-C-2 — voice-teach mic. Wrapped in a span with stopPropagation
              so clicking the mic doesn't toggle the panel collapse. */}
          <span
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <KeeperMicButton
              entityId={entityId}
              customerId={data?.customer_id ?? null}
              bizname={data?.bizname ?? null}
              onSaved={() => setRefreshNonce((n) => n + 1)}
            />
          </span>
        </div>
        <span className="text-[10px] text-zoca-text-2">
          {collapsed ? "expand" : "collapse"}
        </span>
      </button>

      {!collapsed && (
        <>
          {loading && (
            <div className="text-[12px] text-zoca-text-2 italic">
              Loading Keeper…
            </div>
          )}
          {error && (
            <div className="text-[12px] text-zoca-pink-bright">
              Error: {error}
            </div>
          )}
          {!loading && !error && data && data.facts_count === 0 && (
            <div className="text-[12px] text-zoca-text-2 italic">
              {data.reason === "entity_not_in_active_book"
                ? "Customer not on the active book — no Keeper entry."
                : data.reason === "no_chargebee_customer_id"
                  ? "No Chargebee customer_id — Keeper is keyed on Chargebee handle."
                  : "No facts saved yet. Tell Beam to remember things about this customer — they'll show up here."}
            </div>
          )}
          {/* Wave 1.1 — Currently-managed-by section. Surfaces even when
              there are 0 curated facts, so AMs always see who's on this
              customer right now (per BaseSheet). */}
          {!loading && !error && data?.currently_managed && (
            <div className="mb-3 rounded-md border border-zoca-border/40 bg-zoca-bg/50 p-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zoca-text-2/80">
                <Users size={11} className="opacity-80" aria-hidden />
                <span>Currently managed</span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
                {data.currently_managed.current_am && (
                  <span>
                    <span className="text-zoca-text-2">AM:</span>{" "}
                    <span className="font-medium">
                      {data.currently_managed.current_am}
                    </span>
                  </span>
                )}
                {data.currently_managed.current_ae && (
                  <span>
                    <span className="text-zoca-text-2">AE:</span>{" "}
                    {data.currently_managed.current_ae}
                  </span>
                )}
                {data.currently_managed.current_pod && (
                  <span>
                    <span className="text-zoca-text-2">Pod:</span>{" "}
                    {data.currently_managed.current_pod}
                  </span>
                )}
                {data.currently_managed.current_sp && (
                  <span>
                    <span className="text-zoca-text-2">SP:</span>{" "}
                    {data.currently_managed.current_sp}
                  </span>
                )}
              </div>
            </div>
          )}
          {!loading && !error && data && data.facts_count > 0 && (
            <>
              {sections}
              <div className="mt-3 text-[10px] text-zoca-text-2/60">
                Beam reads from the Keeper when answering questions
                about {data.bizname ?? "this customer"}. Tell Beam to
                remember new facts — they'll appear here after page reload.
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

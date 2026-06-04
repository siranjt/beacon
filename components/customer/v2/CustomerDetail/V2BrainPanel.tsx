"use client";

/**
 * Brain Wave 2c — read-only Brain panel on the Customer 360 page.
 *
 * Shows topic-clustered confirmed facts the AM / bootstrap have saved.
 * Each row is "field_label — value" with a small source pill + relative
 * timestamp. Beacon AI reads from the same data when answering questions
 * about this customer; this panel makes that visible.
 *
 * Wave 2c.1 (deferred): inline edit, delete, version-history popover,
 * sunset_at indicator on Concerns rows.
 *
 * Wave 2d (deferred): add-via-panel (manual entry without going through
 * Beacon AI). For v1, AMs add facts by talking to Beacon AI; this panel
 * is read-only.
 */

import { useEffect, useState } from "react";
import type { BrainFact } from "@/lib/brain/types";

type Props = {
  entityId: string;
};

type FetchResponse = {
  ok: boolean;
  entity_id: string;
  customer_id: string | null;
  bizname: string | null;
  facts: BrainFact[];
  grouped: {
    identity: BrainFact[];
    operational: BrainFact[];
    behavioral: BrainFact[];
    concerns: BrainFact[];
  };
  facts_count: number;
  reason?: string;
  error?: string;
};

/** Maps schema field_name → human-friendly label for panel display. */
const FIELD_LABELS: Record<string, string> = {
  owner_name: "Owner",
  owner_nickname: "Nickname",
  owner_role: "Role",
  decision_style: "Decision style",
  secondary_contacts: "Secondary contacts",
  manager_relationships: "Manager relationships",
  sold_by_ae: "Sold by",
  sold_at: "Sale date",
  sales_promise: "Sales promise",
  time_to_first_value: "Time to value",
  contract_terms: "Contract terms",
  custom_pricing: "Custom pricing",
  contract_start: "Contract start",
  contract_renewal_at: "Renews",
  mrr_amount: "MRR",
  platform: "Platform",
  integration_state: "Integration state",
  integration_notes: "Integration notes",
  features_active: "Features active",
  features_inactive: "Features inactive",
  feature_adoption_notes: "Feature notes",
  payment_timing: "Payment timing",
  payment_method_preference: "Payment method",
  auto_debit_history: "Auto-debit history",
  preferred_channel: "Preferred channel",
  channel_avoid: "Avoid channel",
  response_pattern: "Response pattern",
  best_time_to_reach: "Best time to reach",
  high_season_months: "High season",
  low_season_notes: "Low season notes",
  vacation_dates: "Vacation",
  demo_engagement: "Demo engagement",
  follow_up_pattern: "Follow-up pattern",
  risk_description: "Risk",
  risk_severity: "Risk severity",
  watch_until: "Watch until",
  agenda_item: "Next-call agenda",
  raised_by: "Raised by",
  raised_at: "Raised at",
  flag_description: "Red flag",
  flag_category: "Flag category",
  other: "Other",
};

function labelFor(field_name: string): string {
  return FIELD_LABELS[field_name] ?? field_name;
}

/** Source pill color matches provenance taxonomy from lib/brain/types.ts. */
function sourceColor(source: string): { bg: string; fg: string } {
  switch (source) {
    case "basesheet":
      return { bg: "rgba(40, 80, 130, 0.10)", fg: "rgb(40, 80, 130)" };
    case "chargebee":
      return { bg: "rgba(80, 60, 130, 0.10)", fg: "rgb(80, 60, 130)" };
    case "customer_note":
      return { bg: "rgba(130, 70, 50, 0.10)", fg: "rgb(130, 70, 50)" };
    case "beacon_ai_conversation":
      return { bg: "rgba(180, 100, 30, 0.12)", fg: "rgb(180, 100, 30)" };
    case "beacon_ai_extracted":
      return { bg: "rgba(180, 100, 30, 0.18)", fg: "rgb(140, 70, 20)" };
    case "manual":
      return { bg: "rgba(80, 80, 80, 0.10)", fg: "rgb(70, 70, 70)" };
    default:
      return { bg: "rgba(80, 80, 80, 0.08)", fg: "rgb(80, 80, 80)" };
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function FactRow({ fact }: { fact: BrainFact }) {
  const src = sourceColor(fact.source_type);
  return (
    <div className="flex items-start gap-2 py-1.5 text-[12px] leading-snug">
      <div className="min-w-[110px] flex-shrink-0 text-zoca-text-2">
        {labelFor(fact.field_name)}
      </div>
      <div className="flex-1 break-words">
        <div className="text-zoca-text">{fact.value}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
          <span
            className="rounded-full px-1.5 py-0.5 font-medium"
            style={{ background: src.bg, color: src.fg }}
            title={`Source: ${fact.source_type}`}
          >
            {fact.source_type.replace(/_/g, " ")}
          </span>
          {fact.confirmed_at && (
            <span className="text-zoca-text-2/70">
              {formatRelative(fact.confirmed_at)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TopicSection({
  label,
  facts,
}: {
  label: string;
  facts: BrainFact[];
}) {
  if (facts.length === 0) return null;
  // Group by subcategory for visual clustering within the topic.
  const bySubcategory: Record<string, BrainFact[]> = {};
  for (const f of facts) {
    if (!bySubcategory[f.topic_subcategory]) {
      bySubcategory[f.topic_subcategory] = [];
    }
    bySubcategory[f.topic_subcategory].push(f);
  }
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zoca-text-2/80">
        {label} · {facts.length}
      </div>
      {Object.entries(bySubcategory).map(([sub, rows]) => (
        <div key={sub} className="border-t border-zoca-border/40 first:border-t-0">
          {rows.map((r) => (
            <FactRow key={r.fact_id} fact={r} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function V2BrainPanel({ entityId }: Props) {
  const [data, setData] = useState<FetchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v2/brain/${encodeURIComponent(entityId)}`)
      .then((r) => r.json())
      .then((json: FetchResponse) => {
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error || "Failed to load Brain");
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
  }, [entityId]);

  return (
    <section
      className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
      aria-label="Brain — confirmed facts"
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="-m-1 mb-2 flex w-full items-baseline justify-between gap-2 rounded-md p-1 text-left hover:bg-zoca-border/20"
      >
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Brain
          {data?.facts_count !== undefined && data.facts_count > 0 && (
            <span className="ml-1.5 text-[11px] font-normal normal-case tracking-normal text-zoca-text-2/70">
              · {data.facts_count} confirmed fact
              {data.facts_count === 1 ? "" : "s"}
            </span>
          )}
        </h3>
        <span className="text-[10px] text-zoca-text-2">
          {collapsed ? "expand" : "collapse"}
        </span>
      </button>

      {!collapsed && (
        <>
          {loading && (
            <div className="text-[12px] text-zoca-text-2 italic">
              Loading Brain…
            </div>
          )}
          {error && (
            <div className="text-[12px] text-red-700">Error: {error}</div>
          )}
          {!loading && !error && data && data.facts_count === 0 && (
            <div className="text-[12px] text-zoca-text-2 italic">
              {data.reason === "entity_not_in_active_book"
                ? "Customer not on the active book — no Brain entry."
                : data.reason === "no_chargebee_customer_id"
                  ? "No Chargebee customer_id — Brain is keyed on Chargebee handle."
                  : "No facts saved yet. Tell Beacon AI to remember things about this customer — they'll show up here."}
            </div>
          )}
          {!loading && !error && data && data.facts_count > 0 && (
            <div>
              <TopicSection label="Identity" facts={data.grouped.identity} />
              <TopicSection
                label="Operational"
                facts={data.grouped.operational}
              />
              <TopicSection
                label="Behavioral"
                facts={data.grouped.behavioral}
              />
              <TopicSection label="Concerns" facts={data.grouped.concerns} />
              <div className="mt-3 text-[10px] text-zoca-text-2/60">
                Beacon AI reads from this Brain when answering questions
                about {data.bizname ?? "this customer"}. Tell Beacon to
                remember new facts — they'll appear here after page reload.
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

import type { SnapshotV2 } from "@/lib/customer/types";

/**
 * Phase 13.1 (light-themed in 17.D): thin strip at the top of /v2 and
 * /customer/manager surfacing the data-scope of the dashboard — total
 * customers, distinct Chargebee customer_ids, and multi-location count.
 * Hover for the active-sub universe explainer.
 *
 * Phase 17.D — restyled to a Zoca brand light card matching V2RefreshBar.
 */
export default function ScopeStrip({ scope }: { scope?: SnapshotV2["scope"] }) {
  if (!scope) return null;
  const statusLabel = scope.statuses.map((s) => s.replace(/_/g, "-")).join(", ");
  // Phase 33.scope-finish — tooltip updated for 30-day churn retention.
  const tooltip =
    `Active sub universe (${statusLabel}) plus customers whose subscription was ` +
    `cancelled in the last 30 days (visible to AMs for the retention window). ` +
    `Multi-location customers contribute one row per entity_id.`;
  return (
    <div
      className="mx-6 mt-4 mb-2 rounded-2xl px-5 py-2.5 text-[11px] text-zoca-text-2 flex items-center gap-1 flex-wrap"
      // Phase 33.brand-watchfire-T5 — Light Parchment surface.
      style={{
        background: "var(--zoca-bg-soft)",
        border: "1px solid var(--zoca-border)",
        boxShadow: "0 1px 2px rgba(43,31,20,0.04)",
      }}
      title={tooltip}
    >
      <span className="zoca-micro-label mr-2">Scope</span>
      Showing{" "}
      <span className="font-semibold text-zoca-text">
        {scope.customer_count.toLocaleString()}
      </span>{" "}
      customers across{" "}
      <span className="font-semibold text-zoca-text">
        {scope.customer_id_count.toLocaleString()}
      </span>{" "}
      Chargebee customer_ids
      {scope.multi_location_count > 0 && (
        <>
          {" · "}
          <span className="font-semibold text-zoca-text">
            {scope.multi_location_count}
          </span>{" "}
          multi-location
        </>
      )}
      {" · Active subs ("}
      {statusLabel}
      {")"}
      {/* F-purge-churned — "+N recently churned" segment removed; churned customers
          are dropped from the book on the day they cancel. newly_onboarded /
          resurrected sibling counts remain. */}
      {scope.newly_onboarded_count !== undefined && scope.newly_onboarded_count > 0 && (
        <>
          {" · "}
          <span className="font-semibold text-zoca-text">+{scope.newly_onboarded_count}</span>{" new"}
        </>
      )}
      {scope.resurrected_count !== undefined && scope.resurrected_count > 0 && (
        <>
          {" · "}
          <span className="font-semibold text-zoca-text">+{scope.resurrected_count}</span>{" resurrected"}
        </>
      )}

    </div>
  );
}

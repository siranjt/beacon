"use client";

/**
 * Miss Payment Beacon — KPI grid.
 * Six tiles: Outstanding $ / Invoice count / ACH in flight / Multi-month /
 * Tickets matched / Annotations. The last four are click-to-filter.
 */

import type { InvoiceRow, AnnotationsMap } from "@/lib/miss-payment/types";

export type KpiKey = "outstanding" | "invoices" | "ach" | "multi" | "tickets" | "annotations";

function fmtUsd(n: number) { return "$" + Math.round(n).toLocaleString(); }
function fmtNum(n: number) { return n.toLocaleString(); }

type Tile = {
  key: KpiKey;
  label: string;
  value: string;
  accent: string;
  sub: string;
  pillClass: string;
  pillText: string;
  clickable: boolean;
};

export default function KpiCards({
  rows,
  multiMonthSet,
  annotations,
  activeKpi,
  onKpiClick,
}: {
  rows: InvoiceRow[];
  multiMonthSet: Set<string>;
  annotations?: AnnotationsMap;
  activeKpi?: KpiKey | null;
  onKpiClick?: (k: KpiKey) => void;
}) {
  const outstanding = rows.reduce((s, r) => s + (r.amountDue || 0), 0);
  const customers = new Set(rows.map((r) => r.customerId)).size;
  const ach = rows.filter((r) => r.achStatus === "In Progress").length;
  const multi = new Set(
    rows.filter((r) => multiMonthSet.has(r.entityId || r.customerId)).map((r) => r.entityId || r.customerId),
  ).size;
  const tickets = rows.filter((r) => r.latestTicket).length;
  const annotationCount = annotations
    ? Object.keys(annotations).filter((inv) => {
        const a = annotations[inv];
        return a && (a.caller || a.connectionStatus || a.comments || a.oldComments || a.amComment);
      }).length
    : 0;

  // 2026-06-12 — all 6 tiles are click-to-filter for parity. Outstanding
  // filters to high-value invoices (>= $500). Invoices filters to repeat
  // businesses (the same customer appears on ≥ 2 unpaid invoices). The
  // dashboard's row-filter useMemo applies the matching predicate when
  // activeKpi flips.
  const HIGH_VALUE_THRESHOLD = 500;
  const customerCounts = new Map<string, number>();
  for (const r of rows) {
    customerCounts.set(r.customerId, (customerCounts.get(r.customerId) || 0) + 1);
  }
  const highValue = rows.filter((r) => (r.amountDue || 0) >= HIGH_VALUE_THRESHOLD).length;
  const repeatBusinessInvoices = rows.filter(
    (r) => (customerCounts.get(r.customerId) || 0) >= 2,
  ).length;

  const tiles: Tile[] = [
    { key: "outstanding", label: "Outstanding", value: fmtUsd(outstanding), accent: "#2B1F14", sub: `${highValue} high-value ≥ $500`, pillClass: "pill-blue", pillText: "CLICK TO FILTER", clickable: true },
    { key: "invoices", label: "Invoices", value: fmtNum(rows.length), accent: "#C8431D", sub: `${repeatBusinessInvoices} from repeat businesses`, pillClass: "pill-pink", pillText: "CLICK TO FILTER", clickable: true },
    { key: "ach", label: "ACH in flight", value: fmtNum(ach), accent: "#2A4D5C", sub: "collection in progress", pillClass: "pill-blue", pillText: "CLICK TO FILTER", clickable: true },
    { key: "multi", label: "Multi-month", value: fmtNum(multi), accent: "#D9A441", sub: "overdue ≥ 2 cycles", pillClass: "pill-amber", pillText: "CLICK TO FILTER", clickable: true },
    { key: "tickets", label: "Tickets matched", value: fmtNum(tickets), accent: "#7C2D12", sub: "linked Linear issues", pillClass: "pill-purple", pillText: "CLICK TO FILTER", clickable: true },
    { key: "annotations", label: "Annotations", value: fmtNum(annotationCount), accent: "#4A7C59", sub: "notes saved by reps", pillClass: "pill-green", pillText: "CLICK TO FILTER", clickable: true },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
      {tiles.map((t) => (
        <div
          key={t.key}
          className={`kpi-card surface ${!t.clickable ? "!cursor-default" : ""}`}
          data-active={t.clickable && activeKpi === t.key ? "true" : "false"}
          onClick={() => t.clickable && onKpiClick?.(t.key)}
          role={t.clickable ? "button" : undefined}
          tabIndex={t.clickable ? 0 : undefined}
          onKeyDown={(e) => {
            if (!t.clickable) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onKpiClick?.(t.key);
            }
          }}
          style={{ padding: 16 }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="kpi-label text-[10px] text-zoca-textMuted uppercase tracking-[0.12em] font-bold">{t.label}</span>
            <span className={t.pillClass} style={{ fontSize: 9, padding: "2px 8px" }}>{t.pillText}</span>
          </div>
          <div className="display font-extrabold leading-none" style={{ color: t.accent, fontSize: 26, letterSpacing: "-0.01em" }}>{t.value}</div>
          <div className="text-[11px] text-zoca-textDim mt-1.5">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

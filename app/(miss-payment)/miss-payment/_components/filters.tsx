"use client";

/**
 * Miss Payment Beacon — top-of-page filter bar.
 * Search box + AM + status + month + ACH + auto-debit + multi-month toggle.
 */

import { useMemo } from "react";
import type { InvoiceRow } from "@/lib/miss-payment/types";
import { Search } from "lucide-react";

export type FilterState = {
  q: string;
  am: string;
  status: string;
  month: string;
  ach: string;
  autoDebit: string;
  multiOnly: boolean;
};

export default function Filters({
  value,
  onChange,
  rows,
}: {
  value: FilterState;
  onChange: (s: FilterState) => void;
  rows: InvoiceRow[];
}) {
  const ams = useMemo(
    () => Array.from(new Set(rows.map((r) => r.amName).filter(Boolean))).sort(),
    [rows],
  );
  const months = useMemo(
    () => Array.from(new Set(rows.map((r) => r.invoiceMonth).filter(Boolean))),
    [rows],
  );

  const set = <K extends keyof FilterState>(k: K, v: FilterState[K]) =>
    onChange({ ...value, [k]: v });

  const inputCls =
    "h-9 px-3 text-sm border border-zoca-stroke rounded-lg bg-white focus:outline-none focus:border-zoca-blue focus:ring-2 focus:ring-zoca-blue/20 transition-colors text-zoca-text";

  return (
    <div className="surface" style={{ padding: 12 }}>
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zoca-textDim" />
          <input
            className={`${inputCls} pl-9 w-full`}
            placeholder="Search business, AM, customer ID, invoice…"
            value={value.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </div>
        <select className={inputCls} value={value.am} onChange={(e) => set("am", e.target.value)}>
          <option value="">All AMs</option>
          {ams.map((a) => (<option key={a} value={a}>{a}</option>))}
        </select>
        <select className={inputCls} value={value.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">All statuses</option>
          <option value="payment_due">payment_due</option>
          <option value="not_paid">not_paid</option>
        </select>
        <select className={inputCls} value={value.month} onChange={(e) => set("month", e.target.value)}>
          <option value="">All months</option>
          {months.map((m) => (<option key={m} value={m}>{m}</option>))}
        </select>
        <select className={inputCls} value={value.ach} onChange={(e) => set("ach", e.target.value)}>
          <option value="">ACH any</option>
          <option value="in_progress">In Progress</option>
          <option value="none">No ACH</option>
        </select>
        <select className={inputCls} value={value.autoDebit} onChange={(e) => set("autoDebit", e.target.value)}>
          <option value="">Auto debit any</option>
          <option value="On">On</option>
          <option value="Off">Off</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-zoca-textMuted px-2">
          <input
            type="checkbox"
            className="accent-zoca-blue"
            checked={value.multiOnly}
            onChange={(e) => set("multiOnly", e.target.checked)}
          />
          Multi-month only
        </label>
      </div>
    </div>
  );
}

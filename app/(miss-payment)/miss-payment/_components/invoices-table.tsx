"use client";

/**
 * Miss Payment Beacon — invoices table.
 * 21 columns. Sortable on every chargebee-sourced field. Inline-editable
 * AM Comment / Caller / Connection / Comments / Old comments cells with
 * blur-to-save. Linear ticket badge in the last column when a join hit.
 */

import { useMemo, useState } from "react";
import type { InvoiceRow, AnnotationsMap, InvoiceAnnotation } from "@/lib/miss-payment/types";

type SortKey = keyof InvoiceRow | "";

function compare(a: any, b: any, key?: SortKey) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (key === "invoiceDate" || key === "cancellingAt") {
    const da = new Date(String(a)).getTime();
    const db = new Date(String(b)).getTime();
    const va = isNaN(da) ? 0 : da;
    const vb = isNaN(db) ? 0 : db;
    return va - vb;
  }
  return String(a).localeCompare(String(b));
}

function fmt(n: number) { return "$" + Math.round(n).toLocaleString(); }

function StatusPill({ s }: { s: string }) {
  const style: React.CSSProperties =
    s === "payment_due"
      ? { background: "#F5E6BB", color: "#8C6D14" }
      : { background: "#F5C9B6", color: "#7C2D12" };
  return <span className="pill" style={style}>{s}</span>;
}

function AchPill({ s }: { s: string }) {
  if (!s) return null;
  return <span className="pill" style={{ background: "#D8E1E6", color: "#1F3B47" }}>{s}</span>;
}

function callerStyle(v: string): React.CSSProperties {
  if (v === "Shakthi") return { background: "#F5C9B6", color: "#7C2D12" };
  if (v === "Joshi") return { background: "#DAE5DC", color: "#2D5037" };
  return {};
}
function connStyle(v: string): React.CSSProperties {
  if (v === "Connected") return { background: "#DAE5DC", color: "#2D5037" };
  if (v === "VM") return { background: "#D8E1E6", color: "#1F3B47" };
  if (v === "Not connected") return { background: "#F5C9B6", color: "#7C2D12" };
  return {};
}

function EditableText({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value || "");
  return (
    <input
      className="w-full min-w-[140px] h-7 px-2 text-xs border border-zoca-stroke rounded-md bg-white text-zoca-text focus:ring-2 focus:ring-zoca-blue/20 focus:border-zoca-blue focus:outline-none transition-colors"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function EditableSelect({
  value, options, onSave, styleFn,
}: {
  value: string;
  options: string[];
  onSave: (v: string) => void;
  styleFn?: (v: string) => React.CSSProperties;
}) {
  return (
    <select
      className="h-7 text-xs border border-zoca-stroke rounded-md bg-white text-zoca-text focus:ring-2 focus:ring-zoca-blue/20 focus:outline-none px-1 font-medium transition-colors"
      style={styleFn?.(value) || {}}
      value={value || ""}
      onChange={(e) => onSave(e.target.value)}
    >
      <option value="" style={{ background: "#fff", color: "#8B7A66" }}>—</option>
      {options.map((o) => <option key={o} value={o} style={{ background: "#fff", color: "#2B1F14" }}>{o}</option>)}
    </select>
  );
}

export default function InvoicesTable({
  rows,
  annotations,
  onSave,
  loading,
  multiMonthSet,
}: {
  rows: InvoiceRow[];
  annotations: AnnotationsMap;
  onSave: (invoiceNumber: string, patch: InvoiceAnnotation) => void;
  loading: boolean;
  multiMonthSet: Set<string>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "invoiceDate", dir: -1 });

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const k = sort.key as keyof InvoiceRow;
    return [...rows].sort((a, b) => sort.dir * compare(a[k], b[k], sort.key));
  }, [rows, sort]);

  function header(label: string, key: SortKey, extra = "") {
    const active = sort.key === key;
    return (
      <th
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}
        className={`cursor-pointer select-none ${extra}`}
      >
        {label}{active ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </th>
    );
  }

  return (
    <div className="overflow-x-auto surface !p-0">
      <table className="zoca-tbl w-full" style={{ minWidth: 1900 }}>
        <thead>
          <tr>
            {header("Customer Id", "customerId")}
            {header("Entity Id", "entityId")}
            {header("Biz name", "bizName")}
            {header("AM", "amName")}
            {header("Sub status", "subscriptionStatus")}
            {header("Cancelling at", "cancellingAt")}
            {header("Invoice #", "invoiceNumber")}
            {header("ACH", "achStatus")}
            {header("Auto debit", "autoDebit")}
            <th>AM Comment</th>
            {header("Date", "invoiceDate")}
            {header("First Name", "customerFirstName")}
            {header("Email", "customerEmail")}
            {header("Phone", "phoneNumber")}
            {header("Company", "customerCompany")}
            {header("Amount Due", "amountDue", "text-right")}
            <th>Caller</th>
            <th>Connection</th>
            <th>Comments</th>
            <th>Old comments</th>
            <th>Tickets</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={21} className="text-center text-zoca-textMuted py-8">Loading…</td></tr>
          )}
          {!loading && sorted.length === 0 && (
            <tr><td colSpan={21} className="text-center text-zoca-textMuted py-8">No invoices match these filters.</td></tr>
          )}
          {sorted.map((r) => {
            const a = annotations[r.invoiceNumber] || {};
            const isMulti = multiMonthSet.has(r.entityId || r.customerId);
            return (
              <tr key={r.invoiceNumber} className={isMulti ? "multi-month" : ""}>
                <td className="font-mono text-[11px] text-zoca-textMuted">{r.customerId}</td>
                <td className="font-mono text-[11px] text-zoca-textMuted">{r.entityId}</td>
                <td className="font-semibold text-zoca-text">{r.bizName}</td>
                <td>{r.amName}</td>
                <td>{r.subscriptionStatus}</td>
                <td>{r.cancellingAt}</td>
                <td className="font-mono text-[11px] text-zoca-blueDeep">{r.invoiceNumber}</td>
                <td><AchPill s={r.achStatus} /></td>
                <td>{r.autoDebit}</td>
                <td><EditableText value={a.amComment || ""} onSave={(v) => onSave(r.invoiceNumber, { amComment: v })} /></td>
                <td className="whitespace-nowrap">{r.invoiceDate}</td>
                <td>{r.customerFirstName}</td>
                <td>{r.customerEmail}</td>
                <td className="whitespace-nowrap">{r.phoneNumber}</td>
                <td>{r.customerCompany}</td>
                <td className="text-right tabular-nums whitespace-nowrap">
                  <span className="font-semibold mr-2">{fmt(r.amountDue)}</span>
                  <StatusPill s={r.status} />
                </td>
                <td>
                  <EditableSelect
                    value={a.caller || ""}
                    options={["Shakthi", "Joshi"]}
                    onSave={(v) => onSave(r.invoiceNumber, { caller: v as any })}
                    styleFn={callerStyle}
                  />
                </td>
                <td>
                  <EditableSelect
                    value={a.connectionStatus || ""}
                    options={["Connected", "VM", "Not connected"]}
                    onSave={(v) => onSave(r.invoiceNumber, { connectionStatus: v as any })}
                    styleFn={connStyle}
                  />
                </td>
                <td><EditableText value={a.comments || ""} onSave={(v) => onSave(r.invoiceNumber, { comments: v })} /></td>
                <td><EditableText value={a.oldComments || ""} onSave={(v) => onSave(r.invoiceNumber, { oldComments: v })} /></td>
                <td>
                  {r.latestTicket ? (
                    <a
                      href={r.latestTicket.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={r.latestTicket.title}
                      className="ticket-link block max-w-[260px]"
                    >
                      <span
                        className="ticket-badge inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold transition-colors"
                        style={{ background: "#F5C9B6", color: "#7C2D12" }}
                      >
                        {r.latestTicket.id}
                        <span style={{ opacity: 0.7 }}>↗</span>
                      </span>
                      <div
                        className="ticket-title text-[11px] text-zoca-textMuted mt-1 leading-tight transition-colors"
                        style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word" }}
                      >
                        {r.latestTicket.title}
                      </div>
                    </a>
                  ) : (
                    <span className="text-[11px] italic text-zoca-textDim">No tickets</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

"use client";

/**
 * Miss Payment Beacon — Excel + CSV export.
 * Builds a multi-sheet xlsx with:
 *  - "Miss-payment Sheet"   — every visible row
 *  - "August" / "July" / "June" / "May" — month-bucketed sheets
 *  - "<Month> <ord> <year>" — date-stamped clones of the month sheets
 *  - "Multi-month <ord> <year>" — entities that owe across multiple months
 *
 * The CSV button emits the same 21-column layout (single flat sheet of
 * the currently-visible rows). Both formats stay locked to the finance
 * team's expected header set; changes here must land in both HEADERS
 * consumers (xlsx multi-sheet + csv single dump) to stay reconcilable.
 */

import { Download, FileText } from "lucide-react";
import type { InvoiceRow, AnnotationsMap } from "@/lib/miss-payment/types";

const HEADERS = [
  "Customer Id",
  "Entity Id",
  "Biz name",
  "Am name",
  "Subscription status",
  "Cancelling at",
  "Invoice Number",
  "ACH status",
  "Auto debit",
  "AM Comment",
  "Invoice Date",
  "Customer First Name",
  "Customer Email",
  "Phone Number",
  "Customer Company",
  "Amount Due",
  "Caller",
  "Connection status",
  "Comments",
  "Old comments",
  "Ticket URL",
];

const COL = {
  caller: HEADERS.indexOf("Caller"),
  conn: HEADERS.indexOf("Connection status"),
};

const HEADER_STYLE = {
  font: { name: "Arial", sz: 11, bold: true, color: { rgb: "FFFFFFFF" } },
  fill: { fgColor: { rgb: "FF1F0843" }, patternType: "solid" },
  alignment: { horizontal: "center", vertical: "center" },
};

function rowValues(r: InvoiceRow, ann: any) {
  return [
    r.customerId,
    r.entityId,
    r.bizName,
    r.amName,
    r.subscriptionStatus,
    r.cancellingAt,
    r.invoiceNumber,
    r.achStatus,
    r.autoDebit,
    ann?.amComment || "",
    r.invoiceDate,
    r.customerFirstName,
    r.customerEmail,
    r.phoneNumber,
    r.customerCompany,
    r.amountDue,
    ann?.caller || "",
    ann?.connectionStatus || "",
    ann?.comments || "",
    ann?.oldComments || "",
    r.latestTicket?.url || "",
  ];
}

function styleSheet(XLSX: any, ws: any) {
  const range = XLSX.utils.decode_range(ws["!ref"]);

  for (let c = 0; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = HEADER_STYLE;
  }

  for (let r = 1; r <= range.e.r; r++) {
    const callerCell = ws[XLSX.utils.encode_cell({ r, c: COL.caller })];
    if (callerCell?.v === "Shakthi") {
      callerCell.s = { font: { color: { rgb: "FF9C0006" }, bold: true }, fill: { fgColor: { rgb: "FFFCE4E4" }, patternType: "solid" } };
    } else if (callerCell?.v === "Joshi") {
      callerCell.s = { font: { color: { rgb: "FF006100" }, bold: true }, fill: { fgColor: { rgb: "FFE2EFDA" }, patternType: "solid" } };
    }
    const connCell = ws[XLSX.utils.encode_cell({ r, c: COL.conn })];
    if (connCell?.v === "Connected") {
      connCell.s = { font: { color: { rgb: "FF006100" }, bold: true }, fill: { fgColor: { rgb: "FFE2EFDA" }, patternType: "solid" } };
    } else if (connCell?.v === "VM") {
      connCell.s = { font: { color: { rgb: "FF1F3864" }, bold: true }, fill: { fgColor: { rgb: "FFD9E2F3" }, patternType: "solid" } };
    } else if (connCell?.v === "Not connected") {
      connCell.s = { font: { color: { rgb: "FF9C0006" }, bold: true }, fill: { fgColor: { rgb: "FFFCE4E4" }, patternType: "solid" } };
    }
  }

  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  ws["!autofilter"] = { ref: ws["!ref"] };
  ws["!cols"] = HEADERS.map((h) => {
    if (h === "Customer Email" || h === "Biz name" || h === "Customer Company") return { wch: 30 };
    if (h === "Ticket URL") return { wch: 60 };
    if (h === "Comments" || h === "Old comments" || h === "AM Comment") return { wch: 25 };
    return { wch: 18 };
  });
}

/**
 * CSV escape per RFC 4180: wrap any field that contains a comma, quote,
 * CR or LF in double-quotes; double any embedded quote. Numbers/nulls
 * become bare strings.
 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(rows: InvoiceRow[], annotations: AnnotationsMap): string {
  const lines: string[] = [HEADERS.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(rowValues(r, annotations[r.invoiceNumber]).map(csvCell).join(","));
  }
  // Trailing newline so shells / Excel read cleanly.
  return lines.join("\r\n") + "\r\n";
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function buildSheet(XLSX: any, rows: InvoiceRow[], annotations: AnnotationsMap) {
  const data = [HEADERS, ...rows.map((r) => rowValues(r, annotations[r.invoiceNumber]))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  styleSheet(XLSX, ws);
  return ws;
}

export default function ExportButton({
  rows,
  annotations,
  multiMonthSet,
}: {
  rows: InvoiceRow[];
  annotations: AnnotationsMap;
  multiMonthSet: Set<string>;
}) {
  async function onExport() {
    const XLSX: any = await import("xlsx-js-style");
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, rows, annotations), "Miss-payment Sheet");

    // 2026-07-31 — month tab set kept in lockstep with dashboard.tsx TABS.
    // Change here whenever a month tab is added/dropped.
    const months = ["August", "July", "June", "May"];
    for (const m of months) {
      const mr = rows.filter((r) => r.invoiceMonth === m);
      XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, mr, annotations), m);
    }

    const today = new Date();
    const stampSuffix = `${ordinal(today.getDate())} ${today.getFullYear()}`;
    for (const m of months) {
      const mr = rows.filter((r) => r.invoiceMonth === m);
      const tabName = `${m.slice(0, 8)} ${stampSuffix}`.slice(0, 31);
      XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, mr, annotations), tabName);
    }

    const multiRows = rows.filter((r) => multiMonthSet.has(r.entityId || r.customerId));
    const multiName = `Multi-month ${stampSuffix}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, multiRows, annotations), multiName);

    XLSX.writeFile(wb, `missed-payments-${today.toISOString().slice(0, 10)}.xlsx`);
  }

  function onExportCsv() {
    const csv = buildCsv(rows, annotations);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `missed-payments-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give the browser a beat before revoking so the download can hand off.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div style={{ display: "inline-flex", gap: 8 }}>
      <button onClick={onExport} className="btn-ghost">
        <Download size={14} />
        Export Excel
      </button>
      <button onClick={onExportCsv} className="btn-ghost">
        <FileText size={14} />
        Download CSV
      </button>
    </div>
  );
}

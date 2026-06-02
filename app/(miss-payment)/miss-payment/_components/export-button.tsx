"use client";

/**
 * Miss Payment Beacon — Excel export button.
 * Builds a multi-sheet xlsx with:
 *  - "Miss-payment Sheet"   — every visible row
 *  - "June" / "May" / "April" / "March" — month-bucketed sheets
 *  - "<Month> <ord> <year>" — date-stamped clones of the month sheets
 *  - "Multi-month <ord> <year>" — entities that owe across multiple months
 *
 * Header style + per-cell caller/connection conditional fills match the
 * standalone Excel report the Finance team has been distributing.
 */

import { Download } from "lucide-react";
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

    const months = ["June", "May", "April", "March"];
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

  return (
    <button onClick={onExport} className="btn-ghost">
      <Download size={14} />
      Export Excel
    </button>
  );
}

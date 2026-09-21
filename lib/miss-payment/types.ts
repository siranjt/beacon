/**
 * Miss Payment Beacon — type contracts.
 *
 * Mirrors the standalone Missed Invoice Tracker types verbatim. Kept in
 * its own namespace so neighboring agents can't accidentally import
 * (e.g. Escalation's InvoiceRow would be a different shape).
 */

export type InvoiceStatus = "payment_due" | "not_paid";

export type LatestTicket = {
  id: string; // Linear identifier, e.g. "FIN-3899"
  title: string;
  url: string;
};

export type InvoiceRow = {
  customerId: string;
  entityId: string;
  bizName: string;
  amName: string;
  subscriptionStatus: string;
  cancellingAt: string;
  invoiceNumber: string;
  achStatus: string;
  autoDebit: string;
  invoiceDate: string;
  invoiceMonth: string;
  customerFirstName: string;
  customerEmail: string;
  phoneNumber: string;
  customerCompany: string;
  amountDue: number;
  status: InvoiceStatus;
  /** Most-recent open Finance ticket matched to this row's entity_id. */
  latestTicket?: LatestTicket;
};

export type InvoiceAnnotation = {
  amComment?: string;
  /**
   * 2026-09-01 — Will Pay / Will Not Pay commitment captured from the
   * customer during the collection call. Feeds a green/red dropdown in
   * the table and lands as the "Will Pay/Will Not Pay" column in the
   * Excel export. Positioned between Invoice Number and ACH status per
   * finance's request.
   */
  willPay?: "" | "Will Pay" | "Will Not Pay";
  /** Free-text remarks from the call, distinct from `comments`. */
  remarks?: string;
  /** Reason the customer gave for the delay / non-payment. */
  reason?: string;
  /** ETA the customer committed to (date string, free-form). */
  eta?: string;
  caller?: "" | "Shakthi" | "Joshi";
  connectionStatus?: "" | "Connected" | "VM" | "Not connected";
  comments?: string;
  oldComments?: string;
  tickets?: string;
};

export type AnnotationsMap = Record<string, InvoiceAnnotation>;

export type InvoicesResponse = {
  rows: InvoiceRow[];
  fetchedAt: string;
  cached: boolean;
};

// Transparent rule-based scoring for the cross-customer Escalation Queue.
// Every point in a customer's score has a documented reason — the queue UI
// shows the reasons as chips, so an AM can argue with the ordering.
//
// Inputs are MetabaseTicket rows (already pulled by lib/tickets.ts).

import type { MetabaseTicket } from "./tickets";

const OPEN_STATES = new Set(["Todo", "In Progress", "In Review"]);

const CLASSIFICATION_WEIGHT: Record<string, { score: number; label: string }> = {
  "Churn Ticket": { score: 30, label: "Open Churn" },
  "Retention Risk Alert": { score: 25, label: "Open Retention Risk" },
  Subscription_Cancellation: { score: 20, label: "Open Subscription Cancel" },
  paid_user_offboarding: { score: 20, label: "Open Paid Offboarding" },
  "Subscription Support Ticket": { score: 10, label: "Open Sub Support" },
};

export interface QueueEntry {
  entityId: string;
  customerId: string;
  customerName: string;
  amName: string;
  aeName: string;
  score: number;
  reasons: string[]; // human-readable, shown as chips in UI
  openTickets: number;
  totalTickets: number;
  latestTicket?: {
    identifier: string;
    title: string;
    classification: string;
    state: string;
    url: string;
    createdAt: string;
  };
  lastActivityAt: string; // ISO — used for "X days ago" sort
  hasChurnTicket: boolean;
  hasRetentionRiskTicket: boolean;
  hasCancellationTicket: boolean;
}

export function scoreCustomers(tickets: MetabaseTicket[]): QueueEntry[] {
  // Group by entity_id (skip rows without one).
  const byEntity = new Map<string, MetabaseTicket[]>();
  for (const t of tickets) {
    if (!t.entityId) continue;
    const arr = byEntity.get(t.entityId);
    if (arr) arr.push(t);
    else byEntity.set(t.entityId, [t]);
  }

  const out: QueueEntry[] = [];
  for (const [entityId, ts] of byEntity.entries()) {
    let score = 0;
    const reasons: string[] = [];
    const seenReasons = new Set<string>();
    const addReason = (r: string) => {
      if (seenReasons.has(r)) return;
      seenReasons.add(r);
      reasons.push(r);
    };

    let openTickets = 0;
    let hasChurn = false;
    let hasRetention = false;
    let hasCancel = false;

    // Sort tickets newest first so latest data wins where it matters.
    ts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    for (const t of ts) {
      const isOpen = OPEN_STATES.has(t.state);
      const w = CLASSIFICATION_WEIGHT[t.classification];

      if (isOpen) {
        openTickets++;
        if (w) {
          score += w.score;
          addReason(w.label);
        }
        if (t.classification === "Churn Ticket") hasChurn = true;
        if (t.classification === "Retention Risk Alert") hasRetention = true;
        if (t.classification === "Subscription_Cancellation") hasCancel = true;
      }

      // Churn potential modifier — independent of state.
      if (t.churnPotentialStatus === "CONFIRMED") {
        score += 30;
        addReason("Churn confirmed");
      } else if (t.churnPotentialStatus === "POTENTIAL" && isOpen) {
        score += 5;
      }
    }

    // Recency boost — any ticket in the last 7 days, plus velocity boost.
    const now = Date.now();
    const newestCreated = Date.parse(ts[0].createdAt);
    if (Number.isFinite(newestCreated) && now - newestCreated <= 7 * 86400000) {
      score += 10;
      addReason("New ticket · last 7d");
    } else if (Number.isFinite(newestCreated) && now - newestCreated <= 30 * 86400000) {
      score += 3;
    }

    if (openTickets >= 3) {
      score += 15;
      addReason(`${openTickets} open tickets`);
    } else if (openTickets === 2) {
      score += 5;
    }

    // Skip customers with zero score — they're not on the queue.
    if (score === 0) continue;

    const latest = ts[0];
    out.push({
      entityId,
      customerId: latest.customerId,
      customerName: latest.customerName || "(no name)",
      amName: latest.amName,
      aeName: latest.aeName,
      score,
      reasons,
      openTickets,
      totalTickets: ts.length,
      latestTicket: {
        identifier: latest.identifier,
        title: latest.title,
        classification: latest.classification,
        state: latest.state,
        url: latest.url,
        createdAt: latest.createdAt,
      },
      lastActivityAt: latest.createdAt,
      hasChurnTicket: hasChurn,
      hasRetentionRiskTicket: hasRetention,
      hasCancellationTicket: hasCancel,
    });
  }

  // Sort by score desc, then most-recent activity desc.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  });
  return out;
}

// Bucket a numeric score into a tier for color/label purposes.
export function scoreTier(score: number): { label: string; color: string; bg: string; border: string } {
  if (score >= 50) return { label: "Critical", color: "#b91c1c", bg: "#fef2f2", border: "#fecaca" };
  if (score >= 30) return { label: "High", color: "#92400e", bg: "#fffbeb", border: "#fde68a" };
  if (score >= 15) return { label: "Medium", color: "#3b5bff", bg: "#eef2ff", border: "#c7d2fe" };
  return { label: "Watch", color: "#5a6371", bg: "#f7f8fb", border: "#e5e7eb" };
}

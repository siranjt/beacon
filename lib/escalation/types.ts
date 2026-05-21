// Shared types used across the agent.

export type Channel = "app_chat" | "email" | "phone" | "video" | "sms";

export interface CommsMessage {
  channel: Channel;
  createdAt: string; // ISO
  sender: "client" | "team" | "unknown";
  // Display name when available — App Chat has real person names ("Bikash
  // Mishra", "Zoca Support"), Video has the organizer email. Email / SMS /
  // Phone don't carry a per-message display label, so this stays undefined.
  senderLabel?: string;
  body: string;
  durationSec?: number;
}

export interface Customer {
  // Chargebee handle (string id like "AbCdEf123")
  customerId?: string;
  // Zoca entity id (UUID)
  entityId?: string;
  bizName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  amName?: string;
  spName?: string;
  aeName?: string;
  status?: string; // chrone_zoca_status from BaseSheet
  churnDate?: string;
  totalMonthlyRevenue?: number;
}

export interface SubscriptionState {
  subscriptionId?: string;
  status?: string; // active, paused, cancelled, ...
  cancellingAt?: string;
  autoCollection?: "on" | "off";
  planId?: string;
  mrr?: number;
}

export interface InvoiceState {
  invoiceId: string;
  status: string;
  amountDue: number;
  date: string;
  dueDate?: string;
  ach?: "in_progress" | "none";
}

export interface CustomerContext {
  customer: Customer;
  subscription?: SubscriptionState;
  unpaidInvoices: InvoiceState[];
  recentComms: CommsMessage[]; // capped, recency-ordered
  signals: string[]; // short signal phrases the agent can use
  lookupNotes: string[]; // anything the lookup couldn't resolve, for transparency
}

export type Severity = "P0" | "P1" | "P2" | "P3";

export type Category =
  | "billing"
  | "product_bug"
  | "feature_request"
  | "onboarding"
  | "churn_risk"
  | "data_question"
  | "complaint"
  | "general"
  | "other";

export interface AgentResult {
  severity: Severity;
  category: Category;
  ownerSuggestion: {
    role: "AM" | "Support" | "Engineering" | "Billing" | "CS Lead";
    namedPerson?: string; // e.g. AM name from BaseSheet
    rationale: string;
  };
  summary: string; // 4-6 sentence customer brief
  draftReply: {
    channel: Channel | "best_match";
    subject?: string;
    body: string;
  };
  autoResolvable: {
    eligible: boolean;
    confidence: number; // 0..1
    reason: string;
  };
  routing: {
    actions: RoutingAction[];
  };
  signalsUsed: string[];
}

export type RoutingAction =
  | { type: "slack_dm"; to: string; message: string }
  | { type: "slack_channel"; channel: string; message: string }
  | { type: "linear_issue"; team?: string; title: string; body: string; labels?: string[] }
  | { type: "email"; to: string; subject: string; body: string }
  | { type: "noop"; reason: string };

export interface EscalationInput {
  text: string;
  // Hints — any of these makes lookup faster / more accurate.
  customerHint?: {
    customerId?: string;
    entityId?: string;
    email?: string;
    bizName?: string;
  };
  // Where this escalation came from.
  source?: {
    medium: "slack" | "email" | "sms" | "phone" | "video" | "app_chat" | "form" | "webhook" | "unknown";
    channelOrThread?: string;
    receivedAt?: string;
  };
}

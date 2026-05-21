// Chart palette tuned for the light theme. Matches Zoca's brand pair
// (cobalt #3b5bff + neon pink #ff5aa0) plus a violet middle for the gradient.

export const CHANNEL_COLORS: Record<string, string> = {
  app_chat: "#3b5bff",
  email: "#8b4dff",
  phone: "#22c55e",
  video: "#eab308",
  sms: "#ff5aa0",
};

export const CHANNEL_LABELS: Record<string, string> = {
  app_chat: "App Chat",
  email: "Email",
  phone: "Phone",
  video: "Video",
  sms: "SMS",
};

export const SENDER_COLORS = {
  client: "#ff5aa0",
  team: "#3b5bff",
  unknown: "#838d9d",
};

export const CLASSIFICATION_COLORS: Record<string, string> = {
  "Churn Ticket": "#ef4444",
  "Retention Risk Alert": "#f59e0b",
  "Subscription Support Ticket": "#3b5bff",
  paid_user_offboarding: "#8b4dff",
  Subscription_Cancellation: "#ff5aa0",
};

export const CLASSIFICATION_LABELS: Record<string, string> = {
  "Churn Ticket": "Churn",
  "Retention Risk Alert": "Retention Risk",
  "Subscription Support Ticket": "Sub Support",
  paid_user_offboarding: "Paid Off",
  Subscription_Cancellation: "Sub Cancel",
};

export const CHART_TOOLTIP_STYLE: any = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  fontSize: "12px",
  color: "#0d1117",
  padding: "10px 14px",
  boxShadow: "0 4px 16px -8px rgba(13, 17, 23, 0.12)",
};

export const CHART_TOOLTIP_LABEL_STYLE = { color: "#838d9d", fontSize: "11px", marginBottom: "4px" };
export const CHART_TOOLTIP_ITEM_STYLE = { color: "#0d1117" };

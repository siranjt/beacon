// Watchfire chart palette — distinct hues drawn from the Beacon vocabulary
// (Ember, Brass, Patina, Sea Lapis, Deep Crimson) so categorical encodings
// stay legible at a glance.

export const CHANNEL_COLORS: Record<string, string> = {
  app_chat: "#2A4D5C", // Sea Lapis
  email: "#D9A441",    // Brass
  phone: "#4A7C59",    // Patina
  video: "#C8431D",    // Ember
  sms: "#7C2D12",      // Deep Crimson
};

export const CHANNEL_LABELS: Record<string, string> = {
  app_chat: "App Chat",
  email: "Email",
  phone: "Phone",
  video: "Video",
  sms: "SMS",
};

export const SENDER_COLORS = {
  client: "#C8431D",   // Ember (client = warm/attention)
  team: "#2A4D5C",     // Sea Lapis (team = calm/measured)
  unknown: "#8B7A66",  // Faded Smoke
};

export const CLASSIFICATION_COLORS: Record<string, string> = {
  "Churn Ticket": "#7C2D12",                  // Deep Crimson
  "Retention Risk Alert": "#D9A441",          // Brass
  "Subscription Support Ticket": "#2A4D5C",   // Sea Lapis
  paid_user_offboarding: "#4A7C59",           // Patina
  Subscription_Cancellation: "#C8431D",       // Ember
};

export const CLASSIFICATION_LABELS: Record<string, string> = {
  "Churn Ticket": "Churn",
  "Retention Risk Alert": "Retention Risk",
  "Subscription Support Ticket": "Sub Support",
  paid_user_offboarding: "Paid Off",
  Subscription_Cancellation: "Sub Cancel",
};

export const CHART_TOOLTIP_STYLE: any = {
  background: "#F8EFD7",      // Light Parchment
  border: "1px solid #D4C29B", // Aged Brass
  borderRadius: "10px",
  fontSize: "12px",
  color: "#2B1F14",            // Char
  padding: "10px 14px",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif",
  boxShadow: "0 4px 16px -8px rgba(43, 31, 20, 0.18)",
};

export const CHART_TOOLTIP_LABEL_STYLE = {
  color: "#6E5F50",  // Smoke
  fontSize: "11px",
  marginBottom: "4px",
};
export const CHART_TOOLTIP_ITEM_STYLE = { color: "#2B1F14" }; // Char

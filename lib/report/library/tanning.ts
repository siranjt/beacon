/** Playbook for tanning salons. */

import type { Playbook } from "./types";

export const tanningPlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload GBP photos (high impact — do this today)",
    emphasis: "high_impact",
    intro:
      "Tanning customers shop on aesthetic and cleanliness. Fresh photos that show both win bookings.",
    bullets: [
      "Bed/booth interiors — clean, lit, branded",
      "Reception and lounge area",
      "Membership offers prominently displayed",
      "Team photos with friendly faces",
      "Service menu or price list",
      "A 30-second walk-through video showing the space",
    ],
    closing: "Aim for 5–8 new photos this week.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer",
    intro:
      "Membership-style offers tend to convert best in tanning. Spotlight the saving against single-session prices.",
    table: {
      caption: "Suggested promotional offers",
      headers: ["Offer idea", "Recommended price", "Original price"],
      rows: [
        ["First month unlimited (intro)", "$29 (save $20)", "$49 regular"],
        ["Spray-tan starter pack (3 sessions)", "$89 (save $16)", "$35 each separate"],
        ["Couples' membership month", "$69 for two", "$98 separate"],
      ],
    },
    closing: "Call or WhatsApp {{am_name}} to publish on GBP.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro: "Loyalty in tanning translates into membership renewals. Make returning members feel like VIPs.",
    bullets: [
      "Member-only after-hours slot once a month",
      "Birthday-month free spray tan",
      "Refer-a-friend: each gets one week free",
      "10-session punch card → 11th session free",
    ],
    closing: "Ping your AE to wire this into the Zoca app.",
  },
};

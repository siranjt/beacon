/** Playbook for hair salons / hairdressers. */

import type { Playbook } from "./types";

export const hairSalonPlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload GBP photos (high impact — do this today)",
    emphasis: "high_impact",
    intro:
      "Hair-salon GBPs that stay fresh win the local-pack ranking battle. Photo updates are the fastest lever you have.",
    bullets: [
      "Interior shots — your styling chairs, color station, washing area",
      "Stylist at work — mid-style is more compelling than 'finished look only'",
      "Before/after — color transformations, balayage, big chops",
      "Service menu or price list",
      "Team photos at the chair",
      "A short 30-second salon walk-through video",
    ],
    closing:
      "Aim for 5–8 new photos this week. Color transformations get the highest engagement.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer",
    intro:
      "Limited-time offers drive bookings fast. Pick one of the ideas below or share your own — your AE will publish it as a Google Post.",
    table: {
      caption: "Suggested promotional offers",
      headers: ["Offer idea", "Recommended price", "Original price"],
      rows: [
        ["New client cut + style", "$45 (save $15)", "$60 regular"],
        ["Color refresh package", "$99 (save $21)", "$120 regular"],
        ["Balayage intro session", "$159 (save $40)", "$199 regular"],
        ["Bridal trial cut + style + brow", "$120 bundle", "$155 separate"],
      ],
    },
    closing:
      "WhatsApp or call {{am_name}} with the offer you'd like to run.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro:
      "Repeat clients are the lifeblood of a salon. A small loyalty mechanic keeps them on a 4–6 week return cadence.",
    bullets: [
      "5th visit free, or 50% off the 5th cut/color",
      "Birthday-month blow-dry on us",
      "Refer-a-friend: both get $15 credit",
      "Color-club: prepay 4 sessions, get the 5th free",
    ],
    closing:
      "We can wire the loyalty mechanic into your Zoca app — let your AE know.",
  },
};

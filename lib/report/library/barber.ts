/** Playbook for barber shops. */

import type { Playbook } from "./types";

export const barberPlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload GBP photos (high impact — do this today)",
    emphasis: "high_impact",
    intro:
      "Barber-shop GBPs win on vibe and craft. Refresh your photos to recover clicks and pull in walk-ins.",
    bullets: [
      "Interior shots — your barber chairs, mirrors, vibe",
      "Mid-cut shots — clippers in hand, fade in progress",
      "Before/after — beard shape-ups and clean fades",
      "Service menu and price list",
      "Team photos at the chair",
      "A short 30-second shop walk-through video",
    ],
    closing: "Aim for 5–8 new photos this week.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer",
    intro: "Limited-time offers are great for filling weekday slots. Pick one of the ideas below.",
    table: {
      caption: "Suggested promotional offers",
      headers: ["Offer idea", "Recommended price", "Original price"],
      rows: [
        ["First-time cut + beard trim", "$25 (save $10)", "$35 regular"],
        ["Hot-towel shave + cut combo", "$45 (save $10)", "$55 regular"],
        ["Father–son combo cut", "$45 for two", "$60 separate"],
        ["Walk-in Wednesday cut", "$20 (save $5)", "$25 regular"],
      ],
    },
    closing: "WhatsApp or call {{am_name}} to push the offer to your GBP.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro: "Barber loyalty cards still work — and they translate cleanly into GBP and the Zoca app.",
    bullets: [
      "10th cut free",
      "Birthday cut on us",
      "Refer-a-friend: each gets $5 off",
      "Member-only first-pick weekend slots",
    ],
    closing: "Ping your AE to get this set up in the Zoca app.",
  },
};

/** Playbook for medical spas / aesthetics clinics / permanent make-up. */

import type { Playbook } from "./types";

export const medSpaPlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload GBP photos (high impact — do this today)",
    emphasis: "high_impact",
    intro:
      "Med-spa GBPs convert when prospects can see the space and the practitioner. Add fresh photos to recover profile clicks.",
    bullets: [
      "Treatment room — tidy, well-lit, equipment visible",
      "Practitioner at work (with patient consent)",
      "Before/after results — the single biggest conversion driver",
      "Service-menu or price-list slide",
      "Team credentials — display certifications and titles",
      "A short 30-second walk-through video of the clinic",
    ],
    closing:
      "Aim for 5–8 new photos this week. Before/after pairs deserve their own album in your GBP.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer",
    intro:
      "Med-spa offers convert best when they're a no-brainer entry point — discounted first session, bundled add-ons, or a milestone-package.",
    table: {
      caption: "Suggested promotional offers",
      headers: ["Offer idea", "Recommended price", "Original price"],
      rows: [
        ["Hydrafacial intro session", "$129 (save $40)", "$169 regular"],
        ["Botox per-area (first-time client)", "$10/unit", "$13/unit regular"],
        ["Microneedling 3-pack", "$549 (save $150)", "$700 separate"],
        ["IPL photo facial — 4 face areas", "$199 (save $50)", "$249 regular"],
      ],
    },
    closing:
      "WhatsApp or call {{am_name}} with the offer you'd like to run.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro:
      "Med-spa clients are high-LTV when retained. A milestone-package or membership program is the highest-leverage retention play.",
    bullets: [
      "Membership: monthly fee → discounted treatments + free goodies",
      "Birthday-month free add-on (chemical peel, dermaplaning)",
      "5th treatment 50% off in any series",
      "Refer-a-friend: $50 credit each when they book their first session",
    ],
    closing:
      "We can help set up the membership flow in your Zoca app — just ping {{am_name}}.",
  },
};

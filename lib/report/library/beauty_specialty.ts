/** Playbook for beauty specialty (eyelash, waxing, beauty parlour, etc.). */

import type { Playbook } from "./types";

export const beautySpecialtyPlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload GBP photos (high impact — do this today)",
    emphasis: "high_impact",
    intro:
      "For specialty beauty services, before/after photos and close-ups are what convert browsers into bookers.",
    bullets: [
      "Close-up before/after of your signature service",
      "Treatment area — chair, lighting, sanitation visible",
      "Technician at work",
      "Team photos at the workstation",
      "Service menu and price list",
      "A short 30-second walk-through video",
    ],
    closing:
      "Aim for 5–8 new photos this week. Close-up before/after work tends to outperform wider shots.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer",
    intro:
      "Bundle-style offers convert well in specialty beauty — pair the lead service with a high-margin add-on.",
    bullets: [
      "Time-bound — 14 days max for urgency",
      "Anchor against the regular price",
      "Pair the headline service with a complementary add-on",
    ],
    closing:
      "WhatsApp or call {{am_name}} with the offer you'd like to run.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro:
      "Most specialty-beauty services have a natural cadence (4–6 weeks). Loyalty mechanics that align to that cadence work best.",
    bullets: [
      "Prepay 4 sessions → 5th free",
      "Birthday-month freebie (lash fill, brow shape, etc.)",
      "Refer-a-friend credit",
      "Member-only early-access slots",
    ],
    closing: "We can wire the loyalty into Zoca — ping your AE.",
  },
};

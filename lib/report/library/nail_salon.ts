/** Playbook for nail salons. */

import type { Playbook } from "./types";

export const nailSalonPlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload GBP photos (high impact — do this today)",
    emphasis: "high_impact",
    intro:
      "Nail-salon profiles live and die by photo quality. New photos = more clicks = more bookings.",
    bullets: [
      "Close-up nail-art shots — gel, acrylic, dip, nail art designs",
      "Interior shots — your manicure stations, pedicure chairs, ambiance",
      "Technician at work — mid-application beats finished-only photos",
      "Color and design wall — show your range",
      "Team photos — friendly faces win trust",
      "A short 30-second walk-through video",
    ],
    closing:
      "Aim for 5–8 new photos this week. Trending nail-art styles tend to get the most reach.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer",
    intro:
      "A limited-time offer published on GBP can move the needle fast. Pick one of these or share your own.",
    table: {
      caption: "Suggested promotional offers",
      headers: ["Offer idea", "Recommended price", "Original price"],
      rows: [
        ["Classic mani + pedi combo", "$45 (save $10)", "$55 regular"],
        ["Gel mani intro", "$30 (save $10)", "$40 regular"],
        ["Spa pedicure 60 min", "$45 (save $15)", "$60 regular"],
        ["Nail-art bundle (2 designs)", "$25 add-on", "$15 each separate"],
      ],
    },
    closing:
      "WhatsApp or call {{am_name}} with the offer you'd like to run.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro: "Loyalty in nails is everything. A simple punch-card-style reward locks in repeat visits.",
    bullets: [
      "5th visit free or 50% off",
      "Birthday-month free nail-art accent",
      "Refer-a-friend: each gets a free polish change",
      "Prepay 4 manicures → 5th is on us",
    ],
    closing: "We can wire this into your Zoca app — ping your AE.",
  },
};

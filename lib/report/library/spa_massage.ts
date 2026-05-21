/**
 * Playbook for spa / massage / day spa / facial spa / massage therapist.
 * This is the most polished playbook because the reference report (888 F&N)
 * was for a massage spa.
 */

import type { Playbook } from "./types";

export const spaMassagePlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload GBP photos (high impact — do this today)",
    emphasis: "high_impact",
    intro:
      "Google rewards spas that keep their profiles fresh. Adding new photos is the fastest way to recover profile clicks. Here's what to upload:",
    bullets: [
      "Interior shots — treatment room, reception, lighting ambiance",
      "Therapist at work (with customer permission)",
      "Before/after of a relaxed client (face optional)",
      "Menu board or service price list visually displayed",
      "Team photos — build trust with potential customers",
      "A short 30-second walk-through video of the spa — these earn massive impressions",
    ],
    closing:
      "Aim to upload at least 5–8 new photos this week. More photos = more Google confidence = more profile clicks.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer",
    intro:
      "A limited-time offer is one of the quickest ways to drive new bookings. Below are four ideas tailored to a spa menu — pick one or share your own and we'll help publish it as a Google Post.",
    table: {
      caption: "Suggested promotional offers",
      headers: ["Offer idea", "Recommended price", "Original price"],
      rows: [
        ["Refresh — Thai 60 min", "$59 (save $11)", "$70 regular"],
        ["Date Night Combo — 2× 60 min Swedish", "$120 for two", "$140 regular"],
        ["New Client Deep Tissue 90 min", "$89 (save $21)", "$110 regular"],
        ["Lymphatic Drain + Scalp Add-on", "$99 bundle", "$110 + $40 separate"],
      ],
    },
    closing:
      "WhatsApp or call your account executive ({{am_name}}) with the offer you'd like to run and we'll set it up as a Google Post on your GBP profile.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro:
      "You have repeat customers — they love you. Consider a loyalty reward to drive consistent repeat bookings.",
    bullets: [
      "5th visit free, or 50% off the 5th massage",
      "Birthday-month deep tissue discount",
      "Refer-a-friend: $10 credit each when a friend books their first visit",
      "Member tier perks at 3, 5, 10 visits — early-access slots, free upgrade to 90 min",
    ],
    closing:
      "We can help set up the loyalty mechanic in your Zoca app — just let your account executive know.",
  },
};

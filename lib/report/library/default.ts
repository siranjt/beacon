/**
 * Default playbook — vertical-agnostic action copy used as the fallback.
 * Per-vertical playbooks override only the actions where the wording or
 * examples need to be different (e.g. photo subjects, offer service names).
 */

import type { Playbook } from "./types";

export const defaultPlaybook: Playbook = {
  upload_photos: {
    id: "upload_photos",
    title: "Upload fresh GBP photos this week",
    emphasis: "high_impact",
    intro:
      "Google rewards businesses that keep their profiles fresh. Adding new photos is one of the fastest ways to recover profile clicks.",
    bullets: [
      "Interior shots — your workspace, reception, ambiance",
      "Your team or you at work (with customer permission)",
      "Before/after of a satisfied client",
      "Service menu or price list visually displayed",
      "Team photos to build trust with new customers",
      "A short 30-second walk-through video — these earn outsized impressions",
    ],
    closing:
      "Aim to upload at least 5–8 new photos this week. More photos means more Google confidence, which means more profile clicks.",
  },

  run_offer: {
    id: "run_offer",
    title: "Run a promotional offer this season",
    intro:
      "A limited-time offer is one of the quickest ways to drive new bookings. Pick one of the ideas below or share your own and your account executive will help you publish it as a Google Post.",
    bullets: [
      "Keep the offer time-bound (e.g. valid for 14 days) — urgency drives clicks",
      "Anchor the price against your regular rate so the saving is obvious",
      "Promote the offer on your GBP profile as a 'Google Post'",
    ],
    closing:
      "WhatsApp or call your account executive to push the offer live on your GBP profile.",
  },

  use_app_more: {
    id: "use_app_more",
    title: "Use the Zoca app more — you're missing out",
    intro:
      "The Zoca app is your growth command center. The more you engage, the better the predictions and the faster we spot dips.",
    bullets: [
      "Check the Leads tab daily and update the status of each enquiry",
      "Watch your weekly profile-click trend to spot dips early",
      "Track your Keyword Rankings tab to monitor position changes",
      "Respond to new Google reviews from the Reviews section",
      "Check your Health Score for a prioritized GBP to-do list",
      "Schedule new GBP posts directly through the app",
    ],
    closing:
      "Target: open the Zoca app at least 3 times a week. The more you engage, the more accurately we can grow your profile.",
  },

  respond_to_reviews: {
    id: "respond_to_reviews",
    title: "Respond to every Google review",
    intro:
      "Responding to reviews — both positive and negative — is a confirmed local SEO ranking signal. Keep responses warm, professional, and weave in your services where it makes sense.",
    bullets: [
      "Thank the reviewer by name",
      "Mention the specific service they highlighted",
      "Invite them back with a soft call-to-action",
      "For critical reviews, acknowledge the concern and offer to make it right offline",
    ],
    closing:
      "If you have any unanswered reviews, please respond this week. Your account executive can help draft responses if needed.",
  },

  returning_client_incentive: {
    id: "returning_client_incentive",
    title: "Reward your returning clients",
    intro:
      "You have repeat customers — they love you. A small loyalty reward keeps them coming back and drives revenue consistency.",
    bullets: [
      "5th visit free, or a percent-off on the 5th visit",
      "Birthday-month discount",
      "Refer-a-friend credit",
      "Member-tier perks at 3, 5, 10 visits",
    ],
    closing:
      "We can help set up the loyalty mechanic in your Zoca app — just let your account executive know.",
  },
};

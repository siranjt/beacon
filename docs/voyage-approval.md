# Adding Voyage AI to Beacon — quick approval ask

Hey,

Quick context + ask. I'd like your OK to add Voyage AI as a vendor for Beacon. I expect this to cost us zero dollars for the foreseeable future, but I need to put a card on file with them, so I wanted to walk you through what it is and why before I do.

## What it solves

Beacon's Keeper feature (the per-customer fact store) just landed its first 1,269 candidate facts from AM-written notes. Looking at the first one — Bird of Paradise Skin Therapy — I noticed something annoying. From a single 7-word quote ("SP has requested to churn..."), Claude Haiku extracted four candidate facts. Three of them are essentially the same thing rephrased: "Service Partner has requested to churn," "Follow up on SP churn request," "Churn mitigation strategy needed." Only the fourth (`renewal_risk_level = Churning`) carries genuinely new information.

That's three rows of busywork the AM has to reject before they get to a real fact. Multiply by 1,269 candidates across 9 AMs and we're set up for triage fatigue and a "the inbox is noisy" reputation that kills adoption.

We need to catch these duplicates before they hit the AM's queue. Exact-string matching doesn't help because the wording is always slightly different. We need to compare *meaning*, not text.

## How we'd do it

Standard pattern: convert each fact into a numerical fingerprint (a "vector embedding"), store it next to the fact, and when a new one arrives compare its fingerprint to existing ones. If two facts have nearly-identical fingerprints, they mean the same thing — block the duplicate at write time, before it reaches the AM.

The engineering work is already done. Migration ran. Code is on main. The only remaining piece is the embedding model — and that needs an external vendor.

## Why Voyage specifically

I looked at four options:

- **Voyage AI** — $0.02 per million tokens, with the first 200M free. Anthropic explicitly recommends it (we already use Anthropic for Claude/Haiku, so this stays in the same vendor family).
- **OpenAI** — same price, but we don't use OpenAI anywhere else. Adding them opens a new vendor category, not just a new provider.
- **Cohere** — 5× more expensive at our volume.
- **Self-host an open-source model** — no vendor cost but adds a server we'd have to manage and scale. Not worth it at our size.

Voyage is the call. Anthropic-aligned, cheap, fast, well-benchmarked.

## What we'd send them

Only the structured fact text — short snippets like `"comms_preference / preferred_channel: WhatsApp"`. No customer names in the embedded text. No emails, phone numbers, payment info, health data, or raw AM notes. Server-side calls only; nothing touches the browser.

Voyage's published policy: they compute the embedding and return it. They don't retain the input.

## Cost

Here's what the math actually looks like:

| | Tokens used | % of 200M free tier | Cost if billed |
|---|---|---|---|
| One-time backfill (5k existing facts) | ~150K | 0.08% | $0.003 |
| Daily steady-state (~100 writes/day) | ~3K | 0.0015% | $0.0001 |
| One year of normal usage | ~2M | 1% | $0.04 |
| One year at 10× scale (Wave 1.6 — comms extraction) | ~100M | 50% | $2 |
| Worst case (50× scale) | ~500M | over | ~$6 |

So worst-case-realistic is single-digit dollars per year. Realistic projection: $0.

The card on file is a Voyage requirement to unlock standard rate limits — without it we're capped at 3 requests/minute, which doesn't fit our extraction cron. The card stays on file; we never get charged unless we somehow blow past 200M tokens in a year, which would take roughly 10× our current write volume sustained for twelve months.

## Things worth flagging

A few honest concerns:

**Voyage is a small AI startup.** They could be acquired or pivot. The good news: the embeddings live in our Postgres, not theirs. If Voyage disappeared, we'd re-embed everything on another provider in a single cron run. Vendor is interchangeable.

**External dependency on writes.** Our write path now makes an external API call. I coded graceful degradation — if Voyage is down, writes still succeed, the dedup check just skips. No data loss.

**Data residency.** Voyage is US-based on GCP. The text we send is non-PII and short, but flag if we have a specific data-residency constraint I'm not aware of.

## If you'd rather not add a new vendor

We could skip Voyage entirely and use Claude Haiku (which we already pay for) to make the duplicate judgment — send Haiku the proposed fact + the customer's existing facts, ask "is this a duplicate?" Same Anthropic relationship, no new vendor.

Tradeoffs there: 20× slower per check (3s vs 150ms), 100× more expensive per check (still trivial), doesn't scale past ~30 facts per customer (prompt size hits limits), and doesn't unlock the retrieval features we'll need later (top-K search across a customer's history).

If we go that route, we'll be back here in 3–6 months asking the same approval question when scale forces the move. I'd rather do it once. But if there's a vendor-review reason to defer, Haiku-judge works for now and is ~10 minutes to swap.

## The ask

OK to add Voyage and put a card on file?

- No budget commitment expected
- I'll set a $5/month billing alert so we never get surprised
- High reversibility — we can swap vendors anytime by re-embedding

If yes, the backfill of the 5,000 existing facts takes 2 minutes and Wave 2b (semantic dedup) is live in production today.

Happy to walk through any of this in person if easier — should be a 5-minute conversation.

Thanks,
Siranjith

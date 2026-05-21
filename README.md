# Beacon

> The gateway to Zoca's internal agents.

Beacon is the umbrella app that hosts Zoca's four internal-tooling agents under
one sign-in, one brand, one navigation. Same Watchfire register as the v1
Customer Beacon dashboard, but now hosting:

- **Customer Beacon** — live AM/Manager disengagement dashboard
- **Performance Beacon** — per-customer growth + local-SEO reports
- **Escalation Beacon** — triage agent: customer state + ticket queue + draft reply
- **Post-Payment Reviews Beacon** — ICP gating on Chargebee `customer.created`

## Architecture

- **Stack:** Next.js 14 (App Router) · TypeScript · Tailwind 3.4 · NextAuth (Google OAuth)
- **Pattern:** route groups — each agent lives in `app/(agent)/agent/...` so they
  share root layout + auth but stay code-isolated. ESLint rule prevents
  cross-agent imports.
- **Auth:** single Google OAuth client with `@zoca.com` / `@zoca.ai` allowlist.
  All four agents inherit the same session.
- **Brand:** Watchfire palette (Parchment + Char + Ember + Brass + Patina +
  Sea Lapis) inherited from v1.

## Current state (Phase A)

The umbrella shell is live. The four agents are still served from their
standalone Vercel deployments — the launcher cards link out to them. As
each agent migrates (Phase B-D), its card flips from `external` to
`internal` and routes to a local path.

| Agent | Current state | Migration phase |
| --- | --- | --- |
| Customer Beacon | External (beacon-zoca.vercel.app) | Phase B |
| Performance Beacon | External (zoca-performance-report.vercel.app) | Phase B |
| Escalation Beacon | External (zoca-escalation-agent.vercel.app) | Phase C |
| Post-Payment Reviews | External (zoca-payment-dashboard.vercel.app) | Phase D |

## Local development

```bash
npm install
cp .env.example .env.local
# fill in NEXTAUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
npm run dev
```

Open <http://localhost:3000> → sign in → land on launcher.

## Deployment

Vercel auto-deploys on push to `main`. Env vars set in Vercel dashboard.

## Repo structure

```
app/
  layout.tsx                ← root (auth provider + Watchfire CSS)
  page.tsx                  ← LAUNCHER (gateway screen with 4 tool cards)
  _components/              ← launcher-only shared components
    LauncherCard.tsx
  auth/signin/page.tsx      ← sign-in screen (Watchfire register)
  api/auth/[...nextauth]/   ← NextAuth route
  (customer)/customer/      ← Customer Beacon (placeholder until Phase B)
  (performance)/performance/← Performance Beacon (placeholder until Phase B)
  (escalation)/escalation/  ← Escalation Beacon (placeholder until Phase C)
  (post-payment)/post-payment/  ← Post-Payment Reviews (placeholder until Phase D)
  globals.css               ← Watchfire palette + flame + ember keyframes
components/
  BeaconMark.tsx            ← 4-layer flame mark
  BeaconAmbient.tsx         ← fixed-center page ambient layer
  SessionProvider.tsx       ← client-side NextAuth provider
lib/
  auth.ts                   ← NextAuth config with allowlist
  config.ts                 ← AGENTS array + email allowlist
```

## Cross-agent imports — forbidden

ESLint rule `.eslintrc.json` blocks imports from one agent's `(group)/` folder
into another. Shared code goes in `lib/` or `components/`.

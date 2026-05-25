# Beacon umbrella — operational runbook

Last updated: 2026-05-22 · maintained alongside production deployments.

This is the source-of-truth doc for anyone running, debugging, or extending the Beacon umbrella in production. Read this before paging me at 2am.

---

## Production surface

| Surface | URL |
|---|---|
| Beacon (umbrella) | https://beacon-v2-delta.vercel.app |
| Customer Beacon (legacy v1, still live) | https://beacon-zoca.vercel.app |
| Postgres (Neon, project: `disengagement-pg`) | console.neon.tech |
| Vercel project | `beacon-v2-delta` |
| Auth | Google OAuth, allowlist `zoca.com` + `zoca.ai` |
| Monorepo | https://github.com/siranjt/beacon |

---

## Environment variables

All set in Vercel → beacon-v2-delta → Settings → Environment Variables.

| Name | Purpose | Required? |
|---|---|---|
| `POSTGRES_URL` | Main DB connection (points at `disengagement-pg`) | Yes |
| `POST_PAYMENT_POSTGRES_URL` | Override for post-payment if it ever splits DBs | Optional fallback |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth | Yes |
| `NEXTAUTH_SECRET` | JWT signing | Yes |
| `NEXTAUTH_URL` | Canonical app URL | Yes |
| `ALLOWED_EMAIL_DOMAINS` | CSV, defaults `zoca.com,zoca.ai` | Optional |
| `ANTHROPIC_API_KEY` | Powers Beacon AI + post-payment LLM eval | Yes for AI features |
| `ANTHROPIC_ASK_MODEL` | Override for Beacon AI default (Sonnet 4.6) | Optional |
| `ANTHROPIC_FACT_MODEL` | Override for fact-extraction cron (Haiku 4.5) | Optional |
| `CRON_SECRET` | Authorizes Vercel cron + ops curl on cron + admin routes | Yes |
| `SLACK_AM_ACTIVITY_WEBHOOK_URL` | Where the hourly activity digest + real-time mutation alerts post | Yes for Slack |
| `SLACK_BOT_TOKEN` | Post-payment Slack thread integration | Yes for post-payment |
| `SLACK_CHANNEL_ID` | Default channel for post-payment messages | Yes for post-payment |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (post-payment docx) | Yes for post-payment |
| `CHARGEBEE_API_KEY` / `CHARGEBEE_SITE` | Chargebee customer sync | Yes |
| `METABASE_API_KEY` | Pulled comms / performance / health card data | Yes |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot enrichment | Yes |
| `STUCK_THRESHOLD_MINUTES` | Watchdog reaper threshold | Optional, default 20 |
| `SENTRY_DSN` | Error tracking | Recommended (not yet wired) |

---

## Scheduled jobs (Vercel cron)

All defined in `vercel.json` `crons[]`. Each requires `Authorization: Bearer ${CRON_SECRET}`.

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/post-payment/api/cron/retry-pending` | hourly `0 * * * *` | Retry pending-entity post-payment customers |
| `/post-payment/api/cron/reap-stuck` | every 10 min `*/10 * * * *` | Mark stuck `processing` customers as failed |
| `/api/cron/refresh/stage-a` | hourly | Customer Beacon snapshot stage A — Chargebee + entity merge |
| `/api/cron/refresh/stage-b` | hourly | Snapshot stage B — comms aggregation |
| `/api/cron/refresh/stage-c` | hourly | Snapshot stage C — score derivation |
| `/api/cron/refresh/stage-d` | hourly | Snapshot stage D — HubSpot enrichment |
| `/api/cron/refresh/compose` | hourly | Final snapshot composer |
| `/api/cron/prune` | nightly | Trim old snapshots beyond retention |
| `/api/cron/outcome-backfill` | nightly | Reconcile predicted vs actual outcomes |
| `/api/cron/health-alert` | morning | Stale-data alerts |
| `/api/cron/digest` | morning | Daily Slack digest of customer movement |
| `/api/cron/sync-hubspot-locations` | daily | HubSpot Locations object pull |
| `/api/cron/sync-health-card` | daily | Metabase health card pull |
| `/api/cron/slack-activity-digest` | hourly `0 * * * *` | Beacon usage rollup → Slack |
| `/api/ai/cron/extract-facts` | every 12h `30 */12 * * *` | Beacon AI fact extraction |

Manually trigger any of these from your terminal:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://beacon-v2-delta.vercel.app/<path>
```

`$CRON_SECRET` must be exported in your shell. Grab the value from Vercel → Settings → Env Vars → reveal `CRON_SECRET`.

---

## Database

**Connection**: `disengagement-pg` Neon project (shared with v1 Customer Beacon at `beacon-zoca.vercel.app`).

**Schema migrations** are tracked under `migrations/`. Each is a dated SQL file. Run via Neon Console SQL Editor (one statement at a time — Neon doesn't allow multi-statement queries with BEGIN/COMMIT).

| Migration | Tables touched | Purpose |
|---|---|---|
| `2026-05-22-umbrella-activity.sql` | `am_activity_log` | Add `agent` column + drop `role` NOT NULL |
| `2026-05-22-beacon-ai-memory.sql` | `beacon_ai_conversations` (new) | Persistent Beacon AI conversation memory |
| `2026-05-22-beacon-ai-facts.sql` | `beacon_ai_user_facts` (new) | Distilled stable facts per user |

**Tables of note:**

- `dashboard_snapshots` — Customer Beacon's hourly snapshot blob (one row per snapshot_date)
- `customers` — Post-Payment customer records + verdicts
- `events` — Post-Payment pipeline events (per-stage logs)
- `am_activity_log` — Umbrella-wide click telemetry
- `beacon_ai_conversations` — Beacon AI per-user, per-scope conversation turns
- `beacon_ai_user_facts` — Beacon AI distilled stable facts per user

---

## Access control

Three roles, defined in `lib/customer/config.ts`:

- **admin** (2 emails) — superuser. Sees `/admin/activity`, switches AMs, full mutations.
- **manager** (11 emails) — cross-AM access, no admin-exclusive surfaces.
- **am** (12 emails) — locked to own book.

Non-customer-beacon zoca users sign in fine and use Performance / Escalation / Post-Payment / Beacon AI freely — they just can't access Customer Beacon UI.

To add a user: edit `lib/customer/config.ts` → `ADMIN_EMAILS` / `MANAGER_EMAILS` / `AM_EMAILS`. Deploy to apply.

Sensitive admin routes (delete-customer, restore-blob, rerender, diag) accept dual auth — NextAuth session OR `Authorization: Bearer ${CRON_SECRET}`. See `lib/post-payment/admin-auth.ts`.

---

## Beacon AI

User-facing assistant inside the Beacon dashboard product.

- **Branding**: "Beacon AI" — the dashboard product is "Beacon", the assistant inside it is "Beacon AI".
- **Model**: Sonnet 4.6 default, Haiku 4.5 for the fact-extraction cron.
- **Stateful**: every conversation persists in `beacon_ai_conversations`. Memory + distilled facts surface on every new question.
- **Settings page**: `/settings/beacon-ai` — users see all extracted/explicit facts, can delete or add.
- **`/remember X` slash command** — types in the AskPanel, stored as an explicit fact (confidence 1.00).
- **Activity events**: `claude_asked`, `fact_remembered`, `fact_forgotten`, `fact_extracted`.

Force a fact extraction run for testing:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://beacon-v2-delta.vercel.app/api/ai/cron/extract-facts
```

Returns `{ ok: true, users_processed: N, totals: { added, reused, extracted }, per_user: [...] }`.

---

## Common issues + fixes

### "Application error: a client-side exception has occurred"

Open DevTools → Console → look for the red stack trace. Most recent culprit was `FaviconFlicker` removing React-managed favicon links. Pattern: check if anything in `app/layout.tsx` is mutating DOM that React also manages.

### Cron returns 401 unauthorized

Either `CRON_SECRET` env var isn't set in Vercel (server side) OR your shell `$CRON_SECRET` is empty when calling. `export CRON_SECRET=...` in your shell, then retry.

### Slack digest is empty

- Check `SLACK_AM_ACTIVITY_WEBHOOK_URL` is set in Vercel env.
- Check there's activity in the window — `SELECT COUNT(*) FROM am_activity_log WHERE ts > NOW() - INTERVAL '1 hour'`.
- Force-trigger: `curl -H "Authorization: Bearer $CRON_SECRET" https://beacon-v2-delta.vercel.app/api/cron/slack-activity-digest`.

### Beacon AI returns 503

- `ANTHROPIC_API_KEY` not set in Vercel env. Fix → redeploy.

### Snapshot is stale on the customer dashboard

- Check `/api/health` for last-snapshot timestamp.
- Force a refresh: `curl -H "Authorization: Bearer $CRON_SECRET" https://beacon-v2-delta.vercel.app/api/cron/refresh/stage-a` — and chain through stages B, C, D, compose.

### Post-payment customer stuck in "processing"

- Hit `/post-payment/api/diag/[cb_customer_id]` to see which stage stalled.
- The watchdog cron (`/post-payment/api/cron/reap-stuck`) flips anything stuck > `STUCK_THRESHOLD_MINUTES` to "failed" automatically every 10 min.
- Then re-run via `POST /post-payment/api/analyze/[cb_customer_id]?force=true`.

---

## Migration history & rollback

All migrations are forward-only by design (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`). To roll back a code deploy:

1. Vercel → Deployments → find a known-good deploy → **Promote to Production**.
2. The DB stays as-is. New columns/tables added by the rolled-back-from version just sit unused.

To actually drop a table (DESTRUCTIVE):

```sql
DROP TABLE beacon_ai_user_facts;  -- example
```

Then redeploy a version of the code that doesn't reference it.

---

## Smoke test (run after every deploy)

1. Open https://beacon-v2-delta.vercel.app/ — should redirect to `/auth/signin` if logged out, or show launcher.
2. Sign in. Land on launcher with inbox feed visible (or empty states if nothing's queued).
3. Press **Cmd+K** — palette opens, typing a bizname surfaces results.
4. Click into a customer (any agent or 360).
5. Open **Ask Beacon AI** — drawer slides in, ask a question, response streams.
6. Hit `/admin/activity` (admin only) — recent rows visible.
7. Run the Slack digest curl — expect `{"ok":true,"posted":true,...}`.

If any of the above is red, see "Common issues" above.

---

## Contact + ownership

- Tech lead: Siranjith (siranjith.t@zoca.com)
- Admin (umbrella): success@zoca.com
- Postgres / Neon: same admin emails
- Vercel project owner: same admin emails

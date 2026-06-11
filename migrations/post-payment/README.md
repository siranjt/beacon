# Post-Payment migrations

These migrations target the **post-payment Neon project** (env var
`POST_PAYMENT_POSTGRES_URL`), NOT the umbrella Beacon DB that
`scripts/migrate.mjs` connects to.

The umbrella migration runner uses non-recursive `readdirSync` against
`/migrations/`, so anything in this subdirectory is invisible to it. That is
intentional — running these against the umbrella DB would fail with
"relation does not exist" because the tables (`customers`, etc.) only exist in
the post-payment project.

## How to apply

Until we wire a parallel runner pointed at `POST_PAYMENT_POSTGRES_URL`, apply
these manually via Neon console (post-payment project) or via psql:

```bash
psql "$POST_PAYMENT_POSTGRES_URL" -f migrations/post-payment/<filename>.sql
```

## Why this directory exists

A post-payment migration accidentally landed in `/migrations/` on 2026-06-11.
The umbrella runner tried to apply it during `vercel-build`, hit
`relation "customers" does not exist`, exited 1, and killed two consecutive
production deploys (6dbf99b, df766d0) at ~8s each.

Convention going forward: any migration touching the post-payment DB schema
goes in this subdirectory.

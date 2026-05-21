-- =============================================================================
-- Zoca Payment Validator Dashboard — Postgres schema
-- Run via: npm run db:migrate (executes scripts/migrate.mjs)
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
    cb_customer_id          TEXT PRIMARY KEY,                  -- Chargebee customer.id (e.g. 16A2rRVIyq4cQjAV)
    email                   TEXT,
    first_name              TEXT,
    last_name               TEXT,
    biz_name                TEXT,                              -- BaseSheet bizname or Chargebee cf_entity_name
    primary_category        TEXT,                              -- BaseSheet primary_category
    locality                TEXT,                              -- BaseSheet locality
    state_code              TEXT,
    country                 TEXT,

    cb_created_at           TIMESTAMPTZ NOT NULL,              -- Chargebee customer.created_at
    cb_channel              TEXT,                              -- 'web', 'api', etc.
    cb_payment_method       TEXT,                              -- 'apple_pay', 'card', etc.

    stripe_customer_id      TEXT,
    stripe_created_at       TIMESTAMPTZ,
    timestamp_mismatch_h    NUMERIC,                           -- |CB - Stripe| in hours
    timestamp_mismatch_flag BOOLEAN DEFAULT false,

    -- subscription / scope
    sub_id                  TEXT,                              -- first sub id (if any)
    sub_status              TEXT,
    sub_item_price_ids      TEXT[],                            -- array of item_price_ids on the sub
    sub_billing_period      INTEGER,                           -- 1, 3, 12 etc.
    sub_billing_period_unit TEXT,                              -- 'month', 'year'
    sub_total_cents         INTEGER,                           -- $ amount paid on first invoice (cents)

    -- BaseSheet enrichment (mirror of one row)
    entity_id               TEXT,                              -- Zoca entity_id (first one if multi-loc)
    ae_name                 TEXT,
    am_name                 TEXT,
    lead_source_group       TEXT,
    lead_source             TEXT,
    predicted_6_month_leads INTEGER,
    open_tickets_30d        INTEGER,
    churn_potential_flag    TEXT,
    total_monthly_revenue   NUMERIC,

    -- Review metrics
    total_reviews_at_onb    INTEGER,
    avg_rating_at_onb       NUMERIC,
    five_star_reviews       INTEGER,

    -- Booking platform
    booking_platform        TEXT,                              -- canonical name (e.g. 'GLOSSGENIUS')
    booking_platform_url    TEXT,
    booking_platform_active BOOLEAN,

    -- Verdict / output
    scope                   TEXT NOT NULL DEFAULT 'pending'    -- 'discovery_first_pay', 'discovery_addon', 'other_subscription', 'no_subscription', 'pre_floor', 'pending'
                                CHECK (scope IN ('discovery_first_pay','discovery_addon','other_subscription','no_subscription','pre_floor','pending')),
    verdict                 TEXT,                              -- 'icp', 'review', 'not_icp', null when out of scope or pending
                                                               -- maps to UI labels '✅ ICP', '⚠️ Review', '❌ Not ICP'
    needs_am_call           BOOLEAN DEFAULT false,
    verdict_one_line        TEXT,                              -- short summary (≤25 words)
    key_flags               TEXT[],                            -- 3–5 bullet flags

    -- Report artefacts (Vercel Blob URLs)
    report_blob_docx_url    TEXT,                              -- canonical Word doc
    report_blob_pdf_url     TEXT,                              -- PDF preview (best-effort)
    report_blob_json_url    TEXT,                              -- raw structured JSON
    report_blob_md_url      TEXT,                              -- LLM Markdown analysis

    -- Slack post tracking
    slack_channel_id        TEXT,
    slack_ts                TEXT,                              -- top-level message ts (so thread replies can be linked)

    -- Pipeline status
    status                  TEXT NOT NULL DEFAULT 'pending'    -- 'pending','processing','ready','failed','out_of_scope'
                                CHECK (status IN ('pending','processing','ready','failed','out_of_scope')),
    failure_reason          TEXT,
    failure_attempts        INTEGER DEFAULT 0,

    -- Audit
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customers_cb_created_at_idx ON customers (cb_created_at DESC);
CREATE INDEX IF NOT EXISTS customers_status_idx        ON customers (status);
CREATE INDEX IF NOT EXISTS customers_scope_idx         ON customers (scope);
CREATE INDEX IF NOT EXISTS customers_verdict_idx       ON customers (verdict);
CREATE INDEX IF NOT EXISTS customers_email_idx         ON customers (email);

-- =============================================================================
-- events: append-only audit log of every webhook + pipeline step per customer
-- =============================================================================

CREATE TABLE IF NOT EXISTS events (
    id                  SERIAL PRIMARY KEY,
    cb_customer_id      TEXT REFERENCES customers (cb_customer_id) ON DELETE CASCADE,
    kind                TEXT NOT NULL,                          -- 'webhook_received','validator_started','validator_done','llm_eval_done','docx_rendered','blob_uploaded','slack_posted','failure'
    detail              JSONB,                                  -- structured payload (event source, timing, error details, etc.)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_customer_idx ON events (cb_customer_id);
CREATE INDEX IF NOT EXISTS events_kind_idx     ON events (kind);
CREATE INDEX IF NOT EXISTS events_created_idx  ON events (created_at DESC);

-- =============================================================================
-- updated_at trigger so customers.updated_at always reflects last write
-- =============================================================================

CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_updated_at ON customers;
CREATE TRIGGER customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

#!/usr/bin/env node
/**
 * Wave 1.5 dry-run — Haiku extraction of customer_notes into Keeper candidate facts.
 *
 * What it does:
 *   1. Connects to Postgres via POSTGRES_URL.
 *   2. Picks the top N customers (default 20) by total note text length
 *      across all AMs. Densest notes = best stress test for Haiku.
 *   3. For each customer:
 *      - Pulls all notes (one per AM)
 *      - Sends to Haiku with the extraction prompt (FIELD_CATALOG-aware)
 *      - Receives a JSON array of candidate facts
 *      - Validates each candidate against the schema (category/subcategory/field_name)
 *      - Saves <entity_id>.json with raw + validated candidates
 *   4. Writes an aggregate index (_index.json + _summary.md) with stats.
 *
 * NOTHING is written to the Keeper DB. This is a pure dry-run — the JSON
 * dump is for the user to review before we ship the production cron.
 *
 * Run locally:
 *   POSTGRES_URL='postgres://...' \
 *   ANTHROPIC_API_KEY='sk-ant-...' \
 *   node scripts/wave-1.5-dry-run.mjs
 *
 * Tunables (env):
 *   W15_SAMPLE_SIZE        default 20
 *   W15_MIN_NOTE_LENGTH    default 50  (skip customers whose total notes are shorter)
 *   W15_HAIKU_MODEL        default claude-haiku-4-5-20251001
 *   W15_OUTPUT_DIR         default outputs/wave-1.5-dry-run
 *   W15_DRY_RUN_NO_API     if "1", skips Haiku calls (audit-only mode)
 */

import { neon } from "@neondatabase/serverless";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// FIELD_CATALOG — mirrored from lib/brain/types.ts. Keep in sync if the
// schema expands. Plain object here so this stays a single-file mjs script.
// ──────────────────────────────────────────────────────────────────────────

const FIELD_CATALOG = {
  // identity
  owner_info:        { category: "identity",     fields: ["owner_name", "owner_nickname", "owner_role", "decision_style"] },
  decision_makers:   { category: "identity",     fields: ["secondary_contacts", "manager_relationships"] },
  sold_by:           { category: "identity",     fields: ["sold_by_ae", "sold_at", "sales_promise", "time_to_first_value"] },
  assignment:        { category: "identity",     fields: ["transition_history", "last_transition_at", "transition_reason", "customer_relationship_context"] },
  business_profile:  { category: "identity",     fields: ["service_focus", "service_mix", "location_count", "staff_count", "business_age", "ownership_structure", "business_model_note", "aesthetic_market_segment"] },
  // operational
  contract:          { category: "operational",  fields: ["contract_terms", "custom_pricing", "contract_start", "contract_renewal_at", "mrr_amount"] },
  integration:       { category: "operational",  fields: ["platform", "integration_state", "integration_notes"] },
  feature_usage:     { category: "operational",  fields: ["features_active", "features_inactive", "feature_adoption_notes"] },
  tech_stack:        { category: "operational",  fields: ["gbp_url", "website_url", "booking_url", "review_platforms", "pos_system", "social_handles", "email_marketing_tool"] },
  renewal:           { category: "operational",  fields: ["renewal_advocates", "renewal_pull_factors", "renewal_push_factors", "renewal_risk_level", "retention_strategy", "pricing_sensitivity_notes", "renewal_decision_makers"] },
  onboarding:        { category: "operational",  fields: ["onboarded_by_csm", "onboarding_completed_at", "time_to_first_lead", "first_value_event", "onboarding_friction_points"] },
  performance_context:{category: "operational",  fields: ["gbp_setup_quality", "review_velocity_pattern", "seasonal_dependency_strength", "known_growth_levers"] },
  // behavioral
  payment_pattern:   { category: "behavioral",   fields: ["payment_timing", "payment_method_preference", "auto_debit_history"] },
  comms_preference:  { category: "behavioral",   fields: ["preferred_channel", "channel_avoid", "response_pattern", "best_time_to_reach"] },
  seasonal:          { category: "behavioral",   fields: ["high_season_months", "low_season_notes", "vacation_dates"] },
  demo_style:        { category: "behavioral",   fields: ["demo_engagement", "follow_up_pattern"] },
  competitive_context:{category: "behavioral",   fields: ["prior_platforms", "competing_offers_seen", "why_chose_zoca", "switch_risks", "churn_attempt_history"] },
  // concerns
  latent_risk:       { category: "concerns",     fields: ["risk_description", "risk_severity", "watch_until"] },
  next_call_agenda:  { category: "concerns",     fields: ["agenda_item", "raised_by", "raised_at"] },
  soft_red_flag:     { category: "concerns",     fields: ["flag_description", "flag_category"] },
  // relationship
  advocacy:          { category: "relationship", fields: ["nps_score", "would_refer_likelihood", "has_referred", "case_study_eligible", "public_quote_eligible"] },
  engagement:        { category: "relationship", fields: ["meeting_cadence", "last_in_person_meeting", "community_events_attended"] },
};

function catalogPromptBlock() {
  const lines = [];
  for (const [sub, entry] of Object.entries(FIELD_CATALOG)) {
    lines.push(`  - ${entry.category}/${sub}: ${entry.fields.join(", ")}, or "other"`);
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Extraction prompt
// ──────────────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are the Wave 1.5 Keeper extractor. Your job: read free-form AM notes about a single customer and emit STRUCTURED CANDIDATE FACTS that get reviewed before landing in the Keeper (Zoca's per-customer canonical truth store).

The Keeper schema is two-level (topic_category × topic_subcategory) with named fields per subcategory. Here is the full FIELD_CATALOG:

${catalogPromptBlock()}

RULES — read carefully, this is grounded extraction not generation:

1. ONLY emit facts that are EXPLICITLY stated in the notes. Do not infer, do not extrapolate, do not synthesize. If the notes say "owner is Sarah", you emit owner_name=Sarah. If they say "called Sarah" you do NOT emit owner_name — "Sarah" might be the manager.

2. For each candidate fact you emit, provide a verbatim source_quote — the exact phrase from the notes that justifies it. This is non-negotiable; a fact with no quote will be rejected.

3. Classify each fact into (topic_category, topic_subcategory, field_name, value) using the catalog above. field_name MUST be one of the named fields for that subcategory OR exactly "other". Do NOT invent field names.

4. topic_category MUST match the subcategory's category (e.g. "comms_preference" is always "behavioral"). Mismatches will be rejected.

5. For 'other' rows, set field_name="other" and write a complete short sentence as the value. Use "other" liberally for anything that doesn't fit a named field.

6. CHRONOLOGICAL CONFLICT RULE: if the notes contradict themselves over time (e.g., "owner is Sarah" then later "Sarah left, Maria now runs it"), emit ONLY the latest fact (Maria). Pre-Maria facts should NOT be emitted.

7. CONFIDENCE FILTER: only emit facts when the notes state them clearly. Skip ambiguous phrasing like "I think Sarah might be the owner?" — that's a candidate question, not a fact.

8. VOLUME EXPECTATION: a typical customer note yields 3-12 candidate facts. If you find yourself emitting 30+, you're inferring too much. If you find 0, look harder — most notes have at least the owner/platform mentioned.

9. DO NOT emit facts for:
   - DERIVED fields (current_am, current_ae, current_pod, current_sp — these come from snapshot)
   - High-trust auto-bootstrap fields (sold_by_ae, sold_at, contract_start, mrr_amount — these come from BaseSheet+Chargebee at bootstrap; only emit if notes EXPLICITLY contradict the system-of-record value)
   - PII that doesn't belong in a fact store (SSNs, credit cards, passwords)

10. CATEGORY DISAMBIGUATION — these are commonly confused, classify carefully:
    - \`identity/assignment\` is for WHO AT ZOCA owns the customer relationship (AM/AE/Pod/SP assignment changes, transition history, why the handoff happened). It is NOT for facts about the customer's own state.
    - \`identity/business_profile\` is for the CUSTOMER's own shape — services offered, location count, staff count, business age, ownership structure, business model, operational status (open / closed / seasonal / dormant).
    - \`identity/owner_info\` is for who OWNS or RUNS the customer's business — the owner's name, role, decision style. NOT the Zoca AM.
    - Concrete examples:
      • "Business permanently closed" → \`identity/business_profile/other\` (NOT assignment).
      • "Customer is a Chrone client, migrating Monday" → \`operational/integration/integration_notes\` (platform move).
      • "Owner sold the business to her sister" → \`identity/owner_info/other\` (customer-side ownership change).
      • "AM changed from Apurvaa to Taanya, account inherited mid-renewal" → \`identity/assignment/transition_history\` (Zoca-side AM handoff).
      • "SP unreachable, profile access stuck with previous owner" → \`concerns/latent_risk/risk_description\` (operational blocker).
      • "Refunded last month, churn ticket created" → \`operational/renewal/renewal_risk_level\` value "Churned" or "Churning".

OUTPUT FORMAT — emit ONE JSON object, no preamble, no markdown fences:

{
  "candidate_facts": [
    {
      "topic_category": "identity" | "operational" | "behavioral" | "concerns" | "relationship",
      "topic_subcategory": "<one of the subcategories above>",
      "field_name": "<a named field for that subcategory, OR 'other'>",
      "value": "<concise value, full sentence for 'other' rows>",
      "source_quote": "<verbatim phrase from notes>",
      "source_am_name": "<which AM's note this came from>",
      "confidence_note": "<short reason this is high-confidence, or 'ambiguous' if you're unsure (skip ambiguous ones)>"
    }
  ],
  "extraction_meta": {
    "total_notes_processed": <integer count of notes you read>,
    "notes_skipped_reason": "<empty string if all read, else why some skipped>",
    "extractor_summary": "<one short sentence describing what kind of customer this is, based on what you saw — useful for the reviewer>"
  }
}

If the notes are empty, contain no extractable facts, or are pure scheduling chatter ("called, no answer"), return {"candidate_facts": [], "extraction_meta": {...}}. Empty is fine.`;

function buildUserPrompt(customer, notes) {
  const noteBlocks = notes.map((n, i) => {
    const ts = n.updated_at instanceof Date ? n.updated_at.toISOString() : String(n.updated_at);
    return `--- Note ${i + 1} of ${notes.length} ---
AM: ${n.am_name}
Last updated: ${ts}
Note text:
${n.note}`;
  }).join("\n\n");

  return `Customer: ${customer.bizname || "(no bizname)"}
Entity ID: ${customer.entity_id}
Chargebee customer_id: ${customer.customer_id || "(none)"}
Note count: ${notes.length}

${noteBlocks}

Now extract candidate Keeper facts per the rules above. Emit the JSON object directly with no preamble.`;
}

// ──────────────────────────────────────────────────────────────────────────
// Validation — keep candidates only if catalog-valid
// ──────────────────────────────────────────────────────────────────────────

function validateCandidate(cand) {
  const errs = [];
  if (!cand || typeof cand !== "object") {
    return { ok: false, errs: ["not an object"] };
  }
  const sub = cand.topic_subcategory;
  const cat = cand.topic_category;
  const fld = cand.field_name;
  const val = cand.value;
  const quote = cand.source_quote;

  if (typeof sub !== "string" || !FIELD_CATALOG[sub]) {
    errs.push(`unknown subcategory: ${sub}`);
  } else {
    if (FIELD_CATALOG[sub].category !== cat) {
      errs.push(`category/subcategory mismatch: ${cat} vs ${FIELD_CATALOG[sub].category}`);
    }
    if (typeof fld !== "string" || (fld !== "other" && !FIELD_CATALOG[sub].fields.includes(fld))) {
      errs.push(`invalid field_name for ${sub}: ${fld}`);
    }
  }
  if (typeof val !== "string" || val.trim().length === 0) {
    errs.push("empty value");
  }
  if (typeof quote !== "string" || quote.trim().length < 3) {
    errs.push("missing/short source_quote");
  }
  return { ok: errs.length === 0, errs };
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  // Codebase reads POSTGRES_URL; Vercel sometimes ships CUSTOMER_POSTGRES_URL
  // (Neon integration). Accept either.
  const POSTGRES_URL =
    process.env.POSTGRES_URL || process.env.CUSTOMER_POSTGRES_URL;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SAMPLE_SIZE = Number(process.env.W15_SAMPLE_SIZE || 20);
  const MIN_NOTE_LENGTH = Number(process.env.W15_MIN_NOTE_LENGTH || 50);
  const HAIKU_MODEL = process.env.W15_HAIKU_MODEL || "claude-haiku-4-5-20251001";
  const OUTPUT_DIR = process.env.W15_OUTPUT_DIR || "outputs/wave-1.5-dry-run";
  const SKIP_API = process.env.W15_DRY_RUN_NO_API === "1";

  if (!POSTGRES_URL) {
    console.error("Missing POSTGRES_URL (or CUSTOMER_POSTGRES_URL)");
    process.exit(1);
  }
  if (!SKIP_API && !ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY (set W15_DRY_RUN_NO_API=1 to audit-only mode)");
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const sql = neon(POSTGRES_URL);
  const anthropic = SKIP_API ? null : new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 3 });

  // ── Step 1 — audit the customer_notes table
  console.log("\n=== STEP 1: Audit customer_notes ===");
  const auditRows = await sql`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT entity_id) AS distinct_entities,
      COUNT(DISTINCT am_name) AS distinct_ams,
      COALESCE(AVG(length(note)), 0)::int AS avg_note_length,
      COALESCE(MAX(length(note)), 0)::int AS max_note_length,
      COALESCE(SUM(length(note)), 0)::bigint AS total_text_length
    FROM customer_notes
    WHERE note IS NOT NULL AND length(trim(note)) > 0
  `;
  const audit = auditRows[0] || {};
  console.log(JSON.stringify(audit, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  // ── Step 2 — pick top N by total text length (summed across AMs)
  console.log(`\n=== STEP 2: Pick top ${SAMPLE_SIZE} by total note length ===`);
  const topRows = await sql`
    SELECT
      entity_id,
      MAX(bizname) AS bizname,
      MAX(customer_id) AS customer_id,
      COUNT(*) AS am_count,
      SUM(length(note))::int AS total_chars,
      MAX(updated_at) AS last_updated
    FROM customer_notes
    WHERE note IS NOT NULL AND length(trim(note)) > 0
    GROUP BY entity_id
    HAVING SUM(length(note)) >= ${MIN_NOTE_LENGTH}
    ORDER BY total_chars DESC
    LIMIT ${SAMPLE_SIZE}
  `;
  console.log(`Picked ${topRows.length} customers.`);
  for (const r of topRows) {
    console.log(`  ${r.entity_id.slice(0, 8)}  ${(r.bizname || "?").padEnd(40)}  ${r.am_count} AMs  ${r.total_chars} chars`);
  }

  // ── Step 3 — for each, pull notes + extract
  console.log(`\n=== STEP 3: Extract candidates ===`);

  const aggregate = {
    generated_at: new Date().toISOString(),
    audit,
    sample_size: topRows.length,
    haiku_model: HAIKU_MODEL,
    skip_api: SKIP_API,
    per_customer: [],
    stats: {
      total_candidates: 0,
      valid_candidates: 0,
      invalid_candidates: 0,
      empty_extractions: 0,
      api_errors: 0,
      total_input_chars: 0,
      category_distribution: {},
      subcategory_distribution: {},
      field_name_distribution: {},
    },
  };

  for (let i = 0; i < topRows.length; i++) {
    const customer = topRows[i];
    console.log(`\n[${i + 1}/${topRows.length}] ${customer.entity_id.slice(0, 8)}  ${customer.bizname || "?"}`);

    const notes = await sql`
      SELECT am_name, note, updated_at, bizname, customer_id
      FROM customer_notes
      WHERE entity_id = ${customer.entity_id}
        AND note IS NOT NULL AND length(trim(note)) > 0
      ORDER BY updated_at DESC
    `;
    aggregate.stats.total_input_chars += notes.reduce((s, n) => s + n.note.length, 0);

    const perCustomer = {
      entity_id: customer.entity_id,
      bizname: customer.bizname,
      customer_id: customer.customer_id,
      am_count: notes.length,
      total_chars: customer.total_chars,
      notes: notes.map((n) => ({
        am_name: n.am_name,
        updated_at: n.updated_at instanceof Date ? n.updated_at.toISOString() : String(n.updated_at),
        note: n.note,
      })),
      extraction: null,
      validation: null,
      error: null,
    };

    if (SKIP_API) {
      console.log("  (audit-only mode, skipping Haiku)");
      aggregate.per_customer.push(perCustomer);
      continue;
    }

    try {
      const t0 = Date.now();
      const resp = await anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 4000,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(customer, notes) }],
      });
      const elapsed = Date.now() - t0;
      const block = resp.content?.[0];
      const text = block && block.type === "text" ? block.text : "";

      let parsed;
      try {
        // Tolerate code fences just in case
        const cleaned = text.trim().replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        perCustomer.error = `JSON parse failed: ${e.message}`;
        perCustomer.extraction = { raw_text: text };
        aggregate.stats.api_errors++;
        console.log(`  ✗ JSON parse failed`);
        aggregate.per_customer.push(perCustomer);
        continue;
      }

      const cands = Array.isArray(parsed.candidate_facts) ? parsed.candidate_facts : [];
      const valid = [];
      const invalid = [];
      for (const c of cands) {
        const v = validateCandidate(c);
        if (v.ok) {
          valid.push(c);
          aggregate.stats.category_distribution[c.topic_category] =
            (aggregate.stats.category_distribution[c.topic_category] || 0) + 1;
          aggregate.stats.subcategory_distribution[c.topic_subcategory] =
            (aggregate.stats.subcategory_distribution[c.topic_subcategory] || 0) + 1;
          aggregate.stats.field_name_distribution[c.field_name] =
            (aggregate.stats.field_name_distribution[c.field_name] || 0) + 1;
        } else {
          invalid.push({ ...c, _validation_errors: v.errs });
        }
      }
      aggregate.stats.total_candidates += cands.length;
      aggregate.stats.valid_candidates += valid.length;
      aggregate.stats.invalid_candidates += invalid.length;
      if (cands.length === 0) aggregate.stats.empty_extractions++;

      perCustomer.extraction = {
        elapsed_ms: elapsed,
        input_tokens: resp.usage?.input_tokens ?? null,
        output_tokens: resp.usage?.output_tokens ?? null,
        candidate_facts: valid,
        invalid_candidates: invalid,
        extraction_meta: parsed.extraction_meta || null,
      };
      perCustomer.validation = {
        total: cands.length,
        valid: valid.length,
        invalid: invalid.length,
      };
      console.log(`  ✓ ${valid.length} valid / ${invalid.length} invalid · ${elapsed}ms · ${resp.usage?.input_tokens}→${resp.usage?.output_tokens} tok`);
    } catch (e) {
      perCustomer.error = e.message || String(e);
      aggregate.stats.api_errors++;
      console.log(`  ✗ ${e.message}`);
    }

    // Persist per-customer file as we go (resumable mental model)
    const filename = `${customer.entity_id.slice(0, 8)}-${(customer.bizname || "unknown").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}.json`;
    writeFileSync(join(OUTPUT_DIR, filename), JSON.stringify(perCustomer, null, 2));
    aggregate.per_customer.push(perCustomer);
  }

  // ── Step 4 — write aggregate index + markdown summary
  console.log(`\n=== STEP 4: Write aggregate ===`);
  writeFileSync(
    join(OUTPUT_DIR, "_index.json"),
    JSON.stringify(aggregate, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );

  const summary = buildMarkdownSummary(aggregate);
  writeFileSync(join(OUTPUT_DIR, "_summary.md"), summary);

  console.log(`\nWrote ${aggregate.per_customer.length} customer files + _index.json + _summary.md to ${OUTPUT_DIR}/`);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total candidates: ${aggregate.stats.total_candidates}`);
  console.log(`Valid: ${aggregate.stats.valid_candidates}  ·  Invalid: ${aggregate.stats.invalid_candidates}`);
  console.log(`Empty extractions: ${aggregate.stats.empty_extractions}  ·  API errors: ${aggregate.stats.api_errors}`);
  console.log(`Avg candidates/customer: ${(aggregate.stats.valid_candidates / topRows.length).toFixed(1)}`);
  console.log(`${"=".repeat(60)}\n`);
}

function buildMarkdownSummary(agg) {
  const lines = [];
  lines.push(`# Wave 1.5 dry-run — extraction report`);
  lines.push(``);
  lines.push(`Generated: ${agg.generated_at}`);
  lines.push(`Model: ${agg.haiku_model}`);
  lines.push(`Sample size: ${agg.sample_size}`);
  lines.push(``);
  lines.push(`## customer_notes table audit`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  for (const [k, v] of Object.entries(agg.audit)) lines.push(`| ${k} | ${v} |`);
  lines.push(``);
  lines.push(`## Extraction stats`);
  lines.push(``);
  lines.push(`- Total candidates emitted: **${agg.stats.total_candidates}**`);
  lines.push(`- Valid (catalog-conformant): **${agg.stats.valid_candidates}**`);
  lines.push(`- Invalid (schema violations): **${agg.stats.invalid_candidates}**`);
  lines.push(`- Empty extractions: ${agg.stats.empty_extractions}`);
  lines.push(`- API errors: ${agg.stats.api_errors}`);
  lines.push(`- Avg valid candidates per customer: ${(agg.stats.valid_candidates / agg.sample_size).toFixed(1)}`);
  lines.push(``);
  lines.push(`## Category distribution`);
  lines.push(``);
  lines.push(`| Category | Count |`);
  lines.push(`|---|---|`);
  for (const [k, v] of Object.entries(agg.stats.category_distribution).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push(``);
  lines.push(`## Subcategory distribution (top 15)`);
  lines.push(``);
  lines.push(`| Subcategory | Count |`);
  lines.push(`|---|---|`);
  for (const [k, v] of Object.entries(agg.stats.subcategory_distribution).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push(``);
  lines.push(`## Per-customer summary`);
  lines.push(``);
  lines.push(`| Entity | Bizname | AMs | Chars in | Valid | Invalid | Status |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const c of agg.per_customer) {
    const status = c.error ? `ERROR: ${c.error}` : c.validation ? "ok" : "(audit-only)";
    lines.push(`| \`${c.entity_id.slice(0, 8)}\` | ${c.bizname || "?"} | ${c.am_count} | ${c.total_chars} | ${c.validation?.valid ?? "-"} | ${c.validation?.invalid ?? "-"} | ${status} |`);
  }
  lines.push(``);
  lines.push(`## How to review this`);
  lines.push(``);
  lines.push(`1. Open \`_summary.md\` (this file) — start here. Look at the category distribution + per-customer table to spot outliers.`);
  lines.push(`2. Sample-read 3-5 of the \`<entity_id>-<bizname>.json\` files. Focus on the \`candidate_facts\` array.`);
  lines.push(`3. For each candidate, ask:`);
  lines.push(`   - Is the (category, subcategory, field_name) classification right?`);
  lines.push(`   - Is the value accurate to the source_quote? (No invention, no inference.)`);
  lines.push(`   - Is anything missing that's clearly in the notes?`);
  lines.push(`4. If quality is solid: approve to ship the Validate inbox + run on the full book.`);
  lines.push(`5. If the prompt needs tuning: send back specific failure cases and we'll iterate before the full run.`);
  return lines.join("\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

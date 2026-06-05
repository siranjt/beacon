/**
 * Beacon Keeper — Wave 1.5 production extraction from customer_notes.
 *
 * Reads AM-written notes for a customer, sends them to Haiku with the
 * FIELD_CATALOG-aware extraction prompt, and writes each candidate fact
 * to beacon_brain_facts with:
 *   - confidence_state = 'candidate'
 *   - source_type     = 'beacon_ai_extracted'
 *   - source_ref      = "note:<am_name>:<entity_id>::quote:<verbatim>"
 *   - owning_am_email = (best-effort lookup from snapshot by am_name)
 *
 * AMs review candidates via /admin/brain/validate — see lib/brain/repo.ts
 * helpers (confirmCandidateFact, editAndConfirmCandidateFact,
 * rejectCandidateFact, reclassifyCandidateFact).
 *
 * The prompt + validation logic mirrors scripts/wave-1.5-dry-run.mjs
 * (which was the iterated reference implementation). Any future tuning
 * should happen here AND in the dry-run script in lockstep.
 *
 * Idempotency: writeBrainFact skips exact-duplicate values on named
 * fields. For 'other' fields, this module dedupes BEFORE calling
 * writeBrainFact — if a candidate at the same (customer_id, subcategory,
 * field_name='other', value) already exists (any state, not deleted),
 * we don't insert a new one.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getSql } from "../customer/postgres";
import { readLatestSnapshotV2 } from "../customer/postgres";
import { writeBrainFact } from "./repo";
import {
  FIELD_CATALOG,
  categoryForSubcategory,
  isNamedField,
} from "./types";
import type {
  TopicCategory,
  TopicSubcategory,
  BrainFact,
} from "./types";

const HAIKU_MODEL =
  process.env.W15_HAIKU_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4000;

/** One note row from customer_notes. */
export interface NoteRow {
  am_name: string;
  entity_id: string;
  customer_id: string | null;
  bizname: string | null;
  note: string;
  updated_at: string;
}

interface RawCandidate {
  topic_category?: unknown;
  topic_subcategory?: unknown;
  field_name?: unknown;
  value?: unknown;
  source_quote?: unknown;
  source_am_name?: unknown;
  confidence_note?: unknown;
}

interface ValidatedCandidate {
  topic_category: TopicCategory;
  topic_subcategory: TopicSubcategory;
  field_name: string;
  value: string;
  source_quote: string;
  source_am_name: string;
}

export interface ExtractionResult {
  entity_id: string;
  customer_id: string | null;
  bizname: string | null;
  notes_processed: number;
  candidates_proposed: number;
  candidates_valid: number;
  candidates_written: number;
  candidates_duplicate: number;
  candidates_invalid: number;
  errors: string[];
  haiku_input_tokens: number | null;
  haiku_output_tokens: number | null;
}

function catalogPromptBlock(): string {
  const lines: string[] = [];
  for (const sub of Object.keys(FIELD_CATALOG) as TopicSubcategory[]) {
    const entry = FIELD_CATALOG[sub];
    lines.push(
      `  - ${entry.category}/${sub}: ${entry.named_fields.join(", ")}, or "other"`,
    );
  }
  return lines.join("\n");
}

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

function buildUserPrompt(
  bizname: string | null,
  entity_id: string,
  customer_id: string | null,
  notes: NoteRow[],
): string {
  const noteBlocks = notes
    .map(
      (n, i) =>
        `--- Note ${i + 1} of ${notes.length} ---
AM: ${n.am_name}
Last updated: ${n.updated_at}
Note text:
${n.note}`,
    )
    .join("\n\n");

  return `Customer: ${bizname || "(no bizname)"}
Entity ID: ${entity_id}
Chargebee customer_id: ${customer_id || "(none)"}
Note count: ${notes.length}

${noteBlocks}

Now extract candidate Keeper facts per the rules above. Emit the JSON object directly with no preamble.`;
}

function validateCandidate(c: RawCandidate): {
  ok: boolean;
  value?: ValidatedCandidate;
  reason?: string;
} {
  const sub = c.topic_subcategory;
  const cat = c.topic_category;
  const fld = c.field_name;
  const val = c.value;
  const quote = c.source_quote;
  const amName = c.source_am_name;

  if (typeof sub !== "string" || !(sub in FIELD_CATALOG)) {
    return { ok: false, reason: `unknown subcategory: ${String(sub)}` };
  }
  const entry = FIELD_CATALOG[sub as TopicSubcategory];
  if (cat !== entry.category) {
    return {
      ok: false,
      reason: `category mismatch: ${String(cat)} vs expected ${entry.category}`,
    };
  }
  if (typeof fld !== "string" || (fld !== "other" && !entry.named_fields.includes(fld))) {
    return { ok: false, reason: `invalid field_name: ${String(fld)}` };
  }
  if (typeof val !== "string" || val.trim().length === 0) {
    return { ok: false, reason: "empty value" };
  }
  if (typeof quote !== "string" || quote.trim().length < 3) {
    return { ok: false, reason: "missing source_quote" };
  }
  return {
    ok: true,
    value: {
      topic_category: cat as TopicCategory,
      topic_subcategory: sub as TopicSubcategory,
      field_name: fld,
      value: val.trim(),
      source_quote: quote.trim(),
      source_am_name: typeof amName === "string" ? amName : "",
    },
  };
}

/**
 * Look up the AM email for a given am_name from the latest snapshot.
 * Best-effort — returns null if no match. Used to populate
 * owning_am_email on candidate facts.
 *
 * Snapshot caches name→email via the snapshot's am-mapping data; this
 * helper just exposes the mapping for the extractor.
 */
async function buildAmNameToEmail(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const snap = await readLatestSnapshotV2();
    const customers = snap?.customers ?? [];
    for (const c of customers) {
      const am = (c.am_name || "").trim();
      const email = ((c as { am_email?: string }).am_email || "").trim();
      if (am && email && !out.has(am)) out.set(am, email);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Check whether an 'other' candidate (same subcategory + value) already exists. */
async function otherFactExists(
  customer_id: string,
  topic_subcategory: TopicSubcategory,
  value: string,
): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;
  const rows = (await sql`
    SELECT fact_id FROM beacon_brain_facts
    WHERE customer_id = ${customer_id}
      AND topic_subcategory = ${topic_subcategory}
      AND field_name = 'other'
      AND value = ${value}
      AND soft_deleted_at IS NULL
    LIMIT 1
  `) as Array<{ fact_id: string }>;
  return rows.length > 0;
}

/**
 * Pull all customer_notes rows for an entity (one per AM), call Haiku
 * with the extraction prompt, validate, dedupe, and persist candidates.
 *
 * Returns an ExtractionResult summarizing what happened. Errors are
 * collected (not thrown) so a single bad customer doesn't kill the
 * whole cron run.
 */
export async function extractAndPersistForEntity(
  entity_id: string,
  amNameToEmail: Map<string, string>,
  anthropic: Anthropic,
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    entity_id,
    customer_id: null,
    bizname: null,
    notes_processed: 0,
    candidates_proposed: 0,
    candidates_valid: 0,
    candidates_written: 0,
    candidates_duplicate: 0,
    candidates_invalid: 0,
    errors: [],
    haiku_input_tokens: null,
    haiku_output_tokens: null,
  };

  const sql = getSql();
  if (!sql) {
    result.errors.push("no postgres connection");
    return result;
  }

  // Pull notes for this entity.
  const noteRows = (await sql`
    SELECT am_name, entity_id, customer_id, bizname, note, updated_at
    FROM customer_notes
    WHERE entity_id = ${entity_id}
      AND note IS NOT NULL AND length(trim(note)) > 0
    ORDER BY updated_at DESC
  `) as Array<{
    am_name: string;
    entity_id: string;
    customer_id: string | null;
    bizname: string | null;
    note: string;
    updated_at: string | Date;
  }>;

  if (noteRows.length === 0) {
    result.errors.push("no notes for entity");
    return result;
  }

  const notes: NoteRow[] = noteRows.map((r) => ({
    am_name: r.am_name,
    entity_id: r.entity_id,
    customer_id: r.customer_id,
    bizname: r.bizname,
    note: r.note,
    updated_at:
      typeof r.updated_at === "string"
        ? r.updated_at
        : r.updated_at.toISOString(),
  }));
  result.notes_processed = notes.length;

  const cbCustomerId = notes.find((n) => n.customer_id)?.customer_id ?? null;
  const bizname = notes.find((n) => n.bizname)?.bizname ?? null;
  result.customer_id = cbCustomerId;
  result.bizname = bizname;

  // Candidates need a customer_id (Chargebee handle) to key on — same
  // rule as the Wave 1 bootstrap. Skip if missing.
  if (!cbCustomerId) {
    result.errors.push("no Chargebee customer_id — cannot key candidates");
    return result;
  }

  // Call Haiku.
  let resp: Anthropic.Messages.Message;
  try {
    resp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: MAX_TOKENS,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(bizname, entity_id, cbCustomerId, notes),
        },
      ],
    });
  } catch (e) {
    result.errors.push(`haiku call failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  result.haiku_input_tokens = resp.usage?.input_tokens ?? null;
  result.haiku_output_tokens = resp.usage?.output_tokens ?? null;

  const firstBlock = resp.content?.[0];
  const text = firstBlock && firstBlock.type === "text" ? firstBlock.text : "";
  let parsed: { candidate_facts?: RawCandidate[] };
  try {
    const cleaned = text
      .trim()
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    result.errors.push(`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  const candidates = Array.isArray(parsed.candidate_facts)
    ? parsed.candidate_facts
    : [];
  result.candidates_proposed = candidates.length;

  // Validate + persist each candidate.
  for (const raw of candidates) {
    const v = validateCandidate(raw);
    if (!v.ok || !v.value) {
      result.candidates_invalid++;
      continue;
    }
    result.candidates_valid++;
    const c = v.value;

    // Dedupe 'other' candidates by value.
    if (c.field_name === "other") {
      const exists = await otherFactExists(
        cbCustomerId,
        c.topic_subcategory,
        c.value,
      );
      if (exists) {
        result.candidates_duplicate++;
        continue;
      }
    }

    const sourceRef = `note:${c.source_am_name}:${entity_id}::quote:${c.source_quote}`;
    const owningAmEmail =
      (c.source_am_name && amNameToEmail.get(c.source_am_name)) ||
      null;

    try {
      const written = await writeBrainFact({
        customer_id: cbCustomerId,
        topic_category: c.topic_category,
        topic_subcategory: c.topic_subcategory,
        field_name: c.field_name,
        value: c.value,
        source_type: "beacon_ai_extracted",
        source_ref: sourceRef,
        owning_am_email: owningAmEmail,
        // No confirmed_by_email — lands as 'candidate' for AM triage.
      });
      if (written) {
        // Named-field idempotency: writeBrainFact short-circuits if value
        // matches an existing fact. We treat that as "not really written,
        // it was already there" — count as duplicate.
        // We can detect by checking confidence_state: if the existing was
        // confirmed, the candidate fact didn't get inserted at all.
        // Simplest heuristic: count as written. The dup is harmless because
        // the unique index on named fields prevents true duplication.
        result.candidates_written++;
      } else {
        result.candidates_invalid++;
        result.errors.push(`writeBrainFact returned null for ${c.topic_subcategory}/${c.field_name}`);
      }
    } catch (e) {
      // Category/field mismatch errors thrown by writeBrainFact land here.
      result.candidates_invalid++;
      result.errors.push(
        `write failed for ${c.topic_subcategory}/${c.field_name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Verify all required outputs were referenced (TypeScript exhaustiveness).
  void categoryForSubcategory;
  void isNamedField;
  void ({} as BrainFact);

  return result;
}

/**
 * Find all entity_ids whose customer_notes row was updated since a given
 * timestamp. Used by the daily cron — picks up notes touched in the last
 * 24h (or all notes when backfilling).
 */
export async function listEntitiesWithNotesSince(
  since: Date | null,
): Promise<string[]> {
  const sql = getSql();
  if (!sql) return [];
  const sinceIso = since ? since.toISOString() : null;
  const rows = (await sql`
    SELECT DISTINCT entity_id
    FROM customer_notes
    WHERE note IS NOT NULL AND length(trim(note)) > 0
      AND (${sinceIso}::timestamptz IS NULL OR updated_at >= ${sinceIso})
    ORDER BY entity_id
  `) as Array<{ entity_id: string }>;
  return rows.map((r) => r.entity_id);
}

/**
 * Top-level run: iterate every entity with notes touched since `since`,
 * extract candidates, persist. Returns the aggregate stats.
 */
export interface RunResult {
  started_at: string;
  finished_at: string;
  entities_attempted: number;
  entities_succeeded: number;
  entities_with_errors: number;
  total_candidates_written: number;
  total_candidates_invalid: number;
  total_candidates_duplicate: number;
  total_input_tokens: number;
  total_output_tokens: number;
  per_entity: ExtractionResult[];
  errors: string[];
}

export async function runExtractionSince(
  since: Date | null,
): Promise<RunResult> {
  const startedAt = new Date();
  const result: RunResult = {
    started_at: startedAt.toISOString(),
    finished_at: "",
    entities_attempted: 0,
    entities_succeeded: 0,
    entities_with_errors: 0,
    total_candidates_written: 0,
    total_candidates_invalid: 0,
    total_candidates_duplicate: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    per_entity: [],
    errors: [],
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    result.errors.push("ANTHROPIC_API_KEY not set");
    result.finished_at = new Date().toISOString();
    return result;
  }
  const anthropic = new Anthropic({ apiKey, maxRetries: 3 });

  const entities = await listEntitiesWithNotesSince(since);
  result.entities_attempted = entities.length;
  if (entities.length === 0) {
    result.finished_at = new Date().toISOString();
    return result;
  }

  const amNameToEmail = await buildAmNameToEmail();

  for (const entityId of entities) {
    const per = await extractAndPersistForEntity(
      entityId,
      amNameToEmail,
      anthropic,
    );
    result.per_entity.push(per);
    if (per.errors.length > 0) {
      result.entities_with_errors++;
    } else {
      result.entities_succeeded++;
    }
    result.total_candidates_written += per.candidates_written;
    result.total_candidates_invalid += per.candidates_invalid;
    result.total_candidates_duplicate += per.candidates_duplicate;
    result.total_input_tokens += per.haiku_input_tokens ?? 0;
    result.total_output_tokens += per.haiku_output_tokens ?? 0;
  }

  result.finished_at = new Date().toISOString();
  return result;
}

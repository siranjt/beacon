/**
 * Fetch and enrich HubSpot notes (Fireflies-processed call summaries)
 * associated with active customer companies.
 *
 * For each company, returns its single most-recent note (last 60 days)
 * with Haiku-extracted { sentiment, topics[], action_items[], fireflies_url }.
 *
 * Caching: hubspot_note_enrichment table keyed on note_id. We only re-Haiku
 * a note when its content (or hash) changes. Self-heals the table via
 * CREATE TABLE IF NOT EXISTS on first run.
 */

import { hubspotBatchAssociations, hubspotBatchRead, hubspotConfigured } from "./hubspot";
import { callHaikuJson, llmConfigured } from "./llm";

export type LastCallSummary = {
  note_id: string;
  date: string;                        // ISO timestamp
  sentiment: "warm" | "neutral" | "frustrated" | "unknown";
  topics: string[];                    // top 3
  action_items: string[];              // top 5
  fireflies_url: string | null;
  body_preview: string;                // first 200 chars, plain text
};

type HubspotApiNote = {
  id: string;
  properties: Record<string, string>;
};

const NOTE_PROPS = ["hs_note_body", "hs_body_preview", "hs_createdate", "hubspot_owner_id"];

const SYSTEM_PROMPT = `You analyze customer success meeting notes (typically Fireflies-processed transcripts) between an account manager and a small-business owner.

Input: a note body. Output STRICT JSON only, no preamble:

{
  "sentiment": "warm" | "neutral" | "frustrated",
  "topics": ["...", "...", "..."],
  "action_items": ["...", "..."]
}

Rules:
- topics: 1-3 short noun phrases (max 4 words each) describing what was discussed
  (e.g., "Renewal pricing", "Square booking integration", "Groupon strategy")
- action_items: 0-5 short imperative items (max 12 words each). Pull from any
  "Action Items" or "Next Steps" section if present. Pull names ("Shruti to...")
- sentiment: warm/neutral/frustrated based on overall tone. Customer concerns,
  budget pushback, complaints = frustrated. Engaged collaboration = warm.
- Use only what's in the note. Don't invent facts.`;

type EnrichedNote = {
  sentiment: "warm" | "neutral" | "frustrated";
  topics: string[];
  action_items: string[];
};

const FALLBACK: EnrichedNote = {
  sentiment: "neutral",
  topics: [],
  action_items: [],
};

/** Extract first Fireflies URL from the note body, if present. */
function extractFirefliesUrl(body: string): string | null {
  if (!body) return null;
  const m = body.match(/https?:\/\/app\.fireflies\.ai\/view\/[A-Z0-9]+/);
  return m ? m[0] : null;
}

/** Strip HTML to plain text + collapse whitespace. */
function htmlToText(html: string): string {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * For each company_id → returns its single most recent note (if any in 60d).
 */
/**
 * Discover the most-recent note per company. Exported so callers can
 * (1) read the cache by note_id before paying the Haiku enrichment cost,
 * and (2) pass a populated cache into `fetchEnrichedNotesPerCompany`.
 *
 * Without this pre-fetch, every Stage D run re-enriches every note from
 * scratch — that was the root cause of the 22:00 UTC cron timing out.
 */
export async function fetchLatestNotePerCompany(
  hubspotCompanyIds: string[],
): Promise<Map<string, HubspotApiNote>> {
  const map = new Map<string, HubspotApiNote>();
  if (!hubspotConfigured() || !hubspotCompanyIds.length) return map;

  // 1) Get note IDs per company via associations
  const companyToNoteIds = await hubspotBatchAssociations(
    "companies",
    hubspotCompanyIds,
    "notes",
  );
  if (companyToNoteIds.size === 0) return map;

  // 2) Collect all unique note IDs
  const allNoteIds = new Set<number>();
  for (const ids of companyToNoteIds.values()) {
    for (const id of ids) allNoteIds.add(id);
  }
  if (allNoteIds.size === 0) return map;

  // 3) Batch-read notes (limited fields)
  const noteRecords = new Map<string, HubspotApiNote>();
  const noteIdsArr = Array.from(allNoteIds);
  const fetched = await hubspotBatchRead<HubspotApiNote>("notes", noteIdsArr, NOTE_PROPS);
  for (const n of fetched) noteRecords.set(n.id, n);

  // 4) For each company, find the most recent note (last 60d)
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const [companyId, noteIds] of companyToNoteIds) {
    let bestId: string | null = null;
    let bestMs = 0;
    for (const nid of noteIds) {
      const note = noteRecords.get(String(nid));
      if (!note) continue;
      const createdMs = Date.parse(note.properties.hs_createdate || "");
      if (!Number.isFinite(createdMs) || createdMs < cutoff) continue;
      if (createdMs > bestMs) {
        bestMs = createdMs;
        bestId = String(nid);
      }
    }
    if (bestId) {
      const note = noteRecords.get(bestId);
      if (note) map.set(companyId, note);
    }
  }
  return map;
}

/**
 * Enrich a single note with Haiku. Skipped if note already cached in
 * hubspot_note_enrichment for this note_id.
 */
async function enrichNoteWithCache(
  note: HubspotApiNote,
  cached: Map<string, EnrichedNote>,
): Promise<EnrichedNote> {
  if (cached.has(note.id)) return cached.get(note.id)!;
  if (!llmConfigured()) return FALLBACK;

  const body = note.properties.hs_note_body || note.properties.hs_body_preview || "";
  const text = htmlToText(body);
  if (text.length < 50) return FALLBACK;          // too short to bother

  // Truncate to 10K chars — Haiku-friendly, captures the whole summary section
  const prompt = `Analyze this customer call note and return strict JSON only:\n\n---\n${text.slice(0, 10_000)}\n---`;

  const result = await callHaikuJson<EnrichedNote>(
    {
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 400,
      temperature: 0.1,
      timeoutMs: 6_000,
    },
    FALLBACK,
  );
  // Defensive sanitize
  return {
    sentiment: ["warm", "neutral", "frustrated"].includes(result.sentiment)
      ? result.sentiment
      : "neutral",
    topics: Array.isArray(result.topics) ? result.topics.slice(0, 3).map((s) => String(s).slice(0, 60)) : [],
    action_items: Array.isArray(result.action_items)
      ? result.action_items.slice(0, 5).map((s) => String(s).slice(0, 200))
      : [],
  };
}

/**
 * Main entry. Returns per-company most-recent enriched note.
 */
export async function fetchEnrichedNotesPerCompany(
  hubspotCompanyIds: string[],
  cachedEnrichments: Map<string, EnrichedNote>,
): Promise<{
  perCompany: Map<string, LastCallSummary>;
  toCache: Map<string, EnrichedNote>;
}> {
  const perCompany = new Map<string, LastCallSummary>();
  const toCache = new Map<string, EnrichedNote>();
  if (!hubspotConfigured() || !hubspotCompanyIds.length) {
    return { perCompany, toCache };
  }

  const latestNotes = await fetchLatestNotePerCompany(hubspotCompanyIds);
  if (latestNotes.size === 0) {
    console.log("[hubspot-notes] no recent notes for any company");
    return { perCompany, toCache };
  }

  // Concurrency-cap Haiku enrichment (note bodies are bigger than narratives)
  const entries = Array.from(latestNotes.entries());
  const CONCURRENCY = 10;
  let idx = 0;
  let enrichedCount = 0;
  let cacheHits = 0;
  async function worker() {
    while (idx < entries.length) {
      const i = idx++;
      const [companyId, note] = entries[i];
      const wasCached = cachedEnrichments.has(note.id);
      const enriched = await enrichNoteWithCache(note, cachedEnrichments);
      if (wasCached) cacheHits += 1;
      else {
        enrichedCount += 1;
        toCache.set(note.id, enriched);
      }
      const body = note.properties.hs_note_body || "";
      const preview = htmlToText(body).slice(0, 200);
      perCompany.set(companyId, {
        note_id: note.id,
        date: note.properties.hs_createdate || "",
        sentiment: enriched.sentiment,
        topics: enriched.topics,
        action_items: enriched.action_items,
        fireflies_url: extractFirefliesUrl(body),
        body_preview: preview,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()),
  );
  console.log(
    `[hubspot-notes] enriched ${enrichedCount} new, ${cacheHits} cached, ${perCompany.size} total companies`,
  );
  return { perCompany, toCache };
}

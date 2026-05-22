import Papa from "papaparse";
import { METABASE_ENDPOINTS } from "./config";

/**
 * Phase 28 — per-entity comms thread fetcher.
 *
 * Mirrors the fetch/parse approach of `fetchAllCommsSequential` in
 * `lib/metabase.ts`, but with three differences:
 *   1. Filters by `entity_id` DURING parse — rows for other entities are
 *      dropped immediately so we never hold them in memory.
 *   2. Keeps the message body so the UI can render the thread.
 *   3. Returns a per-entity slice (typically tens to hundreds of rows)
 *      instead of the full multi-million-row corpus.
 *
 * Soft-fail behavior: on any Metabase or parse error we log a warning and
 * return `[]`. The detail page must never crash because comms are slow.
 */

export type EntityCommsEvent = {
  ts: number;
  channel: "chat" | "email" | "phone" | "video" | "sms";
  direction: "in" | "out";
  body: string;
  sender: string;
  duration?: number;
};

async function fetchCsvText(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    headers: { Accept: "text/csv" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Metabase CSV ${url} ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.text();
}

function parseRows<T extends Record<string, string>>(csv: string): T[] {
  const out = Papa.parse<T>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return (out.data || []).filter((r) => r && typeof r === "object");
}

function parseTs(s: string | undefined): number | null {
  if (!s) return null;
  const clean = s.trim();
  if (!clean) return null;
  const t = Date.parse(
    clean.endsWith("Z") ? clean : clean.includes("+") ? clean : clean + "Z",
  );
  return Number.isFinite(t) ? t : null;
}

function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Fetch + filter + parse all 5 comms feeds for a single entity over the last
 * `daysBack` days. Returns events sorted newest-first. Soft-fails to [] on
 * any error (logs a warning).
 */
export async function fetchCommsForEntity(
  entityId: string,
  daysBack: number = 90,
): Promise<EntityCommsEvent[]> {
  if (!entityId) return [];
  const days = Math.max(1, Math.min(180, Math.floor(daysBack || 90)));
  const cutoff = Date.now() - days * 86400 * 1000;
  const events: EntityCommsEvent[] = [];

  try {
    // ----- Chat -----
    try {
      const csv = await fetchCsvText(METABASE_ENDPOINTS.chat);
      const rows = parseRows<Record<string, string>>(csv);
      for (const r of rows) {
        const eid = (r["Entity ID"] || "").trim();
        if (eid !== entityId) continue;
        const ts = parseTs(r["Created At"]);
        if (ts === null || ts < cutoff) continue;
        const mt = r["Member Type"];
        const body = r["Message Body"] || "";
        const sender = r["Sender"] || "";
        if (mt === "Team Member") {
          events.push({ ts, channel: "chat", direction: "out", body, sender });
        } else if (mt === "User") {
          events.push({ ts, channel: "chat", direction: "in", body, sender });
        }
      }
    } catch (e) {
      console.warn(
        "[fetchCommsForEntity] chat fetch/parse failed:",
        e instanceof Error ? e.message : e,
      );
    }

    // ----- Email -----
    try {
      const csv = await fetchCsvText(METABASE_ENDPOINTS.email);
      const rows = parseRows<Record<string, string>>(csv);
      for (const r of rows) {
        const eid = (r["Entity ID"] || "").trim();
        if (eid !== entityId) continue;
        const ts = parseTs(r["Created At"]);
        if (ts === null || ts < cutoff) continue;
        const s = r["Sender"];
        const body = r["Message Body"] || "";
        if (s === "Received_By_Client") {
          events.push({ ts, channel: "email", direction: "out", body, sender: s });
        } else if (s === "Sent_By_Client") {
          events.push({ ts, channel: "email", direction: "in", body, sender: s });
        }
      }
    } catch (e) {
      console.warn(
        "[fetchCommsForEntity] email fetch/parse failed:",
        e instanceof Error ? e.message : e,
      );
    }

    // ----- Phone -----
    try {
      const csv = await fetchCsvText(METABASE_ENDPOINTS.phone);
      const rows = parseRows<Record<string, string>>(csv);
      for (const r of rows) {
        const eid = (r["Entity ID"] || "").trim();
        if (eid !== entityId) continue;
        const ts = parseTs(r["Created At"]);
        if (ts === null || ts < cutoff) continue;
        const s = r["Sender"];
        const body = r["Message Body"] || "";
        const duration = parseDuration(r["Call Duration"]);
        if (s === "Initiated_By_Us") {
          events.push({
            ts,
            channel: "phone",
            direction: "out",
            body,
            sender: s,
            duration,
          });
        } else if (s === "Initiated_By_Client") {
          events.push({
            ts,
            channel: "phone",
            direction: "in",
            body,
            sender: s,
            duration,
          });
        }
      }
    } catch (e) {
      console.warn(
        "[fetchCommsForEntity] phone fetch/parse failed:",
        e instanceof Error ? e.message : e,
      );
    }

    // ----- Video (single entry per row; direction set to "in" since
    //        videos are mutual meetings rather than directional messages) -----
    try {
      const csv = await fetchCsvText(METABASE_ENDPOINTS.video);
      const rows = parseRows<Record<string, string>>(csv);
      for (const r of rows) {
        const eid = (r["Entity ID"] || "").trim();
        if (eid !== entityId) continue;
        const ts = parseTs(r["Created At"]);
        if (ts === null || ts < cutoff) continue;
        const sender = r["Organizer Email"] || r["Sender"] || "";
        const duration = parseDuration(r["Duration"]);
        events.push({
          ts,
          channel: "video",
          direction: "in",
          body: "",
          sender,
          duration,
        });
      }
    } catch (e) {
      console.warn(
        "[fetchCommsForEntity] video fetch/parse failed:",
        e instanceof Error ? e.message : e,
      );
    }

    // ----- SMS -----
    try {
      const csv = await fetchCsvText(METABASE_ENDPOINTS.sms);
      const rows = parseRows<Record<string, string>>(csv);
      for (const r of rows) {
        const eid = (r["Entity ID"] || "").trim();
        if (eid !== entityId) continue;
        const ts = parseTs(r["Created At"]);
        if (ts === null || ts < cutoff) continue;
        const s = r["Sender"];
        const body = r["Message Body"] || "";
        if (s === "Received_By_Client") {
          events.push({ ts, channel: "sms", direction: "out", body, sender: s });
        } else if (s === "Sent_By_Client") {
          events.push({ ts, channel: "sms", direction: "in", body, sender: s });
        }
      }
    } catch (e) {
      console.warn(
        "[fetchCommsForEntity] sms fetch/parse failed:",
        e instanceof Error ? e.message : e,
      );
    }
  } catch (e) {
    console.warn(
      "[fetchCommsForEntity] top-level failure:",
      e instanceof Error ? e.message : e,
    );
    return [];
  }

  // Sort newest first
  events.sort((a, b) => b.ts - a.ts);
  return events;
}

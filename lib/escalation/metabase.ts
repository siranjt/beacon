// Metabase access — public CSV endpoints (no auth needed).
//
// Production note: the comms CSVs are HUGE (the SMS feed alone is ~130 MB and
// 1.1M rows). Buffering the whole CSV via res.text() before parsing OOMs and
// frequently times out on Vercel. We therefore stream-parse the response,
// and we expose a separate streamFilterCsv() that exits as soon as it has
// `maxMatches` rows matching a predicate. The CSVs are cached at the Vercel
// edge for 24h so the slow first request becomes a one-time tax.

import type { Channel, CommsMessage } from "./types";

const PUBLIC = {
  baseSheet:
    "https://metabase.zoca.ai/public/question/87763e8c-8084-442e-891a-df1b11e81b47.csv",
  appChat:
    "https://metabase.zoca.ai/public/question/10a52e37-04fa-4422-b840-803b66e033bf.csv",
  email:
    "https://metabase.zoca.ai/public/question/7a5aa1f6-9205-4e83-be51-3e585aa0f4a8.csv",
  phone:
    "https://metabase.zoca.ai/public/question/60797a27-c546-450d-b00b-a51b7e490143.csv",
  video:
    "https://metabase.zoca.ai/public/question/d95d9354-7c84-4a57-8af5-e700580c6ecb.csv",
  sms:
    "https://metabase.zoca.ai/public/question/bbaad2fb-5f9d-4249-af59-c7812851437c.csv",
} as const;

// --- CSV parsing primitives ------------------------------------------------

export function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // ignore
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

// Buffered fetch — used only for the small BaseSheet (~2 MB).
async function fetchCsv(url: string, revalidateSec = 86400): Promise<Record<string, string>[]> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/csv" },
    next: { revalidate: revalidateSec },
  });
  if (!res.ok) throw new Error(`Metabase ${url} ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}

// Streaming filter — never holds the whole CSV in memory and exits the read
// loop the moment we have `maxMatches` rows that pass `predicate`. Returns
// {rows, hitLimit, aborted}. `aborted` means we hit the per-call timeout.
export async function streamFilterCsv(
  url: string,
  predicate: (row: Record<string, string>) => boolean,
  maxMatches: number,
  timeoutMs: number,
  revalidateSec = 86400
): Promise<{ rows: Record<string, string>[]; hitLimit: boolean; aborted: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const matches: Record<string, string>[] = [];
  let aborted = false;
  let hitLimit = false;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/csv" },
      signal: controller.signal,
      next: { revalidate: revalidateSec },
    });
    if (!res.ok) throw new Error(`Metabase ${url} ${res.status}`);
    if (!res.body) return { rows: [], hitLimit: false, aborted: false };

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    // Stateful streaming parser — must persist across chunks.
    let headers: string[] | null = null;
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let buf = "";

    const commitField = () => {
      row.push(field);
      field = "";
    };
    const commitRow = () => {
      if (!headers) {
        headers = row.map((h) => h.trim());
      } else {
        const obj: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
        // Skip blank trailing lines.
        if (Object.values(obj).some((v) => v && v.length > 0)) {
          if (predicate(obj)) matches.push(obj);
        }
      }
      row = [];
    };

    let done = false;
    while (!done && matches.length < maxMatches) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        // AbortController fired
        aborted = true;
        break;
      }
      done = chunk.done;
      if (chunk.value) buf += decoder.decode(chunk.value, { stream: !done });

      let i = 0;
      let stop = false;
      while (i < buf.length) {
        const c = buf[i];
        if (inQuotes) {
          if (c === '"') {
            // Need to peek at i+1; if that's beyond buf and we're not at EOF,
            // wait for more data so we don't misclassify a CSV escaped "".
            if (i + 1 >= buf.length && !done) {
              break;
            }
            if (buf[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              inQuotes = false;
              i++;
            }
          } else {
            field += c;
            i++;
          }
        } else {
          if (c === '"') {
            inQuotes = true;
            i++;
          } else if (c === ",") {
            commitField();
            i++;
          } else if (c === "\n") {
            commitField();
            commitRow();
            i++;
            if (matches.length >= maxMatches) {
              hitLimit = true;
              stop = true;
              break;
            }
          } else if (c === "\r") {
            i++;
          } else {
            field += c;
            i++;
          }
        }
      }
      buf = buf.slice(i);

      if (stop) break;
      if (done) {
        // EOF: flush any trailing partial row
        if (field.length > 0 || row.length > 0) {
          commitField();
          commitRow();
        }
        break;
      }
    }

    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  } catch (err: any) {
    // Could be abort or network error; bail with whatever we have.
    if (err?.name === "AbortError") aborted = true;
    else throw err;
  } finally {
    clearTimeout(timer);
  }

  return { rows: matches, hitLimit, aborted };
}

// --- BaseSheet (master customer reference) ---------------------------------

export interface BaseSheetRow {
  entity_id: string;
  bizname: string;
  customer_id: string;
  app_email: string;
  gbp_email: string;
  dct_email: string;
  sp_name: string;
  ae_name: string;
  am_name: string;
  phone_number: string;
  chrone_zoca_status: string;
  churn_date: string;
  total_monthly_revenue: string;
}

export async function fetchBaseSheet(): Promise<BaseSheetRow[]> {
  const rows = await fetchCsv(PUBLIC.baseSheet);
  return rows as unknown as BaseSheetRow[];
}

export async function findBaseSheetRow(opts: {
  customerId?: string;
  entityId?: string;
  email?: string;
  bizName?: string;
}): Promise<BaseSheetRow | null> {
  const all = await fetchBaseSheet();
  const norm = (s?: string) => (s || "").trim().toLowerCase();
  const wantCid = norm(opts.customerId);
  const wantEid = norm(opts.entityId);
  const wantEmail = norm(opts.email);
  const wantBiz = norm(opts.bizName);

  const matches = all.filter((r) => {
    if (wantCid && norm(r.customer_id) === wantCid) return true;
    if (wantEid && norm(r.entity_id) === wantEid) return true;
    if (wantEmail) {
      if (
        norm(r.app_email) === wantEmail ||
        norm(r.gbp_email) === wantEmail ||
        norm(r.dct_email) === wantEmail
      )
        return true;
    }
    if (wantBiz && norm(r.bizname) === wantBiz) return true;
    return false;
  });
  return matches[0] || null;
}

export async function searchBaseSheet(query: string, limit = 10): Promise<BaseSheetRow[]> {
  const all = await fetchBaseSheet();
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];

  const exact = all.filter(
    (r) =>
      r.entity_id?.toLowerCase() === q ||
      r.customer_id?.toLowerCase() === q ||
      r.app_email?.toLowerCase() === q ||
      r.gbp_email?.toLowerCase() === q ||
      r.dct_email?.toLowerCase() === q ||
      r.bizname?.toLowerCase() === q
  );
  if (exact.length) return exact.slice(0, limit);

  const fuzzy = all.filter((r) => {
    const name = (r.bizname || "").toLowerCase();
    const emails = [r.app_email, r.gbp_email, r.dct_email]
      .map((e) => (e || "").toLowerCase())
      .join(" ");
    return name.includes(q) || emails.includes(q);
  });
  return fuzzy.slice(0, limit);
}

// --- Communications --------------------------------------------------------

const FIELD_OF: Record<
  Channel,
  { created: string; sender: string; body: string; entity: string; duration?: string; memberType?: string; organizer?: string }
> = {
  app_chat: {
    created: "Created At",
    sender: "Sender",
    body: "Message Body",
    entity: "Entity ID",
    // App Chat has a separate column that distinguishes "User" (client) from
    // "Team Member" (Zoca staff). The Sender field holds the person's name.
    memberType: "Member Type",
  },
  email: { created: "Created At", sender: "Sender", body: "Message Body", entity: "Entity ID" },
  phone: {
    created: "Created At",
    sender: "Sender",
    body: "Message Body",
    entity: "Entity ID",
    duration: "Call Duration",
  },
  video: {
    created: "Created At",
    sender: "Sender",
    body: "Source",
    entity: "Entity ID",
    duration: "Duration",
    organizer: "Organizer Email",
  },
  sms: { created: "Created At", sender: "Sender", body: "Message Body", entity: "Entity ID" },
};

const URL_OF: Record<Channel, string> = {
  app_chat: PUBLIC.appChat,
  email: PUBLIC.email,
  phone: PUBLIC.phone,
  video: PUBLIC.video,
  sms: PUBLIC.sms,
};

// Sender classification by channel — verified against real CSV data:
//
//   email + sms  : Sent_By_Client (client) | Received_By_Client (team)
//   phone        : Initiated_By_Client (client) | Initiated_By_Us (team)
//   app_chat     : Member Type column distinguishes; Sender column holds the
//                  person's display name. "User" = client, "Team Member" = team,
//                  "Assistant" = team (bot replies count as team).
//   video        : Sender column is always "Video Call - no sender". We rely
//                  on Organizer Email — *@zoca.com = team-organized, otherwise
//                  client-organized.
function classifySender(
  channel: Channel,
  raw: string,
  memberType?: string,
  organizer?: string
): "client" | "team" | "unknown" {
  const sl = (raw || "").trim().toLowerCase();
  const ml = (memberType || "").trim().toLowerCase();
  const ol = (organizer || "").trim().toLowerCase();

  if (channel === "app_chat") {
    if (ml === "user") return "client";
    if (ml === "team member" || ml === "assistant") return "team";
    // Fallback: substring match on sender if Member Type is missing
    if (sl === "user" || sl === "client") return "client";
    return "unknown";
  }

  if (channel === "email" || channel === "sms") {
    if (sl === "sent_by_client") return "client";
    if (sl === "received_by_client") return "team";
    return "unknown";
  }

  if (channel === "phone") {
    if (sl === "initiated_by_us" || sl === "initiated_by_zoca") return "team";
    if (sl === "initiated_by_client") return "client";
    return "unknown";
  }

  if (channel === "video") {
    if (ol.endsWith("@zoca.com") || ol.includes("@zoca.")) return "team";
    if (ol.includes("@")) return "client";
    return "unknown";
  }

  return "unknown";
}

// Display label for the sender — the actual person/role name when available.
// App Chat has real names; other channels just have the directional encoding.
function senderLabelFor(
  channel: Channel,
  raw: string,
  memberType: string | undefined,
  organizer: string | undefined,
  classified: "client" | "team" | "unknown"
): string | undefined {
  const r = (raw || "").trim();
  if (channel === "app_chat") {
    return r || undefined;
  }
  if (channel === "video") {
    return organizer || undefined;
  }
  // Email / SMS / Phone — directional values aren't useful as labels.
  return undefined;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export interface CommsResult {
  messages: CommsMessage[];
  perChannelStatus: Record<
    Channel,
    { fetched: number; aborted: boolean; error?: string }
  >;
}

// Fetch a single channel for the given entity. Stream-parses + early-exits.
export async function fetchChannelForEntity(
  entityId: string,
  channel: Channel,
  opts?: { sinceDays?: number; perChannelLimit?: number; timeoutMs?: number }
): Promise<{ messages: CommsMessage[]; aborted: boolean; error?: string }> {
  const sinceDays = opts?.sinceDays ?? 90;
  const perChannelLimit = opts?.perChannelLimit ?? 100;
  const timeoutMs = opts?.timeoutMs ?? 25000;
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 24 * 3600 * 1000 : 0;
  const fields = FIELD_OF[channel];

  // Cap how many rows we accumulate. Many CSVs are sorted ASC, so we may
  // accept all and then take the most recent N at the end.
  const MAX_ROWS = Math.max(perChannelLimit, 500);

  try {
    const result = await streamFilterCsv(
      URL_OF[channel],
      (row) => {
        if ((row[fields.entity] || "").trim() !== entityId) return false;
        if (cutoff > 0) {
          const t = Date.parse(row[fields.created] || "");
          if (Number.isNaN(t) || t < cutoff) return false;
        }
        return true;
      },
      MAX_ROWS,
      timeoutMs
    );

    const parsed: CommsMessage[] = result.rows
      .map((r) => {
        const t = Date.parse(r[fields.created] || "");
        if (Number.isNaN(t)) return null;
        // Keep the full body for the UI. The agent prompt builder applies its
        // own per-message cap so token economy isn't at risk.
        const body = r[fields.body] || "";
        const senderRaw = r[fields.sender] || "";
        const memberType = fields.memberType ? r[fields.memberType] : undefined;
        const organizer = fields.organizer ? r[fields.organizer] : undefined;
        const sender = classifySender(channel, senderRaw, memberType, organizer);
        const senderLabel = senderLabelFor(channel, senderRaw, memberType, organizer, sender);
        const msg: CommsMessage = {
          channel,
          createdAt: new Date(t).toISOString(),
          sender,
          senderLabel,
          body,
        };
        if (fields.duration) {
          const d = Number(r[fields.duration]);
          if (!Number.isNaN(d)) msg.durationSec = d;
        }
        return msg;
      })
      .filter((m): m is CommsMessage => m !== null);

    parsed.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { messages: parsed.slice(0, perChannelLimit), aborted: result.aborted };
  } catch (err: any) {
    return { messages: [], aborted: false, error: err?.message || "fetch failed" };
  }
}

// Multi-channel fetch with per-channel budget + partial-results semantics.
export async function fetchCommsForEntity(
  entityId: string,
  opts?: { sinceDays?: number; perChannelLimit?: number; perChannelTimeoutMs?: number }
): Promise<CommsResult> {
  const channels: Channel[] = ["app_chat", "email", "phone", "video", "sms"];
  const sinceDays = opts?.sinceDays ?? 90;
  const perChannelLimit = opts?.perChannelLimit ?? 100;
  const timeoutMs = opts?.perChannelTimeoutMs ?? 25000;

  const perChannelStatus: CommsResult["perChannelStatus"] = {
    app_chat: { fetched: 0, aborted: false },
    email: { fetched: 0, aborted: false },
    phone: { fetched: 0, aborted: false },
    video: { fetched: 0, aborted: false },
    sms: { fetched: 0, aborted: false },
  };

  const results = await Promise.all(
    channels.map((ch) =>
      fetchChannelForEntity(entityId, ch, {
        sinceDays,
        perChannelLimit,
        timeoutMs,
      }).then((r) => ({ ch, ...r }))
    )
  );

  const all: CommsMessage[] = [];
  for (const r of results) {
    perChannelStatus[r.ch] = {
      fetched: r.messages.length,
      aborted: r.aborted,
      error: r.error,
    };
    all.push(...r.messages);
  }
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { messages: all, perChannelStatus };
}

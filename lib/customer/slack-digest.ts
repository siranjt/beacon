/**
 * Daily Slack digest — Phase 21.
 *
 * For every active AM in the latest snapshot, compose a Block Kit message
 * summarizing their book and post it to `SLACK_WEBHOOK_URL` (Phase 9.8).
 * Includes:
 *   - Header with AM name + RED count
 *   - Pod context line + RED/YELLOW counts
 *   - Top 3 most-urgent (RED) customers with one-line narrative + days silent
 *   - "Open my planner →" button linking to /v2?am={amName}
 *
 * Edge cases:
 *   - AMs with zero customers (e.g. Taanya Solanki, incoming) are skipped
 *     entirely — no digest sent.
 *   - AMs with no RED and no YELLOW get a brief "All clear today" message.
 *   - Snoozed customers (Phase 19) are filtered out if that module is
 *     present; the import is wrapped in a try/catch so this works before
 *     Phase 19 ships.
 *
 * Routing: posts ALL digests to the existing single shared channel
 * configured by SLACK_WEBHOOK_URL. AM→Slack-user-id mapping is a TODO; for
 * now the AM's name is just rendered in the header.
 */

import type { ScoredCustomerV2 } from "./types";
import { readLatestSnapshotV2 } from "./postgres";
import { postSlack, slackConfigured, type SlackBlock } from "./slack";

/**
 * Pod assignment — hardcoded mapping (no upstream `pod` field yet; per the
 * AM Transition Toolkit memo, pods are forward-state, not in any data
 * system). The toolkit snapshot already carries `pod` on each customer,
 * but this map is the authoritative AM→Pod resolution for the digest
 * header.
 */
const POD_MAP: Record<string, string> = {
  "Sudha Goutami": "Pod 1",
  "Kanak sharma": "Pod 1",
  "Hubern C": "Pod 2",
  "Sakshi Mamgain": "Pod 2",
  "Bikash Mishra": "Pod 3",
  "Anu Srivastava": "Pod 3",
  "Apurvaa Biswas": "Pod 4",
  "Atharv Y": "Pod 4",
  "Shruti Sinha": "Pod 4",
  "Taanya Solanki": "Pod 4",
  "Siddhi Shetty": "Pod 5",
  "Kripali Suri": "Pod 5",
  "Nikita Singh": "Floating",
};

export type DigestTopCustomer = {
  bizname: string;
  narrative: string;
  silence_days: number | null;
};

export type DigestResult = {
  am_name: string;
  red_count: number;
  yellow_count: number;
  top_3: DigestTopCustomer[];
  sent: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

/**
 * Best-effort snooze loader. Phase 19 hasn't shipped on this branch yet, but
 * when it does it'll expose `listActiveSnoozes(amName)` from `lib/snooze`.
 * We dynamically import and swallow the not-found case so the digest works
 * either way.
 */
async function loadSnoozedEntityIds(amName: string): Promise<Set<string>> {
  try {
    const modulePath = "./snooze";
    // Dropped @typescript-eslint/no-explicit-any disable directive — that
    // rule is provided by @typescript-eslint/eslint-plugin, which v1 had
    // installed but beacon does not (it sticks to eslint-config-next).
    // The `any` annotation passes beacon's looser ESLint config without
    // a disable comment; the comment itself causes "rule definition not
    // found" build errors.
    const mod: any = await import(/* webpackIgnore: true */ modulePath).catch(
      () => null,
    );
    if (mod && typeof mod.listActiveSnoozes === "function") {
      const rows = (await mod.listActiveSnoozes(amName)) as Array<{
        entity_id: string;
      }>;
      return new Set(rows.map((r) => r.entity_id));
    }
  } catch {
    // module not present — fall through to empty snooze set
  }
  return new Set();
}

function pickTop3(red: ScoredCustomerV2[]): ScoredCustomerV2[] {
  return [...red]
    .sort((a, b) => (b.signals_v2?.composite ?? 0) - (a.signals_v2?.composite ?? 0))
    .slice(0, 3);
}

function silenceDays(c: ScoredCustomerV2): number | null {
  const d = c.metrics?.days_since_out;
  if (typeof d !== "number" || !Number.isFinite(d)) return null;
  // Sentinel guard — the v2 scorer uses 9999 to mean "no outbound ever in
  // window". Treat as null so we don't render "9999d silent".
  if (d >= 9999) return null;
  return d;
}

function plannerUrl(amName: string): string {
  const base =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ||
    process.env.DASHBOARD_URL ||
    "https://beacon-zoca.vercel.app";
  return `${base.replace(/\/$/, "")}/v2?am=${encodeURIComponent(amName)}`;
}

function buildDigestBlocks(
  amName: string,
  redCount: number,
  yellowCount: number,
  top3: ScoredCustomerV2[],
): SlackBlock[] {
  const pod = POD_MAP[amName] || "—";
  const url = plannerUrl(amName);

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${amName}'s Beacon — ${redCount} need a call today`,
        emoji: false,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${pod} · ${redCount} RED · ${yellowCount} watching · auto-scored by Claude`,
        },
      ],
    },
  ];

  if (top3.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Top urgency today:*" },
    });
    top3.forEach((c, i) => {
      const narrative = c.signals_v2?.reason_one_line || "(no narrative)";
      const sd = silenceDays(c);
      const silenceText = sd != null ? `${sd}d silent` : "no silence data";
      const status = c.cb_status || "active";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${i + 1}. ${c.company}*\n${narrative}\n_${silenceText} · ${status}_`,
        },
      });
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open my planner →", emoji: false },
        url,
        style: "primary",
      },
    ],
  });

  return blocks;
}

function buildDigestFallbackText(
  amName: string,
  redCount: number,
  yellowCount: number,
  top3: ScoredCustomerV2[],
): string {
  const pod = POD_MAP[amName] || "—";
  const lines: string[] = [
    `*${amName}'s Beacon — ${redCount} need a call today*`,
    `${pod} · ${redCount} RED · ${yellowCount} watching`,
  ];
  if (top3.length > 0) {
    lines.push("");
    lines.push("Top urgency:");
    top3.forEach((c, i) => {
      const narrative = c.signals_v2?.reason_one_line || "(no narrative)";
      lines.push(`${i + 1}. *${c.company}* — ${narrative}`);
    });
  }
  lines.push("");
  lines.push(`Open my planner: <${plannerUrl(amName)}|→>`);
  return lines.join("\n");
}

function buildAllClearBlocks(amName: string): SlackBlock[] {
  const pod = POD_MAP[amName] || "—";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *${amName} — all clear today*\n${pod} · 0 need a call · 0 watching. Nice work.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open my planner →", emoji: false },
          url: plannerUrl(amName),
        },
      ],
    },
  ];
}

/** Iterate every AM with at least one customer and post a digest. */
export async function runDigestForAllAms(opts?: {
  dryRun?: boolean;
}): Promise<DigestResult[]> {
  const dryRun = !!opts?.dryRun;
  const snapshot = await readLatestSnapshotV2();
  if (!snapshot) return [];

  // Group active customers by AM.
  const byAm = new Map<string, ScoredCustomerV2[]>();
  for (const c of snapshot.customers) {
    const am = (c.am_name || "").trim();
    if (!am) continue;
    if (!byAm.has(am)) byAm.set(am, []);
    byAm.get(am)!.push(c);
  }

  const results: DigestResult[] = [];

  for (const [amName, customers] of byAm) {
    if (customers.length === 0) {
      // Skip entirely — no book to summarize.
      results.push({
        am_name: amName,
        red_count: 0,
        yellow_count: 0,
        top_3: [],
        sent: false,
        skipped: true,
        reason: "empty book",
      });
      continue;
    }

    const snoozed = await loadSnoozedEntityIds(amName);
    // Phase 33.scope followup — exclude recently_churned from slack digest.
    // A cancelled sub showing up in tomorrow's "needs a call" list is the
    // failure mode we're guarding against; lifecycle pill handles them.
    const visible = customers
      .filter((c) => !snoozed.has(c.entity_id))
      .filter((c) => (c as any).lifecycle_state !== "recently_churned");

    const red = visible.filter((c) => { const _ht = String(((c as any).metabase_health?.health_tier) || ""); return _ht === "CRITICAL - DEAL BREAKER" || _ht === "CRITICAL" || _ht === "AT-RISK"; });
    const yellow = visible.filter((c) => { const _ht = String(((c as any).metabase_health?.health_tier) || ""); return _ht === "MONITOR" || _ht === ""; });

    // All-clear branch
    if (red.length === 0 && yellow.length === 0) {
      const blocks = buildAllClearBlocks(amName);
      const text = `:white_check_mark: ${amName} — all clear today. 0 need a call · 0 watching.`;
      const post = dryRun ? { sent: false } : await postSlack({ text, blocks });
      results.push({
        am_name: amName,
        red_count: 0,
        yellow_count: 0,
        top_3: [],
        sent: post.sent,
        error: "error" in post ? post.error : undefined,
      });
      continue;
    }

    const top3 = pickTop3(red);
    const blocks = buildDigestBlocks(amName, red.length, yellow.length, top3);
    const text = buildDigestFallbackText(amName, red.length, yellow.length, top3);
    const post = dryRun ? { sent: false } : await postSlack({ text, blocks });

    results.push({
      am_name: amName,
      red_count: red.length,
      yellow_count: yellow.length,
      top_3: top3.map((c) => ({
        bizname: c.company,
        narrative: c.signals_v2?.reason_one_line || "",
        silence_days: silenceDays(c),
      })),
      sent: post.sent,
      error: "error" in post ? post.error : undefined,
    });
  }

  return results;
}

export { slackConfigured };

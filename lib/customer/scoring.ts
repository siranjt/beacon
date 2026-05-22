import {
  SIG_WEIGHTS,
  SIG_WEIGHTS_V2,
  TIER_CUTS,
  WE_SILENT_DAYS,
  CLIENT_SILENT_DAYS,
  ZERO_COMMS_BASELINE_SCORE,
  WATCH_LANE_FLAG_COUNT,
  tierToStoplight,
} from "./config";
import type {
  CommsEvent,
  CustomerMetrics,
  CustomerSignals,
  CustomerSignalsV2,
  UsageMetrics,
  BillingMetrics,
  PerformanceMetrics,
  TicketsMetrics,
} from "./types";
import type { Tier } from "./config";

const DAY_MS = 86400 * 1000;

/** Compute per-window comms metrics for a customer given their events */
export function computeMetrics(events: CommsEvent[], todayMs: number): CustomerMetrics {
  const windowCuts = [7, 14, 30, 60, 90] as const;
  const counts: Record<number, { total: number; in: number; out: number; chs: Set<string> }> = {};
  for (const w of windowCuts) {
    counts[w] = { total: 0, in: 0, out: 0, chs: new Set<string>() };
  }

  let lastAny: number | null = null;
  let lastIn: number | null = null;
  let lastOut: number | null = null;

  for (const e of events) {
    if (lastAny === null || e.ts > lastAny) lastAny = e.ts;
    if (e.direction === "in" && (lastIn === null || e.ts > lastIn)) lastIn = e.ts;
    if (e.direction === "out" && (lastOut === null || e.ts > lastOut)) lastOut = e.ts;

    const ageDays = (todayMs - e.ts) / DAY_MS;
    for (const w of windowCuts) {
      if (ageDays < w) {
        counts[w].total += 1;
        counts[w][e.direction] += 1;
        counts[w].chs.add(e.channel);
      }
    }
  }

  const daysSince = (t: number | null) =>
    t === null ? 9999 : Math.max(0, Math.floor((todayMs - t) / DAY_MS));

  const ch30 = Array.from(counts[30].chs).sort();
  const ch90 = Array.from(counts[90].chs).sort();

  return {
    total_7d: counts[7].total,  in_7d: counts[7].in,  out_7d: counts[7].out,  channels_7d: counts[7].chs.size,
    total_14d: counts[14].total, in_14d: counts[14].in, out_14d: counts[14].out, channels_14d: counts[14].chs.size,
    total_30d: counts[30].total, in_30d: counts[30].in, out_30d: counts[30].out, channels_30d: counts[30].chs.size,
    total_60d: counts[60].total, in_60d: counts[60].in, out_60d: counts[60].out, channels_60d: counts[60].chs.size,
    total_90d: counts[90].total, in_90d: counts[90].in, out_90d: counts[90].out, channels_90d: counts[90].chs.size,
    channels_used_30d: ch30.join(","),
    channels_used_90d: ch90.join(","),
    last_any_iso: lastAny !== null ? new Date(lastAny).toISOString() : null,
    last_in_iso: lastIn !== null ? new Date(lastIn).toISOString() : null,
    last_out_iso: lastOut !== null ? new Date(lastOut).toISOString() : null,
    days_since_in: daysSince(lastIn),
    days_since_out: daysSince(lastOut),
  };
}

function tierFor(score: number, total90d: number): Tier {
  if (total90d === 0) return "HIGH";
  if (score >= TIER_CUTS.high) return "HIGH";
  if (score >= TIER_CUTS.medium) return "MEDIUM";
  if (score >= TIER_CUTS.low) return "LOW";
  return "HEALTHY";
}

/**
 * v1 scoring — preserved for backward compat with existing dashboard.
 * Composite of 4 comms signals at original weights (30/30/25/15).
 */
export function scoreCustomer(m: CustomerMetrics): CustomerSignals {
  const notes: string[] = [];

  // Signal 3: We went silent
  let sWeSilent = 0;
  const dso = m.days_since_out;
  if (dso >= WE_SILENT_DAYS.high) {
    sWeSilent = 100;
    notes.push(`We haven't reached out in ${dso === 9999 ? "ever" : dso + "d"}`);
  } else if (dso >= WE_SILENT_DAYS.med) {
    sWeSilent = 70;
    notes.push(`We haven't reached out in ${dso}d`);
  } else if (dso >= WE_SILENT_DAYS.low) {
    sWeSilent = 30;
  }

  // Signal 2: Client went silent
  let sClientSilent = 0;
  const dsi = m.days_since_in;
  const hadHistory = m.in_90d - m.in_30d > 0;
  if (hadHistory) {
    if (dsi >= CLIENT_SILENT_DAYS.high) {
      sClientSilent = 100;
      notes.push(`Client silent ${dsi}d (was active before)`);
    } else if (dsi >= CLIENT_SILENT_DAYS.med) {
      sClientSilent = 70;
      notes.push(`Client silent ${dsi}d`);
    } else if (dsi >= CLIENT_SILENT_DAYS.low) {
      sClientSilent = 30;
    }
  }

  // Signal 1: Response rate dropped
  let sResponseDrop = 0;
  const in30 = m.in_30d, out30 = m.out_30d;
  const inPrior = m.in_90d - m.in_30d, outPrior = m.out_90d - m.out_30d;
  const rate = (i: number, o: number) => (o > 0 ? i / Math.max(o, 1) : null);
  const rRecent = rate(in30, out30);
  const rPrior = rate(inPrior, outPrior);
  if (rPrior !== null && rPrior > 0.05 && rRecent !== null) {
    const drop = (rPrior - rRecent) / rPrior;
    if (drop >= 0.75 && out30 >= 2) {
      sResponseDrop = 100;
      notes.push(`Response rate collapsed (${rPrior.toFixed(2)}→${rRecent.toFixed(2)})`);
    } else if (drop >= 0.5 && out30 >= 2) {
      sResponseDrop = 70;
      notes.push(`Response rate down ${Math.round(drop * 100)}%`);
    } else if (drop >= 0.3 && out30 >= 2) {
      sResponseDrop = 40;
    }
  }

  // Signal 4: Volume collapse + channel narrowing
  let sVolumeCollapse = 0;
  const t30 = m.total_30d, t90 = m.total_90d;
  const baseline = (t90 - t30) / 2.0;
  if (baseline >= 4) {
    if (t30 <= 0.2 * baseline) {
      sVolumeCollapse = 100;
      notes.push(`Comms volume crashed (${Math.round(baseline)}→${t30} per 30d)`);
    } else if (t30 <= 0.4 * baseline) {
      sVolumeCollapse = 60;
      notes.push(`Comms volume down (${Math.round(baseline)}→${t30})`);
    } else if (t30 <= 0.6 * baseline) {
      sVolumeCollapse = 30;
    }
  }
  if (m.channels_90d >= 3 && m.channels_30d <= 1) {
    sVolumeCollapse = Math.max(sVolumeCollapse, 60);
    notes.push(`Channels narrowed ${m.channels_90d}→${m.channels_30d}`);
  }

  let composite = Math.round(
    SIG_WEIGHTS.weSilent * sWeSilent +
      SIG_WEIGHTS.clientSilent * sClientSilent +
      SIG_WEIGHTS.responseDrop * sResponseDrop +
      SIG_WEIGHTS.volumeCollapse * sVolumeCollapse,
  );

  if (m.total_90d === 0) {
    composite = Math.max(composite, ZERO_COMMS_BASELINE_SCORE);
    notes.push("Zero comms in 90d");
  }

  return {
    score: composite,
    tier: tierFor(composite, m.total_90d),
    sig_we_silent: sWeSilent,
    sig_client_silent: sClientSilent,
    sig_response_drop: sResponseDrop,
    sig_volume_collapse: sVolumeCollapse,
    notes: notes.join("; "),
  };
}

// ---------------------------------------------------------------------------
// v2 — Tickets flag
// ---------------------------------------------------------------------------

export function computeTicketsFlag(
  entityId: string,
  openTickets30d: number,
  unresolvedIssues30d: number,
): TicketsMetrics {
  return {
    entity_id: entityId,
    open_tickets_30d: openTickets30d,
    unresolved_issues_last_30_days: unresolvedIssues30d,
    flag: openTickets30d > 0 || unresolvedIssues30d > 0,
  };
}

// ---------------------------------------------------------------------------
// v2 — Hybrid composite (comms 50% / usage 30% / billing 20% + 2 flags)
// ---------------------------------------------------------------------------

/**
 * Compose the v2 hybrid composite. Reuses scoreCustomer() for the 4 comms
 * sub-signals, then layers in usage + billing scores and the modifier flags.
 *
 * @param commsSignals  v1 scoreCustomer() output (for the 4 sub-scores)
 * @param usageScore    Output of scoreUsage()
 * @param billingScore  Output of scoreBilling()
 * @param performance   Performance metrics for the entity (for flag verdict)
 * @param tickets       Tickets metrics for the entity (for flag verdict)
 * @param commsMetrics  Used for zero-comms-90d auto-promote
 * @param mixpanelHasData  False if entity has no Mixpanel coverage at all
 */
export function composeHybridSignals(args: {
  commsSignals: CustomerSignals;
  usageScore: number;
  billingScore: number;
  billing?: BillingMetrics | null;
  performance: PerformanceMetrics | null;
  tickets: TicketsMetrics | null;
  commsMetrics: CustomerMetrics;
  mixpanelHasData: boolean;
  preLaunch?: boolean;
}): CustomerSignalsV2 {
  const { commsSignals, usageScore, billingScore, performance, tickets, commsMetrics, mixpanelHasData, preLaunch } = args;

  // Pre-launch: Chargebee sub status is "future" or activated_at is null/future.
  // Skip normal churn-scoring entirely — these entities have legitimately zero
  // comms/usage/billing because they haven't started yet. Return a neutral
  // HEALTHY/GREEN state with all signal sub-scores zeroed.
  if (preLaunch) {
    return {
      composite: 50,
      tier: "HEALTHY",
      stoplight: "GREEN",
      sig_we_silent: 0,
      sig_client_silent: 0,
      sig_response_drop: 0,
      sig_volume_collapse: 0,
      sig_usage: 0,
      sig_billing: 0,
      flag_performance: false,
      flag_tickets: false,
      flag_count: 0,
      trajectory_7d: "unknown",
      composite_7d_ago: null,
      reason_one_line: "Pre-launch — contract signed, not yet activated.",
      suggested_action:
        "Confirm onboarding kickoff before the activation date.",
      notes: "pre_launch",
      pre_launch: true,
    };
  }

  const composite = Math.round(
    SIG_WEIGHTS_V2.weSilent * commsSignals.sig_we_silent +
      SIG_WEIGHTS_V2.clientSilent * commsSignals.sig_client_silent +
      SIG_WEIGHTS_V2.responseDrop * commsSignals.sig_response_drop +
      SIG_WEIGHTS_V2.volumeCollapse * commsSignals.sig_volume_collapse +
      SIG_WEIGHTS_V2.usage * usageScore +
      SIG_WEIGHTS_V2.billing * billingScore,
  );

  // Modifier flags
  const flagPerformance = !!(performance && performance.flag);
  const flagTickets = !!(tickets && tickets.flag);
  const flagCount = (flagPerformance ? 1 : 0) + (flagTickets ? 1 : 0);

  // Determine tier — same internal model as v1, with WATCH lane awareness
  let tier: Tier;
  // HIGH triggers: composite >= 65, OR (zero comms 90d AND no Mixpanel data)
  //  — "no Mixpanel data" alone is a coverage gap, not a churn signal.
  //  The WATCH lane (via flag_count) still surfaces these as YELLOW.
  if (
    composite >= TIER_CUTS.high ||
    (commsMetrics.total_90d === 0 && !mixpanelHasData)
  ) {
    tier = "HIGH";
  } else if (composite >= TIER_CUTS.medium) {
    tier = "MEDIUM";
  } else if (composite >= TIER_CUTS.low) {
    tier = "LOW";
  } else {
    tier = "HEALTHY";
  }

  // Effective tier — WATCH lane is HEALTHY/LOW with 2+ flags, displayed as Yellow.
  // We keep the internal `tier` value but the stoplight mapping handles the WATCH lift.
  const stoplight = tierToStoplight(tier, flagCount, billingScore);

  // Reason + suggested action: template-driven from dominant signal
  const { reasonOneLine, suggestedAction, notes } = buildNarrative({
    commsSignals,
    usageScore,
    billingScore,
    billing: args.billing ?? null,
    performance,
    tickets,
    commsMetrics,
    mixpanelHasData,
  });

  return {
    composite,
    tier,
    stoplight,
    sig_we_silent: commsSignals.sig_we_silent,
    sig_client_silent: commsSignals.sig_client_silent,
    sig_response_drop: commsSignals.sig_response_drop,
    sig_volume_collapse: commsSignals.sig_volume_collapse,
    sig_usage: usageScore,
    sig_billing: billingScore,
    flag_performance: flagPerformance,
    flag_tickets: flagTickets,
    flag_count: flagCount,
    trajectory_7d: "unknown",          // filled by snapshot writer if prev exists
    composite_7d_ago: null,             // filled by snapshot writer
    reason_one_line: reasonOneLine,
    suggested_action: suggestedAction,
    notes: notes.join("; "),
    pre_launch: false,
  };
}

// ---------------------------------------------------------------------------
// Narrative + suggested-action templates (deterministic; Haiku-substitutable later)
// ---------------------------------------------------------------------------

type NarrativeArgs = {
  commsSignals: CustomerSignals;
  usageScore: number;
  billingScore: number;
  billing: BillingMetrics | null;
  performance: PerformanceMetrics | null;
  tickets: TicketsMetrics | null;
  commsMetrics: CustomerMetrics;
  mixpanelHasData: boolean;
};

function buildNarrative(a: NarrativeArgs): {
  reasonOneLine: string;
  suggestedAction: string;
  notes: string[];
} {
  const notes: string[] = [];

  // ---- Special cases ----------------------------------------------------
  // Both no-app-activity AND no-comms = strongest possible churn signal.
  if (!a.mixpanelHasData && a.commsMetrics.total_90d === 0) {
    return {
      reasonOneLine: "No app activity AND zero communication for 90 days.",
      suggestedAction: "Cold-reach today — call and email. Possible churn.",
      notes: ["Zero on every dimension."],
    };
  }
  if (a.commsMetrics.total_90d === 0) {
    return {
      reasonOneLine: "Zero communication across all channels for 90 days.",
      suggestedAction: "Cold-reach: email + phone today.",
      notes,
    };
  }

  // ---- Identify strong signals -----------------------------------------
  // Same thresholds as the per-signal narrators above. "noUsageData" is
  // a synthetic strong signal for entities with no Mixpanel coverage.
  const strong: string[] = [];
  if (!a.mixpanelHasData) strong.push("noUsageData");
  else if (a.usageScore >= 65) strong.push("usage");
  // Billing tiers: full strong if billingScore >= 40 (real crisis territory).
  // Otherwise add a "softBilling" mention if there's ANY unpaid invoice AND
  // at least one other concern — the unpaid is context-relevant when stacked.
  if (a.billingScore >= 40) strong.push("billing");
  if (a.commsSignals.sig_we_silent >= 70) strong.push("weSilent");
  if (a.commsSignals.sig_client_silent >= 70) strong.push("clientSilent");
  if (a.commsSignals.sig_response_drop >= 70) strong.push("responseDrop");
  if (a.commsSignals.sig_volume_collapse >= 60) strong.push("volumeCollapse");
  // Soft billing pull-up: only when other signals are already firing.
  const hasSoftBilling =
    !strong.includes("billing") &&
    strong.length > 0 &&
    (a.billing?.unpaid_invoice_count ?? 0) >= 1;
  if (hasSoftBilling) strong.push("billing");

  // ---- 0 strong signals ------------------------------------------------
  if (strong.length === 0) {
    // Performance / tickets flags as low-priority fallback narration
    if (a.performance && a.performance.flag) {
      return {
        reasonOneLine: a.performance.flag_reasons.join("; "),
        suggestedAction: "Walk through GBP optimizer / discuss recovery plan.",
        notes,
      };
    }
    if (a.tickets && a.tickets.flag) {
      return {
        reasonOneLine: `Open tickets unresolved (${a.tickets.open_tickets_30d}).`,
        suggestedAction: "Resolve tickets first, then send a recap.",
        notes,
      };
    }
    return {
      reasonOneLine: "Active across signals — no action needed.",
      suggestedAction: "No action needed.",
      notes,
    };
  }

  // ---- 1 strong signal — route to specific narrator -------------------
  if (strong.length === 1) {
    return narrateSingle(strong[0], a);
  }

  // ---- 2+ strong signals — combined narrative -------------------------
  return narrateMultiple(strong, a);
}

/** Route a single strong signal to its dedicated narrator. */
function narrateSingle(signal: string, a: NarrativeArgs) {
  switch (signal) {
    case "noUsageData": {
      // Try to enrich with sub-threshold comms context so identical "no app"
      // cards don't all read the same. Sudha's top of book had 3 such cards.
      const dsi = a.commsMetrics.days_since_in;
      const dso = a.commsMetrics.days_since_out;
      const t30 = a.commsMetrics.total_30d;
      if (dsi <= 14 && t30 >= 3) {
        return {
          reasonOneLine: "No app activity — but actively talking to us.",
          suggestedAction: "Show them how the app accelerates what they're already doing.",
          notes: ["App setup gap; comms relationship is healthy."],
        };
      }
      if (dso >= 30 && dso < 9999) {
        return {
          reasonOneLine: `No app activity + we haven't reached out in ${dso}d.`,
          suggestedAction: "Check-in call: confirm app setup + re-engage.",
          notes: [],
        };
      }
      if (dsi >= 30 && dsi < 9999) {
        return {
          reasonOneLine: `No app activity + client silent ${dsi}d (sub-threshold).`,
          suggestedAction: "Re-engage on comms + confirm app onboarding.",
          notes: [],
        };
      }
      if (t30 === 0) {
        return {
          reasonOneLine: "No app activity AND no comms in last 30 days.",
          suggestedAction: "Cold check-in — high churn risk.",
          notes: [],
        };
      }
      return {
        reasonOneLine: "No Zoca app activity tracked in the last 90 days.",
        suggestedAction: "Verify they're set up on the app — onboard if needed.",
        notes: ["Missing Mixpanel data — likely a setup gap or churned user."],
      };
    }
    case "billing": return narrateBilling(a);
    case "usage": return narrateUsage(a);
    case "weSilent": return narrateWeSilent(a);
    case "clientSilent": return narrateClientSilent(a);
    case "responseDrop": return narrateResponseDrop(a);
    case "volumeCollapse": return narrateVolumeCollapse(a);
  }
  return {
    reasonOneLine: "Multiple signals firing.",
    suggestedAction: "Review the customer profile.",
    notes: [],
  };
}

/**
 * Build a multi-signal reason that lists each firing signal concisely.
 * Suggested action prioritizes the most operationally urgent (billing >
 * usage > comms).
 */
function narrateMultiple(strong: string[], a: NarrativeArgs) {
  const phrases: string[] = [];
  for (const sig of strong) {
    const phrase = signalPhrase(sig, a);
    if (phrase) phrases.push(phrase);
  }
  if (phrases.length === 0) {
    return {
      reasonOneLine: "Multiple signals firing.",
      suggestedAction: "Review the customer profile.",
      notes: [],
    };
  }
  // Capitalize first letter of first phrase.
  phrases[0] = phrases[0][0].toUpperCase() + phrases[0].slice(1);
  const reasonOneLine = phrases.join(" + ") + ".";

  // Pick the suggested action by priority order
  const action = pickMultiAction(strong, a);
  return {
    reasonOneLine,
    suggestedAction: action,
    notes: [`${phrases.length} signals stacked.`],
  };
}

/** Short phrase per signal — used inside the multi-signal narrative. */
function signalPhrase(signal: string, a: NarrativeArgs): string {
  switch (signal) {
    case "noUsageData":
      return "no app activity";
    case "usage":
      return a.usageScore >= 90 ? "app usage Dormant" : "app usage Cold";
    case "billing": {
      const n = a.billing?.unpaid_invoice_count ?? 0;
      return n > 0
        ? `${n} unpaid invoice${n === 1 ? "" : "s"}`
        : "billing issues";
    }
    case "weSilent": {
      const d = a.commsMetrics.days_since_out;
      return d >= 9999 ? "we never reached out" : `silent from us ${d}d`;
    }
    case "clientSilent": {
      const d = a.commsMetrics.days_since_in;
      return d >= 9999 ? "client never replied" : `client silent ${d}d`;
    }
    case "responseDrop":
      return "response rate collapsed";
    case "volumeCollapse":
      return "comms volume crashed";
  }
  return "";
}

/** Pick the most operationally relevant action when multiple signals fire. */
function pickMultiAction(strong: string[], a: NarrativeArgs): string {
  const dsi = a.commsMetrics.days_since_in;

  // 1) Very deep client silence overrides everything — it's the strongest
  //    churn signal we have. Tell the AM to phone TODAY.
  // Treat 9999 (never replied) as the deepest silence, not "no data".
  if (strong.includes("clientSilent") && dsi >= 60) {
    return `Cold-reach by phone today — ${dsi}d silence is critical churn risk.`;
  }

  // 2) Billing — interpolate the actual invoice count.
  if (strong.includes("billing")) {
    const n = a.billing?.unpaid_invoice_count ?? 0;
    if (n >= 2) {
      return `Call about the ${n} unpaid invoices first. Loop back on the other issues after.`;
    }
    return "Call about the unpaid invoice first. Loop back on the other issues after.";
  }

  // 3) No app data — onboarding + comms re-open.
  if (strong.includes("noUsageData")) {
    return "Verify they're set up on the app + re-open conversation.";
  }

  // 4) App usage dropped (data exists, just low).
  if (strong.includes("usage")) {
    return "Walk through a key feature + re-engage on comms.";
  }

  // 5) Both sides silent (medium severity, not 60+).
  if (strong.includes("clientSilent") && strong.includes("weSilent")) {
    return "Both sides silent — cold-reach via phone today.";
  }

  // 6) Client silent only.
  if (strong.includes("clientSilent")) {
    return "Re-open the conversation. Ask how they are doing.";
  }

  // 7) We silent only.
  if (strong.includes("weSilent")) {
    return "Send a check-in — email or quick call.";
  }

  return "Reach out and re-engage.";
}


// ---------------------------------------------------------------------------
// Per-signal narrators — each pulls real data from the metrics so cards don't
// read identically across customers. Added in Phase 2.A polish.
// ---------------------------------------------------------------------------

function narrateBilling(a: NarrativeArgs) {
  const n = a.billing?.unpaid_invoice_count ?? 0;
  const d = a.billing?.days_past_oldest_unpaid ?? 0;
  let reason: string;
  if (n >= 2 && d >= 15) {
    reason = `${n} unpaid invoices stacked — oldest ${d}d past due.`;
  } else if (n >= 2) {
    reason = `${n} unpaid invoices on file.`;
  } else if (d >= 15) {
    reason = `1 unpaid invoice, ${d}d past due.`;
  } else if (n >= 1) {
    reason = `1 unpaid invoice on file.`;
  } else {
    reason = "Billing issues — review account.";
  }
  return {
    reasonOneLine: reason,
    suggestedAction: "Call about the unpaid invoice. Confirm card on file.",
    notes: [],
  };
}

function narrateUsage(a: NarrativeArgs) {
  const notes: string[] = [];
  // We can't know app-open counts here — only the score. Frame by score band.
  if (a.usageScore >= 90) {
    return {
      reasonOneLine: "No app activity at all in the last 30 days.",
      suggestedAction: "Confirm the team is set up. Onboard if needed.",
      notes,
    };
  }
  if (a.usageScore >= 65) {
    return {
      reasonOneLine: "App usage dropped to Cold — barely opening the app.",
      suggestedAction: "Walk them through Leads or Reviews — re-engage on a feature.",
      notes,
    };
  }
  return {
    reasonOneLine: "App engagement has slipped recently.",
    suggestedAction: "Reach out — quick feature walkthrough.",
    notes,
  };
}

function narrateWeSilent(a: NarrativeArgs) {
  const notes: string[] = [];
  const d = a.commsMetrics.days_since_out;
  const dLabel = d >= 9999 ? "we've never reached out" : d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`;
  return {
    reasonOneLine: d >= 9999
      ? "We have never reached out to this customer."
      : `Last we reached out: ${dLabel}.`,
    suggestedAction: "Send a check-in — email or quick call.",
    notes,
  };
}

function narrateClientSilent(a: NarrativeArgs) {
  const notes: string[] = [];
  const d = a.commsMetrics.days_since_in;
  const had = a.commsMetrics.in_90d - a.commsMetrics.in_30d;
  const dLabel = d >= 9999 ? "ever" : d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"}`;
  return {
    reasonOneLine: d >= 9999
      ? "Client has not replied — no inbound on record."
      : `Client silent for ${dLabel}${had > 0 ? " — was active before." : "."}`,
    suggestedAction: "Re-open the conversation. Ask how they are doing.",
    notes,
  };
}

function narrateResponseDrop(a: NarrativeArgs) {
  const notes: string[] = [];
  return {
    reasonOneLine: "Response rate has collapsed — we are talking, they are not.",
    suggestedAction: "Switch channels — try a call instead of email.",
    notes,
  };
}

function narrateVolumeCollapse(a: NarrativeArgs) {
  const notes: string[] = [];
  const t30 = a.commsMetrics.total_30d;
  const baseline = Math.round((a.commsMetrics.total_90d - t30) / 2.0);
  return {
    reasonOneLine: baseline > 0
      ? `Comms volume crashed — ${baseline}/30d baseline down to ${t30}.`
      : "Overall comms volume dropped sharply.",
    suggestedAction: "Re-engage with a strategic update or new feature.",
    notes,
  };
}

export { tierFor };

/**
 * Action-checklist builder — the public entry point for Milestone B.
 *
 *   buildActionChecklist(data) =
 *     for top-N triggered actions:
 *       block = library.getActionBlock(vertical, action_id)
 *       return personalize(block, signal.context)
 *
 * The result is a list of fully-rendered ActionBlocks (no placeholders left)
 * that the HTML and DOCX renderers can consume directly.
 */

import { getActionBlock } from "./library";
import type { ActionBlock } from "./library/types";
import { runSignals, type SignalContext, type TriggeredAction } from "./signals";
import type { EntityReportData } from "./types";

// ---------------------------------------------------------------------------
// Personalization
// ---------------------------------------------------------------------------

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function substitute(input: string, ctx: SignalContext): string {
  return input.replace(TOKEN_RE, (match, key: string) => {
    const v = ctx[key];
    if (v === undefined || v === "") return match; // leave intact if no value — easier to spot in UI
    return String(v);
  });
}

function personalize(block: ActionBlock, ctx: SignalContext): ActionBlock {
  return {
    ...block,
    title: substitute(block.title, ctx),
    intro: block.intro ? substitute(block.intro, ctx) : block.intro,
    bullets: block.bullets?.map((b) => substitute(b, ctx)),
    closing: block.closing ? substitute(block.closing, ctx) : block.closing,
    table: block.table
      ? {
          ...block.table,
          caption: block.table.caption
            ? substitute(block.table.caption, ctx)
            : block.table.caption,
          headers: block.table.headers.map((h) => substitute(h, ctx)),
          rows: block.table.rows.map((row) => row.map((c) => substitute(c, ctx))),
        }
      : block.table,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RenderedAction = ActionBlock & {
  /** Why this action was selected — useful for tooltips and debugging. */
  rationale: string;
  /** Higher = more urgent. */
  priority: number;
};

/**
 * Build the final action checklist for an entity. Returns the top N actions
 * (default 5, matching the reference report) with all placeholders resolved
 * against signal context.
 */
export function buildActionChecklist(
  data: EntityReportData,
  options?: { top?: number; extraContext?: SignalContext }
): RenderedAction[] {
  const top = options?.top ?? 5;
  const extra = options?.extraContext ?? {};
  const triggered: TriggeredAction[] = runSignals(data);

  const out: RenderedAction[] = [];
  for (const t of triggered.slice(0, top)) {
    const block = getActionBlock(data.identity.vertical, t.id);
    if (!block) continue;
    const resolved = personalize(block, { ...extra, ...t.context });
    out.push({
      ...resolved,
      rationale: t.rationale,
      priority: t.priority,
    });
  }
  return out;
}

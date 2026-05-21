/**
 * Anthropic API client for the LLM evaluator.
 *
 * Loads prompt.md from the repo root and combines it with the bundle data + any
 * Fireflies/HubSpot enrichment to produce both:
 *   - Markdown analysis (for the Slack thread reply)
 *   - Fenced ```json block (for the Word-doc renderer)
 *
 * Implements the "retry once on JSON-parse failure" rule.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Bundle } from "@/lib/post-payment/validator/bundle";
import { PROMPT_MD } from "./prompt";

// Default to Haiku — finishes this analysis in 15–30s and stays comfortably
// within Vercel's function budget even on cold starts. Sonnet routinely hits
// 90–150s on this prompt size, which left zero margin and produced repeated
// pipeline_failed events. Quality difference is minimal because the ICP
// framework and rules are fully spelled out in the prompt.
//
// To override: set ANTHROPIC_MODEL=claude-sonnet-4-6 (or opus) in Vercel envs.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 12_000;

// SDK retries: 4 attempts with exponential backoff. Anthropic's CDN
// (Cloudflare) intermittently returns 502/503 (we saw "502 Bad Gateway" on a
// real Satori run that lost a customer's analysis). The SDK retries those
// transient errors transparently. Prior config of maxRetries:0 was a
// pre-Fluid-Compute hack to prevent retry-on-timeout cascades; with the
// per-request `timeout` we now pass explicitly, retries are safe again.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 4,
});

export type EvalResult = {
  markdown: string;        // the full Markdown analysis (Verdict + Key flags + Check-by-check + ...)
  reportData: any;         // parsed JSON block conforming to report_schema.example.json
  raw: string;             // raw model output (for debugging / re-parsing)
};

function loadPrompt(): string {
  // Prompt is now bundled at build time via `import { PROMPT_MD } from
  // "./prompt"`. Previously read via fs.readFileSync(process.cwd() + "/prompt.md"),
  // which broke on Vercel (ENOENT /var/task/prompt.md — the file wasn't in
  // the function bundle). Edit lib/post-payment/evaluator/prompt.ts directly
  // to change the prompt.
  return PROMPT_MD;
}

/**
 * Returns an empty string. The canonical example used to be appended to the
 * system prompt, but it added ~12K input tokens per request and pushed every
 * call over Anthropic's 30K/min rate limit. The schema descriptions in the
 * tool definition + prompt.md guidance are sufficient to convey shape; we
 * trade a small consistency loss for staying under the rate limit.
 *
 * Re-enable by reading the file if/when the org's TPM limit is raised.
 */
function loadCanonicalExample(): string {
  return "";
}

// Hard cap on a single LLM round-trip. The full report schema requires the
// model to fill 11 sections worth of content (~8K tokens) — Sonnet at
// ~50-100 tok/sec needs 100-180s. We give 240s to allow comfortable margin.
// Total budget: 240s LLM + 55s bundle + ~15s render+slack = ~310s, fits
// within Fluid-Compute's 300s soft cap. Override via ANTHROPIC_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 240_000);

const TOOL_NAME = "submit_analysis";

/**
 * Single LLM round-trip using forced tool use. Defining `tool_choice` makes the
 * model REQUIRED to call our tool with structured JSON — Anthropic's API
 * guarantees the input will parse, so we never have to scrape a fenced ```json
 * block out of free-form text (which Haiku was unreliable at emitting).
 *
 * The model is free to also emit a text content block alongside the tool call;
 * we capture that as the Markdown analysis for Slack.
 */
async function callOnce(systemPrompt: string, userPrompt: string): Promise<{ markdown: string; reportData: any }> {
  const t0 = Date.now();
  try {
    // The `cache_control` fields below ride along into TextBlockParam + Tool
    // shapes. They're accepted at runtime (prompt caching is GA), but the
    // SDK's type definitions at ^0.30.x don't expose them on the relevant
    // unions. Cast to `any` rather than reshape the prompt body; we're
    // forwarding to a documented API surface.
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // PROMPT CACHING — cache the system prompt and tool schema, since
        // both are identical across every customer (~10K tokens combined).
        // Cache writes cost 1.25× normal input rate; cache hits cost 0.1×
        // (90% off). Cache window is 5 minutes (ephemeral). With sporadic
        // webhook traffic at Zoca, hits are infrequent, but every call
        // benefits from the warm path even on first write.
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Submit the FULL Post-Payment Account Review for this customer. The " +
              "output JSON renders directly into a multi-section Word document — every " +
              "section described below MUST be populated with substantive content. " +
              "Reference report_schema.example.json (the Be Beauty Studio worked " +
              "example) as the shape template; your output for this customer should " +
              "have equivalent depth and structure.",
            input_schema: {
              type: "object",
              // meta, section1, and references are populated in code from bundle
              // data — DO NOT include them in the tool input. Leaving them out
              // of the schema reduces the model's token output budget and keeps
              // those deterministic sections consistent across customers.
              properties: {
                exec: {
                  type: "object",
                  description: "Executive summary block. Drives the dashboard verdict pill, Slack message, and the cover page.",
                  properties: {
                    verdict_label: { type: "string", enum: ["ICP", "Review", "Not ICP"] },
                    verdict_status: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
                    recommended_action_label: { type: "string", description: "Short imperative; include 'AM' if AM team must act." },
                    driver: { type: "string", description: "One-line cause citing the Module 02 rule." },
                    reinforcing_flags: { type: "string", description: "Semicolon-separated list of 2-4 additional flags." },
                    mitigating_factors: { type: "string", description: "Semicolon-separated factors against the verdict." },
                    summary_paragraphs: { type: "array", items: { type: "string" }, description: "3-5 substantive paragraphs covering: business profile, Module 02 application, reinforcing flags, comms/demo analysis, recommended action with timeline." },
                    net_retention_picture: { type: "string", description: "One paragraph retention outlook." },
                    likely_outcome: { type: "string", description: "Most probable outcome if no action." },
                  },
                  required: ["verdict_label", "verdict_status", "recommended_action_label", "driver", "reinforcing_flags", "mitigating_factors", "summary_paragraphs", "net_retention_picture", "likely_outcome"],
                  additionalProperties: true,
                },
                qualitative_flags: {
                  type: "object",
                  description: "Section 2.5 — quick-scan qualitative red flags table. A scannable read of softer signals (price sensitivity, sales urgency, customer engagement, dissatisfaction, commitment posture, operator decisiveness, cross-data integrity, demand-side signal). Rendered as a 3-column table (Signal / Reading / Evidence) between Section 2 and Section 3.",
                  properties: {
                    intro: { type: "string", description: "One-paragraph framing — same purpose as Be Beauty / Julia canonical examples." },
                    flags: {
                      type: "array",
                      description: "6-8 qualitative signals. Standard signal set: Price sensitivity, Sales urgency / time pressure, Customer engagement quality, Stated dissatisfaction (pre-pay), Long-term commitment posture, Operator decisiveness, Cross-data integrity, Demand-side signal. Add Demo delivery quality when transcript evidence exists.",
                      items: {
                        type: "object",
                        properties: {
                          signal: { type: "string", description: "Signal area label, e.g. 'Price sensitivity'." },
                          reading: { type: "string", enum: ["PASS", "WARN", "FAIL", "GAP"], description: "Status pill color — PASS green, WARN yellow, FAIL red, GAP grey." },
                          evidence: { type: "string", description: "One-sentence cited evidence with source field references where possible." },
                        },
                        required: ["signal", "reading", "evidence"],
                      },
                    },
                    takeaway: { type: "string", description: "One-sentence synthesis of the qualitative read." },
                  },
                  required: ["intro", "flags"],
                  additionalProperties: true,
                },
                section3_risks: {
                  type: "object",
                  description: "Quantified risk register — rendered as a 5-column table.",
                  properties: {
                    intro: { type: "string", description: "One-paragraph framing of the risks." },
                    risks: {
                      type: "array",
                      description: "5-8 risk rows.",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", description: "R1, R2..." },
                          risk: { type: "string", description: "Short title." },
                          likelihood: { type: "string", enum: ["PASS", "WARN", "FAIL", "RISK", "GAP"] },
                          impact: { type: "string", enum: ["PASS", "WARN", "FAIL", "RISK", "GAP"] },
                          driver_mitigation: { type: "string", description: "Driver + recommended mitigation." },
                        },
                        required: ["id", "risk", "likelihood", "impact", "driver_mitigation"],
                      },
                    },
                  },
                  required: ["intro", "risks"],
                  additionalProperties: true,
                },
                section4_framework: {
                  type: "object",
                  description: "Module 02 ICP framework application.",
                  properties: {
                    tier_application: { type: "string", description: "Where this customer falls in Step-1.2 tier rule." },
                    vertical_lock_text: { type: "string", description: "1-2 sentences on whether the customer is in the beauty/wellness vertical." },
                    step1: {
                      type: "array",
                      description: "Exactly 3 gates: 1.1 Device, 1.2 Lead prediction, 1.3 Booking platform.",
                      items: {
                        type: "object",
                        properties: {
                          gate: { type: "string", description: "e.g. '1.1 Device (laptop or iPad in shop)'" },
                          status: { type: "string", enum: ["PASS", "FAIL", "AUTOFAIL", "WARN", "GAP"] },
                          evidence: { type: "string", description: "Evidence + source." },
                        },
                        required: ["gate", "status", "evidence"],
                      },
                    },
                    step1_conclusion: { type: "string", description: "One-sentence conclusion across the 3 gates." },
                    step2_row_label: { type: "string", description: "e.g. 'Single-location + solo'" },
                    step2_row_evidence: { type: "array", items: { type: "string" }, description: "Paragraphs explaining the row identification." },
                    step2: {
                      type: "array",
                      description: "Step-2 rule rows.",
                      items: {
                        type: "object",
                        properties: {
                          rule: { type: "string" },
                          status: { type: "string", enum: ["PASS", "FAIL", "WARN", "GAP"] },
                          evidence: { type: "string" },
                        },
                        required: ["rule", "status", "evidence"],
                      },
                    },
                    disqualifiers: {
                      type: "array",
                      description: "Additional disqualifier rows.",
                      items: {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          status: { type: "string", enum: ["PASS", "FAIL", "WARN", "GAP"] },
                          notes: { type: "string" },
                        },
                        required: ["label", "status", "notes"],
                      },
                    },
                    summary_table: {
                      type: "array",
                      description: "Quantitative summary rows.",
                      items: {
                        type: "object",
                        properties: {
                          layer: { type: "string" },
                          status: { type: "string", enum: ["PASS", "FAIL", "AUTOFAIL", "WARN", "GAP"] },
                          detail: { type: "string" },
                        },
                        required: ["layer", "status", "detail"],
                      },
                    },
                    summary_takeaway: { type: "string" },
                    one_line_blockquote: { type: "string", description: "The single-sentence why-this-verdict line." },
                  },
                  required: ["tier_application", "vertical_lock_text", "step1", "step2"],
                  additionalProperties: true,
                },
                section5_pointers: {
                  type: "array",
                  description:
                    "11 post-payment pointer subsections in canonical order: " +
                    "Pointer 1 — Lead source; " +
                    "Pointer 2 — Comms breakdown (include a 'table' block where data exists); " +
                    "Pointer 3 — Timestamp validation (include a 'table' block); " +
                    "Pointer 4 — Demo call (use 'h3' sub-headings); " +
                    "Pointer 5 — Sales pressure check; " +
                    "Pointer 6 — Customer financial status; " +
                    "Pointer 7 — ICP fit (cross-ref Section 4); " +
                    "Pointer 8 — Stay long/short-term; " +
                    "Pointer 9 — Customer expectations (use 'h3'); " +
                    "Pointer 10 — Red flags (include a 'table' block); " +
                    "Pointer 11 — Pricing (include a 'kv' block). " +
                    "Target ~12-16 tables across the section. Reference the worked example in the system prompt for shape.",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string", description: "Format: 'Pointer N — <subject>'" },
                      source: { type: "string", description: "Data source label e.g. 'review_metrics.csv, BaseSheet'" },
                      signal: { type: "string", description: "One-line signal value." },
                      signal_status: { type: "string", enum: ["PASS", "FAIL", "AUTOFAIL", "WARN", "GAP", "RISK"] },
                      blocks: {
                        type: "array",
                        minItems: 1,
                        description:
                          "Body content. Mix of block types: 'para' (paragraph), 'bullet' (bullet point), " +
                          "'blockquote' (verbatim quote, optional attribution), 'h3' (sub-heading inside the pointer), " +
                          "'richpara' (formatted runs with bold/italics/color), 'table' (nested table with columnWidths + rows), " +
                          "'kv' (2-column key-value table). " +
                          "REQUIRED block types per pointer: " +
                          "Pointer 2 MUST contain a 'table' (channel breakdown). " +
                          "Pointer 3 MUST contain a 'table' (timestamp validation). " +
                          "Pointer 4 MUST contain at least 2 'h3' headings + a 'table'. " +
                          "Pointer 9 MUST contain at least 2 'h3' headings. " +
                          "Pointer 10 MUST contain a 'table' (red flags). " +
                          "Pointer 11 MUST contain a 'kv' block (pricing).",
                        items: {
                          type: "object",
                          properties: {
                            type: { type: "string", enum: ["para", "bullet", "blockquote", "h3", "richpara", "table", "kv"] },
                            text: { type: "string", description: "Used by para/bullet/blockquote/h3" },
                            attribution: { type: "string", description: "Optional, used by blockquote" },
                            runs: {
                              type: "array",
                              description: "Used by richpara — array of { text, bold?, italics?, color? }",
                              items: { type: "object", additionalProperties: true },
                            },
                            columnWidths: {
                              type: "array",
                              items: { type: "number" },
                              description: "Used by table — array of column widths in DXA (twentieths of a point). Total should sum to 9360.",
                            },
                            rows: {
                              type: "array",
                              description:
                                "Used by table and kv. For table: first row is headers, subsequent rows are data. " +
                                "Cells can be plain strings, or { value, bold?, status? } objects, or { status: 'PASS'|'FAIL'|...} for status badges. " +
                                "For kv: array of [key, value] pairs.",
                              items: {},
                            },
                          },
                          required: ["type"],
                          additionalProperties: true,
                        },
                      },
                    },
                    required: ["title", "source", "signal", "signal_status", "blocks"],
                  },
                },
                section6_actions: {
                  type: "object",
                  description: "Per-account action plan table.",
                  properties: {
                    intro: { type: "string" },
                    actions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", description: "A1, A2..." },
                          action: { type: "string" },
                          owner: { type: "string", description: "AM name or role." },
                          deadline: { type: "string", description: "e.g. 'Day 7'" },
                          success_criterion: { type: "string" },
                        },
                        required: ["id", "action", "owner", "deadline", "success_criterion"],
                      },
                    },
                    am_script: { type: "string", description: "Verbatim AM recovery script." },
                    am_script_attribution: { type: "string" },
                    branch_paragraphs: { type: "array", items: { type: "string" } },
                  },
                  required: ["intro", "actions"],
                  additionalProperties: true,
                },
                section7_systemic: {
                  type: "object",
                  description: "Systemic recommendations.",
                  properties: {
                    intro: { type: "string" },
                    recommendations: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", description: "S1, S2..." },
                          recommendation: { type: "string" },
                          owner: { type: "string", description: "Role e.g. 'Sales Ops', 'Data Eng'." },
                          priority: { type: "string", enum: ["P0", "P1", "P2"] },
                          rationale: { type: "string" },
                        },
                        required: ["id", "recommendation", "owner", "priority", "rationale"],
                      },
                    },
                  },
                  required: ["intro", "recommendations"],
                  additionalProperties: true,
                },
                section8_gaps: {
                  type: "object",
                  description: "Open data gaps — rendered as a numbered list.",
                  properties: {
                    intro: { type: "string" },
                    items: { type: "array", items: { type: "string" }, description: "One-sentence-per-gap." },
                  },
                  required: ["intro", "items"],
                  additionalProperties: true,
                },
                section9_evidence: {
                  type: "object",
                  description: "Evidence trail and methodology.",
                  properties: {
                    methodology_paragraphs: { type: "array", items: { type: "string" }, description: "2-4 paragraphs describing how the analysis was conducted." },
                    evidence_trail: { type: "array", items: { type: "string" }, description: "Bullet items citing specific evidence with source." },
                  },
                  required: ["methodology_paragraphs", "evidence_trail"],
                  additionalProperties: true,
                },
              },
              required: [
                "exec", "qualitative_flags", "section3_risks", "section4_framework",
                "section5_pointers", "section6_actions", "section7_systemic",
                "section8_gaps", "section9_evidence",
              ],
              additionalProperties: true,
            },
            // Cache the entire tool schema. Tool definitions are identical
            // across customers, so a single ephemeral cache entry covers
            // every analyze call within the 5-minute window.
            cache_control: { type: "ephemeral" },
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: userPrompt }],
      } as any,
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const elapsed = Date.now() - t0;
    // Cache metrics: usage.cache_creation_input_tokens is the count we
    // wrote into the cache this call (paid 1.25× rate); usage.cache_read_input_tokens
    // is the count we hit (paid 0.1× rate). regular input_tokens is everything
    // not cached. Logging both lets us track hit ratio over time.
    const u: any = (res as any).usage ?? {};
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const inputTok = u.input_tokens ?? 0;
    const outputTok = u.output_tokens ?? 0;
    const cacheHit = cacheRead > 0;
    console.log(
      `[llm] model=${MODEL} elapsed_ms=${elapsed} stop=${res.stop_reason} ` +
      `blocks=${res.content.map((b: any) => b.type).join(",")} ` +
      `cache=${cacheHit ? "HIT" : "MISS"} ` +
      `tokens=in:${inputTok}+cache_read:${cacheRead}+cache_write:${cacheWrite}/out:${outputTok}`
    );

    let markdown = "";
    let toolInput: any = null;
    for (const block of res.content as any[]) {
      if (block.type === "text") markdown += block.text;
      else if (block.type === "tool_use" && block.name === TOOL_NAME) {
        toolInput = block.input;
      }
    }
    if (!toolInput) {
      throw new Error("model did not call submit_analysis tool");
    }
    // The tool input IS the full report-data structure — pass it straight to
    // the renderer. Fill in defaults for any missing keys so the renderer
    // doesn't crash on sparse output (defensive: missing section just renders
    // as an empty heading).
    const reportData = fillReportDefaults(toolInput);
    return { markdown: markdown.trim(), reportData };
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    console.error(`[llm] FAILED model=${MODEL} elapsed_ms=${elapsed} err=${e?.message ?? e}`);
    throw new Error(`llm_call: ${e?.message ?? String(e)} (elapsed ${elapsed}ms, model ${MODEL})`);
  }
}

/**
 * Run the evaluation. Forced tool use guarantees parseable JSON on the first
 * attempt, so the old "retry once on JSON-parse failure" loop is no longer
 * needed. Single call, single error mode (network/timeout) handled at a
 * higher level.
 */
export async function evaluate(args: {
  bundle: Bundle;
  fireflies?: any;
  hubspot?: any;
}): Promise<EvalResult> {
  const basePrompt = loadPrompt();
  const canonical = loadCanonicalExample();
  // Append the worked example to the system prompt so the model sees the
  // exact target structure. Worked examples in the system prompt are far more
  // effective at locking output shape than schema descriptions alone.
  const systemPrompt = canonical
    ? `${basePrompt}\n\n---\n\n## CANONICAL WORKED EXAMPLE (target this structural depth for every customer)\n\nThe following is the full reportData JSON for Julia mag glamour, which the renderer turns into a 177-paragraph / 32-table Word document matching the canonical template. Every new report MUST hit equivalent depth: 11 pointers, ~16 tables in Section 5, h3 sub-headings, table/kv blocks where indicated. Adapt the CONTENT to the customer being analysed, but keep the SHAPE and DEPTH identical.\n\n\`\`\`json\n${canonical}\n\`\`\``
    : basePrompt;
  const userPrompt = [
    "# Bundle (deterministic data)",
    "```json",
    JSON.stringify(args.bundle, null, 2),
    "```",
    "",
    "# Fireflies enrichment",
    "```json",
    JSON.stringify(args.fireflies ?? null, null, 2),
    "```",
    "",
    "# HubSpot enrichment",
    "```json",
    JSON.stringify(args.hubspot ?? null, null, 2),
    "```",
    "",
    "INSTRUCTIONS:",
    "Call the `submit_analysis` tool with the analytical sections of the report. Required sections: exec, qualitative_flags, section3_risks, section4_framework, section5_pointers, section6_actions, section7_systemic, section8_gaps, section9_evidence.",
    "NOTE: meta, section1 (subject + sources tables), and references are populated automatically by the system from bundle data — DO NOT include them in your tool call.",
    "STANDARDISATION REQUIREMENT — the output JSON must render to a Word document with the same depth/structure as the canonical examples (Be Beauty Studio and Julia mag glamour). Specifically:",
    "  • exec.summary_paragraphs: 5 substantive paragraphs",
    "  • qualitative_flags.flags: 6-8 entries with reading PASS/WARN/FAIL/GAP. Always include: Price sensitivity, Sales urgency / time pressure, Customer engagement quality, Stated dissatisfaction (pre-pay), Long-term commitment posture, Operator decisiveness, Cross-data integrity. Add Demand-side signal OR Demo delivery quality when relevant data exists. End with a one-sentence `takeaway`.",
    "  • section3_risks.risks: 5-8 entries with id/risk/likelihood/impact/driver_mitigation",
    "  • section4_framework.step1: EXACTLY 3 gate rows (1.1 Device, 1.2 Lead prediction, 1.3 Booking platform) with status + evidence; evidence MAY be a string OR an array of block objects ({type: 'para'|'richpara', text/runs}) for rich formatting",
    "  • section4_framework.step2: 1-3 rule rows; section4_framework.disqualifiers: 5-7 disqualifier rows; section4_framework.summary_table: 3 layer rows",
    "  • section5_pointers: EXACTLY 11 pointers in canonical order (see schema description). Across all 11, target ~16 tables: Pointer 2 (comms breakdown table), Pointer 3 (timestamp validation table), Pointer 4 (promised-vs-delivered or Module-02-question table + h3 sub-headings), Pointer 9 (h3 sub-headings), Pointer 10 (red-flags table), Pointer 11 (kv pricing block). Other pointers can use para/bullet blocks but should also include at least one rich block (kv or table) where data warrants.",
    "  • section6_actions: 5 actions + verbatim am_script + 3 branch_paragraphs",
    "  • section7_systemic: 5 recommendations with priority P0/P1/P2",
    "  • section8_gaps.items: 7-10 one-sentence gaps",
    "  • section9_evidence: 3 methodology_paragraphs + 12-15 evidence_trail bullets, each citing source field",
    "EVIDENCE DISCIPLINE — every numerical claim cites the source field (e.g., \"review_metrics.csv total_reviews_at_onboarding = 3\"). Where data is missing, mark status GAP — never assert facts the data does not support.",
    "You MAY also emit a short TEXT content block before the tool call summarizing the verdict — it'll be used as the Slack thread reply.",
  ].join("\n");

  const { markdown, reportData } = await callOnce(systemPrompt, userPrompt);

  // OVERRIDE the deterministic sections with bundle-derived data. This
  // guarantees meta/section1/references are consistent across customers and
  // match the canonical template format exactly. The LLM-supplied versions of
  // these sections are discarded in favor of the bundle-computed truth.
  reportData.meta = buildMeta(args.bundle);
  reportData.section1 = buildSection1(args.bundle);
  reportData.references = buildReferences();

  // If the model skipped the text content (some models do that with forced
  // tool use), synthesize a minimal markdown summary from the structured data
  // so Slack still has something to post.
  const finalMarkdown = markdown.length > 50 ? markdown : synthesizeMarkdownFromReport(reportData);
  return { markdown: finalMarkdown, reportData, raw: markdown };
}

/**
 * Bundle-derived meta block. Same structure every run; only subject_account
 * varies per customer. Matches the cover-page convention from the Be Beauty
 * Studio worked example.
 */
function buildMeta(bundle: any): any {
  const cb = bundle.chargebee_customer ?? {};
  const ent = (bundle.entities ?? [])[0] ?? {};
  const bizName = ent.bizname ?? cb.cf_entity_name ?? cb.company ?? "(business)";
  const owner = [cb.first_name, cb.last_name].filter(Boolean).join(" ");
  const subjectAccount = owner ? `${bizName} (${owner})` : bizName;
  return {
    classification_banner: "ZOCA · CONFIDENTIAL",
    title: "Post-Payment Account Review",
    subtitle: "ICP Fit Assessment & Post-Payment Pointer Analysis",
    subject_account: subjectAccount,
    header_text: `Zoca · Confidential — Post-Payment Account Review · ${bizName}`,
  };
}

/**
 * Bundle-derived section1: subject identifier table + data sources table.
 * Both are deterministic — every row's value comes straight from bundle
 * fields. data_sources_table is the same list every run (the validator
 * always uses the same set of sources).
 */
function buildSection1(bundle: any): any {
  const cb = bundle.chargebee_customer ?? {};
  const ent = (bundle.entities ?? [])[0] ?? {};
  const sub = bundle.subscription ?? {};
  const stripe = bundle.stripe_customer ?? {};
  const bizName = ent.bizname ?? cb.cf_entity_name ?? cb.company ?? "—";
  const owner = [cb.first_name, cb.last_name].filter(Boolean).join(" ") || "—";
  const primaryCategory = ent.primary_category ?? "—";
  const locality = ent.locality ?? "";
  const stateCode = ent.state ?? "";
  const location = [locality, stateCode].filter(Boolean).join(", ") || "—";
  const cbId = bundle.customer_id ?? cb.id ?? "—";
  const stripeId = stripe.id ?? "—";
  const entityId = ent.entity_id ?? "—";
  const firstPayUnix = bundle.t_chargebee_unix;
  const firstPayStr = firstPayUnix
    ? new Date(firstPayUnix * 1000).toISOString().replace("T", " at ").slice(0, 22) + " UTC"
    : "—";
  const subSkus = (sub.subscription_items ?? []).map((i: any) => i.item_price_id).join(", ") || "—";
  const aeName = ent.ae_name ?? "—";
  const amName = ent.am_name ?? "—";

  return {
    subject_table: [
      ["Subject identifier", "Value"],
      ["Business name", bizName],
      ["Owner / decision-maker", owner],
      ["Primary category (BaseSheet)", primaryCategory],
      ["Location", location],
      ["Chargebee customer ID", cbId],
      ["Stripe customer ID", stripeId],
      ["Zoca entity ID", entityId],
      ["First Discovery payment", firstPayStr],
      ["Subscription SKU", subSkus],
      ["Account executive (sale)", `${aeName}${aeName !== "—" ? " (per BaseSheet ae_name)" : ""}`],
      ["Account manager (post-sale)", `${amName}${amName !== "—" ? " (per BaseSheet am_name)" : ""}`],
    ],
    data_sources_table: [
      ["Data source", "Type", "Used for"],
      ["Chargebee API", "Live REST", "Customer record, subscription, invoice, payment status, customer.created_at timestamp"],
      ["Stripe API", "Live REST", "Customer record by email, customer.created timestamp, payment-method status, transaction record"],
      ["Metabase BaseSheet", "CSV (87763e8c)", "Entity ID, business name, AE/AM, primary category, lead-source label, churn flags, ticket counts, missed-payment flags, predicted_6_month_leads"],
      ["Metabase comms — App Chat / Email / Phone / SMS / Video", "CSV (5 endpoints)", "All inbound and outbound communications tied to entity ID, filtered to the 90-day window before T_created"],
      ["Booking platform CSV", "CSV (4d3a953e)", "Verifies Step-1.3 booking-platform gate by entity ID; identifies linked social media accounts"],
      ["Business opening date CSV", "CSV (8b6f5349)", "Verifies GBP age disqualifier (Open Info → Opening Date → Year/Month/Day) by entity ID"],
      ["Review metrics CSV", "CSV (88a7ea2a)", "predicted_6_month_leads, total_reviews_at_onboarding, avg_rating_at_onboarding, review_target, pre-onboard GBP profile clicks"],
      ["Fireflies", "MCP", "Demo / discovery transcript matching by participant email or business name within 90-day window"],
      ["HubSpot", "MCP", "Lead source, deal stage, lifecycle stage, owner, contact properties"],
    ],
  };
}

/**
 * Static references registry — same every run, since the validator always
 * uses the same set of data sources. Matches Be Beauty Studio Appendix C.
 */
function buildReferences(): any {
  return {
    intro: "Every claim in this report can be traced to one of the sources catalogued below. Wherever a source could not provide data for this entity, the gap is explicitly called out in the relevant section above (data gap).",
    entries: [
      { source: "Chargebee API", identifier: "zoca.chargebee.com", url: "https://zoca.chargebee.com/" },
      { source: "Stripe API", identifier: "stripe.com/customers", url: "https://stripe.com/" },
      { source: "Metabase BaseSheet", identifier: "card 87763e8c", url: "https://metabase.zoca.ai/public/question/87763e8c-8084-442e-891a-df1b11e81b47.csv" },
      { source: "App Chat comms", identifier: "card 10a52e37", url: "https://metabase.zoca.ai/public/question/10a52e37-04fa-4422-b840-803b66e033bf.csv" },
      { source: "Email comms", identifier: "card 7a5aa1f6", url: "https://metabase.zoca.ai/public/question/7a5aa1f6-9205-4e83-be51-3e585aa0f4a8.csv" },
      { source: "Phone-call comms", identifier: "card 60797a27", url: "https://metabase.zoca.ai/public/question/60797a27-c546-450d-b00b-a51b7e490143.csv" },
      { source: "Video-call comms", identifier: "card d95d9354", url: "https://metabase.zoca.ai/public/question/d95d9354-7c84-4a57-8af5-e700580c6ecb.csv" },
      { source: "SMS comms", identifier: "card bbaad2fb", url: "https://metabase.zoca.ai/public/question/bbaad2fb-5f9d-4249-af59-c7812851437c.csv" },
      { source: "Booking platform CSV", identifier: "card 4d3a953e", url: "https://metabase.zoca.ai/public/question/4d3a953e.csv" },
      { source: "Business opening date CSV", identifier: "card 8b6f5349", url: "https://metabase.zoca.ai/public/question/8b6f5349.csv" },
      { source: "Review metrics CSV", identifier: "card 88a7ea2a", url: "https://metabase.zoca.ai/public/question/88a7ea2a.csv" },
    ],
    matching_keys: [
      { key: "Chargebee customer_id ↔ BaseSheet customer_id", usage: "Joins Chargebee customer record to BaseSheet entity row." },
      { key: "BaseSheet entity_id ↔ comms Entity ID", usage: "Filters all comms feeds to this specific entity." },
      { key: "Chargebee email ↔ Stripe email", usage: "Matches Chargebee customer to Stripe customer for timestamp reconciliation." },
    ],
  };
}

/**
 * Fallback for when the model emits only the tool call with no text content.
 * Builds a brief Markdown summary from the structured report data so we have
 * something to post to Slack. Defensive about missing fields.
 */
function synthesizeMarkdownFromReport(report: any): string {
  const exec = report?.exec ?? {};
  const lines: string[] = [];
  if (exec.verdict_label) lines.push(`**Verdict:** ${exec.verdict_label}`);
  if (exec.driver) lines.push(`**One-line driver:** ${exec.driver}`);
  if (exec.recommended_action_label) lines.push(`**Recommended action:** ${exec.recommended_action_label}`);
  if (exec.reinforcing_flags) lines.push(`**Key flag:** ${exec.reinforcing_flags}`);
  lines.push("");
  lines.push("_Full analysis available in the Word doc attached to this thread._");
  return lines.join("\n");
}

/**
 * Take the LLM's full report-data output and back-fill any sections it left
 * out. This is defense-in-depth — the schema asks for all 11 sections, but
 * if the model skips one, we want the renderer to still produce a valid doc
 * (the skipped section will just render as an empty heading).
 */
function fillReportDefaults(input: any): any {
  return {
    meta: input.meta ?? {
      classification_banner: "ZOCA · CONFIDENTIAL",
      title: "Post-Payment Account Review",
      subtitle: "ICP Fit Assessment & Post-Payment Pointer Analysis",
      subject_account: "(see Section 1)",
      header_text: "Zoca · Confidential — Post-Payment Account Review",
    },
    exec: input.exec ?? {},
    section1: input.section1 ?? { subject_table: [], data_sources_table: [] },
    section3_risks: input.section3_risks ?? { intro: "", risks: [] },
    section4_framework: input.section4_framework ?? { tier_application: "", vertical_lock_text: "", step1: [], step2: [] },
    section5_pointers: Array.isArray(input.section5_pointers) ? input.section5_pointers : [],
    section6_actions: input.section6_actions ?? { intro: "", actions: [] },
    section7_systemic: input.section7_systemic ?? { intro: "", recommendations: [] },
    section8_gaps: input.section8_gaps ?? { intro: "", gaps: [] },
    section9_evidence: input.section9_evidence ?? { intro: "", items: [] },
    references: input.references ?? { intro: "", items: [] },
  };
}

"use client";

/**
 * AskPanel — universal "Ask Beacon AI" copilot (Claude under the hood).
 * Phase E-9.
 *
 * Mounted once at the umbrella root layout. Detects scope from
 * usePathname() and adapts:
 *   - Quick-prompt chips change per scope
 *   - Endpoint /api/ai/ask receives the resolved scope + question
 *   - localStorage key is per-scope so each surface keeps its own history
 *   - Header subtitle says "About this customer" / "About the inbox" / etc.
 *
 * UX:
 *   - Floating "✨ Ask Beacon AI" button bottom-right (hidden when scope is
 *     "hidden" — auth pages, admin pages)
 *   - Click to open right-edge drawer
 *   - Esc / backdrop click to close
 *   - ⌘+Enter to send
 *   - Conversation persists in localStorage scoped to the current view
 *
 * Note on branding: this is *Beacon* — Zoca's customer-intelligence
 * copilot. It's powered by Claude (Anthropic) but speaks as Beacon. Users
 * never see "Claude" in the UI.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  pathToScope,
  scopeKey,
  scopeLabel,
  scopeQuickPrompts,
  type AiScope,
} from "@/lib/ai/scopes";
import { BeaconMark } from "@/components/BeaconMark";
// Phase E-12 (E-12.4) — first-login working-style onboarding nudge.
import StyleOnboarding from "@/components/ai/StyleOnboarding";
// Phase E-16 Wave 1 — inline approval card for Beacon AI tool_use blocks.
import ActionCard, {
  type ActionCardData,
  type ActionCardStatus,
} from "@/components/ai/ActionCard";
// Phase E-17 Wave 3a — inline citations + confidence calibration.
import CitationChip from "@/components/ai/CitationChip";
import ConfidenceBadge, {
  type ConfidenceData,
} from "@/components/ai/ConfidenceBadge";
import {
  CITATION_PATTERN_SOURCE,
  CONFIDENCE_PATTERN_SOURCE,
  type CitationEntry,
  type CitationLookup,
} from "@/lib/ai/citations";

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = "-apple-system, Inter, system-ui, sans-serif";

const C = {
  text: "var(--zoca-text)",
  text2: "var(--zoca-text-2)",
  text3: "var(--zoca-text-3)",
  surface: "#F8EFD7",
  parchment: "#F0E4CC",
  border: "#D4C29B",
  ember: "#C8431D",
  brass: "#D9A441",
  lapis: "#2A4D5C",
  patina: "#4A7C59",
  char: "#2B1F14",
};

interface Turn {
  role: "user" | "assistant";
  content: string;
  /**
   * Phase E-12 — assistant turn id from beacon_ai_conversations. Used as
   * the target for thumbs up/down feedback (POST /api/ai/feedback).
   * Undefined for user turns, the streaming-in-progress assistant placeholder,
   * and historical turns hydrated from /api/ai/memory (those don't get
   * thumbs because we'd need to render historical feedback state too —
   * scope creep we don't want yet).
   */
  turnId?: number;
  /**
   * Phase E-12 — thumbs feedback already sent for this turn. Set after the
   * user clicks; prevents repeated clicks from spamming the endpoint and
   * gives us a visible "active" state on the button.
   */
  feedback?: "up" | "down" | null;
  /**
   * Phase E-16 Wave 1 — tool_use blocks that streamed in alongside this
   * assistant turn. Each renders as an ActionCard inline in the transcript.
   * Approve/Discard mutate the matching entry's status; on success we feed
   * the tool_result back into the conversation and Claude can follow up.
   */
  toolUses?: Array<{
    data: ActionCardData;
    status: ActionCardStatus;
    resultSummary?: string | null;
    resultError?: string | null;
    /**
     * Phase E-16 Wave 2 — extended tool-result payload from /execute. Drafts
     * carry subject/body/recipient; lookup_customer carries the matched
     * hits. The Wave-1 mutators leave this null.
     */
    resultData?: Record<string, unknown> | null;
  }>;
  /**
   * Phase E-17 Wave 3a — citation lookup for this assistant turn. Received
   * via the `citations` SSE frame at stream start. Used to resolve
   * `[cite:KEY]` markers when rendering this turn's content.
   */
  citationLookup?: CitationLookup;
}

const MAX_HISTORY_TURNS = 6;

/**
 * Memory hydration — Phase E-9.
 *
 * Beacon's memory now lives in Postgres (beacon_ai_conversations) so it
 * persists across sessions, browsers, and devices. localStorage is kept
 * as a 5-minute cache to avoid re-fetching on every drawer open, but the
 * server is the source of truth.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedHydration {
  scope_key: string;
  fetched_at: number;
  scope_turns: Turn[];
  total: number;
}

function cacheKeyFor(scope: AiScope): string {
  return `beacon_ai_cache_${scopeKey(scope)}`;
}

function readCache(scope: AiScope): CachedHydration | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKeyFor(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedHydration;
    if (Date.now() - parsed.fetched_at > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(scope: AiScope, payload: CachedHydration): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKeyFor(scope), JSON.stringify(payload));
  } catch {
    /* ignore quota */
  }
}

function invalidateCache(scope: AiScope): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(cacheKeyFor(scope));
  } catch {
    /* ignore */
  }
}

/* ────────────────────────────────────────────────────────────────
 * Phase E-17 Wave 3a — helpers to parse `<confidence: ...>` markers and
 * `[cite:KEY]` markers out of streaming assistant text.
 *
 * Confidence parsing strips ALL markers from the prose; the first one
 * found becomes the displayed badge. Citation parsing keeps markers in
 * place but tokenizes them out so they can be rendered as React chips.
 * ──────────────────────────────────────────────────────────────── */

interface ParsedAssistantContent {
  /** Prose with `<confidence:...>` markers removed. Citation markers stay. */
  text: string;
  /** First confidence marker (if any) — driver of ConfidenceBadge. */
  confidence: ConfidenceData | null;
}

function parseAssistantContent(raw: string): ParsedAssistantContent {
  const re = new RegExp(CONFIDENCE_PATTERN_SOURCE, "g");
  let firstMatch: ConfidenceData | null = null;
  const stripped = raw.replace(re, (full, pctStr: string, reasonsStr: string) => {
    if (!firstMatch) {
      const pct = Number.parseInt(pctStr, 10);
      const reasons = reasonsStr
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (Number.isFinite(pct)) {
        firstMatch = {
          percent: Math.max(0, Math.min(100, pct)),
          reasons,
          raw: full,
        };
      }
    }
    return "";
  });
  // F-ai-context L1 — strip `<gap: ...>` telemetry markers. These get parsed
  // server-side into the failure inbox at /admin/beacon-ai-gaps; they're
  // never user-facing content. Pattern matches a single line up to the
  // closing `>` and won't span newlines.
  const cleaned = stripped
    .replace(/<gap:[^>\n]*>/gi, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
  return { text: cleaned, confidence: firstMatch };
}

/**
 * Tokenize a string into alternating text + citation-chip pieces.
 * Returns an array suitable for direct React rendering.
 */
function renderWithCitations(
  text: string,
  lookup: CitationLookup | undefined,
): React.ReactNode[] {
  if (!text) return [];
  const re = new RegExp(CITATION_PATTERN_SOURCE, "g");
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let chipIndex = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const key = match[1];
    const entry: CitationEntry | undefined = lookup ? lookup[key] : undefined;
    nodes.push(
      <CitationChip
        key={`cite-${chipIndex}-${key}`}
        citationKey={key}
        entry={entry}
      />,
    );
    chipIndex += 1;
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export default function AskPanel() {
  const pathname = usePathname() ?? "/";
  const scope: AiScope = pathToScope(pathname);

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Phase E-9 memory — total conversations Beacon has stored for this
  // user, surfaced as a "Beacon remembers N" chip in the drawer header.
  const [totalMemory, setTotalMemory] = useState<number | null>(null);
  const [hydrating, setHydrating] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // FIX: React 18 batches setState — the functional updater passed to
  // setTurns() runs ASYNCHRONOUSLY, after the surrounding code has already
  // continued. Previously `resolveToolUse` captured `entry` inside the
  // updater via closure side-effect, which meant `entry` was still
  // `undefined` when checked right after `setTurns(...)`. The early-return
  // fired before the updater ever ran, so the fetch was never dispatched
  // and the action card hung on "Running…".
  //
  // The fix is a ref that mirrors `turns` synchronously. `resolveToolUse`
  // reads the entry from `turnsRef.current` BEFORE calling setTurns, and
  // setTurns is then used purely for the visual state transition.
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  // Phase E-16 Wave 2 — forward ref for resolveToolUse so the stream handler
  // (inside `ask`) can auto-approve lookup_customer without a definition
  // ordering loop with the later useCallback.
  const resolveToolUseRef = useRef<
    | ((
        turnIndex: number,
        toolUseId: string,
        decision: "approve" | "discard",
      ) => Promise<void> | void)
    | null
  >(null);

  // Hydrate from Postgres on scope change. Cache to localStorage for 5min
  // so revisiting the same scope is instant. Server is the source of truth.
  useEffect(() => {
    let cancelled = false;
    if (scope.kind === "hidden") return;

    const sKey = scopeKey(scope);
    const cached = readCache(scope);
    if (cached && cached.scope_key === sKey) {
      setTurns(cached.scope_turns);
      setTotalMemory(cached.total);
    } else {
      // Show empty immediately; spinner is implicit in `hydrating`.
      setTurns([]);
      setHydrating(true);
    }

    (async () => {
      try {
        const res = await fetch(
          `/api/ai/memory?scope_key=${encodeURIComponent(sKey)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`memory ${res.status}`);
        const json = (await res.json()) as {
          scope: Array<{ role: "user" | "assistant"; content: string }>;
          total: number;
        };
        if (cancelled) return;
        const hydrated = json.scope.map((t) => ({
          role: t.role,
          content: t.content,
        }));
        setTurns(hydrated);
        setTotalMemory(json.total);
        writeCache(scope, {
          scope_key: sKey,
          fetched_at: Date.now(),
          scope_turns: hydrated,
          total: json.total,
        });
      } catch {
        // Silent fallback — empty transcript, no total.
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey(scope)]);

  // Auto-scroll transcript on update.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, streaming]);

  // Phase E-9 — SuggestedActions strip dispatches a "beacon-ai:open" event
  // when a user clicks a card. We open the drawer, pre-fill the textarea
  // with the suggested prompt, and optionally auto-submit (for drafts).
  useEffect(() => {
    const onOpenEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt?: string; autoSubmit?: boolean }>)
        .detail;
      if (!detail?.prompt) return;
      setOpen(true);
      setDraft(detail.prompt);
      if (detail.autoSubmit) {
        // Defer one tick so the open + draft state lands before submit.
        requestAnimationFrame(() => {
          ask(detail.prompt!);
        });
      } else {
        // Focus the textarea so the user can edit before sending.
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener("beacon-ai:open", onOpenEvent);
    return () => window.removeEventListener("beacon-ai:open", onOpenEvent);
    // We deliberately omit `ask` from deps to keep the listener stable —
    // it closes over the latest setters via React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes drawer (unless streaming, to avoid losing partial reply).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !streaming) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => textareaRef.current?.focus());
    return () => document.removeEventListener("keydown", onKey);
  }, [open, streaming]);

  const ask = useCallback(
    async (
      question: string,
      opts?: { extraCitations?: Record<string, unknown> },
    ) => {
      const trimmed = question.trim();
      if (!trimmed || streaming) return;
      setErrorMsg(null);
      setDraft("");

      // Phase E-9 · Phase 2 — /remember slash command. User types
      // "/remember they manage Apurvaa's book" and Beacon AI stores it
      // as an explicit fact in beacon_ai_user_facts. The fact is then
      // injected into every future prompt as part of USER PROFILE.
      // We acknowledge inline as a synthetic assistant turn — no LLM
      // call needed.
      const rememberMatch = trimmed.match(/^\/remember\s+(.+)$/i);
      if (rememberMatch) {
        const fact = rememberMatch[1].trim();
        const userTurn: Turn = { role: "user", content: trimmed };
        setTurns((prev) => [...prev, userTurn]);
        try {
          const res = await fetch("/api/ai/facts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fact }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(body.error || `facts ${res.status}`);
          }
          const json = (await res.json()) as { ok: boolean; reused: boolean };
          const ackText = json.reused
            ? `Got it — I already remembered that. I'll keep applying it.`
            : `Got it — I'll remember that across our future conversations.`;
          setTurns((prev) => [
            ...prev,
            { role: "assistant", content: ackText },
          ]);
        } catch (e) {
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
        return;
      }

      const history = turns.slice(-MAX_HISTORY_TURNS * 2);
      const userTurn: Turn = { role: "user", content: trimmed };
      setTurns((prev) => [
        ...prev,
        userTurn,
        { role: "assistant", content: "" },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch("/api/ai/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope,
            question: trimmed,
            history,
            ...(opts?.extraCitations
              ? { extra_citations: opts.extraCitations }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const errBody = await res
            .json()
            .catch(() => ({ error: res.statusText }));
          throw new Error(errBody.error || `ai/ask ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const evt of events) {
            const line = evt.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            const obj = JSON.parse(payload) as {
              delta?: string;
              done?: boolean;
              error?: string;
              turn_id?: number | null;
              feedback_enabled?: boolean;
              tool_use?: {
                id: string;
                name: string;
                input: Record<string, unknown>;
              };
              /**
               * Phase E-17 Wave 3a — citation lookup for this turn. Arrives
               * once at the start of the stream (or not at all for scopes
               * without citation support in v1). Attached to the in-flight
               * assistant turn so `[cite:KEY]` markers in subsequent deltas
               * resolve to real entries.
               */
              citations?: CitationLookup;
            };
            if (obj.error) throw new Error(obj.error);
            if (obj.citations) {
              const citationLookup = obj.citations;
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  next[next.length - 1] = {
                    ...last,
                    citationLookup,
                  };
                }
                return next;
              });
            }
            if (obj.delta) {
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  next[next.length - 1] = {
                    ...last,
                    role: "assistant",
                    content: last.content + obj.delta,
                  };
                }
                return next;
              });
            }
            // Phase E-16 Wave 1 — tool_use block streamed in. Attach an
            // ActionCard entry to the in-flight assistant turn so the AM can
            // approve or discard inline.
            //
            // Wave 2 — for multi-customer scopes (book / inbox / escalation /
            // performance-report / post-payment-*), the entity_id comes from
            // the tool input rather than the URL. We prefer:
            //   1. scope.entityId for single-customer scopes (customer-360,
            //      performance-report).
            //   2. input.customer_id when the tool carries one (every Wave 1
            //      mutator + draft tools).
            //   3. empty string for lookup_customer (the read-only tool that
            //      doesn't act on a specific customer).
            // Drafts may also include bizname inside the tool result when
            // approved; for the pending state we fall back to the scope label.
            if (obj.tool_use) {
              const tu = obj.tool_use;
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  const scopeEntityId =
                    scope.kind === "customer-360"
                      ? scope.entityId
                      : scope.kind === "performance-report"
                        ? scope.entityId
                        : null;
                  const inputCustomerId =
                    typeof tu.input["customer_id"] === "string"
                      ? (tu.input["customer_id"] as string)
                      : null;
                  const customerId =
                    inputCustomerId ?? scopeEntityId ?? "";
                  // FIX E-16.A — schemas now require `bizname` on mutation
                  // tools, but be defensive: fall back to the in-conversation
                  // text or "this customer" if the model still omits it.
                  const biznameFromArgs =
                    typeof tu.input["bizname"] === "string" &&
                    (tu.input["bizname"] as string).trim()
                      ? (tu.input["bizname"] as string).trim()
                      : null;
                  const customerName = biznameFromArgs ?? "this customer";
                  const newEntry = {
                    data: {
                      toolUseId: tu.id,
                      toolName: tu.name,
                      input: tu.input,
                      customerId,
                      customerName,
                    } satisfies ActionCardData,
                    status: "pending" as ActionCardStatus,
                  };
                  next[next.length - 1] = {
                    ...last,
                    toolUses: [...(last.toolUses ?? []), newEntry],
                  };
                  // Wave 2 + Tier 2 — read-only tools auto-execute. We schedule
                  // the approve a tick after setState lands so the status flip
                  // from "pending" → "approving" → "approved" is visible
                  // (matches the flow other tools follow on Approve).
                  if (
                    tu.name === "lookup_customer" ||
                    tu.name === "query_customer_book" ||
                    tu.name === "read_customer_notes" ||
                    tu.name === "get_chargebee_billing" ||
                    tu.name === "get_customer_performance" ||
                    // Brain Wave 2a.1 — read-only, auto-approve.
                    tu.name === "read_customer_brain"
                  ) {
                    const turnIdx = next.length - 1;
                    const toolUseId = tu.id;
                    queueMicrotask(() => {
                      resolveToolUseRef.current?.(
                        turnIdx,
                        toolUseId,
                        "approve",
                      );
                    });
                  }
                }
                return next;
              });
            }
            // Phase E-12 — stamp the assistant turn with its DB id when the
            // backend's final SSE frame lands. The thumbs UI keys off this id.
            if (obj.done && typeof obj.turn_id === "number") {
              const newId = obj.turn_id;
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  next[next.length - 1] = {
                    ...last,
                    turnId: newId,
                  };
                }
                return next;
              });
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          // user cancelled — leave partial in place
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          setErrorMsg(msg);
          setTurns((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && !last.content) {
              return prev.slice(0, -1);
            }
            return prev;
          });
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [scope, streaming, turns],
  );

  const onSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      ask(draft);
    },
    [ask, draft],
  );

  /**
   * Phase E-16 Wave 1 — Approve or Discard a proposed tool_use.
   *
   * Approve: POST /api/ai/action/execute → on success, set status="approved"
   * and feed the tool_result back into the conversation so Claude can
   * follow up naturally.
   *
   * Discard: PUT /api/ai/action/execute (audit-only, no DB write) → set
   * status="discarded" + feed back a `{ok:false, error:"user_declined"}`
   * tool_result so Claude knows not to retry.
   */
  const resolveToolUse = useCallback(
    async (
      turnIndex: number,
      toolUseId: string,
      decision: "approve" | "discard",
    ) => {
      // FIX: Look up the entry SYNCHRONOUSLY from `turnsRef.current` before
      // calling setTurns. Previously we captured `entry` via closure
      // side-effect inside the setTurns updater — but React 18 runs the
      // updater asynchronously, so `entry` was always `undefined` when the
      // outer code checked it. That triggered an early return and the
      // approval fetch never fired. Read first, mutate second.
      const currentTurns = turnsRef.current;
      const currentTurn = currentTurns[turnIndex];
      if (!currentTurn || currentTurn.role !== "assistant") return;
      const currentUses = currentTurn.toolUses ?? [];
      const entryIdx = currentUses.findIndex(
        (u) => u.data.toolUseId === toolUseId,
      );
      if (entryIdx === -1) return;
      const entry = currentUses[entryIdx];
      if (entry.status !== "pending") return;
      const { data } = entry;

      // Now transition the visual state. The updater is allowed to run
      // async — we no longer rely on its side effects.
      setTurns((prev) => {
        const next = [...prev];
        const turn = next[turnIndex];
        if (!turn || turn.role !== "assistant") return prev;
        const uses = turn.toolUses ?? [];
        const idx = uses.findIndex((u) => u.data.toolUseId === toolUseId);
        if (idx === -1) return prev;
        if (uses[idx].status !== "pending") return prev;
        const updatedUses = uses.slice();
        updatedUses[idx] = {
          ...uses[idx],
          status: decision === "approve" ? "approving" : "discarded",
        };
        next[turnIndex] = { ...turn, toolUses: updatedUses };
        return next;
      });

      const writeResult = (
        status: ActionCardStatus,
        summary: string | null,
        error: string | null,
        rich: Record<string, unknown> | null = null,
      ) => {
        setTurns((prev) => {
          const next = [...prev];
          const turn = next[turnIndex];
          if (!turn || turn.role !== "assistant") return prev;
          const uses = turn.toolUses ?? [];
          const idx = uses.findIndex((u) => u.data.toolUseId === toolUseId);
          if (idx === -1) return prev;
          const updatedUses = uses.slice();
          updatedUses[idx] = {
            ...uses[idx],
            status,
            resultSummary: summary,
            resultError: error,
            resultData: rich,
          };
          next[turnIndex] = { ...turn, toolUses: updatedUses };
          return next;
        });
      };

      if (decision === "discard") {
        // Audit-only PUT; we still let Claude know it was declined so the
        // follow-up message reads correctly.
        try {
          await fetch("/api/ai/action/execute", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tool_use_id: data.toolUseId,
              tool_name: data.toolName,
              args: data.input,
              customer_id: data.customerId,
            }),
          });
        } catch {
          /* audit-only — failure shouldn't block the UX */
        }
        // FIX E-16.B — fire-and-forget. Don't await the follow-up ask, so
        // the card's "discarded" state is final even if the next streaming
        // turn races with concurrent approves on other cards.
        void askWithToolResult(data, { ok: false, error: "user_declined" });
        return;
      }

      // Approve — actually execute.
      try {
        const res = await fetch("/api/ai/action/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool_use_id: data.toolUseId,
            tool_name: data.toolName,
            args: data.input,
            customer_id: data.customerId,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          summary?: string;
          error?: string;
          // Phase E-16 Wave 2 — rich payload (draft subject/body or lookup hits).
          data?: Record<string, unknown> | null;
        };
        if (!res.ok || json.ok === false) {
          const errMsg = json.error || `execute ${res.status}`;
          writeResult("error", null, errMsg);
          // FIX E-16.B — fire-and-forget, see above.
          void askWithToolResult(data, { ok: false, error: errMsg });
          return;
        }
        writeResult(
          "approved",
          json.summary ?? null,
          null,
          json.data ?? null,
        );
        // FIX E-16.B — fire-and-forget. The card's "approved" state is
        // already committed by writeResult above; the follow-up ask is for
        // Claude's narration only and must not block the UI.
        // FIX T2.B — for query_customer_book, the structured rows are in
        // json.data and the model needs them to format the table. Other
        // tools ignore the data field (their value is the action itself).
        void askWithToolResult(data, {
          ok: true,
          summary: json.summary ?? "Action completed.",
          data: json.data ?? null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeResult("error", null, msg);
        // FIX E-16.B — fire-and-forget, see above.
        void askWithToolResult(data, { ok: false, error: msg });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope],
  );

  /**
   * Phase E-16 Wave 1 — after an approve/discard resolves, drop a short
   * "user-side" message into the conversation describing the result and
   * re-run the streaming /api/ai/ask so Claude can naturally follow up
   * ("Great — I snoozed Acme Salon. Anything else?").
   *
   * We keep this simple: the message that goes back to Claude is plain
   * text rather than a real tool_result content block. The current /ask
   * route doesn't carry tool-use threading across requests (each request
   * is a fresh window). This is documented as a v1.1 gap.
   */
  const askWithToolResult = useCallback(
    async (
      action: ActionCardData,
      outcome:
        | { ok: true; summary: string; data?: Record<string, unknown> | null }
        | { ok: false; error: string },
    ) => {
      const verb =
        ({
          snooze_customer: "snooze",
          pin_customer: "pin",
          mark_contacted_today: "mark-contacted",
          add_note: "add-note",
          lookup_customer: "lookup",
          read_customer_notes: "read notes",
          read_customer_brain: "read brain",
          add_fact_to_brain: "save to brain",
          get_chargebee_billing: "pull billing",
          get_customer_performance: "pull performance",
          draft_email_to_contact: "draft-email",
          draft_slack_message: "draft-slack",
          query_customer_book: "query",
        } as Record<string, string>)[action.toolName] ?? action.toolName;

      // F-polish-AI hotfix B — query_customer_book is book-level AND its
      // value is in the structured rows, not the one-line summary. Inline
      // the rows into the follow-up so the model has something to format
      // into a markdown table. Other tools keep the lean summary-only
      // path (their value is in the action itself, not the data).
      let followUp: string;
      if (action.toolName === "query_customer_book" && outcome.ok) {
        const summary = outcome.summary;
        const rich = (outcome.data ?? null) as
          | {
              metric?: string;
              group_by?: string;
              buckets?: Record<string, unknown>;
              filter?: Record<string, unknown> | null;
              total_customers_in_scope?: number;
              rows?: Array<Record<string, unknown>>;
            }
          | null;
        const lines: string[] = [];
        lines.push(`[Beacon ran query_customer_book → ${summary}`);
        if (rich) {
          lines.push(`metric: ${rich.metric}`);
          lines.push(`group_by: ${rich.group_by}`);
          if (rich.buckets) {
            lines.push(`buckets: ${JSON.stringify(rich.buckets)}`);
          }
          if (rich.filter && Object.keys(rich.filter).length > 0) {
            lines.push(`filter: ${JSON.stringify(rich.filter)}`);
          }
          if (typeof rich.total_customers_in_scope === "number") {
            lines.push(`total_customers_in_scope: ${rich.total_customers_in_scope}`);
          }
          if (Array.isArray(rich.rows)) {
            lines.push(`rows (${rich.rows.length}):`);
            lines.push(JSON.stringify(rich.rows, null, 2));
          }
        }
        lines.push("");
        lines.push(
          "Now format these rows as a clean markdown table. Cite each non-header cell with a chip in this exact pattern: `[cite:count:query:<metric>:<group_slug>:<bucket_label>]` — `group_slug` is the row's group_key lowercased with non-alphanumerics → underscores. For sum/avg cells use `<group_slug>:sum` or `<group_slug>:avg`. For the total-customers column use `<group_slug>:total`. Don't restate the parameters above the table. End with one short line naming the most-silent / highest-value group_key as a takeaway.",
        );
        followUp = lines.join("\n") + "]";
      } else if (action.toolName === "query_customer_book" && !outcome.ok) {
        followUp = `[Beacon's query_customer_book proposal was not run — ${outcome.error}.]`;
      } else if (action.toolName === "read_customer_notes" && outcome.ok) {
        // F-ai-context chunk 2 — inline the actual note content into the
        // follow-up so the model can quote/summarize. The one-line summary
        // alone tells it how many notes exist but not what's in them.
        const rich = (outcome.data ?? null) as
          | {
              entity_id?: string;
              scope?: "own-am" | "all-ams";
              note?: { note: string; updated_at: string } | null;
              notes?: Array<{
                am_name: string;
                bizname: string | null;
                note: string;
                updated_at: string;
              }>;
            }
          | null;
        const lines: string[] = [
          `[Beacon ran read_customer_notes → ${outcome.summary}`,
        ];
        if (rich?.scope === "own-am" && rich.note) {
          lines.push(`Your saved note (updated ${rich.note.updated_at}):`);
          lines.push(rich.note.note);
        } else if (rich?.scope === "all-ams" && Array.isArray(rich.notes)) {
          lines.push("");
          for (const n of rich.notes) {
            lines.push(`— ${n.am_name} (updated ${n.updated_at}):`);
            lines.push(n.note);
            lines.push("");
          }
        }
        lines.push("");
        lines.push(
          "Now answer the user's question using these notes. Quote relevant lines directly when helpful. If the notes are empty / missing, say so plainly — don't apologize or hedge with 'I don't have access'; the tool ran and this is the result.",
        );
        followUp = lines.join("\n") + "]";
      } else if (action.toolName === "read_customer_notes" && !outcome.ok) {
        followUp = `[Beacon's read_customer_notes proposal was not run — ${outcome.error}.]`;
      } else if (action.toolName === "read_customer_brain" && outcome.ok) {
        // Brain Wave 2a.1 — inline the topic-clustered Brain block so the
        // model can quote specific field values directly in its reply.
        const rich = (outcome.data ?? null) as
          | {
              entity_id?: string;
              customer_id?: string;
              bizname?: string | null;
              found?: boolean;
              facts_returned?: number;
              brain?: {
                identity: Record<string, string>;
                operational: Record<string, string>;
                behavioral: Record<string, string>;
                concerns: Record<string, string>;
                other: Array<{ subcategory: string; value: string }>;
                facts_returned: number;
                facts_dropped: number;
              } | null;
            }
          | null;
        const lines: string[] = [
          `[Beacon ran read_customer_brain → ${outcome.summary}`,
        ];
        if (rich?.brain) {
          lines.push("Brain data:");
          lines.push(JSON.stringify(rich.brain));
        }
        lines.push("");
        lines.push(
          "Now answer the user's question using the Brain facts above. The Brain is AUTHORITATIVE — prefer it over inference from raw signals. Quote field values directly (e.g. 'Sarah Chen' not 'owner_name: Sarah Chen'). If the Brain has no entry for this customer, say so plainly without hedging.",
        );
        followUp = lines.join("\n") + "]";
      } else if (action.toolName === "read_customer_brain" && !outcome.ok) {
        followUp = `[Beacon's read_customer_brain proposal was not run — ${outcome.error}.]`;
      } else if (action.toolName === "add_fact_to_brain" && outcome.ok) {
        // Brain Wave 2a.2 — success message. The data payload carries the
        // fact_id + topic + value; the model uses these to confirm to the
        // AM what was saved (or that it was already known).
        const rich = (outcome.data ?? null) as
          | {
              entity_id?: string;
              customer_id?: string;
              fact_id?: string;
              topic_category?: string;
              topic_subcategory?: string;
              field_name?: string;
              value?: string;
              version?: number;
              idempotent?: boolean;
            }
          | null;
        const lines: string[] = [
          `[Beacon ran add_fact_to_brain → ${outcome.summary}`,
        ];
        if (rich) {
          lines.push("");
          if (rich.idempotent) {
            lines.push("This fact was already in the Brain — no change made.");
          } else {
            lines.push(
              `Saved to ${rich.topic_category}/${rich.topic_subcategory}/${rich.field_name} as version ${rich.version}.`,
            );
          }
        }
        lines.push("");
        lines.push(
          "Confirm to the AM that the fact was saved (or that it was already there). Keep the response short — they just told you something, they don't need a paragraph back.",
        );
        followUp = lines.join("\n") + "]";
      } else if (action.toolName === "add_fact_to_brain" && !outcome.ok) {
        // Conflict case: the executor returns ok=false with the conflict
        // details in the error string. Pass that through so the model can
        // surface the conflict to the AM and offer the force=true option.
        followUp = `[Beacon's add_fact_to_brain proposal was not run — ${outcome.error}. Tell the AM what the conflict is and ask if they want to overwrite (resend with force=true) or save as 'other' to keep both.]`;
      } else if (
        (action.toolName === "get_chargebee_billing" ||
          action.toolName === "get_customer_performance") &&
        outcome.ok
      ) {
        // F-ai-context L3b + L3c — inline the structured payload so the model
        // can read fields like unpaid_total / current_month clicks / keyword
        // counts directly. Without this it only sees the one-line summary.
        const lines: string[] = [
          `[Beacon ran ${action.toolName} → ${outcome.summary}`,
        ];
        if (outcome.data) {
          lines.push("Result data:");
          // Use compact JSON (no indent) — the chunk-3 tools (Chargebee +
          // Performance) return ~3-8KB of structured data per call, and the
          // pretty-printed version blew past the server's char cap. The
          // model handles compact JSON fine; humans don't read this bubble.
          lines.push(JSON.stringify(outcome.data));
        }
        lines.push("");
        lines.push(
          "Now answer the user's question using this data. Quote the relevant numbers / fields directly. If a field is null or zero, say so plainly — don't apologize. Format with a short markdown table if comparing values across rows; otherwise prose.",
        );
        followUp = lines.join("\n") + "]";
      } else if (
        (action.toolName === "get_chargebee_billing" ||
          action.toolName === "get_customer_performance") &&
        !outcome.ok
      ) {
        followUp = `[Beacon's ${action.toolName} proposal was not run — ${outcome.error}.]`;
      } else {
        followUp = outcome.ok
          ? `[Beacon ran ${verb} on ${action.customerName}: ${outcome.summary}]`
          : `[Beacon's ${verb} proposal was not run — ${outcome.error}.]`;
      }
      // F-polish-AI Tier 4 — for query_customer_book, lift the synthetic
      // citations out of the tool result and pass them through to the
      // continuation request. The server merges them into the SSE
      // citationLookup frame so the model's table cells render with real
      // popovers.
      let extraCitations: Record<string, unknown> | undefined;
      if (
        action.toolName === "query_customer_book" &&
        outcome.ok &&
        outcome.data &&
        typeof outcome.data === "object" &&
        outcome.data !== null &&
        "citations" in outcome.data
      ) {
        const c = (outcome.data as { citations?: Record<string, unknown> }).citations;
        if (c && typeof c === "object") {
          extraCitations = c;
        }
      }

      // Reuse the regular ask path so memory + facts + everything stays
      // consistent. The bracketed prefix signals to Claude this is a
      // system trace, not a fresh AM question.
      await ask(followUp, extraCitations ? { extraCitations } : undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Phase E-16 Wave 2 — keep the forward ref pointed at the latest
  // resolveToolUse closure so the stream-handler auto-approve for
  // lookup_customer doesn't capture a stale reference.
  useEffect(() => {
    resolveToolUseRef.current = resolveToolUse;
  }, [resolveToolUse]);

  /**
   * Phase E-12 (E-12.3) — thumbs up/down on an assistant turn. Optimistically
   * stamps the local `feedback` flag, then POSTs to /api/ai/feedback. On
   * failure we roll the stamp back so the user can retry. Negative signals
   * eventually demote (or evict) the facts that were active when this
   * response was generated.
   */
  const sendFeedback = useCallback(
    async (index: number, signal: "up" | "down") => {
      const turn = turns[index];
      if (!turn || turn.role !== "assistant" || !turn.turnId) return;
      if (turn.feedback === signal) return; // idempotent click

      // Optimistic UI update
      setTurns((prev) => {
        const next = [...prev];
        if (next[index]) next[index] = { ...next[index], feedback: signal };
        return next;
      });

      try {
        const res = await fetch("/api/ai/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turn_id: turn.turnId, signal }),
        });
        if (!res.ok) {
          const body = await res
            .json()
            .catch(() => ({ error: res.statusText }));
          throw new Error(body.error || `feedback ${res.status}`);
        }
      } catch (e) {
        // Roll back optimistic stamp
        setTurns((prev) => {
          const next = [...prev];
          if (next[index]) next[index] = { ...next[index], feedback: null };
          return next;
        });
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    },
    [turns],
  );

  const clearConversation = useCallback(async () => {
    setTurns([]);
    setErrorMsg(null);
    invalidateCache(scope);
    // Wipe THIS scope's server history. Other scopes' memory is untouched.
    try {
      const sKey = scopeKey(scope);
      const res = await fetch(
        `/api/ai/memory?scope_key=${encodeURIComponent(sKey)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        // Refresh total — count went down.
        const totalRes = await fetch(`/api/ai/memory`, { cache: "no-store" });
        if (totalRes.ok) {
          const json = (await totalRes.json()) as { total: number };
          setTotalMemory(json.total);
        }
      }
    } catch {
      /* swallow — UI already cleared */
    }
  }, [scope]);

  if (scope.kind === "hidden") return null;

  const audience = scopeLabel(scope);
  const quickPrompts = scopeQuickPrompts(scope);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Ask Beacon AI about ${audience}`}
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 80,
            padding: "12px 18px",
            borderRadius: 999,
            background: C.char,
            color: C.parchment,
            border: `1px solid ${C.char}`,
            fontFamily: SANS,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            boxShadow: "0 12px 28px -8px rgba(43,31,20,0.45)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {/* Beacon flame mark — animated 4-layer flicker. Tower flips to
              parchment so it shows on the char button background; flame
              colors (ember + gold) stay default — they pop against char. */}
          <BeaconMark size={18} towerFill="#F0E4CC" flicker />
          Ask Beacon AI
          {turns.length > 0 && (
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 999,
                background: C.brass,
                color: C.char,
                fontWeight: 600,
              }}
            >
              {Math.ceil(turns.length / 2)}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ask Beacon AI"
          onClick={() => {
            if (!streaming) setOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: "rgba(43, 31, 20, 0.35)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(480px, 92vw)",
              height: "100vh",
              background: C.surface,
              borderLeft: `1px solid ${C.border}`,
              boxShadow: "-16px 0 40px -16px rgba(43,31,20,0.45)",
              display: "flex",
              flexDirection: "column",
              fontFamily: SANS,
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "16px 20px",
                borderBottom: `1px solid ${C.border}`,
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: SERIF,
                    fontSize: 17,
                    fontWeight: 500,
                    color: C.text,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {/* Same animated flame, default colors — char tower
                      reads well on the parchment drawer surface. */}
                  <BeaconMark size={20} flicker />
                  Ask Beacon AI
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.text3,
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 360,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span>About {audience}</span>
                  {totalMemory !== null && totalMemory > 0 && (
                    <span
                      title="Beacon AI remembers your past conversations across all surfaces. Earlier discussions are surfaced into the context on every new question."
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 999,
                        background: C.parchment,
                        border: `1px solid ${C.border}`,
                        color: C.text2,
                      }}
                    >
                      ✦ remembers {totalMemory}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <a
                  href="/settings/beacon-ai"
                  title="Beacon AI memory + facts settings"
                  style={{
                    ...ghostBtn(streaming),
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                >
                  Memory
                </a>
                {turns.length > 0 && (
                  <button
                    type="button"
                    onClick={clearConversation}
                    disabled={streaming}
                    style={ghostBtn(streaming)}
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={streaming}
                  style={ghostBtn(streaming)}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Transcript */}
            <div
              ref={transcriptRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "16px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              {turns.length === 0 && (
                <div style={{ marginTop: 4 }}>
                  {/* Phase E-12 (E-12.4) — working-style onboarding nudge.
                      Compact mode auto-detects whether the user already
                      has any source='onboarding' facts; if so, renders
                      nothing. The card only appears for first-time users. */}
                  <div style={{ marginBottom: 14 }}>
                    <StyleOnboarding compact />
                  </div>
                  <div
                    style={{
                      fontFamily: SERIF,
                      fontStyle: "italic",
                      color: C.text2,
                      fontSize: 14,
                      lineHeight: 1.6,
                      marginBottom: 14,
                    }}
                  >
                    Ask anything about {audience}. Pick a starter below or
                    type your own question.
                    {totalMemory !== null && totalMemory > 0 && (
                      <div
                        style={{
                          fontFamily: SANS,
                          fontStyle: "normal",
                          fontSize: 11,
                          color: C.text3,
                          marginTop: 8,
                          lineHeight: 1.5,
                        }}
                      >
                        Beacon AI remembers your past {totalMemory} day
                        {totalMemory === 1 ? "" : "s"} of conversations
                        across every surface and will reference them when
                        relevant.
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr",
                      gap: 6,
                    }}
                  >
                    {quickPrompts.map((q) => (
                      <button
                        key={q.label}
                        type="button"
                        onClick={() => ask(q.prompt)}
                        disabled={streaming}
                        style={{
                          textAlign: "left",
                          padding: "10px 12px",
                          border: `1px solid ${C.border}`,
                          background: C.parchment,
                          borderRadius: 10,
                          fontFamily: SANS,
                          fontSize: 12.5,
                          color: C.text,
                          cursor: streaming ? "wait" : "pointer",
                          lineHeight: 1.4,
                        }}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {turns.map((t, i) => {
                // Phase E-17 Wave 3a — parse assistant content for the
                // `<confidence:...>` marker (stripped from prose, surfaced as
                // a badge) and for `[cite:KEY]` markers (kept inline, replaced
                // with chips at render time). User turns pass through.
                const parsed =
                  t.role === "assistant"
                    ? parseAssistantContent(t.content)
                    : { text: t.content, confidence: null };
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <Bubble
                      role={t.role}
                      content={parsed.text}
                      streaming={streaming && i === turns.length - 1}
                      citationLookup={
                        t.role === "assistant" ? t.citationLookup : undefined
                      }
                      /* Phase E-12 — feedback only on assistant turns that landed
                         with a turn id (set by the SSE done frame). User turns,
                         the streaming-in-progress placeholder, and hydrated
                         historical turns don't get thumbs. */
                      turnId={t.role === "assistant" ? t.turnId : undefined}
                      feedback={t.feedback ?? null}
                      onFeedback={(signal) => sendFeedback(i, signal)}
                    />
                    {/* Phase E-17 Wave 3a — free-text confidence badge.
                        Renders below the bubble when the assistant produced
                        a `<confidence:...>` marker but no tool_use card. */}
                    {parsed.confidence &&
                      t.role === "assistant" &&
                      (t.toolUses?.length ?? 0) === 0 && (
                        <div style={{ alignSelf: "flex-start" }}>
                          <ConfidenceBadge data={parsed.confidence} variant="inline" />
                        </div>
                      )}
                    {/* Phase E-16 Wave 1 — inline ActionCards for any tool_use
                        blocks that streamed in with this assistant turn.
                        Phase E-17 Wave 3a — pipe parsed confidence into the
                        first card so the AM sees it before approving. */}
                    {t.role === "assistant" &&
                      (t.toolUses ?? []).map((u, ui) => (
                        <ActionCard
                          key={u.data.toolUseId}
                          data={u.data}
                          status={u.status}
                          resultSummary={u.resultSummary ?? null}
                          resultError={u.resultError ?? null}
                          resultData={u.resultData ?? null}
                          confidence={ui === 0 ? parsed.confidence : null}
                          onApprove={() =>
                            resolveToolUse(i, u.data.toolUseId, "approve")
                          }
                          onDiscard={() =>
                            resolveToolUse(i, u.data.toolUseId, "discard")
                          }
                        />
                      ))}
                  </div>
                );
              })}

              {errorMsg && (
                <div
                  style={{
                    border: `1px solid ${C.ember}`,
                    background: "rgba(200, 67, 29, 0.06)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 12,
                    color: C.ember,
                  }}
                >
                  {errorMsg}
                </div>
              )}
            </div>

            {/* Composer */}
            <form
              onSubmit={onSubmit}
              style={{
                padding: "12px 16px 16px",
                borderTop: `1px solid ${C.border}`,
                background: C.parchment,
              }}
            >
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                rows={2}
                placeholder={`Ask about ${audience}…  ⌘+Enter to send · /remember X to teach me`}
                disabled={streaming}
                style={{
                  width: "100%",
                  resize: "vertical",
                  minHeight: 44,
                  maxHeight: 200,
                  padding: "10px 12px",
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  background: "white",
                  fontFamily: "inherit",
                  fontSize: 13,
                  color: C.text,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 10,
                  color: C.text3,
                }}
              >
                <span>Beacon AI · grounded in {audience}</span>
                <button
                  type="submit"
                  disabled={streaming || !draft.trim()}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: `1px solid ${C.char}`,
                    background:
                      streaming || !draft.trim() ? C.border : C.char,
                    color: C.parchment,
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor:
                      streaming || !draft.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {streaming ? "Thinking…" : "Send"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function Bubble({
  role,
  content,
  streaming,
  citationLookup,
  turnId,
  feedback,
  onFeedback,
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  /**
   * Phase E-17 Wave 3a — citation lookup attached to this assistant turn.
   * Used to resolve `[cite:KEY]` markers when rendering content.
   */
  citationLookup?: CitationLookup;
  /**
   * Phase E-12 — assistant turn id. Presence enables the thumbs UI.
   * Absent on user turns, streaming-in-progress placeholder, hydrated
   * historical turns.
   */
  turnId?: number;
  feedback?: "up" | "down" | null;
  onFeedback?: (signal: "up" | "down") => void;
}) {
  const isUser = role === "user";
  // Show thumbs only on assistant turns that have a stable id and aren't
  // currently streaming. We don't want users voting on a half-formed answer.
  const showFeedback =
    !isUser && !streaming && typeof turnId === "number" && !!onFeedback;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          maxWidth: "92%",
          background: isUser ? C.char : C.parchment,
          color: isUser ? C.parchment : C.text,
          border: isUser ? `1px solid ${C.char}` : `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "10px 12px",
          fontFamily: isUser ? SANS : SERIF,
          fontSize: isUser ? 13 : 13.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {content
          ? // Phase E-17 Wave 3a — only assistant turns carry citation markers.
            // User turns rendered as plain text to preserve their literal input
            // (a user typing "[cite:foo]" shouldn't get parsed).
            isUser
            ? content
            : renderWithCitations(content, citationLookup)
          : streaming
            ? <BlinkingCursor />
            : ""}
        {streaming && content && (
          <span style={{ display: "inline-block", width: 0 }}>
            <BlinkingCursor />
          </span>
        )}
      </div>
      {showFeedback && (
        <div
          style={{
            display: "flex",
            gap: 4,
            marginTop: 4,
            marginLeft: 2,
            opacity: feedback ? 1 : 0.6,
            transition: "opacity 120ms ease",
          }}
          aria-label="Rate this response"
        >
          <ThumbButton
            label="Helpful"
            active={feedback === "up"}
            onClick={() => onFeedback!("up")}
            char="👍"
          />
          <ThumbButton
            label="Not helpful"
            active={feedback === "down"}
            onClick={() => onFeedback!("down")}
            char="👎"
          />
          {feedback && (
            <span
              style={{
                fontSize: 10,
                color: C.text3,
                alignSelf: "center",
                marginLeft: 4,
                fontStyle: "italic",
              }}
            >
              {feedback === "up"
                ? "Thanks — I'll do more of that."
                : "Noted — I'll adjust."}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ThumbButton({
  label,
  active,
  onClick,
  char,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  char: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        padding: "2px 6px",
        background: active ? "rgba(217, 164, 65, 0.18)" : "transparent",
        border: `1px solid ${active ? "rgba(217, 164, 65, 0.45)" : C.border}`,
        borderRadius: 6,
        fontSize: 11,
        lineHeight: 1,
        cursor: "pointer",
        color: C.text2,
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      {char}
    </button>
  );
}

function BlinkingCursor() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 14,
        verticalAlign: "-3px",
        marginLeft: 2,
        background: "currentColor",
        opacity: 0.6,
        animation: "blink 1s steps(1, end) infinite",
      }}
    />
  );
}

const ghostBtn = (disabled: boolean): React.CSSProperties => ({
  appearance: "none",
  padding: "4px 10px",
  borderRadius: 6,
  border: `1px solid ${C.border}`,
  background: "transparent",
  fontFamily: "inherit",
  fontSize: 11,
  color: C.text2,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 1,
});

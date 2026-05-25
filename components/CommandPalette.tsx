"use client";

/**
 * CommandPalette — Cmd+K cross-agent customer finder. Phase E-9.
 *
 * UX:
 *   - Backdrop click or Esc closes
 *   - ↑/↓ navigates results, Enter opens Customer Beacon for selected row
 *   - Tab/Shift+Tab cycles through the per-row agent buttons; Enter on a
 *     focused agent routes to that agent
 *   - Empty input shows up to 5 recent customers (localStorage)
 *
 * Data:
 *   - First open fetches /api/customers/search-index, caches in a module-
 *     level variable for 5 minutes
 *   - Subsequent opens use the cache (instant)
 *   - On Vercel deploy, the Cache-Control on the endpoint also helps
 *
 * Activity logging:
 *   - "command_palette_opened" on every open
 *   - "command_palette_select" with metadata { agent, entity_id, biz_name }
 *     when the user routes somewhere
 *
 * Routes:
 *   Customer       → /customer/{entity_id}
 *   Performance    → /performance/report/{entity_id}
 *   Escalation     → /escalation?q={bizname}  (EscalationsBrowser
 *                    has its own search input; we hand off via query)
 *   Post-Payment   → /post-payment/reports/{cb_customer_id}
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  searchCustomers,
  shortEntity,
  type SearchableCustomer,
  type ScoredMatch,
} from "@/lib/command-palette/search";
import { useActivityLogger } from "@/components/hooks/use-activity-logger";
// Phase E-14 — multi-customer compare integration. The palette can both
// assemble a selection (+ Compare button on each row) and trigger the
// /compare navigation once 2+ are selected (sticky banner at the top).
import { useCompareSelection } from "@/lib/customer/hooks/use-compare-selection";

const STORAGE_RECENTS = "beacon_palette_recents_v1";
const MAX_RECENTS = 5;
const RESULT_LIMIT = 25;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface SearchIndex {
  customers: SearchableCustomer[];
  fetched_at: number;
}

// Module-level cache. Outlives component remounts (modal open/close).
let cache: SearchIndex | null = null;
let inFlight: Promise<SearchIndex | null> | null = null;

async function fetchIndex(force: boolean = false): Promise<SearchIndex | null> {
  const fresh =
    cache && Date.now() - cache.fetched_at < CACHE_TTL_MS;
  if (fresh && !force) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch("/api/customers/search-index", {
        credentials: "include",
        cache: "no-cache",
      });
      if (!res.ok) throw new Error(`search-index ${res.status}`);
      const json = (await res.json()) as { customers: SearchableCustomer[] };
      const next: SearchIndex = {
        customers: json.customers ?? [],
        fetched_at: Date.now(),
      };
      cache = next;
      return next;
    } catch {
      return cache; // fall back to stale on error
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

type AgentRoute = "360" | "customer" | "performance" | "escalation" | "post-payment";

function buildRoute(agent: AgentRoute, c: SearchableCustomer): string {
  switch (agent) {
    case "360":
      return `/360/${c.entity_id}`;
    case "customer":
      return `/customer/${c.entity_id}`;
    case "performance":
      return `/performance/report/${c.entity_id}`;
    case "escalation":
      return `/escalation?q=${encodeURIComponent(c.biz_name)}`;
    case "post-payment":
      return `/post-payment/reports/${c.cb_customer_id}`;
  }
}

interface RecentEntry {
  entity_id: string;
  biz_name: string;
  am_name: string | null;
  cb_customer_id: string;
  email: string | null;
  ts: number;
}

function readRecents(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_RECENTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function writeRecent(c: SearchableCustomer) {
  if (typeof window === "undefined") return;
  try {
    const list = readRecents().filter((r) => r.entity_id !== c.entity_id);
    list.unshift({
      entity_id: c.entity_id,
      biz_name: c.biz_name,
      am_name: c.am_name,
      cb_customer_id: c.cb_customer_id,
      email: c.email,
      ts: Date.now(),
    });
    window.localStorage.setItem(
      STORAGE_RECENTS,
      JSON.stringify(list.slice(0, MAX_RECENTS)),
    );
  } catch {
    /* ignore quota */
  }
}

const AGENT_LABEL: Record<AgentRoute, string> = {
  "360": "360",
  customer: "Customer",
  performance: "Performance",
  escalation: "Escalation",
  "post-payment": "Post-Pay",
};

const AGENT_ACCENT: Record<AgentRoute, string> = {
  "360": "#2A4D5C", // Sea Lapis — distinct from any individual agent
  customer: "#C8431D", // Ember
  performance: "#D9A441", // Brass
  escalation: "#7C2D12", // Deep Crimson
  "post-payment": "#4A7C59", // Patina
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  // Phase E-14 — wire the global compare-selection store. We're inside the
  // palette, which any role can open, but the /compare destination itself
  // gates by manager/admin role; non-eligible viewers will get redirected.
  const compare = useCompareSelection();
  const inputRef = useRef<HTMLInputElement>(null);
  const log = useActivityLogger("umbrella");

  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<SearchableCustomer[]>(
    () => cache?.customers ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recents, setRecents] = useState<RecentEntry[]>([]);

  // On open: focus input, load index if cache stale, refresh recents.
  useEffect(() => {
    if (!open) return;
    log("command_palette_opened", { surface: "launcher" });
    setQuery("");
    setSelectedIndex(0);
    setRecents(readRecents());
    setError(null);

    // Focus the input on next frame so the modal has mounted.
    requestAnimationFrame(() => inputRef.current?.focus());

    // Load (or refresh stale) index.
    const needFresh = !cache || Date.now() - cache.fetched_at >= CACHE_TTL_MS;
    if (needFresh) {
      setLoading(true);
      fetchIndex().then((idx) => {
        if (idx) setCustomers(idx.customers);
        else setError("Couldn't load customer index. Try again in a moment.");
        setLoading(false);
      });
    } else if (cache) {
      setCustomers(cache.customers);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Build the result rows. Empty query → recents; otherwise → fuzzy matches.
  const results: Array<{ customer: SearchableCustomer; score: number; recent: boolean }> = useMemo(() => {
    if (!query.trim()) {
      // Project recents onto SearchableCustomer for uniform row rendering.
      return recents.map((r) => ({
        customer: {
          entity_id: r.entity_id,
          biz_name: r.biz_name,
          am_name: r.am_name,
          cb_customer_id: r.cb_customer_id,
          email: r.email,
        },
        score: 0,
        recent: true,
      }));
    }
    const scored: ScoredMatch[] = searchCustomers(customers, query, RESULT_LIMIT);
    return scored.map((s) => ({ ...s, recent: false }));
  }, [query, customers, recents]);

  // Reset cursor when results change so we always start at the top.
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  const goTo = useCallback(
    (agent: AgentRoute, customer: SearchableCustomer) => {
      writeRecent(customer);
      log("command_palette_select", {
        surface: "launcher",
        entity_id: customer.entity_id,
        metadata: {
          agent,
          biz_name: customer.biz_name,
          cb_customer_id: customer.cb_customer_id,
        },
      });
      onClose();
      router.push(buildRoute(agent, customer));
    },
    [log, onClose, router],
  );

  // Global key handler while open: arrows, Enter, Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = results[selectedIndex];
        if (row) goTo("360", row.customer);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, selectedIndex, goTo, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Command palette"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(43, 31, 20, 0.55)", // Char @ 55%
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, calc(100vw - 32px))",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "#F8EFD7", // Parchment-light
          border: "1px solid #D4C29B",
          borderRadius: 14,
          boxShadow: "0 24px 60px -20px rgba(43,31,20,0.55), 0 8px 20px -8px rgba(43,31,20,0.35)",
          overflow: "hidden",
          fontFamily: "-apple-system, Inter, system-ui, sans-serif",
        }}
      >
        {/* Input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: "1px solid #D4C29B",
          }}
        >
          <span aria-hidden style={{ fontSize: 16, opacity: 0.6 }}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customers by name, AM, entity ID, or email…"
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 15,
              fontFamily: "inherit",
              color: "#2B1F14",
            }}
          />
          {loading && (
            <span style={{ fontSize: 11, color: "#8B7A66" }}>loading…</span>
          )}
          <kbd
            style={{
              fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
              fontSize: 11,
              padding: "2px 6px",
              border: "1px solid #D4C29B",
              borderRadius: 4,
              color: "#6E5F50",
              background: "#F0E4CC",
            }}
          >
            Esc
          </kbd>
        </div>

        {/* Phase E-14 — "Compare N selected" prompt at the top of the
            palette whenever the user has 2+ customers in the compare store.
            Provides a keyboard-accessible launch point for the comparison
            view without forcing the user back to the dashboard. */}
        {compare.count >= 2 && (
          <button
            type="button"
            onClick={() => {
              const q = encodeURIComponent(compare.selected.join(","));
              log("command_palette_compare", {
                surface: "launcher",
                metadata: { count: compare.count },
              });
              onClose();
              router.push(`/compare?entities=${q}`);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              padding: "10px 16px",
              background: "rgba(42, 77, 92, 0.10)",
              border: "none",
              borderBottom: "1px solid #D4C29B",
              cursor: "pointer",
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 13,
              color: "#2A4D5C",
              fontWeight: 600,
              textAlign: "left",
            }}
          >
            <span>
              Compare {compare.count} selected customer
              {compare.count === 1 ? "" : "s"} →
            </span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>
              {compare.count} / {compare.max}
            </span>
          </button>
        )}

        {/* Results / states */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {error && (
            <div style={{ padding: 20, fontSize: 13, color: "#7C2D12" }}>{error}</div>
          )}

          {!error && results.length === 0 && (
            <div
              style={{
                padding: "32px 20px",
                fontSize: 13,
                color: "#8B7A66",
                textAlign: "center",
                lineHeight: 1.6,
              }}
            >
              {query.trim()
                ? "No customers match. Try a different name or paste an entity ID."
                : "Type to search. Recently opened customers will appear here once you start using the palette."}
            </div>
          )}

          {!error && results.length > 0 && (
            <>
              {query.trim() === "" && recents.length > 0 && (
                <div
                  style={{
                    padding: "10px 16px 4px",
                    fontSize: 10,
                    letterSpacing: "0.12em",
                    color: "#8B7A66",
                    textTransform: "uppercase",
                  }}
                >
                  Recent customers
                </div>
              )}

              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {results.map((row, i) => {
                  const isSelected = i === selectedIndex;
                  return (
                    <li
                      key={row.customer.entity_id}
                      onMouseEnter={() => setSelectedIndex(i)}
                      onClick={() => goTo("360", row.customer)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 16px",
                        cursor: "pointer",
                        background: isSelected ? "rgba(217,164,65,0.15)" : "transparent",
                        borderLeft: isSelected
                          ? "3px solid #D9A441"
                          : "3px solid transparent",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: 'Georgia, "Times New Roman", serif',
                            fontSize: 15,
                            color: "#2B1F14",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={row.customer.biz_name}
                        >
                          {row.customer.biz_name}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6E5F50",
                            marginTop: 2,
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          {row.customer.am_name && <span>{row.customer.am_name}</span>}
                          {row.customer.am_name && <span aria-hidden>·</span>}
                          <span style={{ fontFamily: "ui-monospace, monospace" }}>
                            {shortEntity(row.customer.entity_id)}
                          </span>
                        </div>
                      </div>

                      {/* Per-agent quick-jump buttons. Click stops propagation
                          so the row's default-to-Customer onClick doesn't fire. */}
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        {/* Phase E-14 — compare-toggle button. Adds the customer
                            to the global compare selection (or removes it if
                            already present). Doesn't navigate — lets the user
                            assemble a selection by clicking through results. */}
                        {(() => {
                          const checked = compare.has(row.customer.entity_id);
                          const disabled = !checked && compare.isFull;
                          return (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (disabled) return;
                                compare.toggle(row.customer.entity_id);
                              }}
                              title={
                                disabled
                                  ? `At cap (${compare.max}). Uncheck another customer first.`
                                  : checked
                                    ? "Remove from comparison"
                                    : "Add to comparison"
                              }
                              disabled={disabled}
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: "0.04em",
                                padding: "4px 8px",
                                borderRadius: 6,
                                border: `1px solid ${checked ? "#2A4D5C" : "#2A4D5C40"}`,
                                background: checked ? "rgba(42, 77, 92, 0.16)" : "transparent",
                                color: "#2A4D5C",
                                cursor: disabled ? "not-allowed" : "pointer",
                                opacity: disabled ? 0.4 : 1,
                                fontFamily: "inherit",
                              }}
                            >
                              {checked ? "✓ Compare" : "+ Compare"}
                            </button>
                          );
                        })()}
                        {(["360", "customer", "performance", "escalation", "post-payment"] as AgentRoute[]).map(
                          (agent) => (
                            <button
                              key={agent}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                goTo(agent, row.customer);
                              }}
                              title={`Open in ${AGENT_LABEL[agent]} Beacon`}
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: "0.04em",
                                padding: "4px 8px",
                                borderRadius: 6,
                                border: `1px solid ${AGENT_ACCENT[agent]}40`,
                                background: "transparent",
                                color: AGENT_ACCENT[agent],
                                cursor: "pointer",
                                fontFamily: "inherit",
                              }}
                            >
                              {AGENT_LABEL[agent]}
                            </button>
                          ),
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* Footer hints */}
        <div
          style={{
            borderTop: "1px solid #D4C29B",
            padding: "8px 16px",
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            color: "#8B7A66",
            background: "#F0E4CC",
          }}
        >
          <div style={{ display: "flex", gap: 12 }}>
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>⏎</kbd> open Customer 360</span>
            <span>or click an agent badge</span>
          </div>
          <span>{customers.length.toLocaleString()} customers</span>
        </div>
      </div>
    </div>
  );
}

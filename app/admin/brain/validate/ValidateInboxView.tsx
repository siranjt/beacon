"use client";

/**
 * Keeper Validate inbox — client view component.
 *
 * Renders candidate facts grouped by AM → Customer, with the four
 * triage actions per row (Confirm / Edit+Confirm / Reclassify / Reject).
 * Category filter chips trim the queue; collapsible AM sections let
 * users focus; keyboard shortcuts (J/K/C/R/E/X) speed the triage pass.
 *
 * Optimistic UI: on a successful POST, the row disappears immediately
 * and the keyboard focus advances to the next row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FIELD_CATALOG } from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";
// WAVE-A-3 — canonical Keeper chip on every inbox row. Confidence keys to
// the candidate vs confirmed state (candidate = low, confirmed = moderate)
// so triage state reads at a glance through the chip tint alone.
import KeeperChip, {
  type KeeperChipConfidence,
} from "@/components/keeper/KeeperChip";

type Role = "admin" | "manager" | "am";

interface CandidateRow {
  fact_id: string;
  customer_id: string;
  entity_id: string | null;
  bizname: string | null;
  am_name_resolved: string | null;
  topic_category: TopicCategory;
  topic_subcategory: TopicSubcategory;
  field_name: string;
  value: string;
  source_type: string;
  source_quote: string | null;
  owning_am_email: string | null;
  created_at: string;
  /**
   * WAVE-A-2 — true when this row has a superseded ancestor that can be
   * rolled back via POST /api/admin/keeper/revert. Only true on confirmed
   * facts surfaced in the inbox (typically needs_parent_review rows).
   */
  can_revert?: boolean;
  /** Echo of the underlying confidence_state so we can branch the Revert UI. */
  confidence_state?: "candidate" | "confirmed";
}

interface Props {
  role: Role;
  userEmail: string;
}

const ALL_CATEGORIES: TopicCategory[] = [
  "identity",
  "operational",
  "behavioral",
  "concerns",
  "relationship",
];

/* ────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────── */

function subcategoriesForCategory(cat: TopicCategory): TopicSubcategory[] {
  return (Object.keys(FIELD_CATALOG) as TopicSubcategory[]).filter(
    (s) => FIELD_CATALOG[s].category === cat,
  );
}

function fieldsForSubcategory(sub: TopicSubcategory): readonly string[] {
  return FIELD_CATALOG[sub].named_fields;
}

function formatFieldLabel(field: string): string {
  return field
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ────────────────────────────────────────────────────────────────────
 * Component
 * ──────────────────────────────────────────────────────────────────── */

export default function ValidateInboxView({ role, userEmail }: Props) {
  void userEmail; // reserved for future use

  const isManagerOrAdmin = role === "manager" || role === "admin";

  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyFactId, setBusyFactId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Inline editors keyed by fact_id.
  const [editingValue, setEditingValue] = useState<Record<string, string>>({});
  const [reclassifying, setReclassifying] = useState<
    Record<
      string,
      {
        topic_category: TopicCategory;
        topic_subcategory: TopicSubcategory;
        field_name: string;
      }
    >
  >({});

  // WAVE-A-2 — keyed by fact_id. Open => confirm UI rendered; reason held
  // here too so it survives Cancel/reopen within the same session view.
  const [revertingState, setRevertingState] = useState<
    Record<string, { reason: string; busy: boolean; error: string | null }>
  >({});

  // Manager-only toggle: see only my candidates (treat like AM).
  const [mineOnly, setMineOnly] = useState(false);

  // Category filter ('all' shows everything).
  const [categoryFilter, setCategoryFilter] = useState<TopicCategory | "all">("all");

  // Collapsed AM sections (default: all expanded).
  const [collapsedAms, setCollapsedAms] = useState<Set<string>>(new Set());

  // Active row for keyboard navigation. Null = no row focused yet.
  const [activeFactId, setActiveFactId] = useState<string | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = mineOnly ? "?mine=1" : "";
      const res = await fetch(`/api/v2/brain/validate${qs}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "fetch failed");
      setRows(json.rows as CandidateRow[]);
      setTotal(json.total as number);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [mineOnly]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  // Category counts derived from ALL rows (not filtered), so the chip
  // numbers reflect the full queue regardless of current filter.
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: rows.length,
      identity: 0,
      operational: 0,
      behavioral: 0,
      concerns: 0,
      relationship: 0,
    };
    for (const r of rows) counts[r.topic_category]++;
    return counts;
  }, [rows]);

  // Filtered rows respect the category chip.
  const filteredRows = useMemo(() => {
    if (categoryFilter === "all") return rows;
    return rows.filter((r) => r.topic_category === categoryFilter);
  }, [rows, categoryFilter]);

  // Two-level grouping: AM name → bizname → candidates.
  // Empty-bizname rows land under "(no bizname)".
  const groupedByAmThenCustomer = useMemo(() => {
    const out: Record<string, Record<string, CandidateRow[]>> = {};
    for (const r of filteredRows) {
      const am = r.am_name_resolved || "Unassigned";
      const biz = r.bizname || "(no bizname)";
      if (!out[am]) out[am] = {};
      if (!out[am][biz]) out[am][biz] = [];
      out[am][biz].push(r);
    }
    return out;
  }, [filteredRows]);

  const orderedAmNames = useMemo(
    () => Object.keys(groupedByAmThenCustomer).sort((a, b) => a.localeCompare(b)),
    [groupedByAmThenCustomer],
  );

  // Flat ordered list of fact_ids matching the current grouping +
  // collapse state. Used for J/K keyboard navigation.
  const flatFactIds = useMemo(() => {
    const ids: string[] = [];
    for (const am of orderedAmNames) {
      if (collapsedAms.has(am)) continue;
      const biznames = Object.keys(groupedByAmThenCustomer[am]).sort((a, b) =>
        a.localeCompare(b),
      );
      for (const biz of biznames) {
        for (const r of groupedByAmThenCustomer[am][biz]) {
          ids.push(r.fact_id);
        }
      }
    }
    return ids;
  }, [orderedAmNames, groupedByAmThenCustomer, collapsedAms]);

  /* ────── action handlers ────── */

  const callAction = useCallback(
    async (
      factId: string,
      body: Record<string, unknown>,
    ): Promise<{ ok: boolean; error?: string }> => {
      setBusyFactId(factId);
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[factId];
        return next;
      });
      try {
        const res = await fetch(
          `/api/v2/brain/validate/${encodeURIComponent(factId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const json = await res.json();
        if (!json.ok) {
          setRowErrors((prev) => ({ ...prev, [factId]: json.error || "failed" }));
          return { ok: false, error: json.error || "failed" };
        }
        // Drop the row from local state.
        setRows((prev) => prev.filter((r) => r.fact_id !== factId));
        setTotal((t) => Math.max(0, t - 1));
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRowErrors((prev) => ({ ...prev, [factId]: msg }));
        return { ok: false, error: msg };
      } finally {
        setBusyFactId(null);
      }
    },
    [],
  );

  const onConfirm = (fact_id: string) => void callAction(fact_id, { action: "confirm" });

  const onReject = (fact_id: string) => void callAction(fact_id, { action: "reject" });

  const beginEdit = (row: CandidateRow) => {
    setEditingValue((prev) => ({ ...prev, [row.fact_id]: row.value }));
  };
  const cancelEdit = (fact_id: string) => {
    setEditingValue((prev) => {
      const next = { ...prev };
      delete next[fact_id];
      return next;
    });
  };
  const submitEdit = async (fact_id: string) => {
    const value = editingValue[fact_id];
    if (!value || !value.trim()) return;
    const r = await callAction(fact_id, { action: "edit_confirm", value: value.trim() });
    if (r.ok) cancelEdit(fact_id);
  };

  const beginReclassify = (row: CandidateRow) => {
    setReclassifying((prev) => ({
      ...prev,
      [row.fact_id]: {
        topic_category: row.topic_category,
        topic_subcategory: row.topic_subcategory,
        field_name: row.field_name,
      },
    }));
  };
  const cancelReclassify = (fact_id: string) => {
    setReclassifying((prev) => {
      const next = { ...prev };
      delete next[fact_id];
      return next;
    });
  };
  const submitReclassify = async (fact_id: string) => {
    const t = reclassifying[fact_id];
    if (!t) return;
    const r = await callAction(fact_id, {
      action: "reclassify",
      topic_category: t.topic_category,
      topic_subcategory: t.topic_subcategory,
      field_name: t.field_name,
    });
    if (r.ok) cancelReclassify(fact_id);
  };

  const updateReclassifyCategory = (fact_id: string, cat: TopicCategory) => {
    const firstSub = subcategoriesForCategory(cat)[0];
    setReclassifying((prev) => ({
      ...prev,
      [fact_id]: {
        topic_category: cat,
        topic_subcategory: firstSub,
        field_name: "other",
      },
    }));
  };
  const updateReclassifySub = (fact_id: string, sub: TopicSubcategory) => {
    setReclassifying((prev) => ({
      ...prev,
      [fact_id]: {
        topic_category: FIELD_CATALOG[sub].category,
        topic_subcategory: sub,
        field_name: "other",
      },
    }));
  };
  const updateReclassifyField = (fact_id: string, field: string) => {
    setReclassifying((prev) => ({
      ...prev,
      [fact_id]: { ...prev[fact_id], field_name: field },
    }));
  };

  /* ────── WAVE-A-2 revert handlers ────── */

  // Open / close the confirm UI for a row. The reason and busy/error state
  // live on the same object so they don't get wiped on accidental rerenders.
  const beginRevert = (fact_id: string) => {
    setRevertingState((prev) => ({
      ...prev,
      [fact_id]: { reason: "", busy: false, error: null },
    }));
  };
  const cancelRevert = (fact_id: string) => {
    setRevertingState((prev) => {
      const next = { ...prev };
      delete next[fact_id];
      return next;
    });
  };
  const setRevertReason = (fact_id: string, reason: string) => {
    setRevertingState((prev) => ({
      ...prev,
      [fact_id]: { ...(prev[fact_id] ?? { busy: false, error: null }), reason },
    }));
  };

  // POST /api/admin/keeper/revert. On success, the row drops from the
  // inbox (because the fact has changed its superseded_by chain and the
  // page refetches) and we advance keyboard focus same as the other actions.
  const submitRevert = useCallback(
    async (fact_id: string) => {
      const state = revertingState[fact_id];
      if (!state) return;
      setRevertingState((prev) => ({
        ...prev,
        [fact_id]: { ...state, busy: true, error: null },
      }));
      try {
        const res = await fetch("/api/admin/keeper/revert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            factId: fact_id,
            reason: state.reason.trim() || undefined,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          message?: string;
        };
        if (!res.ok || !json.ok) {
          setRevertingState((prev) => ({
            ...prev,
            [fact_id]: {
              ...state,
              busy: false,
              error: json.message || json.error || `revert failed (${res.status})`,
            },
          }));
          return;
        }
        // Success — refetch so the inbox reflects the cluster swap, and
        // clear any local UI state for this fact_id.
        setRevertingState((prev) => {
          const next = { ...prev };
          delete next[fact_id];
          return next;
        });
        await fetchRows();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRevertingState((prev) => ({
          ...prev,
          [fact_id]: { ...state, busy: false, error: msg },
        }));
      }
    },
    [revertingState, fetchRows],
  );

  /* ────── keyboard nav ────── */

  // Pick the next/prev fact_id relative to activeFactId in flatFactIds.
  // Wraps around at the boundaries.
  const moveActive = useCallback(
    (delta: 1 | -1) => {
      if (flatFactIds.length === 0) return;
      let next: string;
      if (!activeFactId || !flatFactIds.includes(activeFactId)) {
        next = delta === 1 ? flatFactIds[0] : flatFactIds[flatFactIds.length - 1];
      } else {
        const idx = flatFactIds.indexOf(activeFactId);
        const nextIdx = (idx + delta + flatFactIds.length) % flatFactIds.length;
        next = flatFactIds[nextIdx];
      }
      setActiveFactId(next);
    },
    [flatFactIds, activeFactId],
  );

  // When a row is acted on and removed, advance to the next row.
  // Wired via wrapping callAction.
  const callActionAndAdvance = useCallback(
    async (factId: string, body: Record<string, unknown>) => {
      const wasActive = activeFactId === factId;
      const idxBefore = flatFactIds.indexOf(factId);
      const result = await callAction(factId, body);
      if (result.ok && wasActive) {
        // After deletion, the remaining list shifts; pick whatever now
        // sits at the same index, or the previous one if we were at the end.
        const remaining = flatFactIds.filter((id) => id !== factId);
        if (remaining.length === 0) {
          setActiveFactId(null);
        } else {
          const nextIdx = Math.min(idxBefore, remaining.length - 1);
          setActiveFactId(remaining[nextIdx]);
        }
      }
      return result;
    },
    [activeFactId, flatFactIds, callAction],
  );

  // Active row scroll-into-view when activeFactId changes.
  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeFactId]);

  // Global keydown listener. Bails if user is typing in any input/textarea
  // or currently editing/reclassifying a row (so the user can type values
  // without triggering shortcuts).
  useEffect(() => {
    function isTextInputFocused() {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (el as HTMLElement).isContentEditable
      );
    }

    function onKey(e: KeyboardEvent) {
      if (isTextInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j") {
        e.preventDefault();
        moveActive(1);
      } else if (k === "k") {
        e.preventDefault();
        moveActive(-1);
      } else if (k === "c" && activeFactId) {
        e.preventDefault();
        void callActionAndAdvance(activeFactId, { action: "confirm" });
      } else if (k === "r" && activeFactId) {
        e.preventDefault();
        void callActionAndAdvance(activeFactId, { action: "reject" });
      } else if (k === "e" && activeFactId) {
        e.preventDefault();
        const row = rows.find((r) => r.fact_id === activeFactId);
        if (row) beginEdit(row);
      } else if (k === "x" && activeFactId) {
        e.preventDefault();
        const row = rows.find((r) => r.fact_id === activeFactId);
        if (row) beginReclassify(row);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveActive, callActionAndAdvance, activeFactId, rows]);

  /* ────── render ────── */

  const toggleAm = (amName: string) => {
    setCollapsedAms((prev) => {
      const next = new Set(prev);
      if (next.has(amName)) next.delete(amName);
      else next.add(amName);
      return next;
    });
  };

  return (
    <div className="px-6 pb-10 max-w-[1200px] mx-auto">
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-[26px] font-medium text-zoca-text tracking-tight" style={{ fontFamily: "Georgia, serif" }}>
            Keeper validate inbox
          </h1>
          <p className="mt-1 text-[13px] text-zoca-text-2">
            {loading
              ? "Loading…"
              : total === 0
                ? "Inbox is clear. New extractions land here for triage."
                : `${total} candidate fact${total === 1 ? "" : "s"} awaiting review${mineOnly ? " (mine)" : ""}${categoryFilter !== "all" ? ` · filtered to ${categoryFilter}` : ""}.`}
          </p>
        </div>
        <div className="flex gap-2">
          {isManagerOrAdmin && (
            <button
              type="button"
              onClick={() => setMineOnly((v) => !v)}
              className={`px-3 py-1.5 text-[12px] rounded-md border ${
                mineOnly
                  ? "bg-zoca-char text-zoca-parchment border-zoca-char"
                  : "bg-transparent text-zoca-text border-zoca-border"
              }`}
              title="Toggle 'only mine' filter"
            >
              {mineOnly ? "Showing mine" : "Show only mine"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void fetchRows()}
            className="px-3 py-1.5 text-[12px] rounded-md border border-zoca-border bg-transparent text-zoca-text"
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Category filter chips */}
      {!loading && rows.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {(["all", ...ALL_CATEGORIES] as const).map((cat) => {
            const count = categoryCounts[cat];
            const isActive = categoryFilter === cat;
            const label = cat === "all" ? "All" : cat[0].toUpperCase() + cat.slice(1);
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                disabled={count === 0 && cat !== "all"}
                className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors ${
                  isActive
                    ? "bg-zoca-char text-zoca-parchment border-zoca-char"
                    : "bg-transparent text-zoca-text border-zoca-border hover:border-zoca-text-2"
                } ${count === 0 && cat !== "all" ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {label} <span className="opacity-70 ml-0.5">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      {!loading && rows.length > 0 && (
        <div className="mb-4 text-[10px] text-zoca-text-2/70 font-mono">
          <kbd className="px-1 border border-zoca-border rounded">J</kbd> / <kbd className="px-1 border border-zoca-border rounded">K</kbd> navigate
          {" · "}
          <kbd className="px-1 border border-zoca-border rounded">C</kbd> confirm
          {" · "}
          <kbd className="px-1 border border-zoca-border rounded">E</kbd> edit
          {" · "}
          <kbd className="px-1 border border-zoca-border rounded">X</kbd> reclassify
          {" · "}
          <kbd className="px-1 border border-zoca-border rounded">R</kbd> reject
        </div>
      )}

      {error && (
        <section className="rounded-zoca-lg border border-red-200 bg-red-50 p-4 mb-5 text-[13px] text-red-800">
          {error}
        </section>
      )}

      {!loading && !error && rows.length === 0 && (
        <section className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-8 text-center">
          <div className="text-[14px] text-zoca-text">No candidates to review.</div>
          <div className="mt-2 text-[12px] text-zoca-text-2">
            The daily extraction runs at 03:30 UTC. When AMs write or update notes, new candidates land here for review.
          </div>
        </section>
      )}

      {!loading && !error && filteredRows.length === 0 && rows.length > 0 && (
        <section className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-6 text-center">
          <div className="text-[13px] text-zoca-text">No candidates in {categoryFilter}.</div>
          <button
            type="button"
            onClick={() => setCategoryFilter("all")}
            className="mt-2 text-[11px] underline text-zoca-text-2"
          >
            Clear filter
          </button>
        </section>
      )}

      {orderedAmNames.map((amName) => {
        const isCollapsed = collapsedAms.has(amName);
        const customers = groupedByAmThenCustomer[amName];
        const totalForAm = Object.values(customers).reduce(
          (acc, arr) => acc + arr.length,
          0,
        );
        const orderedBiznames = Object.keys(customers).sort((a, b) => a.localeCompare(b));

        return (
          <section
            key={amName}
            className="mb-6 rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft"
          >
            <button
              type="button"
              onClick={() => toggleAm(amName)}
              className="w-full flex items-baseline justify-between px-4 py-3 border-b border-zoca-border hover:bg-zoca-border/10 text-left"
            >
              <h2 className="text-[14px] font-semibold uppercase tracking-wider text-zoca-text-2 flex items-center gap-2">
                <span className="text-zoca-text-2/60 text-[10px]">
                  {isCollapsed ? "▸" : "▾"}
                </span>
                {amName}
              </h2>
              <span className="text-[11px] text-zoca-text-2">
                {totalForAm} candidate{totalForAm === 1 ? "" : "s"} across {orderedBiznames.length} customer{orderedBiznames.length === 1 ? "" : "s"}
              </span>
            </button>

            {!isCollapsed && orderedBiznames.map((biz) => {
              const customerRows = customers[biz];
              const firstRow = customerRows[0];
              const entityId = firstRow?.entity_id ?? null;
              return (
                <div key={biz} className="border-b border-zoca-border/40 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3 px-4 py-2 bg-zoca-bg-soft/50">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium text-[13px] text-zoca-text">{biz}</span>
                      <span className="text-[10px] text-zoca-text-2/70">
                        {customerRows.length} candidate{customerRows.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {entityId && (
                      <a
                        href={`/360/${entityId}`}
                        className="text-[10px] text-zoca-text-2 hover:text-zoca-text underline"
                        title="Open Customer 360"
                      >
                        open 360
                      </a>
                    )}
                  </div>

          <div className="divide-y divide-zoca-border/40">
            {customerRows.map((row) => {
              const isBusy = busyFactId === row.fact_id;
              const rowErr = rowErrors[row.fact_id];
              const isEditing = row.fact_id in editingValue;
              const isReclassifying = row.fact_id in reclassifying;
              const isActive = activeFactId === row.fact_id;

              return (
                <div
                  key={row.fact_id}
                  ref={isActive ? activeRowRef : null}
                  onClick={() => setActiveFactId(row.fact_id)}
                  className={`p-4 transition-colors cursor-pointer ${
                    isActive ? "bg-zoca-brass/10 ring-1 ring-zoca-brass/40" : ""
                  }`}
                >
                  {/* Header row: bizname + classification */}
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium text-[14px] text-zoca-text">
                        {row.bizname || "(no bizname)"}
                      </span>
                      {/* WAVE-A-3 — Keeper chip carries the brand kernel on
                          every triage row. Topic is the most specific token
                          we know (field_name), confidence tracks the row's
                          triage state: candidate rows sit at "low" (waiting
                          for human confirm), confirmed rows already promoted
                          land at "moderate". */}
                      <KeeperChip
                        topic={formatFieldLabel(row.field_name).toLowerCase()}
                        confidence={
                          row.confidence_state === "confirmed"
                            ? ("moderate" as KeeperChipConfidence)
                            : ("low" as KeeperChipConfidence)
                        }
                      />
                      <span className="text-[10px] uppercase tracking-wider text-zoca-text-2/70 font-mono">
                        {row.topic_category} / {row.topic_subcategory}
                      </span>
                    </div>
                    {row.entity_id && (
                      <a
                        href={`/360/${row.entity_id}`}
                        className="text-[10px] text-zoca-text-2 hover:text-zoca-text underline"
                        title="Open Customer 360"
                      >
                        open 360
                      </a>
                    )}
                  </div>

                  {/* Value row */}
                  <div className="mt-2">
                    {isEditing ? (
                      <textarea
                        value={editingValue[row.fact_id]}
                        onChange={(e) =>
                          setEditingValue((prev) => ({
                            ...prev,
                            [row.fact_id]: e.target.value,
                          }))
                        }
                        className="w-full min-h-[60px] p-2 text-[13px] border border-zoca-border rounded-md bg-white text-zoca-text resize-y"
                        autoFocus
                      />
                    ) : (
                      <div className="text-[13px] text-zoca-text leading-relaxed whitespace-pre-wrap">
                        {row.value}
                      </div>
                    )}
                  </div>

                  {/* Source quote */}
                  {row.source_quote && (
                    <div className="mt-2 text-[11px] italic text-zoca-text-2 border-l-2 border-zoca-border pl-2">
                      &ldquo;{row.source_quote}&rdquo;
                    </div>
                  )}

                  {/* Reclassify editor */}
                  {isReclassifying && (
                    <div className="mt-2 flex flex-wrap gap-2 items-center text-[12px]">
                      <span className="text-zoca-text-2">Move to:</span>
                      <select
                        value={reclassifying[row.fact_id].topic_category}
                        onChange={(e) =>
                          updateReclassifyCategory(
                            row.fact_id,
                            e.target.value as TopicCategory,
                          )
                        }
                        className="px-2 py-1 border border-zoca-border rounded bg-white"
                      >
                        {ALL_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <select
                        value={reclassifying[row.fact_id].topic_subcategory}
                        onChange={(e) =>
                          updateReclassifySub(
                            row.fact_id,
                            e.target.value as TopicSubcategory,
                          )
                        }
                        className="px-2 py-1 border border-zoca-border rounded bg-white"
                      >
                        {subcategoriesForCategory(
                          reclassifying[row.fact_id].topic_category,
                        ).map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <select
                        value={reclassifying[row.fact_id].field_name}
                        onChange={(e) =>
                          updateReclassifyField(row.fact_id, e.target.value)
                        }
                        className="px-2 py-1 border border-zoca-border rounded bg-white"
                      >
                        {fieldsForSubcategory(
                          reclassifying[row.fact_id].topic_subcategory,
                        ).map((f) => (
                          <option key={f} value={f}>
                            {formatFieldLabel(f)}
                          </option>
                        ))}
                        <option value="other">Other</option>
                      </select>
                    </div>
                  )}

                  {/* Row error */}
                  {rowErr && (
                    <div className="mt-2 text-[11px] text-red-700">{rowErr}</div>
                  )}

                  {/* Actions */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void submitEdit(row.fact_id)}
                          disabled={isBusy || !editingValue[row.fact_id].trim()}
                          className="px-3 py-1 text-[11px] font-medium rounded-md bg-zoca-char text-zoca-parchment border border-zoca-char disabled:opacity-50"
                        >
                          Save + confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => cancelEdit(row.fact_id)}
                          disabled={isBusy}
                          className="px-3 py-1 text-[11px] rounded-md border border-zoca-border bg-transparent text-zoca-text"
                        >
                          Cancel
                        </button>
                      </>
                    ) : isReclassifying ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void submitReclassify(row.fact_id)}
                          disabled={isBusy}
                          className="px-3 py-1 text-[11px] font-medium rounded-md bg-zoca-char text-zoca-parchment border border-zoca-char disabled:opacity-50"
                        >
                          Apply reclassify
                        </button>
                        <button
                          type="button"
                          onClick={() => cancelReclassify(row.fact_id)}
                          disabled={isBusy}
                          className="px-3 py-1 text-[11px] rounded-md border border-zoca-border bg-transparent text-zoca-text"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onConfirm(row.fact_id)}
                          disabled={isBusy}
                          className="px-3 py-1 text-[11px] font-medium rounded-md bg-zoca-patina text-white border border-zoca-patina disabled:opacity-50"
                        >
                          ✓ Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => beginEdit(row)}
                          disabled={isBusy}
                          className="px-3 py-1 text-[11px] rounded-md border border-zoca-border bg-transparent text-zoca-text"
                        >
                          Edit + confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => beginReclassify(row)}
                          disabled={isBusy}
                          className="px-3 py-1 text-[11px] rounded-md border border-zoca-border bg-transparent text-zoca-text"
                        >
                          Reclassify
                        </button>
                        <button
                          type="button"
                          onClick={() => onReject(row.fact_id)}
                          disabled={isBusy}
                          className="px-3 py-1 text-[11px] rounded-md border border-zoca-ember/40 text-zoca-ember bg-transparent disabled:opacity-50"
                        >
                          ✗ Reject
                        </button>
                        {/* WAVE-A-2 — Revert action surfaces only on confirmed
                            rows where the API marked can_revert=true. These
                            are the `needs_parent_review` rows whose parent
                            got demoted in a supersession; flipping them back
                            restores the prior authoritative fact. */}
                        {row.can_revert && (
                          <button
                            type="button"
                            onClick={() => beginRevert(row.fact_id)}
                            disabled={isBusy || row.fact_id in revertingState}
                            className="px-3 py-1 text-[11px] rounded-md border border-zoca-brass/50 bg-zoca-amber-soft/30 text-zoca-char hover:bg-zoca-amber-soft/60 disabled:opacity-50"
                            title="Roll back to the previously-superseded ancestor"
                          >
                            ↺ Revert
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {/* WAVE-A-2 — inline revert confirm panel. Mirrors the
                      reclassify editor's visual treatment so it slots in
                      next to the existing triage UIs without surprise. */}
                  {row.fact_id in revertingState && (
                    <div className="mt-3 rounded-md border border-zoca-brass/40 bg-zoca-amber-soft/20 p-2">
                      <div className="text-[11px] text-zoca-char">
                        Roll this fact back to the version that was superseded? Optional reason for the audit log:
                      </div>
                      <input
                        type="text"
                        value={revertingState[row.fact_id].reason}
                        onChange={(e) =>
                          setRevertReason(row.fact_id, e.target.value)
                        }
                        placeholder="e.g. extracted name was wrong"
                        maxLength={500}
                        disabled={revertingState[row.fact_id].busy}
                        className="mt-1.5 w-full px-2 py-1 text-[12px] border border-zoca-border rounded bg-white text-zoca-text"
                      />
                      {revertingState[row.fact_id].error && (
                        <div className="mt-1 text-[11px] text-red-700">
                          {revertingState[row.fact_id].error}
                        </div>
                      )}
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => void submitRevert(row.fact_id)}
                          disabled={revertingState[row.fact_id].busy}
                          className="px-3 py-1 text-[11px] font-medium rounded-md bg-zoca-char text-zoca-parchment border border-zoca-char disabled:opacity-50"
                        >
                          {revertingState[row.fact_id].busy
                            ? "Reverting…"
                            : "Confirm revert"}
                        </button>
                        <button
                          type="button"
                          onClick={() => cancelRevert(row.fact_id)}
                          disabled={revertingState[row.fact_id].busy}
                          className="px-3 py-1 text-[11px] rounded-md border border-zoca-border bg-transparent text-zoca-text"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

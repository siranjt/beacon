"use client";

/**
 * Keeper Validate inbox — client view component.
 *
 * Renders a per-AM grouped table of candidate facts. Each row exposes
 * four actions: Confirm / Edit + Confirm / Reject / Reclassify. Inline
 * editors render in-place when the user picks Edit or Reclassify.
 *
 * Optimistic UI: on a successful POST, the row is removed from the
 * local state immediately. On error, surfaces a per-row banner with
 * the server's message and re-enables the action buttons.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FIELD_CATALOG } from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";

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

  // Manager-only toggle: see only my candidates (treat like AM).
  const [mineOnly, setMineOnly] = useState(false);

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

  const grouped = useMemo(() => {
    const out: Record<string, CandidateRow[]> = {};
    for (const r of rows) {
      const key = r.am_name_resolved || "Unassigned";
      if (!out[key]) out[key] = [];
      out[key].push(r);
    }
    // Sort each AM's candidates by bizname.
    for (const key of Object.keys(out)) {
      out[key].sort((a, b) =>
        (a.bizname || "").localeCompare(b.bizname || ""),
      );
    }
    return out;
  }, [rows]);

  const orderedAmNames = useMemo(
    () => Object.keys(grouped).sort((a, b) => a.localeCompare(b)),
    [grouped],
  );

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

  /* ────── render ────── */

  return (
    <div className="px-6 pb-10 max-w-[1200px] mx-auto">
      <header className="mb-5 flex items-baseline justify-between">
        <div>
          <h1 className="text-[26px] font-medium text-zoca-text tracking-tight" style={{ fontFamily: "Georgia, serif" }}>
            Keeper validate inbox
          </h1>
          <p className="mt-1 text-[13px] text-zoca-text-2">
            {loading
              ? "Loading…"
              : total === 0
                ? "Inbox is clear. New extractions land here for triage."
                : `${total} candidate fact${total === 1 ? "" : "s"} awaiting review${mineOnly ? " (mine)" : ""}.`}
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

      {orderedAmNames.map((amName) => (
        <section
          key={amName}
          className="mb-6 rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft"
        >
          <header className="flex items-baseline justify-between px-4 py-3 border-b border-zoca-border">
            <h2 className="text-[14px] font-semibold uppercase tracking-wider text-zoca-text-2">
              {amName}
            </h2>
            <span className="text-[11px] text-zoca-text-2">
              {grouped[amName].length} candidate{grouped[amName].length === 1 ? "" : "s"}
            </span>
          </header>

          <div className="divide-y divide-zoca-border/40">
            {grouped[amName].map((row) => {
              const isBusy = busyFactId === row.fact_id;
              const rowErr = rowErrors[row.fact_id];
              const isEditing = row.fact_id in editingValue;
              const isReclassifying = row.fact_id in reclassifying;

              return (
                <div key={row.fact_id} className="p-4">
                  {/* Header row: bizname + classification */}
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium text-[14px] text-zoca-text">
                        {row.bizname || "(no bizname)"}
                      </span>
                      <span className="text-[10px] uppercase tracking-wider text-zoca-text-2/70 font-mono">
                        {row.topic_category} / {row.topic_subcategory} /{" "}
                        <span className="text-zoca-text">{formatFieldLabel(row.field_name)}</span>
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
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

"use client";

/**
 * Admin Brain search — filter form + paginated table + CSV download.
 *
 * Pulls from /api/v2/brain/search (JSON) for the table view and
 * /api/v2/brain/search/csv for downloads. Same filter shape; CSV
 * returns up to 5000 rows in one shot.
 */

import { useEffect, useMemo, useState } from "react";
import { FIELD_CATALOG } from "@/lib/brain/types";
import type {
  TopicCategory,
  TopicSubcategory,
} from "@/lib/brain/types";

type Row = {
  fact_id: string;
  customer_id: string;
  entity_id: string | null;
  bizname: string | null;
  am_name: string | null;
  topic_category: string;
  topic_subcategory: string;
  field_name: string;
  value: string;
  source_type: string;
  confirmed_at: string | null;
};

type SearchResponse = {
  ok: boolean;
  rows?: Row[];
  total?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  error?: string;
};

const ALL_CATEGORIES: TopicCategory[] = [
  "identity",
  "operational",
  "behavioral",
  "concerns",
];

const PAGE_SIZE = 50;

export default function BrainSearchView() {
  // Filter state.
  const [category, setCategory] = useState<TopicCategory | "">("");
  const [subcategory, setSubcategory] = useState<TopicSubcategory | "">("");
  const [fieldName, setFieldName] = useState<string>("");
  const [valueContains, setValueContains] = useState<string>("");

  // Results state.
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState<boolean>(false);

  // Derived: which subcategories show given the category filter?
  const availableSubcategories = useMemo(() => {
    const subs = Object.keys(FIELD_CATALOG) as TopicSubcategory[];
    if (!category) return subs;
    return subs.filter((s) => FIELD_CATALOG[s].category === category);
  }, [category]);

  // Derived: which named fields show given the subcategory filter?
  const availableFieldNames = useMemo(() => {
    if (!subcategory) return [];
    return [...FIELD_CATALOG[subcategory].named_fields, "other"];
  }, [subcategory]);

  // Reset subcategory if it falls out of the category filter.
  useEffect(() => {
    if (subcategory && category) {
      if (FIELD_CATALOG[subcategory].category !== category) {
        setSubcategory("");
        setFieldName("");
      }
    }
  }, [category, subcategory]);
  // Reset field if subcategory changes and field is no longer valid.
  useEffect(() => {
    if (fieldName && subcategory) {
      const valid =
        fieldName === "other" ||
        FIELD_CATALOG[subcategory].named_fields.includes(fieldName);
      if (!valid) setFieldName("");
    }
  }, [subcategory, fieldName]);

  function buildQueryString(extraParams: Record<string, string | number> = {}): string {
    const params = new URLSearchParams();
    if (category) params.set("topic_category", category);
    if (subcategory) params.set("topic_subcategory", subcategory);
    if (fieldName) params.set("field_name", fieldName);
    if (valueContains.trim()) params.set("value_contains", valueContains.trim());
    for (const [k, v] of Object.entries(extraParams)) {
      params.set(k, String(v));
    }
    return params.toString();
  }

  async function runSearch(newOffset: number = 0) {
    const qs = buildQueryString({ limit: PAGE_SIZE, offset: newOffset });
    if (!category && !subcategory && !fieldName && !valueContains.trim()) {
      setError(
        "Add at least one filter — too many rows otherwise. Pick a category, a subcategory, or type something in the value box.",
      );
      return;
    }
    setLoading(true);
    setError(null);
    setHasSearched(true);
    try {
      const res = await fetch(`/api/v2/brain/search?${qs}`);
      const json = (await res.json()) as SearchResponse;
      if (!json.ok) {
        setError(json.error || "Search failed");
        setRows([]);
        setTotal(0);
        setHasMore(false);
        return;
      }
      setRows(json.rows ?? []);
      setTotal(json.total ?? 0);
      setOffset(json.offset ?? newOffset);
      setHasMore(json.has_more ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function downloadCsv() {
    if (!category && !subcategory && !fieldName && !valueContains.trim()) {
      setError("Add at least one filter before exporting.");
      return;
    }
    const qs = buildQueryString();
    window.location.href = `/api/v2/brain/search/csv?${qs}`;
  }

  function reset() {
    setCategory("");
    setSubcategory("");
    setFieldName("");
    setValueContains("");
    setRows([]);
    setTotal(0);
    setOffset(0);
    setHasMore(false);
    setHasSearched(false);
    setError(null);
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      {/* Filter form */}
      <section className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-5 mb-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2 mb-4">
          Filter
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zoca-text-2 uppercase tracking-wider">
              Category
            </span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as TopicCategory | "")}
              className="rounded-md border border-zoca-border bg-white px-2 py-1.5 text-[13px]"
            >
              <option value="">Any</option>
              {ALL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zoca-text-2 uppercase tracking-wider">
              Subcategory
            </span>
            <select
              value={subcategory}
              onChange={(e) =>
                setSubcategory(e.target.value as TopicSubcategory | "")
              }
              className="rounded-md border border-zoca-border bg-white px-2 py-1.5 text-[13px]"
            >
              <option value="">Any</option>
              {availableSubcategories.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zoca-text-2 uppercase tracking-wider">
              Field
            </span>
            <select
              value={fieldName}
              onChange={(e) => setFieldName(e.target.value)}
              disabled={!subcategory}
              className="rounded-md border border-zoca-border bg-white px-2 py-1.5 text-[13px] disabled:opacity-50"
            >
              <option value="">Any</option>
              {availableFieldNames.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zoca-text-2 uppercase tracking-wider">
              Value contains
            </span>
            <input
              type="text"
              value={valueContains}
              onChange={(e) => setValueContains(e.target.value)}
              placeholder="e.g. WhatsApp"
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch(0);
              }}
              className="rounded-md border border-zoca-border bg-white px-2 py-1.5 text-[13px]"
            />
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => runSearch(0)}
            disabled={loading}
            className="rounded-md bg-zoca-ember px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "var(--zoca-ember, #c8431d)" }}
          >
            {loading ? "Searching…" : "Search"}
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            className="rounded-md border border-zoca-border bg-white px-3 py-1.5 text-[13px]"
          >
            Download CSV
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-zoca-border bg-white px-3 py-1.5 text-[13px] text-zoca-text-2"
          >
            Reset
          </button>
          {hasSearched && !loading && (
            <span className="ml-auto text-[12px] text-zoca-text-2">
              {total} total
              {rows.length < total
                ? ` · showing ${offset + 1}–${offset + rows.length}`
                : ""}
            </span>
          )}
        </div>
      </section>

      {/* Error */}
      {error && (
        <section className="rounded-zoca-lg border border-red-200 bg-red-50 p-4 mb-5 text-[13px] text-red-800">
          {error}
        </section>
      )}

      {/* Results */}
      {hasSearched && !error && (
        <section className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-5">
          {rows.length === 0 ? (
            <div className="text-[13px] text-zoca-text-2 italic">
              No matching Brain facts. Try broadening the filter — drop a
              dropdown or change the value substring.
            </div>
          ) : (
            <>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-zoca-text-2 border-b border-zoca-border">
                    <th className="py-2 pr-2 font-semibold">Customer</th>
                    <th className="py-2 pr-2 font-semibold">AM</th>
                    <th className="py-2 pr-2 font-semibold">Field</th>
                    <th className="py-2 pr-2 font-semibold">Value</th>
                    <th className="py-2 pr-2 font-semibold">Source</th>
                    <th className="py-2 pr-2 font-semibold">Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.fact_id}
                      className="border-b border-zoca-border/40 align-top"
                    >
                      <td className="py-2 pr-2">
                        {r.entity_id ? (
                          <a
                            href={`/customer/${r.entity_id}`}
                            className="text-zoca-ember hover:underline"
                          >
                            {r.bizname ?? r.customer_id}
                          </a>
                        ) : (
                          <span>{r.bizname ?? r.customer_id}</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-zoca-text-2">
                        {r.am_name ?? "—"}
                      </td>
                      <td className="py-2 pr-2 text-zoca-text-2">
                        <span className="font-mono text-[11px]">
                          {r.topic_subcategory}.{r.field_name}
                        </span>
                      </td>
                      <td className="py-2 pr-2">{r.value}</td>
                      <td className="py-2 pr-2 text-zoca-text-2 text-[10px]">
                        {r.source_type.replace(/_/g, " ")}
                      </td>
                      <td className="py-2 pr-2 text-zoca-text-2 text-[10px]">
                        {r.confirmed_at
                          ? new Date(r.confirmed_at).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric", year: "numeric" },
                            )
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {(offset > 0 || hasMore) && (
                <div className="mt-4 flex items-center justify-between text-[12px]">
                  <button
                    type="button"
                    onClick={() => runSearch(Math.max(0, offset - PAGE_SIZE))}
                    disabled={offset === 0 || loading}
                    className="rounded-md border border-zoca-border bg-white px-3 py-1 disabled:opacity-30"
                  >
                    ← Prev
                  </button>
                  <span className="text-zoca-text-2">
                    Page {Math.floor(offset / PAGE_SIZE) + 1} of{" "}
                    {Math.max(1, Math.ceil(total / PAGE_SIZE))}
                  </span>
                  <button
                    type="button"
                    onClick={() => runSearch(offset + PAGE_SIZE)}
                    disabled={!hasMore || loading}
                    className="rounded-md border border-zoca-border bg-white px-3 py-1 disabled:opacity-30"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {!hasSearched && (
        <section className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-5 text-[13px] text-zoca-text-2 italic">
          Pick a filter and search. Examples:
          <ul className="mt-2 ml-4 list-disc">
            <li>Category=behavioral, Subcategory=comms_preference → all customers with a saved comms preference</li>
            <li>Value contains=&ldquo;WhatsApp&rdquo; → everyone with WhatsApp mentioned somewhere</li>
            <li>Subcategory=sold_by, Value contains=&ldquo;Chandan&rdquo; → all of Chandan&rsquo;s sales</li>
            <li>Subcategory=latent_risk → every customer with a flagged risk</li>
          </ul>
        </section>
      )}
    </div>
  );
}

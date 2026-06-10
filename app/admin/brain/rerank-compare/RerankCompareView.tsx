"use client";

/**
 * Voyage rerank A/B compare — client view.
 *
 * Form: entity_id (optional), query (required), candidatesPerStage, topK.
 * On submit POSTs to /api/admin/brain/rerank-compare, then renders:
 *   - Spearman agreement score as the headline number
 *   - Side-by-side top-K tables for rerank-2.5-lite and rerank-2.5
 *   - Per-side error banner when a model soft-fails
 */

import { useState } from "react";

type Row = {
  fact_id: string;
  customer_id: string;
  topic_subcategory: string;
  field_name: string;
  value: string;
  rrf_score: number;
  rerank_score: number;
  matched_via: Array<"embedding" | "keyword">;
};

type Side = {
  model: string;
  ok: boolean;
  rows: Row[];
  rerank_ms: number;
  ran: boolean;
  error?: string;
};

type CompareResponse = {
  ok: boolean;
  query?: string;
  entity_id?: string | null;
  customer_id?: string | null;
  bizname?: string | null;
  entity_resolution_warning?: string | null;
  candidatesPerStage?: number;
  topK?: number;
  candidate_count?: number;
  staged_timing?: { embedding_ms: number; keyword_ms: number };
  staged_ran?: { embedding: boolean; keyword: boolean };
  lite?: Side;
  full?: Side;
  spearman?: number | null;
  error?: string;
};

function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(3);
}

function fmtSpearman(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(3);
}

function shortFactId(fact_id: string): string {
  return fact_id.slice(0, 8);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export default function RerankCompareView() {
  const [entityId, setEntityId] = useState("");
  const [query, setQuery] = useState("");
  const [candidatesPerStage, setCandidatesPerStage] = useState(50);
  const [topK, setTopK] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      setError("Query is required");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/brain/rerank-compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId.trim() || undefined,
          query: query.trim(),
          candidatesPerStage,
          topK,
        }),
      });
      const json = (await res.json()) as CompareResponse;
      if (!res.ok || !json.ok) {
        setError(json.error || `HTTP ${res.status}`);
      } else {
        setResult(json);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        padding: "1.5rem 2rem",
        fontFamily: "Georgia, 'Times New Roman', serif",
        color: "var(--zoca-text)",
        maxWidth: 1400,
        margin: "0 auto",
      }}
    >
      <div style={{ marginBottom: "1.5rem" }}>
        <h1
          style={{
            fontSize: "1.75rem",
            fontWeight: 700,
            margin: 0,
            marginBottom: "0.4rem",
          }}
        >
          Voyage rerank A/B
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: "0.95rem",
            color: "var(--zoca-text-2)",
            maxWidth: 760,
            lineHeight: 1.5,
          }}
        >
          Run the Wave-1 hybrid pipeline (cosine + keyword &rarr; RRF merge)
          and rerank the SAME candidate set with both <code>rerank-2.5-lite</code>{" "}
          (what we ship today) and <code>rerank-2.5</code> (full). Spearman
          coefficient at the top is the agreement score between the two
          orderings on their shared facts &mdash; 1.0 means perfect agreement,
          0 means random, &lt;0 means inverted.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        style={{
          padding: "1.25rem",
          marginBottom: "1.5rem",
          borderRadius: 10,
          background: "var(--zoca-bg-soft)",
          border: "1px solid var(--zoca-border)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "1rem 1.5rem",
        }}
      >
        <label style={labelStyle}>
          <span style={labelTextStyle}>Entity ID (optional)</span>
          <input
            type="text"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="e.g. c152f906-… (leave blank for cross-book)"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Top K</span>
          <input
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => setTopK(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
            style={inputStyle}
          />
        </label>
        <label style={{ ...labelStyle, gridColumn: "1 / -1" }}>
          <span style={labelTextStyle}>Query</span>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            placeholder="What does Beam (or you) want to find? e.g. 'preferred communication channel for the owner'"
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            required
          />
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Candidates per stage (5-200)</span>
          <input
            type="number"
            min={5}
            max={200}
            value={candidatesPerStage}
            onChange={(e) =>
              setCandidatesPerStage(Math.max(5, Math.min(200, Number(e.target.value) || 50)))
            }
            style={inputStyle}
          />
        </label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 6,
              background: loading ? "var(--zoca-bg-tint)" : "var(--zoca-ember)",
              color: loading ? "var(--zoca-text-3)" : "var(--zoca-bg)",
              border: "none",
              fontWeight: 700,
              fontSize: "0.95rem",
              cursor: loading || !query.trim() ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {loading ? "Comparing…" : "Compare"}
          </button>
        </div>
      </form>

      {error && (
        <div
          role="alert"
          style={{
            padding: "0.9rem 1.1rem",
            marginBottom: "1.5rem",
            borderRadius: 8,
            background: "var(--zoca-pink-soft)",
            border: "1px solid var(--zoca-pink)",
            color: "var(--zoca-pink-bright)",
            fontSize: "0.95rem",
          }}
        >
          <strong>Request failed:</strong> {error}
        </div>
      )}

      {result && result.ok && (
        <>
          {result.entity_resolution_warning && (
            <div
              role="status"
              style={{
                padding: "0.8rem 1rem",
                marginBottom: "1rem",
                borderRadius: 8,
                background: "var(--zoca-bg-tint)",
                border: "1px dashed var(--zoca-border)",
                color: "var(--zoca-text-2)",
                fontSize: "0.85rem",
              }}
            >
              {result.entity_resolution_warning}
            </div>
          )}

          <div
            style={{
              padding: "1.5rem",
              marginBottom: "1.5rem",
              borderRadius: 10,
              background: "var(--zoca-bg-soft)",
              border: "1px solid var(--zoca-border)",
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "1.5rem",
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "0.8rem",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase",
                  color: "var(--zoca-text-3)",
                  marginBottom: "0.3rem",
                }}
              >
                Spearman agreement
              </div>
              <div
                style={{
                  fontSize: "3rem",
                  fontWeight: 700,
                  lineHeight: 1,
                  color: "var(--zoca-text)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {fmtSpearman(result.spearman)}
              </div>
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "var(--zoca-text-3)",
                  marginTop: "0.3rem",
                }}
              >
                between rerank-2.5-lite and rerank-2.5 on shared fact_ids
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "0.3rem 0.75rem",
                fontSize: "0.85rem",
                color: "var(--zoca-text-2)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <div>Customer:</div>
              <div>
                {result.bizname ?? "(none)"}{" "}
                {result.customer_id ? (
                  <span style={{ color: "var(--zoca-text-3)" }}>
                    {result.customer_id}
                  </span>
                ) : null}
              </div>
              <div>Candidates after RRF:</div>
              <div>{result.candidate_count ?? "—"}</div>
              <div>Embedding stage:</div>
              <div>
                {result.staged_timing?.embedding_ms ?? "—"} ms
                {result.staged_ran?.embedding === false ? (
                  <span style={{ color: "var(--zoca-text-3)" }}> · no hits</span>
                ) : null}
              </div>
              <div>Keyword stage:</div>
              <div>
                {result.staged_timing?.keyword_ms ?? "—"} ms
                {result.staged_ran?.keyword === false ? (
                  <span style={{ color: "var(--zoca-text-3)" }}> · no hits</span>
                ) : null}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "1.25rem",
            }}
          >
            <SideTable label="rerank-2.5-lite (shipped)" side={result.lite} />
            <SideTable label="rerank-2.5 (full)" side={result.full} />
          </div>
        </>
      )}
    </div>
  );
}

function SideTable({ label, side }: { label: string; side: Side | undefined }) {
  return (
    <div
      style={{
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid var(--zoca-border)",
        background: "var(--zoca-bg-soft)",
      }}
    >
      <div
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--zoca-border)",
          background: "var(--zoca-bg-tint)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{label}</div>
        <div style={{ fontSize: "0.8rem", color: "var(--zoca-text-3)" }}>
          {side ? `${side.rerank_ms} ms` : "—"}
        </div>
      </div>
      {!side ? (
        <div style={{ padding: "1rem", color: "var(--zoca-text-3)" }}>
          No result.
        </div>
      ) : !side.ok ? (
        <div
          style={{
            padding: "1rem",
            color: "var(--zoca-pink-bright)",
            fontSize: "0.9rem",
          }}
        >
          <strong>Rerank failed.</strong> {side.error ?? "Unknown error."}
        </div>
      ) : side.rows.length === 0 ? (
        <div style={{ padding: "1rem", color: "var(--zoca-text-3)" }}>
          No rows.
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.85rem",
          }}
        >
          <thead>
            <tr
              style={{
                background: "var(--zoca-bg-soft)",
                color: "var(--zoca-text)",
                textAlign: "left",
              }}
            >
              <th style={thStyle}>#</th>
              <th style={thStyle}>Fact</th>
              <th style={thStyle}>Value</th>
              <th style={thNumStyle}>Rerank</th>
              <th style={thNumStyle}>RRF</th>
            </tr>
          </thead>
          <tbody>
            {side.rows.map((r, i) => (
              <tr
                key={r.fact_id}
                style={{ borderTop: "1px solid var(--zoca-border)" }}
              >
                <td style={{ ...tdNumStyle, color: "var(--zoca-text-3)" }}>
                  {i + 1}
                </td>
                <td style={tdStyle}>
                  <code
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--zoca-text-3)",
                    }}
                  >
                    {shortFactId(r.fact_id)}
                  </code>
                  <div style={{ fontSize: "0.78rem", color: "var(--zoca-text-2)" }}>
                    {r.topic_subcategory} / {r.field_name}
                  </div>
                </td>
                <td style={tdStyle} title={r.value}>
                  {truncate(r.value, 80)}
                </td>
                <td style={tdNumStyle}>{fmtScore(r.rerank_score)}</td>
                <td style={{ ...tdNumStyle, color: "var(--zoca-text-3)" }}>
                  {fmtScore(r.rrf_score)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
};

const labelTextStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  letterSpacing: "1px",
  textTransform: "uppercase",
  color: "var(--zoca-text-3)",
  fontWeight: 700,
};

const inputStyle: React.CSSProperties = {
  padding: "0.55rem 0.7rem",
  borderRadius: 6,
  border: "1px solid var(--zoca-border)",
  background: "var(--zoca-bg)",
  color: "var(--zoca-text)",
  fontSize: "0.9rem",
  fontFamily: "inherit",
};

const thStyle: React.CSSProperties = {
  padding: "0.55rem 0.8rem",
  fontSize: "0.7rem",
  fontWeight: 700,
  letterSpacing: "1px",
  textTransform: "uppercase",
  color: "var(--zoca-text-2)",
};

const thNumStyle: React.CSSProperties = {
  ...thStyle,
  textAlign: "right",
};

const tdStyle: React.CSSProperties = {
  padding: "0.55rem 0.8rem",
  color: "var(--zoca-text)",
  verticalAlign: "top",
};

const tdNumStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

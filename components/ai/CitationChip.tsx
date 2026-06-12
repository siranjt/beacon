"use client";

/**
 * CitationChip — inline source-of-truth chip for a Beacon AI claim.
 * Phase E-17 Wave 3a, Feature 1.
 *
 * Beacon AI embeds `[cite:KEY]` markers inline in its response when it
 * makes a factual claim grounded in the CONTEXT. AskPanel parses those
 * markers and renders this chip in place. Clicking the chip toggles a
 * popover showing the source entry (label, value, optional raw fields).
 *
 * If the model hallucinated a key that isn't in the lookup, we render a
 * muted "(unverified)" fallback so QA can spot the failure mode.
 *
 * Watchfire palette throughout — parchment background, char text, ember
 * accent on hover. Matches the AskPanel aesthetic.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CitationEntry, CitationProvenance } from "@/lib/ai/citations";
// WAVE-A-3 — Canonical Keeper chip wrapper. When entry.category === "fact"
// (Keeper-sourced), we delegate the visible pill to KeeperChip so every
// surface that renders a Keeper citation shares the brand kernel (vault
// glyph + brass/ember/patina confidence tint + abbrev `K · topic` label).
// The popover behavior here stays unchanged — clicking the chip still
// toggles the X-Ray panel with the value + provenance trace.
import KeeperChip, {
  type KeeperChipConfidence,
} from "@/components/keeper/KeeperChip";

const SANS = "-apple-system, Inter, system-ui, sans-serif";
const SERIF = 'Georgia, "Times New Roman", serif';

const C = {
  text: "var(--zoca-text)",
  text2: "var(--zoca-text-2)",
  text3: "var(--zoca-text-3)",
  surface: "#F8EFD7",
  parchment: "#F0E4CC",
  border: "#D4C29B",
  ember: "#C8431D",
  brass: "#D9A441",
  patina: "#4A7C59",
  lapis: "#2A4D5C",
  char: "#2B1F14",
};

const CATEGORY_LABEL: Record<string, string> = {
  signal: "Signal",
  metric: "Metric",
  ticket: "Ticket",
  billing: "Billing",
  comm: "Comm",
  usage: "Usage",
  count: "Count",
  // Phase G + Roadmap-v2-4
  kb: "Knowledge",
  fact: "Keeper fact",
};

interface Props {
  citationKey: string;
  entry: CitationEntry | undefined;
}

export default function CitationChip({ citationKey, entry }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Close popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onToggle = useCallback(() => setOpen((v) => !v), []);

  // Hallucinated/missing key → muted fallback chip. We deliberately render
  // SOMETHING (rather than swallowing the marker) so QA can spot bad keys.
  if (!entry) {
    return (
      <span
        title={`Beacon AI cited "${citationKey}" but it isn't in the source lookup. Treat with skepticism.`}
        style={{
          display: "inline-block",
          marginLeft: 2,
          marginRight: 1,
          padding: "0 5px",
          fontSize: 10,
          lineHeight: "16px",
          color: C.text3,
          background: "rgba(43, 31, 20, 0.04)",
          border: `1px dashed ${C.border}`,
          borderRadius: 999,
          fontFamily: "ui-monospace, monospace",
          verticalAlign: "1px",
        }}
      >
        (unverified)
      </span>
    );
  }

  const categoryLabel = CATEGORY_LABEL[entry.category] ?? entry.category;
  const rawEntries = entry.raw
    ? Object.entries(entry.raw).filter(([, v]) => v !== null && v !== "")
    : [];

  // WAVE-A-3 — Keeper-sourced chip rendering. When the citation came from a
  // Keeper fact, we swap the generic ✦ button for a canonical KeeperChip
  // (vault glyph + `K · topic` label) so the brand kernel reads consistently
  // everywhere Keeper is the source of truth. The popover behavior stays
  // identical — clicking the KeeperChip wrapper toggles the same X-Ray card.
  if (entry.category === "fact") {
    const topic = deriveKeeperTopic(entry);
    const confidence = inferKeeperConfidence(entry);
    return (
      <span
        ref={wrapRef}
        style={{
          position: "relative",
          display: "inline-block",
          verticalAlign: "1px",
        }}
      >
        <KeeperChip
          topic={topic}
          confidence={confidence}
          onClick={onToggle}
        />
        {open && (
          <CitationPopover
            entry={entry}
            categoryLabel={categoryLabel}
            rawEntries={rawEntries}
            citationKey={citationKey}
          />
        )}
      </span>
    );
  }

  return (
    <span
      ref={wrapRef}
      style={{
        position: "relative",
        display: "inline-block",
        verticalAlign: "1px",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`Source: ${entry.label} — ${entry.value}`}
        title={`${entry.label}: ${entry.value}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginLeft: 2,
          marginRight: 1,
          width: 14,
          height: 14,
          padding: 0,
          fontSize: 9,
          lineHeight: 1,
          fontWeight: 700,
          color: open ? C.parchment : C.ember,
          background: open ? C.ember : C.parchment,
          border: `1px solid ${C.ember}`,
          borderRadius: 999,
          fontFamily: SANS,
          cursor: "pointer",
          transition: "background 120ms ease, color 120ms ease",
          verticalAlign: "baseline",
        }}
      >
        ✦
      </button>

      {open && (
        <CitationPopover
          entry={entry}
          categoryLabel={categoryLabel}
          rawEntries={rawEntries}
          citationKey={citationKey}
        />
      )}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * CitationPopover — extracted X-Ray panel.
 *
 * Shared by the generic (non-Keeper) and Keeper rendering paths so the
 * popover behavior + look stays identical regardless of which chip
 * surface (KeeperChip vs ✦ button) opened it.
 * ──────────────────────────────────────────────────────────────────────── */

function CitationPopover({
  entry,
  categoryLabel,
  rawEntries,
  citationKey,
}: {
  entry: CitationEntry;
  categoryLabel: string;
  rawEntries: Array<[string, string | number | null]>;
  citationKey: string;
}) {
  return (
    <span
      role="dialog"
      aria-label="Source data"
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        minWidth: 220,
        maxWidth: 320,
        padding: "8px 10px",
        background: C.parchment,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${C.ember}`,
        borderRadius: 8,
        boxShadow: "0 8px 24px -8px rgba(43, 31, 20, 0.35)",
        zIndex: 200,
        fontFamily: SANS,
        // Restore reading defaults — the parent bubble uses pre-wrap +
        // break-word which we don't want bleeding into the popover.
        whiteSpace: "normal",
        textAlign: "left",
      }}
    >
      <span
        style={{
          display: "block",
          fontSize: 9,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: C.text3,
          fontFamily: "ui-monospace, monospace",
          marginBottom: 2,
        }}
      >
        {categoryLabel}
      </span>
      <span
        style={{
          display: "block",
          fontSize: 12,
          fontFamily: SERIF,
          color: C.char,
          fontWeight: 500,
          marginBottom: 4,
        }}
      >
        {entry.label}
      </span>
      <span
        style={{
          display: "block",
          fontSize: 13,
          color: C.char,
          fontFamily: SANS,
          fontWeight: 600,
          marginBottom: rawEntries.length > 0 ? 6 : 0,
          wordBreak: "break-word",
        }}
      >
        {entry.value}
      </span>
      {rawEntries.length > 0 && (
        <span
          style={{
            display: "block",
            paddingTop: 6,
            borderTop: `1px solid ${C.border}`,
          }}
        >
          {rawEntries.map(([k, v]) => (
            <span
              key={k}
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr",
                gap: 6,
                fontSize: 11,
                lineHeight: 1.4,
                padding: "1px 0",
              }}
            >
              <span
                style={{
                  color: C.text3,
                  fontFamily: "ui-monospace, monospace",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {k}
              </span>
              <span
                style={{
                  color: C.text2,
                  fontFamily: SANS,
                  wordBreak: "break-word",
                }}
              >
                {String(v)}
              </span>
            </span>
          ))}
        </span>
      )}
      {/* Roadmap-v2-4 — hybrid-retrieval "why" trace. Renders the
          matched_via badges + RRF score + rerank bar + pool position.
          Skipped for non-Keeper chips (provenance is undefined). */}
      {entry.provenance && <ProvenanceTrace data={entry.provenance} />}
      <span
        style={{
          display: "block",
          marginTop: 8,
          fontSize: 9,
          color: C.text3,
          fontFamily: "ui-monospace, monospace",
          wordBreak: "break-all",
        }}
        title="Citation key as emitted by Beacon AI"
      >
        {citationKey}
      </span>
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * WAVE-A-3 — Keeper chip helpers
 *
 * Two pure derivations used to map a "fact"-category CitationEntry onto
 * the (topic, confidence) shape KeeperChip wants:
 *
 *   deriveKeeperTopic   — pulls the most-specific human label from the
 *                         entry. Prefers `field_name` from raw (e.g.
 *                         "preferred_channel"), falls back to subcategory
 *                         (e.g. "comms_preference"), then label, then the
 *                         literal word "fact".
 *
 *   inferKeeperConfidence — maps a Keeper fact's source/confirmation
 *                         shape onto the chip's confidence tier. We
 *                         deliberately err high: a chip's job is brand
 *                         consistency, not lying about confidence. When
 *                         we can't tell, default to "high" rather than
 *                         painting an "unverified" gray on real Keeper
 *                         data.
 * ──────────────────────────────────────────────────────────────────────── */

function deriveKeeperTopic(entry: CitationEntry): string {
  const raw = entry.raw ?? {};
  const fieldName = stringOrNull(raw.field_name);
  if (fieldName) return prettifyToken(fieldName);
  const subcategory = stringOrNull(raw.topic_subcategory);
  if (subcategory) return prettifyToken(subcategory);
  const category = stringOrNull(raw.topic_category);
  if (category) return prettifyToken(category);
  // entry.label is something like "concerns/latent_risk/risk_description"
  // — fall back to its trailing segment.
  if (entry.label) {
    const tail = entry.label.split("/").pop()?.trim();
    if (tail) return prettifyToken(tail);
  }
  return "fact";
}

function inferKeeperConfidence(entry: CitationEntry): KeeperChipConfidence {
  const raw = entry.raw ?? {};
  const sourceType = stringOrNull(raw.source_type);
  const confirmedAt = stringOrNull(raw.confirmed_at);

  // System of record → high.
  if (sourceType === "basesheet" || sourceType === "chargebee") return "high";
  // AM typed it directly → high.
  if (sourceType === "manual") return "high";
  // CS-note extract → moderate.
  if (sourceType === "customer_note") return "moderate";
  // Haiku extraction sitting in the inbox without a confirmation timestamp
  // → low; once confirmed it graduates to moderate.
  if (sourceType === "beacon_ai_extracted") {
    return confirmedAt ? "moderate" : "low";
  }
  if (sourceType === "beacon_ai_conversation") {
    return confirmedAt ? "moderate" : "low";
  }
  // No source_type plumbed through — default high. See the helper docblock
  // for the rationale (brand consistency over false dilution).
  return "high";
}

function stringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function prettifyToken(s: string): string {
  return s.replace(/_/g, " ").trim();
}

/* ────────────────────────────────────────────────────────────────────────
 * ProvenanceTrace — Roadmap-v2-4
 *
 * Inline card surfaced beneath the citation popover's value when the entry
 * carries Wave-1 hybrid-retrieval provenance. Renders:
 *   - matched_via badges ("embedding 🔵 keyword 🟢")
 *   - RRF score (3-decimal)
 *   - Voyage rerank score with a 0-1 bar visualization (or "skipped" when
 *     the rerank stage soft-failed)
 *   - rank + candidate pool size ("3rd of 47 candidates")
 *   - the query that drove the retrieval, when available
 *
 * Transition tokens stay light (120ms ease, matches the rest of the chip);
 * reduced-motion users get the same static layout because there are no
 * keyframes here.
 * ──────────────────────────────────────────────────────────────────────── */

const MATCHED_VIA_COLOR: Record<
  "embedding" | "keyword" | "derived_expansion",
  string
> = {
  embedding: C.lapis,
  keyword: C.patina,
  // SMART-K4 — parent fact auto-pulled because a derived child landed in
  // top-K. Visually distinct from embedding/keyword (different palette
  // slot) so the AM can tell the fact wasn't directly ranked.
  derived_expansion: C.brass,
};

function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * Exported for unit testing — pure derivation of the trace card's display
 * strings from a CitationProvenance payload. Keeps the rendering code free
 * of branching logic that's tricky to assert against.
 */
export function formatProvenanceTrace(p: CitationProvenance): {
  poolLabel: string;
  rrfLabel: string;
  rerankLabel: string;
  rerankPct: number | null;
  matchedVia: Array<"embedding" | "keyword" | "derived_expansion">;
} {
  const rank = Math.max(1, Math.floor(p.rank || 1));
  const pool = Math.max(rank, Math.floor(p.candidate_pool_size || 0));
  const poolLabel =
    pool > 0
      ? `${rank}${ordinalSuffix(rank)} of ${pool} candidate${pool === 1 ? "" : "s"}`
      : `${rank}${ordinalSuffix(rank)} ranked`;
  const rrfLabel = Number.isFinite(p.rrf_score)
    ? p.rrf_score.toFixed(3)
    : "—";
  let rerankLabel = "skipped";
  let rerankPct: number | null = null;
  if (typeof p.rerank_score === "number" && Number.isFinite(p.rerank_score)) {
    const clamped = Math.max(0, Math.min(1, p.rerank_score));
    rerankLabel = clamped.toFixed(3);
    rerankPct = Math.round(clamped * 100);
  }
  return {
    poolLabel,
    rrfLabel,
    rerankLabel,
    rerankPct,
    matchedVia:
      Array.isArray(p.matched_via) && p.matched_via.length > 0
        ? p.matched_via
        : [],
  };
}

function ProvenanceTrace({ data }: { data: CitationProvenance }) {
  const fmt = formatProvenanceTrace(data);
  return (
    <span
      data-testid="citation-provenance-trace"
      style={{
        display: "block",
        marginTop: 8,
        paddingTop: 8,
        borderTop: `1px dashed ${C.border}`,
      }}
    >
      <span
        style={{
          display: "block",
          fontSize: 9,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: C.text3,
          fontFamily: "ui-monospace, monospace",
          marginBottom: 4,
        }}
      >
        Why this was surfaced
      </span>
      {/* matched_via badges */}
      <span
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        {fmt.matchedVia.length === 0 && (
          <span
            style={{
              fontSize: 10,
              color: C.text3,
              fontStyle: "italic",
              fontFamily: SANS,
            }}
          >
            no signal data
          </span>
        )}
        {fmt.matchedVia.map((m) => (
          <span
            key={m}
            data-testid={`matched-via-${m}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "1px 6px",
              fontSize: 10,
              fontFamily: SANS,
              color: MATCHED_VIA_COLOR[m],
              background: `${MATCHED_VIA_COLOR[m]}1A`,
              border: `1px solid ${MATCHED_VIA_COLOR[m]}66`,
              borderRadius: 999,
              fontWeight: 500,
              lineHeight: 1.2,
              transition: "background 120ms ease, border-color 120ms ease",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: MATCHED_VIA_COLOR[m],
                display: "inline-block",
              }}
            />
            {m}
          </span>
        ))}
      </span>
      {/* RRF + rerank rows */}
      <span
        style={{
          display: "grid",
          gridTemplateColumns: "70px 1fr",
          gap: "2px 6px",
          fontSize: 11,
          fontFamily: SANS,
          color: C.text2,
          lineHeight: 1.4,
        }}
      >
        <span
          style={{
            color: C.text3,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          RRF
        </span>
        <span data-testid="provenance-rrf">{fmt.rrfLabel}</span>
        <span
          style={{
            color: C.text3,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          Rerank
        </span>
        <span
          data-testid="provenance-rerank"
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          {fmt.rerankPct !== null ? (
            <>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 70,
                  height: 4,
                  background: `${C.border}80`,
                  borderRadius: 2,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <span
                  style={{
                    display: "block",
                    height: "100%",
                    width: `${fmt.rerankPct}%`,
                    background: C.ember,
                    transition: "width 200ms ease",
                  }}
                />
              </span>
              <span>{fmt.rerankLabel}</span>
            </>
          ) : (
            <span style={{ color: C.text3, fontStyle: "italic" }}>
              {fmt.rerankLabel}
            </span>
          )}
        </span>
        <span
          style={{
            color: C.text3,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          Pool
        </span>
        <span data-testid="provenance-pool">{fmt.poolLabel}</span>
      </span>
      {data.query && (
        <span
          style={{
            display: "block",
            marginTop: 6,
            fontSize: 10,
            fontFamily: SANS,
            color: C.text3,
            fontStyle: "italic",
            wordBreak: "break-word",
          }}
        >
          query: &ldquo;{data.query}&rdquo;
        </span>
      )}
    </span>
  );
}

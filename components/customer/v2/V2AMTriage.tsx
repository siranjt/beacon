"use client";
// Phase 33.brand-watchfire-pink-sweep-v2 (7 hex/rgba + 0 tailwind-rose swept)

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScoredCustomerV2 } from "@/lib/customer/types";
import V2CustomerCard from "./V2CustomerCard";
import { AnimatedNumber } from "./AnimatedNumber";
import { EmptyState } from "./EmptyState";
import V2AMBookTrendStrip from "./V2AMBookTrendStrip";
import { SavedViewsRow, type SavedViewConfig } from "./SavedViewsRow";
import V2CoachingLoops from "./V2CoachingLoops";
import V2OnboardingTour from "./V2OnboardingTour";
import V2KeyboardShortcutsOverlay from "./V2KeyboardShortcutsOverlay";
import { useKeyboardShortcuts } from "@/lib/customer/hooks/useKeyboardShortcuts";
import type { CoachingRow, CoachingMetric } from "@/lib/customer/coaching";
import {
  SIGNAL_LABELS,
  customerHasSignal,
  type SignalKey,
} from "@/lib/customer/signal-taxonomy";
import { POD_MAP, normalizeHealthTier} from "@/lib/customer/config";

type CustomerTrendPoint = { date: string; composite: number };

type Props = {
  amName: string;
  pod: string;
  customers: ScoredCustomerV2[];
  generatedAt: string;
  pinnedSet?: Set<string>;
  onTogglePinned?: (
    entityId: string,
    meta: { customer_id: string | null; bizname: string | null },
  ) => void;
  /** Phase 19 — entity_id -> snoozed_until ISO timestamp. */
  snoozedSet?: Map<string, string>;
  onSnooze?: (
    entityId: string,
    days: number,
    meta: { customer_id: string | null; bizname: string | null },
  ) => void;
  onUnsnooze?: (entityId: string) => void;
  /** Phase 22.B.1 — active signal filter from V2Dashboard (URL-bound). */
  signal?: SignalKey | null;
  onSignalChange?: (key: SignalKey | null) => void;
  /** Per-card chip click — toast + filter set are handled by the parent. */
  onSignalChipClick?: (key: SignalKey) => void;
  /** Phase 22.B.3 — pod filter (?pod=) from heatmap drill-in. Optional. */
  podFilter?: string | null;
  onPodFilterChange?: (pod: string | null) => void;
  /** Phase 24 — controlled filter from URL (?filter=) / KPI-tile clicks. */
  filterFromUrl?: FilterKey | null;
  /** Phase 24 — controlled sort from URL (?sort=) — used by MRR @ risk drill. */
  sortFromUrl?: SortKey | null;
};

// Phase 32.1 — added "watch" (YELLOW) + "healthy" (GREEN) so primary filter
// pills mirror the KPI tile tiers exactly. "improving" and "quiet" remain in
// the type for URL backward-compat + saved views but no longer have primary
// chips on the bar.
type FilterKey = "pinned" | "act" | "watch" | "healthy" | "improving" | "quiet" | "all" | "snoozed";
type SortKey = "urgency" | "plan" | "lasttouch";

const FILTER_KEYS: FilterKey[] = ["pinned", "act", "watch", "healthy", "improving", "quiet", "all", "snoozed"];
const SORT_KEYS: SortKey[] = ["urgency", "plan", "lasttouch"];
function isFilterKey(v: string): v is FilterKey {
  return (FILTER_KEYS as string[]).includes(v);
}
function isSortKey(v: string): v is SortKey {
  return (SORT_KEYS as string[]).includes(v);
}

const ACT_TODAY_TOP_N = 10;

const COACHING_METRIC_LABEL: Record<CoachingMetric, string> = {
  untouched_7d: "RED untouched >7d",
  stale_14d: "Stale RED >14d",
  noreach_streak: "No-reach streak (3+)",
  snooze_ignored: "Snooze ignored",
};

export default function V2AMTriage({ amName, pod, customers, generatedAt, pinnedSet, onTogglePinned, snoozedSet, onSnooze, onUnsnooze, signal, onSignalChange, onSignalChipClick, podFilter, onPodFilterChange, filterFromUrl, sortFromUrl }: Props) {
  const [filter, setFilter] = useState<FilterKey>("act");
  const [sort, setSort] = useState<SortKey>("urgency");
  const [query, setQuery] = useState<string>("");
  const [customerTrends, setCustomerTrends] = useState<Record<string, CustomerTrendPoint[]>>({});
  const [contactedRecently, setContactedRecently] = useState<Set<string>>(new Set());
  // Phase 27 — coaching loops for this AM
  const [coachingRow, setCoachingRow] = useState<CoachingRow | null>(null);
  const [coachingMetric, setCoachingMetric] = useState<CoachingMetric | null>(null);
  // Phase 32 — keyboard navigation state.
  const [focusedEntityId, setFocusedEntityId] = useState<string | null>(null);
  // Phase 33.brand-watchfire-PR7-37 — transient id of the card that JUST
  // got focused, used to fire the brass focus-entry ring for 400ms.
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusedEntityId) return;
    setFocusEntryId(focusedEntityId);
    const tFocus = setTimeout(() => setFocusEntryId(null), 400);
    return () => clearTimeout(tFocus);
  }, [focusedEntityId]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Beacon — sticky filter bar pinned state (true when scrolled past hero).
  const [_stickyPinned, _setStickyPinned] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onScroll = () => _setStickyPinned(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Fetch the set of entities this AM has contacted in the last 7 days so we
  // can dim those cards and show a 'Contacted Xd ago' chip.
  useEffect(() => {
    if (!amName) {
      setContactedRecently(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/am/${encodeURIComponent(amName)}/contacted-recently?days=7`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { entity_ids: string[] };
        if (cancelled) return;
        setContactedRecently(new Set(json.entity_ids || []));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [amName]);

  // Phase 24 — when V2Dashboard pushes a new ?filter= (e.g. KPI tile click),
  // mirror it into our local state. Runs on mount + whenever the URL value
  // changes.
  useEffect(() => {
    if (filterFromUrl && isFilterKey(filterFromUrl)) {
      setFilter(filterFromUrl);
    }
  }, [filterFromUrl]);
  useEffect(() => {
    if (sortFromUrl && isSortKey(sortFromUrl)) {
      setSort(sortFromUrl);
    }
  }, [sortFromUrl]);

  // Phase 27 — fetch this AM's coaching row.
  useEffect(() => {
    if (!amName) {
      setCoachingRow(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/v2/coaching?am=${encodeURIComponent(amName)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { ok: boolean; rows: CoachingRow[] };
        if (cancelled) return;
        const row = json.ok && json.rows?.[0] ? json.rows[0] : null;
        setCoachingRow(row);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [amName]);

  useEffect(() => {
    if (customers.length === 0) {
      setCustomerTrends({});
      return;
    }
    let cancelled = false;
    const ids = customers.map((c) => c.entity_id).slice(0, 200);
    (async () => {
      try {
        const params = new URLSearchParams({ days: "14", ids: ids.join(",") });
        const res = await fetch(`/api/v2/trends/customers?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          data: { entity_id: string; points: CustomerTrendPoint[] }[];
        };
        if (cancelled) return;
        const map: Record<string, CustomerTrendPoint[]> = {};
        for (const b of json.data || []) map[b.entity_id] = b.points;
        setCustomerTrends(map);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customers]);

  // ---------------------------------------------------------------------------
  // Bucketing logic
  // ---------------------------------------------------------------------------
  const baseBuckets = useMemo(() => {
    // Phase 19: default filters HIDE snoozed customers. A snoozed customer
    // is only visible on the dedicated 'snoozed' filter. This keeps the
    // triage list focused on what the AM actually wants to act on.
    const isSnoozed = (entityId: string): boolean =>
      !!snoozedSet && snoozedSet.has(entityId);

    // Phase 17.B.2: align "Need to call today" lane with the "Need to call"
    // KPI tile (which counts strictly RED). Previously this bucket included
    // YELLOW capped at top-N, which caused a visible mismatch ("10 to act on"
    // vs KPI "3"). Now both are RED-only — pre-launch RED still excluded.
    const act = customers
      .filter((c) => {
        // Phase 33.E.5 — Need-to-call-today lane.
        // CRITICAL + AT-RISK from Metabase health card are urgent.
        // Falls back to old "stoplight === RED" when metabase_health is absent.
        if (c.signals_v2.pre_launch) return false;
        if (isSnoozed(c.entity_id)) return false;
        const _ht = normalizeHealthTier((c as any).metabase_health?.health_tier);
        if (_ht === "CRITICAL" || _ht === "AT-RISK") return true;
        if (_ht === null && c.signals_v2.stoplight === "RED") return true;
        return false;
      })
      .sort((a, b) => b.signals_v2.composite - a.signals_v2.composite);

    // Phase 32.1 — new primary buckets that mirror the KPI-tile tiers exactly,
    // so a click on WATCH/HEALTHY drills into the SAME cohort the KPI counted.
    const watch = customers
      .filter(
        (c) =>
          !c.signals_v2.pre_launch &&
          c.signals_v2.stoplight === "YELLOW" &&
          !isSnoozed(c.entity_id),
      )
      .sort((a, b) => b.signals_v2.composite - a.signals_v2.composite);

    const healthy = customers
      .filter(
        (c) =>
          !c.signals_v2.pre_launch &&
          c.signals_v2.stoplight === "GREEN" &&
          !isSnoozed(c.entity_id),
      )
      .sort((a, b) => a.signals_v2.composite - b.signals_v2.composite);

    // Pre-Phase-32.1 buckets — kept for URL/saved-view backward compat. No
    // longer have primary chips on the bar. "improving" is the top-15 lowest-
    // composite GREEN; "quiet" is comms-gap (≥30d since inbound), capped at 20.
    // Phase 33.scope optionB triage improving exclude recently_churned
    const improving = customers
      .filter(
        (c) =>
          c.lifecycle_state !== "recently_churned" &&
          c.signals_v2.stoplight === "GREEN" &&
          c.signals_v2.composite < 20 &&
          !isSnoozed(c.entity_id),
      )
      .sort((a, b) => a.signals_v2.composite - b.signals_v2.composite)
      .slice(0, 15);

    // Phase 33.scope optionB triage quiet30 exclude recently_churned
    const quiet30 = customers
      .filter(
        (c) =>
          c.lifecycle_state !== "recently_churned" &&
          (c.metrics.days_since_in >= 30 ||
            (c.metrics.last_any_iso === null &&
              c.signals_v2.tier !== "HEALTHY")) &&
          !isSnoozed(c.entity_id),
      )
      .sort((a, b) => b.metrics.days_since_in - a.metrics.days_since_in)
      .slice(0, 20);

    // 'all' bucket: the full book sorted by composite desc; pre-launch
    // customers retained (the AM still wants to see them, they just don't
    // appear in 'Act today'). Snoozed are hidden from 'all' too — they
    // belong on the snoozed lane.
    const all = [...customers]
      .filter((c) => !isSnoozed(c.entity_id))
      .sort((a, b) => b.signals_v2.composite - a.signals_v2.composite);

    const pinned = pinnedSet
      ? customers
          .filter(
            (c) => pinnedSet.has(c.entity_id) && !isSnoozed(c.entity_id),
          )
          .sort((a, b) => b.signals_v2.composite - a.signals_v2.composite)
      : [];

    // Snoozed lane — ordered by soonest-expiring first so the AM sees what's
    // about to come back into rotation. Falls back to composite when timestamps
    // are missing.
    const snoozed = snoozedSet
      ? customers
          .filter((c) => snoozedSet.has(c.entity_id))
          .sort((a, b) => {
            const au = snoozedSet.get(a.entity_id) || "";
            const bu = snoozedSet.get(b.entity_id) || "";
            return au.localeCompare(bu);
          })
      : [];

    return { pinned, act, watch, healthy, improving, quiet: quiet30, all, snoozed };
  }, [customers, pinnedSet, snoozedSet]);

  const filterCounts = {
    pinned: baseBuckets.pinned.length,
    act: baseBuckets.act.length,
    watch: baseBuckets.watch.length,
    healthy: baseBuckets.healthy.length,
    improving: baseBuckets.improving.length,
    quiet: baseBuckets.quiet.length,
    all: baseBuckets.all.length,
    snoozed: baseBuckets.snoozed.length,
  };

  // If the user is on the "pinned" filter and their pinned count drops to
  // 0 (e.g. they just unpinned everything), fall back to the default lane.
  useEffect(() => {
    if (filter === "pinned" && filterCounts.pinned === 0) {
      setFilter("act");
    }
    if (filter === "snoozed" && filterCounts.snoozed === 0) {
      setFilter("act");
    }
  }, [filter, filterCounts.pinned, filterCounts.snoozed]);

  // Apply search + sort to current filter's customers
  const filtered = useMemo(() => {
    let list = baseBuckets[filter];
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((c) => (c.company || "").toLowerCase().includes(q));
    }
    // Sort within filter
    const sorted = [...list];
    switch (sort) {
      case "plan":
        sorted.sort((a, b) => b.plan_amount - a.plan_amount);
        break;
      case "lasttouch":
        sorted.sort(
          (a, b) => b.metrics.days_since_in - a.metrics.days_since_in,
        );
        break;
      case "urgency":
      default:
        if (filter === "improving") {
          sorted.sort((a, b) => a.signals_v2.composite - b.signals_v2.composite);
        } else if (filter === "snoozed" && snoozedSet) {
          sorted.sort((a, b) => {
            const au = snoozedSet.get(a.entity_id) || "";
            const bu = snoozedSet.get(b.entity_id) || "";
            return au.localeCompare(bu);
          });
        } else {
          sorted.sort((a, b) => b.signals_v2.composite - a.signals_v2.composite);
        }
        break;
    }
    return sorted;
  }, [baseBuckets, filter, query, sort]);

  // Phase 22.B.1 — narrow visible list to a single signal key when set.
  // Phase 22.B.3 — additionally narrow by pod when podFilter is set. Both
  // are POST-filters on the bucket/search/sort pipeline above, so they
  // compose with whatever lane the AM is currently on.
  // Phase 27   — additionally narrow by coaching cohort when coachingMetric
  // is set (filters to the entity_ids surfaced by the heads-up pill).
  const finalList = useMemo(() => {
    let out = filtered;
    if (signal) out = out.filter((c) => customerHasSignal(c, signal));
    if (podFilter) {
      out = out.filter((c) => (POD_MAP[c.am_name] || "Floating") === podFilter);
    }
    if (coachingMetric && coachingRow) {
      let allowed: Set<string> = new Set();
      switch (coachingMetric) {
        case "untouched_7d":
          allowed = new Set(coachingRow.red_untouched_7d.entity_ids);
          break;
        case "stale_14d":
          allowed = new Set(coachingRow.stale_red_14d.entity_ids);
          break;
        case "noreach_streak":
          allowed = new Set(coachingRow.noreach_streak_3plus.entity_ids);
          break;
        case "snooze_ignored":
          allowed = new Set(coachingRow.snooze_ignored.entity_ids);
          break;
      }
      // Coaching cohorts can include snoozed customers (especially
      // snooze_ignored), so search the full book — not the bucket-filtered
      // list above which strips snoozed entries by default.
      const source =
        coachingMetric === "snooze_ignored" ? customers : filtered;
      out = source.filter((c) => allowed.has(c.entity_id));
    }
    return out;
  }, [filtered, signal, podFilter, coachingMetric, coachingRow, customers]);

  // Phase 33.brand-watchfire-PR8-45 — viewList orchestration for exit animations.
  //
  // viewList is a superset of finalList that keeps cards around for 500ms
  // after they leave finalList, so the .beacon-card-exit animation has time
  // to play. Bulk transitions (> 3 cards removed in one render — typically
  // filter/sort changes) snap to finalList immediately to avoid mass-exit
  // noise; targeted removals (snooze, unpin, mark-contacted) animate.
  //
  // Phase 33.brand-watchfire-PR9-52 — tier-changed set:
  // read beacon_seen_v2_<am> once on mount and build a Set of entity_ids whose
  // tier has changed since the previous session. When the viewList
  // orchestration marks any of these for exit, .beacon-tier-exit-spark is
  // layered on top of .beacon-card-exit for the comet-trail effect.
  type ViewItem = (typeof finalList)[number] & {
    _exiting?: boolean;
    _tierExit?: boolean;
  };
  const [viewList, setViewList] = useState<ViewItem[]>(() => finalList);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tierChangedSetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Phase 33.brand-watchfire-T3-deps — rebuild when amName changes so
    // switching AM picker re-reads that AM's seen map.
    try {
      if (typeof window === "undefined") return;
      const am = amName || "default";
      const key = `beacon_seen_v2_${am}`;
      let raw = window.localStorage.getItem(key);
      // Phase 33.brand-watchfire-T3-migration — same legacy promotion as V2CustomerCard.
      if (!raw) {
        const legacyRaw = window.localStorage.getItem(`beacon_seen_${am}`);
        if (legacyRaw) {
          try {
            const legacy = JSON.parse(legacyRaw) as Record<string, string>;
            const migrated: Record<string, { tier: string }> = {};
            for (const [eid, tier] of Object.entries(legacy)) {
              if (typeof tier === "string") migrated[eid] = { tier };
            }
            window.localStorage.setItem(key, JSON.stringify(migrated));
            raw = JSON.stringify(migrated);
          } catch {
            /* legacy parse failed */
          }
        }
      }
      if (!raw) {
        tierChangedSetRef.current = new Set();
        return;
      }
      const seen = JSON.parse(raw) as Record<
        string,
        { tier?: string; last_touch_at?: string | null; churn_open?: number }
      >;
      const next = new Set<string>();
      for (const c of customers) {
        const prev = seen[c.entity_id]?.tier;
        const curr = c.signals_v2?.stoplight;
        if (prev && curr && prev !== curr) next.add(c.entity_id);
      }
      tierChangedSetRef.current = next;
    } catch {
      tierChangedSetRef.current = new Set();
    }
  }, [amName, customers]);
  useEffect(() => {
    const finalIds = new Set(finalList.map((c) => c.entity_id));
    const stillVisible = viewList.filter((c) => !c._exiting);
    const newlyRemoved = stillVisible.filter((c) => !finalIds.has(c.entity_id));

    // Bulk or zero-removal: snap to finalList and clear any pending exits.
    if (newlyRemoved.length === 0 || newlyRemoved.length > 3) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setViewList(finalList);
      return;
    }

    // Targeted removals: rebuild viewList preserving positions.
    //   • finalList items → use fresh copy, drop any _exiting flag.
    //   • items in viewList missing from finalList:
    //       - already _exiting → leave as is
    //       - newly removed → mark _exiting: true
    //   • new arrivals (in finalList, not in viewList) → append at end.
    const viewIds = new Set(viewList.map((c) => c.entity_id));
    const next: ViewItem[] = [];
    for (const c of viewList) {
      if (finalIds.has(c.entity_id)) {
        const fresh = finalList.find((x) => x.entity_id === c.entity_id);
        next.push(fresh ?? c);
      } else if (c._exiting) {
        next.push(c);
      } else {
        // Phase 33.brand-watchfire-PR9-52 — flag tier-driven exits for the
        // comet-trail spark; everything else just collapses cleanly.
        const tierExit = tierChangedSetRef.current.has(c.entity_id);
        next.push({ ...c, _exiting: true, _tierExit: tierExit });
      }
    }
    for (const c of finalList) {
      if (!viewIds.has(c.entity_id)) next.push(c);
    }
    setViewList(next);

    // Schedule the actual removal — 500ms matches .beacon-card-exit duration.
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    exitTimerRef.current = setTimeout(() => {
      setViewList((prev) => prev.filter((c) => finalIds.has(c.entity_id)));
      exitTimerRef.current = null;
    }, 500);

    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalList]);

  // Phase 22.C — FLIP transitions: when finalList re-orders (filter/sort/pin/snooze),
  // each card animates from its previous DOM position to its new one via inverse
  // transform + transition-back. Cards are identified across renders by their
  // [data-entity-id] attribute on the outermost element of V2CustomerCard.
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevPositions = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    if (!listRef.current) return;
    const els = listRef.current.querySelectorAll<HTMLElement>("[data-entity-id]");
    els.forEach((el) => {
      const id = el.dataset.entityId;
      if (!id) return;
      const prev = prevPositions.current.get(id);
      if (prev) {
        const next = el.getBoundingClientRect();
        const dy = prev.top - next.top;
        const dx = prev.left - next.left;
        if (dy !== 0 || dx !== 0) {
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          el.style.transition = "none";
          requestAnimationFrame(() => {
            el.style.transform = "";
            el.style.transition = "transform 0.32s cubic-bezier(0.4, 0, 0.2, 1)";
          });
        }
      }
    });
    // Save current positions for the next render.
    prevPositions.current.clear();
    els.forEach((el) => {
      const id = el.dataset.entityId;
      if (!id) return;
      prevPositions.current.set(id, el.getBoundingClientRect());
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 32 — Keyboard shortcuts. Cycle focused card, open detail, etc.
  // ---------------------------------------------------------------------------
  const focusedIndex = useMemo(() => {
    if (!focusedEntityId) return -1;
    return finalList.findIndex((c) => c.entity_id === focusedEntityId);
  }, [finalList, focusedEntityId]);

  // Keep focusedEntityId in-sync with the visible list. If the focused card
  // disappears (filter change), reset to the first visible card.
  useEffect(() => {
    if (finalList.length === 0) {
      if (focusedEntityId !== null) setFocusedEntityId(null);
      return;
    }
    if (focusedIndex === -1) {
      setFocusedEntityId(finalList[0]?.entity_id ?? null);
    }
  }, [finalList, focusedIndex, focusedEntityId]);

  const cycleNext = useCallback(() => {
    if (finalList.length === 0) return;
    const next =
      focusedIndex < 0 || focusedIndex >= finalList.length - 1
        ? 0
        : focusedIndex + 1;
    const id = finalList[next]?.entity_id ?? null;
    setFocusedEntityId(id);
    if (id) scrollFocusedCardIntoView(id);
  }, [finalList, focusedIndex]);

  const cyclePrev = useCallback(() => {
    if (finalList.length === 0) return;
    const next =
      focusedIndex <= 0 ? finalList.length - 1 : focusedIndex - 1;
    const id = finalList[next]?.entity_id ?? null;
    setFocusedEntityId(id);
    if (id) scrollFocusedCardIntoView(id);
  }, [finalList, focusedIndex]);

  const openFocusedDetail = useCallback(() => {
    if (!focusedEntityId) return;
    const url = `/customer/${encodeURIComponent(focusedEntityId)}`;
    if (typeof window !== "undefined") window.location.assign(url);
  }, [focusedEntityId]);

  const clickFocusedSelector = useCallback(
    (selector: string) => {
      if (!focusedEntityId) return;
      const card = document.querySelector(
        `[data-entity-id="${cssEscapeId(focusedEntityId)}"]`,
      );
      if (!card) return;
      const target = card.querySelector<HTMLElement>(selector);
      target?.click();
    },
    [focusedEntityId],
  );

  const triggerRefresh = useCallback(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-v2-refresh-button="1"]');
    btn?.click();
  }, []);

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
  }, []);

  const gotoManager = useCallback(() => {
    if (typeof window !== "undefined") window.location.assign("/customer/manager");
  }, []);
  const gotoOneOnOne = useCallback(() => {
    if (typeof window !== "undefined") window.location.assign("/customer/manager/1on1");
  }, []);

  useKeyboardShortcuts({
    onHelp: () => setShortcutsOpen(true),
    onEsc: () => setShortcutsOpen(false),
    onCycleNext: cycleNext,
    onCyclePrev: cyclePrev,
    onOpenDetail: openFocusedDetail,
    onClickPrimary: () => clickFocusedSelector('[data-primary-action="1"]'),
    onClickSnooze: () => clickFocusedSelector('[data-snooze-menu="1"] button'),
    onRefresh: triggerRefresh,
    onFocusSearch: focusSearch,
    onGotoManager: gotoManager,
    onGotoOneOnOne: gotoOneOnOne,
  });

  // Hero — count + label
  const heroCount = finalList.length;
  const heroLabelRich = (() => {
    if (filter === "pinned") {
      if (query.trim()) {
        return `${heroCount} match${heroCount === 1 ? "" : "es"} in pinned`;
      }
      if (heroCount === 0) {
        return "Nothing pinned yet. Click the pin icon on any customer card to add it here.";
      }
      return `You have ${heroCount} pinned customer${heroCount === 1 ? "" : "s"}`;
    }
    if (filter === "act") {
      if (query.trim()) {
        return `${heroCount} match${heroCount === 1 ? "" : "es"} for "${query.trim()}"`;
      }
      if (heroCount === 0) return "All clear — nobody urgent in your book today";
      return null; // use rich rendering below
    }
    if (filter === "watch") {
      if (heroCount === 0) return "No customers in the watch tier — your YELLOW lane is clear";
      return `${heroCount} customer${heroCount === 1 ? "" : "s"} to watch`;
    }
    if (filter === "healthy") {
      if (heroCount === 0) return "No GREEN customers in your book yet";
      return `${heroCount} customer${heroCount === 1 ? "" : "s"} doing fine`;
    }
    if (filter === "improving") {
      if (heroCount === 0) return "No one's clearly improving this week";
      return `${heroCount} customer${heroCount === 1 ? "" : "s"} with strongest momentum`;
    }
    if (filter === "quiet") {
      if (heroCount === 0) return "No one's been quiet for 30+ days";
      return `${heroCount} customer${heroCount === 1 ? "" : "s"} you haven't heard from in 30+ days`;
    }
    if (filter === "snoozed") {
      if (heroCount === 0) {
        return "No snoozed customers. Snooze a customer to come back to them later.";
      }
      return `You have ${heroCount} snoozed customer${heroCount === 1 ? "" : "s"}`;
    }
    // 'all' filter
    if (query.trim()) {
      return `${heroCount} match${heroCount === 1 ? "" : "es"} for "${query.trim()}" in your book`;
    }
    return `${heroCount} customer${heroCount === 1 ? "" : "s"} in your book`;
  })();

  return (
    <section className="mt-2">
      {/* Phase 27 — Coaching loops "Heads up" pill bar. Mounts at the very
          top of the AM-mode tree so the AM sees behavioral signals before
          the saved-views row. Clicking a pill sets coachingMetric, which
          narrows the customer list below via finalList. */}
      {coachingRow && (
        <V2CoachingLoops
          mode="am"
          rows={[coachingRow]}
          onMetricClick={(_am, m) =>
            setCoachingMetric((curr) => (curr === m ? null : m))
          }
        />
      )}
      {/* Book trend strip — last 14 days */}
      {amName && <V2AMBookTrendStrip amName={amName} days={14} />}
      {/* Beacon — sticky filter container starts here */}
      <div
        style={{
          position: "sticky",
          top: 6,
          zIndex: 10,
          marginBottom: 12,
          // Phase 33.brand-watchfire-T8 — sticky filter panel on Parchment.
          background: "rgba(240, 228, 204, 0.94)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: "0.5px solid var(--zoca-border)",
          borderRadius: 14,
          padding: _stickyPinned ? "10px 14px" : "14px 16px",
          boxShadow: _stickyPinned
            ? "0 8px 24px -12px rgba(11,5,29,0.18)"
            : "0 1px 3px rgba(11,5,29,0.04)",
          transition: "padding 0.2s ease, box-shadow 0.2s ease",
        }}
      >
      {/* Hero */}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        {heroLabelRich !== null ? (
          <h1
            className="text-zoca-text"
            style={{
              fontSize: "clamp(22px, 2.8vw, 28px)",
              fontWeight: 800,
              letterSpacing: "-0.025em",
              lineHeight: 1.15,
              margin: 0,
            }}
          >
            {heroLabelRich}
          </h1>
        ) : (
          <h1
            className="text-zoca-text"
            style={{
              fontSize: "clamp(22px, 2.8vw, 28px)",
              fontWeight: 800,
              letterSpacing: "-0.025em",
              lineHeight: 1.15,
              margin: 0,
            }}
          >
            Today, you have{" "}
            <span className="zoca-num-gradient" style={{ fontVariantNumeric: "tabular-nums" }}>
              <AnimatedNumber value={heroCount} duration={900} />
            </span>{" "}
            customer{heroCount === 1 ? "" : "s"} to act on
          </h1>
        )}
        <p className="text-[12px] text-zoca-text-2">
          {amName}
          {pod && ` · ${pod}`}
        </p>
      </div>

      {/* Controls row: filter chips + search + sort */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {filterCounts.pinned > 0 && (
          <FilterChip
            label="📌 Pinned"
            count={filterCounts.pinned}
            active={filter === "pinned"}
            onClick={() => setFilter("pinned")}
          />
        )}
        {/* Phase 32.1 — primary chips now mirror KPI tiers exactly. Clicking
            WATCH on the KPI tile drills into the SAME cohort the tile counted. */}
        <FilterChip
          label="Need to call today"
          count={filterCounts.act}
          active={filter === "act"}
          onClick={() => setFilter("act")}
        />
        <FilterChip
          label="Watch"
          count={filterCounts.watch}
          active={filter === "watch"}
          onClick={() => setFilter("watch")}
        />
        <FilterChip
          label="Healthy"
          count={filterCounts.healthy}
          active={filter === "healthy"}
          onClick={() => setFilter("healthy")}
        />
        <FilterChip
          label="Full book"
          count={filterCounts.all}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        {/* Secondary chips — useful sub-segments that don't add up to the book.
            Kept as primary-row chips at 0.7 opacity to signal they're alternative
            lenses, not tier counts. */}
        {filterCounts.quiet > 0 && (
          <FilterChip
            label="Quiet 30+d"
            count={filterCounts.quiet}
            active={filter === "quiet"}
            onClick={() => setFilter("quiet")}
          />
        )}
        {filterCounts.snoozed > 0 && (
          <FilterChip
            label="💤 Snoozed"
            count={filterCounts.snoozed}
            active={filter === "snoozed"}
            onClick={() => setFilter("snoozed")}
          />
        )}

        {amName && (
          <SavedViewsRow
            amName={amName}
            currentFilter={filter}
            currentSearch={query}
            currentSort={sort}
            onLoadView={(cfg: SavedViewConfig) => {
              if (cfg.filter && isFilterKey(cfg.filter)) setFilter(cfg.filter);
              if (typeof cfg.search === "string") setQuery(cfg.search);
              if (cfg.sort && isSortKey(cfg.sort)) setSort(cfg.sort);
            }}
          />
        )}

        <div className="basis-full flex items-center gap-2 mt-2">
          {/* Search */}
          <label className="relative inline-flex items-center flex-1">
            <span className="absolute left-3 text-zoca-text-soft" aria-hidden>
              ⌕
            </span>
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search business name…"
              aria-label="Search business name"
              className="w-full rounded-full border py-1.5 pl-8 pr-3 text-[12px] focus:outline-none"
              style={{
                borderColor: "var(--zoca-border)",
                background: "var(--zoca-bg-soft)",
                color: "var(--zoca-text)",
                minWidth: 200,
              }}
            />
          </label>

          {/* Sort dropdown */}
          <label className="inline-flex items-center gap-1 text-[11px] text-zoca-text-soft">
            <span className="hidden md:inline">Sort:</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort customers"
              className="rounded-full border px-2.5 py-1.5 text-[12px] focus:outline-none"
              style={{
                borderColor: "var(--zoca-border)",
                background: "var(--zoca-bg-soft)",
                color: "var(--zoca-text)",
              }}
            >
              <option value="urgency">By urgency</option>
              <option value="plan">By plan amount</option>
              <option value="lasttouch">By last touch</option>
            </select>
          </label>
        </div>
      </div>

      </div>
      {/* Beacon — sticky filter container ends here */}

      {/* Phase 22.B.1 + 22.B.3 — sticky filter banners (signal and pod).
          They sit side-by-side in a flex row, each independently dismissible.
          Phase 27 adds a coaching cohort banner alongside. */}
      {(signal || podFilter || coachingMetric) && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            marginBottom: "10px",
          }}
        >
          {signal && (
            <div
              role="status"
              className="zoca-fade-in"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 14px",
                background: "rgba(124, 45, 18, 0.12)",
                border: "1px solid rgba(200, 67, 29, 0.22)",
                color: "var(--zoca-pink-bright)",
                borderRadius: "9999px",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              <i className="ti ti-filter" aria-hidden style={{ fontSize: "14px" }} />
              <span>Filtered to: {SIGNAL_LABELS[signal]}</span>
              <button
                type="button"
                onClick={() => onSignalChange?.(null)}
                aria-label="Clear signal filter"
                style={{
                  background: "transparent",
                  border: 0,
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: "14px",
                  padding: "0 4px",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          )}
          {podFilter && (
            <div
              role="status"
              className="zoca-fade-in"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 14px",
                background: "rgba(124, 45, 18, 0.12)",
                border: "1px solid rgba(200, 67, 29, 0.22)",
                color: "var(--zoca-pink-bright)",
                borderRadius: "9999px",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              <i className="ti ti-filter" aria-hidden style={{ fontSize: "14px" }} />
              <span>Filtered to: {podFilter}</span>
              <button
                type="button"
                onClick={() => onPodFilterChange?.(null)}
                aria-label="Clear pod filter"
                style={{
                  background: "transparent",
                  border: 0,
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: "14px",
                  padding: "0 4px",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          )}
          {coachingMetric && (
            <div
              role="status"
              className="zoca-fade-in"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 14px",
                background: "rgba(200, 67, 29, 0.08)",
                border: "1px solid rgba(200, 67, 29, 0.22)",
                color: "#0c4a6e",
                borderRadius: "9999px",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              <i className="ti ti-filter" aria-hidden style={{ fontSize: "14px" }} />
              <span>Showing coaching cohort: {COACHING_METRIC_LABEL[coachingMetric]}</span>
              <button
                type="button"
                onClick={() => setCoachingMetric(null)}
                aria-label="Clear coaching cohort filter"
                style={{
                  background: "transparent",
                  border: 0,
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: "14px",
                  padding: "0 4px",
                  lineHeight: 1,
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {/* Cards or empty state */}
      {viewList.length === 0 ? (
        <V2EmptyState filter={filter} hasQuery={query.trim().length > 0} />
      ) : (
        <div ref={listRef} className="flex flex-col gap-3">
          {viewList.map((c, i) => {
            const isFocused = c.entity_id === focusedEntityId;
            // Phase 33.brand-watchfire-PR8-45 — mid-exit cards get the
            // collapse animation; suppress focus ring while exiting.
            const isExiting = !!c._exiting;
            // Phase 33.brand-watchfire-PR9-52 — comet trail spark on tier-driven exits.
            const isTierExit = isExiting && !!c._tierExit;
            // Phase 33.brand-watchfire-PR7-37 — brass focus-entry ring for 400ms.
            const isFocusEntry = focusEntryId === c.entity_id && !isExiting;
            const baseClass = isExiting
              ? `beacon-card-exit${isTierExit ? " beacon-tier-exit-spark" : ""} transition`
              : isFocused
                ? "rounded-zoca-lg ring-2 ring-zoca-pink-cta/30 transition"
                : "transition";
            const wrapperClass = isFocusEntry
              ? `${baseClass} beacon-card-focus-entry`
              : baseClass;
            return (
              <div
                key={c.entity_id}
                data-focused={isFocused && !isExiting ? "true" : undefined}
                className={wrapperClass}
                onClick={isExiting ? undefined : () => setFocusedEntityId(c.entity_id)}
              >
                <V2CustomerCard
                  customer={c}
                  index={i}
                  trend={customerTrends[c.entity_id]}
                  recentlyContacted={contactedRecently.has(c.entity_id)}
                  isPinned={pinnedSet?.has(c.entity_id) ?? false}
                  onTogglePinned={
                    onTogglePinned
                      ? () =>
                          onTogglePinned(c.entity_id, {
                            customer_id: c.customer_id ?? null,
                            bizname: c.company ?? null,
                          })
                      : undefined
                  }
                  amName={amName}
                  isSnoozed={snoozedSet?.has(c.entity_id) ?? false}
                  snoozedUntil={snoozedSet?.get(c.entity_id) ?? null}
                  onSnooze={
                    onSnooze
                      ? (days: number) =>
                          onSnooze(c.entity_id, days, {
                            customer_id: c.customer_id ?? null,
                            bizname: c.company ?? null,
                          })
                      : undefined
                  }
                  onUnsnooze={onUnsnooze ? () => onUnsnooze(c.entity_id) : undefined}
                  onSignalChipClick={onSignalChipClick}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Footer info — link to Full book view when we're showing a partial bucket */}
      {customers.length > finalList.length && finalList.length > 0 && filter !== "all" && (
        <p className="mt-8 text-center text-[12px] text-zoca-text-soft">
          Showing {finalList.length} of {customers.length} in your book.{" "}
          <button
            type="button"
            onClick={() => setFilter("all")}
            className="text-zoca-purple underline-offset-2 hover:text-zoca-pink-cta hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-zoca-pink-cta/40"
          >
            Open full book →
          </button>
        </p>
      )}

      <p className="mt-6 text-center text-[10px] text-zoca-text-soft">
        Generated at {new Date(generatedAt).toLocaleString()}
      </p>

      {/* Phase 32 — onboarding tour (first-run only; ?force-tour=1 overrides) */}
      {customers.length > 0 && <V2OnboardingTour />}

      {/* Phase 32 — keyboard shortcuts cheat sheet */}
      <V2KeyboardShortcutsOverlay
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
    </section>
  );
}

function scrollFocusedCardIntoView(entityId: string): void {
  if (typeof window === "undefined") return;
  const el = document.querySelector<HTMLElement>(
    `[data-entity-id="${cssEscapeId(entityId)}"]`,
  );
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.top < 80 || rect.bottom > window.innerHeight - 40) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function cssEscapeId(value: string): string {
  if (typeof window !== "undefined" && "CSS" in window && typeof (window as Window & { CSS?: { escape?: (s: string) => string } }).CSS?.escape === "function") {
    return (window as Window & { CSS: { escape: (s: string) => string } }).CSS.escape(value);
  }
  return value.replace(/[^\-_a-zA-Z0-9]/g, (ch) => `\\${ch}`);
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label} — ${count} customers`}
      className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition focus-visible:outline-none focus-visible:ring-2"
      style={
        active
          ? {
              borderColor: "var(--zoca-pink)",
              background:
                "linear-gradient(180deg, rgba(200, 67, 29, 0.06), rgba(252, 228, 214, 0.08))",
              color: "var(--zoca-text)",
            }
          : {
              borderColor: "var(--zoca-border)",
              background: "var(--zoca-bg-soft)",
              color: "var(--zoca-text-2)",
            }
      }
    >
      <span>{label}</span>
      <span
        className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
        style={
          active
            ? { background: "rgba(200, 67, 29, 0.14)", color: "var(--zoca-pink-bright)" }
            : { background: "var(--zoca-bg-soft)", color: "var(--zoca-text-2)" }
        }
      >
        <AnimatedNumber value={count} duration={900} />
      </span>
    </button>
  );
}

function V2EmptyState({ filter, hasQuery }: { filter: FilterKey; hasQuery: boolean }) {
  if (hasQuery) {
    return (
      <EmptyState
        variant="filter-empty"
        title="No customers match your search."
        subtitle="Try a different name, or clear the search to see the full filter."
      />
    );
  }
  const messages: Record<FilterKey, { title: string; body: string; variant: "all-clear" | "filter-empty" | "snoozed-none" | "pinned-none" }> = {
    pinned: {
      title: "Nothing pinned yet.",
      body: "Click the pin icon on any customer card to add it here.",
      variant: "pinned-none",
    },
    act: {
      title: "You're caught up.",
      body: "No customers in your book need urgent attention right now. Nice work.",
      variant: "all-clear",
    },
    // Phase 33.A.1 — added watch + healthy to match the FilterKey union extended
    // in Phase 32.1 (was previously missing here, causing TS2739 build error).
    watch: {
      title: "No customers in the watch tier.",
      body: "Your YELLOW lane is clear. Watch this space — customers can shift into it as signals change.",
      variant: "all-clear",
    },
    healthy: {
      title: "No GREEN customers yet.",
      body: "Your healthy lane is empty. Either your book is new or every customer needs attention right now.",
      variant: "filter-empty",
    },
    improving: {
      title: "Nothing clearly improving yet.",
      body: "Trend data needs a few days of history. Check back later this week.",
      variant: "filter-empty",
    },
    quiet: {
      title: "No one's gone silent.",
      body: "Every customer in your book has been in touch within the last 30 days.",
      variant: "all-clear",
    },
    all: {
      title: "Your book is empty.",
      body: "No customers in your book — either you're brand new or your accounts haven't loaded.",
      variant: "filter-empty",
    },
    snoozed: {
      title: "No snoozed customers.",
      body: "Snooze a customer to come back to them later. They'll reappear in your book when the snooze expires.",
      variant: "snoozed-none",
    },
  };
  const m = messages[filter];
  return <EmptyState variant={m.variant} title={m.title} subtitle={m.body} />;
}

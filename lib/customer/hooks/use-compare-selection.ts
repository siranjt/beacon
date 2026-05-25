"use client";

/**
 * Multi-customer comparison — selection store.
 * Phase E-14.
 *
 * A tiny module-scoped store backed by `useSyncExternalStore` so any
 * component can read/toggle selections without prop-drilling and without
 * needing a React Context provider. Both the checkbox on V2CustomerCard
 * and the floating <V2CompareBar /> subscribe to the same store.
 *
 * Selection is transient — kept in memory only, not persisted to
 * localStorage. Refreshing the page or navigating away clears it. This is
 * intentional: a stale selection from yesterday in the corner of the screen
 * is more confusing than helpful.
 */

import { useSyncExternalStore } from "react";

const MAX_COMPARE = 3;

type Listener = () => void;
const listeners = new Set<Listener>();
let selection: string[] = [];

function snapshot(): string[] {
  return selection;
}

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useCompareSelection(): {
  selected: string[];
  count: number;
  has: (entityId: string) => boolean;
  toggle: (entityId: string) => void;
  remove: (entityId: string) => void;
  clear: () => void;
  isFull: boolean;
  max: number;
} {
  const selected = useSyncExternalStore(
    subscribe,
    snapshot,
    // Server snapshot — always empty so server-rendered HTML doesn't show
    // selections (which would be hydration-mismatch territory anyway since
    // the store is browser-only).
    () => [] as string[],
  );

  return {
    selected,
    count: selected.length,
    has: (id) => selected.includes(id),
    toggle: (id) => {
      if (selection.includes(id)) {
        selection = selection.filter((x) => x !== id);
      } else if (selection.length < MAX_COMPARE) {
        selection = [...selection, id];
      } else {
        // At cap. Refuse to add. UI should disable the checkbox.
        return;
      }
      emit();
    },
    remove: (id) => {
      if (!selection.includes(id)) return;
      selection = selection.filter((x) => x !== id);
      emit();
    },
    clear: () => {
      if (selection.length === 0) return;
      selection = [];
      emit();
    },
    isFull: selected.length >= MAX_COMPARE,
    max: MAX_COMPARE,
  };
}

/**
 * Programmatic accessor for non-React consumers (e.g. command palette
 * actions that need to seed the selection before navigating to /compare).
 */
export function setCompareSelection(ids: string[]): void {
  selection = Array.from(new Set(ids)).slice(0, MAX_COMPARE);
  emit();
}

"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "beacon.performance.recent";
const MAX_STORED = 8;

export type RecentReport = {
  entityId: string;
  bizname: string;
  vertical: string;
  location: string;
  openedAt: number; // unix ms
};

/**
 * React hook — reads recent-reports from localStorage on mount. Returns an
 * empty array on first render (SSR-safe) and populates after hydration.
 */
export function useRecentReports(): RecentReport[] {
  const [list, setList] = useState<RecentReport[]>([]);

  useEffect(() => {
    setList(loadRecent());
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setList(loadRecent());
    };
    window.addEventListener("storage", handler);
    // Also poll on focus — same-tab writes don't fire the storage event.
    const focusHandler = () => setList(loadRecent());
    window.addEventListener("focus", focusHandler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("focus", focusHandler);
    };
  }, []);

  return list;
}

function loadRecent(): RecentReport[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is RecentReport =>
          typeof x === "object" &&
          x != null &&
          typeof x.entityId === "string" &&
          typeof x.bizname === "string"
      )
      .slice(0, MAX_STORED);
  } catch {
    return [];
  }
}

/**
 * Push a report onto the recent list. De-dupes by entityId (most recent wins).
 * Caps the list at MAX_STORED. Safe in SSR / disabled-storage environments.
 */
export function recordRecentReport(r: RecentReport): void {
  if (typeof window === "undefined") return;
  try {
    const list = loadRecent();
    const filtered = list.filter((x) => x.entityId !== r.entityId);
    filtered.unshift(r);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(filtered.slice(0, MAX_STORED))
    );
  } catch {
    /* swallow — quota exceeded or storage disabled */
  }
}

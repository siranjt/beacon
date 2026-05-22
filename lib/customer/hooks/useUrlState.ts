"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

// ---------------------------------------------------------------------------
// Phase 22.B.1 — URL state sync hook.
//
// Binds an in-memory React state value to a URL search-param. When the value
// changes, the URL is updated via `router.replace` (scroll:false, no history
// entry). When the value equals `defaultValue` or is empty, the param is
// removed entirely (keeps URLs clean — no `?foo=` noise).
//
// Pair this with `useUrlStateRead` for one-time read on mount.
// ---------------------------------------------------------------------------

export function useUrlState(
  key: string,
  value: string | null,
  defaultValue: string | null = null,
) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const current = searchParams.get(key);
    const normalizedValue =
      value === defaultValue || value === "" || value === null ? null : value;
    if (normalizedValue === current) return;

    const params = new URLSearchParams(searchParams.toString());
    if (normalizedValue === null) {
      params.delete(key);
    } else {
      params.set(key, normalizedValue);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [key, value, defaultValue, router, pathname, searchParams]);
}

export function useUrlStateRead(
  key: string,
  defaultValue: string | null = null,
): string | null {
  const searchParams = useSearchParams();
  return searchParams.get(key) ?? defaultValue;
}

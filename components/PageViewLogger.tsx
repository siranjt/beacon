"use client";

/**
 * PageViewLogger — drop-in on any page/landing component. Phase E-8.
 *
 * Renders nothing. Fires a single `page_view` activity event via the umbrella
 * logger on mount, tagged with the given agent + surface. Use this instead of
 * inlining the useEffect everywhere — most pages only need the page_view, so
 * a one-line component reads cleaner than a custom hook setup per file.
 *
 * Usage:
 *   <PageViewLogger agent="performance" surface="performance_landing" />
 *
 * For click events, use useActivityLogger("performance") in the same
 * component and call log("event_name", { ... }) from the relevant onClick.
 */

import { useEffect } from "react";
import { useActivityLogger } from "./hooks/use-activity-logger";
import type { Agent, AnySurface } from "@/lib/activity/types";

interface Props {
  agent: Agent;
  surface: AnySurface | string;
  /** Optional metadata to attach to the page_view event. */
  metadata?: Record<string, unknown>;
}

export default function PageViewLogger({ agent, surface, metadata }: Props) {
  const log = useActivityLogger(agent);
  useEffect(() => {
    log("page_view", { surface, metadata });
    // We intentionally fire once per mount — re-rendering this component
    // does not re-log unless its key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

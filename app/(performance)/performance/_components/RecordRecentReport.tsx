"use client";

import { useEffect } from "react";
import { recordRecentReport } from "./useRecentReports";

/**
 * Invisible client tag — when the report page renders, this writes the
 * entity to the user's localStorage recent list. Mounted on every full
 * report view; idempotent (de-dupes by entityId).
 */
export default function RecordRecentReport({
  entityId,
  bizname,
  vertical,
  location,
}: {
  entityId: string;
  bizname: string;
  vertical: string;
  location: string;
}) {
  useEffect(() => {
    recordRecentReport({
      entityId,
      bizname,
      vertical,
      location,
      openedAt: Date.now(),
    });
  }, [entityId, bizname, vertical, location]);
  return null;
}

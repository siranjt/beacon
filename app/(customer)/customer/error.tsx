"use client";

/**
 * Customer Beacon route-segment error boundary. Phase E-9.
 *
 * Caught by Next.js when an error escapes any nested boundary under
 * /customer/*. Keeps the rest of the umbrella usable — clicking
 * "Back to launcher" or any agent in the user menu still works.
 */

import { useEffect } from "react";
import { AgentErrorScreen } from "@/components/AgentErrorScreen";

export default function CustomerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[Customer Beacon error]", error);
  }, [error]);
  return (
    <AgentErrorScreen
      agentLabel="Customer Beacon"
      error={error}
      reset={reset}
      agentPath="/customer"
    />
  );
}

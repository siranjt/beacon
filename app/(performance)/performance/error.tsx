"use client";

import { useEffect } from "react";
import { AgentErrorScreen } from "@/components/AgentErrorScreen";

export default function PerformanceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[Performance Beacon error]", error);
  }, [error]);
  return (
    <AgentErrorScreen
      agentLabel="Performance Beacon"
      error={error}
      reset={reset}
      agentPath="/performance"
    />
  );
}

"use client";

import { useEffect } from "react";
import { AgentErrorScreen } from "@/components/AgentErrorScreen";

export default function EscalationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[Escalation Beacon error]", error);
  }, [error]);
  return (
    <AgentErrorScreen
      agentLabel="Escalation Beacon"
      error={error}
      reset={reset}
      agentPath="/escalation"
    />
  );
}

"use client";

import { useEffect } from "react";
import { AgentErrorScreen } from "@/components/AgentErrorScreen";

export default function PostPaymentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[Post-Payment Reviews error]", error);
  }, [error]);
  return (
    <AgentErrorScreen
      agentLabel="Post-Payment Reviews"
      error={error}
      reset={reset}
      agentPath="/post-payment"
    />
  );
}

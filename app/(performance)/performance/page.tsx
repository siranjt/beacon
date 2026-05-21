import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import PerformanceLanding from "./_components/PerformanceLanding";
import SamplePreview, { PreviewSkeleton } from "./_components/SamplePreview";

/**
 * Performance Beacon — landing page.
 *
 * Server: gates on NextAuth, then renders the client shell (hero + search +
 * sample-card grid) with a Suspense-streamed preview slot. The sample entity
 * is fetched server-side so the preview is real data; the hero + grid render
 * instantly while the preview streams in below.
 */
export const dynamic = "force-dynamic";

const SAMPLE_ENTITY_ID = "a24bbd56-42ab-4540-9769-7cf65fadeaa6"; // Sheila Marie Aesthetics

export default async function PerformanceLandingPage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/auth/signin");
  }
  return (
    <PerformanceLanding>
      <Suspense fallback={<PreviewSkeleton />}>
        <SamplePreview entityId={SAMPLE_ENTITY_ID} />
      </Suspense>
    </PerformanceLanding>
  );
}

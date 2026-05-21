import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { composeReport } from "@/lib/report/compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Performance Beacon — preview JSON.
 *
 * Fetches the entity's report data, composes it, returns the composed
 * report as JSON for the client-side preview swap. Gated by NextAuth.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { entityId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const entityId = params.entityId;
  if (!entityId || entityId.length < 8) {
    return NextResponse.json({ error: "Missing or invalid entityId" }, { status: 400 });
  }

  try {
    const data = await fetchEntityReportData(entityId);
    if (!data) {
      return NextResponse.json(
        { error: `No location found for entity_id ${entityId}` },
        { status: 404 }
      );
    }
    const report = composeReport(data, {});
    return NextResponse.json({ report });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

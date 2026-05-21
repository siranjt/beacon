import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchEntityReportData } from "@/lib/report/fetchers";
import { composeReport } from "@/lib/report/compose";
import { buildDocxBuffer } from "@/lib/report/render/docx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Performance Beacon — DOCX export.
 *
 * Fetches the entity's report data, composes the report shape, renders to a
 * DOCX buffer, and streams it back as an attachment. Gated by the umbrella's
 * NextAuth session — returns 401 if not signed in.
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
    return new Response(
      JSON.stringify({ error: "Missing or invalid entityId" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  try {
    const data = await fetchEntityReportData(entityId);
    if (!data) {
      return new Response(
        JSON.stringify({ error: `No location found for entity_id ${entityId}` }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }
    const report = composeReport(data, {});
    const buffer = await buildDocxBuffer(report);

    const safeTitle = report.identity.title
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
    const filename = `${safeTitle || "zoca_report"}_${report.reportMonth.replace(
      " ",
      "_"
    )}.docx`;

    return new Response(buffer, {
      status: 200,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}

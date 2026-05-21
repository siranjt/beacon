/**
 * DOCX renderer — turns a ComposedReport into a Word document buffer.
 * Uses the `docx` npm package (no Java dep, pure TypeScript).
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { fmtMonth, type ComposedReport } from "../compose";
import type { Lead } from "../types";
import type { RenderedAction } from "../checklist";

const ZOCA_BLUE_HEX = "4472C4";
const TILE_BG_HEX = "F4F7FC";
const CALLOUT_INFO_HEX = "E7F0FF";
const CALLOUT_WARN_HEX = "FFF4E6";
const CALLOUT_OK_HEX = "E6F4EA";

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function buildDocxBuffer(
  report: ComposedReport
): Promise<Buffer> {
  const doc = new Document({
    creator: "Zoca",
    title: `${report.identity.title} — Local SEO & Growth Report`,
    description: `Performance report for ${report.identity.title}`,
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        children: [
          ...renderHeader(report),
          ...renderSnapshot(report),
          ...renderLeadSourceCallout(report),
          ...renderGbpClicks(report),
          ...renderKeywords(report),
          ...renderLeads(report),
          ...renderRca(report),
          ...renderChecklist(report),
          ...renderForecast(report),
          ...renderGrowthManagerNote(report),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const text = (
  s: string,
  opts: { bold?: boolean; size?: number; color?: string; italics?: boolean } = {}
) =>
  new TextRun({
    text: s,
    bold: opts.bold,
    size: opts.size,
    color: opts.color,
    italics: opts.italics,
  });

const p = (children: TextRun[] | string) =>
  new Paragraph({
    children: typeof children === "string" ? [text(children)] : children,
    spacing: { after: 120 },
  });

const h2 = (s: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [text(s, { bold: true, color: ZOCA_BLUE_HEX, size: 28 })],
    spacing: { before: 320, after: 160 },
  });

const h3 = (s: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [text(s, { bold: true, size: 24 })],
    spacing: { before: 200, after: 100 },
  });

const bulletItem = (s: string) =>
  new Paragraph({ text: s, bullet: { level: 0 }, spacing: { after: 60 } });

function callout(text: string, hex: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text, size: 22 }),
    ],
    shading: { type: ShadingType.CLEAR, color: "auto", fill: hex },
    spacing: { before: 100, after: 200 },
    indent: { left: 100 },
  });
}

function makeTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map(
          (h) =>
            new TableCell({
              shading: { type: ShadingType.CLEAR, color: "auto", fill: ZOCA_BLUE_HEX },
              children: [
                new Paragraph({
                  children: [text(h, { bold: true, color: "FFFFFF", size: 20 })],
                }),
              ],
            })
        ),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (c) =>
                new TableCell({
                  children: [
                    new Paragraph({ children: [text(c, { size: 20 })] }),
                  ],
                })
            ),
          })
      ),
    ],
  });
}

function tile(headline: string, label: string, sub: string): TableCell {
  return new TableCell({
    shading: { type: ShadingType.CLEAR, color: "auto", fill: TILE_BG_HEX },
    children: [
      new Paragraph({
        children: [text(headline, { bold: true, color: ZOCA_BLUE_HEX, size: 36 })],
      }),
      new Paragraph({
        children: [text(label, { bold: true, size: 20 })],
        spacing: { before: 60 },
      }),
      new Paragraph({
        children: [text(sub, { color: "666666", size: 18 })],
      }),
    ],
  });
}

function tilesRow(tiles: TableCell[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: tiles })],
  });
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(r: ComposedReport): Paragraph[] {
  const subtitle = `${r.identity.city ?? ""}${r.identity.state ? ", " + r.identity.state : ""}`.trim();
  return [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [text(r.identity.title, { bold: true, size: 36 })],
      spacing: { after: 120 },
    }),
    p([text("Local SEO & Growth Performance Report", { size: 22, color: "555555" })]),
    p([
      text(`Prepared for ${r.identity.title} | ${r.reportMonth}`, {
        size: 20,
        color: "666666",
      }),
      ...(subtitle
        ? [text(`  ·  ${subtitle}`, { size: 20, color: "666666" })]
        : []),
    ]),
  ];
}

function renderSnapshot(r: ComposedReport): (Paragraph | Table)[] {
  const t = r.snapshot;
  return [
    h2("Performance snapshot at a glance"),
    tilesRow([
      tile(
        t.totalGbpLeadsYtd.toLocaleString(),
        "Total GBP Leads (YTD)",
        "Active pipeline"
      ),
      tile(t.bookedLeads.toString(), "Booked Leads", "Confirmed bookings"),
      tile(
        t.predicted6MonthRevenue != null
          ? `$${t.predicted6MonthRevenue.toLocaleString()}`
          : "—",
        "Predicted 6-Month Revenue",
        t.predicted6MonthLeads != null
          ? `${t.predicted6MonthLeads} leads forecast`
          : "Baseline projection"
      ),
      tile(
        t.weeklyReviewTarget != null ? `${t.weeklyReviewTarget} reviews` : "—",
        "Weekly Review Target",
        "Per week"
      ),
    ]),
  ];
}

function renderLeadSourceCallout(r: ComposedReport): Paragraph[] {
  const top = r.leadSourceMix[0];
  if (!top) return [];
  const message =
    top.source === "Google Maps GBP"
      ? `📍 ${top.pct}% of your recent leads are coming directly from Google Maps GBP — your Zoca-powered profile is your #1 lead engine right now.`
      : `📍 ${top.pct}% of your recent leads are coming from ${top.source}.`;
  return [callout(message, CALLOUT_INFO_HEX)];
}

function renderGbpClicks(r: ComposedReport): (Paragraph | Table)[] {
  const ct = r.clicksTrend;
  const out: (Paragraph | Table)[] = [h2("Google Business Profile — what's working")];
  const start = ct.sampledMonths[0];
  if (start && ct.peak && ct.current) {
    out.push(
      p(
        `Profile click trajectory from ${fmtMonth(start.month)} to ${fmtMonth(
          ct.current.month
        )} — peaking at ${ct.peak.clicks.toLocaleString()} profile clicks in ${fmtMonth(
          ct.peak.month
        )}.`
      )
    );
  }
  if (ct.sampledMonths.length > 0) {
    out.push(
      makeTable(
        ["Month", ...ct.sampledMonths.map((m) => fmtMonth(m.month))],
        [
          [
            "Profile clicks",
            ...ct.sampledMonths.map(
              (m) =>
                `~${m.profileClicks.toLocaleString()}${
                  ct.peak && m.month === ct.peak.month ? " ⭐" : ""
                }`
            ),
          ],
        ]
      )
    );
  }
  if (ct.dipPct != null && ct.dipPct >= 30 && ct.peak && ct.current) {
    out.push(
      callout(
        `⚠ Profile clicks declined ${ct.dipPct}% from ${fmtMonth(
          ct.peak.month
        )} to ${fmtMonth(ct.current.month)}. See the RCA section below.`,
        CALLOUT_WARN_HEX
      )
    );
  } else if (ct.dipPct != null && ct.dipPct < 0) {
    out.push(callout("✅ Profile clicks are holding up well — current month is in line with peak.", CALLOUT_OK_HEX));
  }
  return out;
}

function renderKeywords(r: ComposedReport): (Paragraph | Table)[] {
  if (!r.keywords.length) return [];
  const wins = r.keywords.filter(
    (k) =>
      k.rankWhenJoined != null &&
      k.rankCurrent != null &&
      k.rankWhenJoined - k.rankCurrent >= 50
  );
  const out: (Paragraph | Table)[] = [h2("Top keyword rankings")];
  out.push(
    p("Despite any visibility shifts, your keyword rankings tell a strong story:")
  );
  out.push(
    makeTable(
      ["Keyword", "When you joined", "Best rank", "Current rank"],
      r.keywords.slice(0, 10).map((k) => [
        k.keyword,
        k.rankWhenJoined?.toString() ?? "—",
        `${k.rankBest ?? "—"}${k.rankBest != null && k.rankBest <= 3 ? " 🏆" : ""}`,
        k.rankCurrent?.toString() ?? "—",
      ])
    )
  );
  if (wins.length) {
    out.push(
      callout(
        `🏆 Major wins: ${wins
          .slice(0, 3)
          .map(
            (w) =>
              `'${w.keyword}' jumped from rank ${w.rankWhenJoined} to ${w.rankCurrent}`
          )
          .join("; ")}.`,
        CALLOUT_OK_HEX
      )
    );
  }
  return out;
}

function renderLeads(r: ComposedReport): (Paragraph | Table)[] {
  const recent = r.leads.slice(0, 12);
  if (!recent.length) return [];
  const out: (Paragraph | Table)[] = [h2(`Leads analysis — ${r.leads.length} recent leads`)];
  out.push(
    makeTable(
      ["Customer", "Created", "Service", "Status", "Type"],
      recent.map((l) => [
        customerLabel(l),
        shortDate(l.createdAt),
        l.service || l.serviceVariationName || "(no service)",
        l.status,
        l.customerType ?? "—",
      ])
    )
  );
  const unmarked = r.leads.filter((l) => l.status === "UNMARKED").length;
  if (unmarked) {
    out.push(
      callout(
        `⚡ Action required: ${unmarked} of ${r.leads.length} leads are currently UNMARKED. Update status in the Zoca app to improve forecast accuracy.`,
        CALLOUT_WARN_HEX
      )
    );
  }
  return out;
}

function renderRca(r: ComposedReport): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [h2("RCA update — profile click trend investigation")];
  out.push(
    p(
      "We track every entity's profile-click trajectory continuously. This section gives you the latest read on visibility and what we're acting on."
    )
  );
  const rows: string[][] = [
    [
      "Peak month",
      r.rca.peak
        ? `${fmtMonth(r.rca.peak.month)} (~${r.rca.peak.clicks.toLocaleString()} clicks)`
        : "—",
    ],
    [
      "Current month",
      r.rca.current
        ? `${fmtMonth(r.rca.current.month)} (~${r.rca.current.clicks.toLocaleString()} clicks)`
        : "—",
    ],
    [
      "Change from peak",
      r.rca.dipPct != null
        ? r.rca.dipPct > 0
          ? `↓ ${r.rca.dipPct}%`
          : `↑ ${Math.abs(r.rca.dipPct)}%`
        : "—",
    ],
  ];
  if (r.rca.ticketId) {
    rows.push([
      "RCA ticket",
      `${r.rca.ticketId}${r.rca.status ? " — " + r.rca.status : ""}`,
    ]);
  }
  out.push(makeTable(["Factor", "Details"], rows));
  out.push(
    r.rca.showDipBanner
      ? callout(
          "⚠ A material dip has been detected. The action checklist below has been re-prioritized — refreshing GBP photos and posting an offer typically recover visibility within 2–3 weeks.",
          CALLOUT_WARN_HEX
        )
      : callout(
          "✅ Click volume is stable. We continue to monitor for any emerging dips and will surface them automatically here.",
          CALLOUT_OK_HEX
        )
  );
  return out;
}

function renderChecklist(r: ComposedReport): (Paragraph | Table)[] {
  if (!r.actions.length) return [];
  const out: (Paragraph | Table)[] = [h2("What you can do right now — action checklist")];
  r.actions.forEach((a, idx) => {
    out.push(actionTitle(idx + 1, a));
    if (a.intro) out.push(p(a.intro));
    if (a.bullets) for (const b of a.bullets) out.push(bulletItem(b));
    if (a.table) {
      if (a.table.caption) out.push(p([text(a.table.caption, { color: "666666", size: 18 })]));
      out.push(makeTable(a.table.headers, a.table.rows));
    }
    if (a.closing) out.push(p(a.closing));
    out.push(
      p([text(`Why this is here: ${a.rationale}`, { italics: true, color: "888888", size: 18 })])
    );
  });
  return out;
}

function actionTitle(num: number, a: RenderedAction): Paragraph {
  const children: TextRun[] = [
    text(`${num}. ${a.title}`, { bold: true, size: 24 }),
  ];
  if (a.emphasis === "high_impact") {
    children.push(text("   [HIGH IMPACT]", { bold: true, color: ZOCA_BLUE_HEX, size: 18 }));
  }
  return new Paragraph({
    children,
    spacing: { before: 200, after: 80 },
  });
}

function renderForecast(r: ComposedReport): (Paragraph | Table)[] {
  const f = r.forecast;
  if (!f) return [];
  return [
    h2("6-month forecast"),
    tilesRow([
      tile(
        f.predicted6MonthLeads?.toString() ?? "—",
        "Projected leads (6 months)",
        f.predicted6MonthLeads
          ? `+${Math.round(f.predicted6MonthLeads / 26)} per week target`
          : "—"
      ),
      tile(
        f.predicted6MonthRevenue != null
          ? `$${f.predicted6MonthRevenue.toLocaleString()}`
          : "—",
        "Predicted revenue",
        "Baseline projection"
      ),
      tile(
        f.percentageChangeProfileClicks != null
          ? `${f.percentageChangeProfileClicks > 0 ? "+" : ""}${f.percentageChangeProfileClicks}%`
          : "—",
        "Predicted click change",
        "Versus without-Zoca baseline"
      ),
    ]),
    callout(
      "💡 Following up on every incoming lead and updating their status in the Zoca app helps the algorithm produce more accurate (and higher) forecasts.",
      CALLOUT_INFO_HEX
    ),
  ];
}

function renderGrowthManagerNote(r: ComposedReport): Paragraph[] {
  return [
    h2("A note from your Growth Manager"),
    p(`Hi ${r.identity.title} team,`),
    p(
      `Thanks for being an active member of the Zoca family. The traction you've built shows there's a strong market for what you offer in ${r.identity.city ?? "your area"}.${
        r.rca.showDipBanner
          ? " The current dip is something we take seriously — please give the action checklist above your attention this week."
          : " Keep up the steady work — and use the action checklist above to compound the lead pipeline week over week."
      }`
    ),
    p(
      "The single biggest things you can do this week are at the top of the checklist. Reach out anytime."
    ),
    p([text(r.growthManagerName, { bold: true })]),
    p([text("Senior Growth Manager, Zoca", { color: "666666", size: 18 })]),
  ];
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function customerLabel(l: Lead): string {
  const name = [l.firstName, l.lastName].filter(Boolean).join(" ").trim();
  return name || l.email || l.phone || l.id.slice(0, 8);
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

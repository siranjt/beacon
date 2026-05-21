// Post-Payment Account Review — Word document template.
// Parameterised: takes a `data` object (see report_schema.example.json) and
// returns a docx Document. Static structure (cover, headings, glossary,
// Module 02 summary, references) lives here; per-customer narrative + status
// pills + tables come from `data`.

const {
  Document, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, LevelFormat, PageNumber, PageBreak, ExternalHyperlink,
} = require("docx");

// ---------- color tokens ----------
const COLOR_HEADER_BG = "1F3864";
const COLOR_HEADER_TEXT = "FFFFFF";
const COLOR_PART_BG = "2F5496";
const COLOR_BANNER_BG = "FFF8E1";
const COLOR_BANNER_BORDER = "B45F06";
const COLOR_PASS = "1B7E3C";
const COLOR_FAIL = "9C1B22";
const COLOR_WARN = "B45F06";
const COLOR_GAP = "595959";
const COLOR_QUOTE_BG = "F5F5F5";
const COLOR_BORDER = "BFBFBF";
const COLOR_INFO_BG = "E7EEF7";
const COLOR_RULE_LINE = "D0D7E2";
const CW = 9360;

// status code → { text, color }
const STATUS_MAP = {
  PASS:     { text: "Pass",            color: COLOR_PASS },
  FAIL:     { text: "Fail",            color: COLOR_FAIL },
  AUTOFAIL: { text: "Automatic fail",  color: COLOR_FAIL },
  WARN:     { text: "Caution",         color: COLOR_WARN },
  RISK:     { text: "Elevated risk",   color: COLOR_WARN },
  GAP:      { text: "Not verified",    color: COLOR_GAP },
  DG:       { text: "Data gap",        color: COLOR_GAP },
  DQ:       { text: "Disqualifier",    color: COLOR_FAIL },
  BORDER:   { text: "Borderline",      color: COLOR_WARN },
  MIXED:    { text: "Mixed",           color: COLOR_WARN },
};
function resolveStatus(s) {
  if (!s) return STATUS_MAP.GAP;
  if (typeof s === "string") return STATUS_MAP[s] || { text: s, color: COLOR_GAP };
  // {text, color} passthrough
  return s;
}

// ---------- low-level paragraph / cell helpers ----------
const border = (c = COLOR_BORDER) => ({ style: BorderStyle.SINGLE, size: 4, color: c });
const cellBorders = (c = COLOR_BORDER) => ({ top: border(c), bottom: border(c), left: border(c), right: border(c) });

const para = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 120, line: opts.line ?? 300 },
  alignment: opts.alignment,
  children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size ?? 22, color: opts.color, font: "Calibri" })],
});
const richPara = (runs, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 120, line: opts.line ?? 300 },
  alignment: opts.alignment, children: runs,
});

const h1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 180 },
  children: [new TextRun({ text, bold: true, size: 30, font: "Calibri", color: COLOR_HEADER_BG })],
});
const h2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 120 },
  children: [new TextRun({ text, bold: true, size: 24, font: "Calibri", color: COLOR_HEADER_BG })],
});
const h3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 200, after: 100 },
  children: [new TextRun({ text, bold: true, size: 22, font: "Calibri" })],
});

const bullet = (text, level = 0) => new Paragraph({
  numbering: { reference: "bullets", level },
  spacing: { after: 80, line: 280 },
  children: [new TextRun({ text, size: 22, font: "Calibri" })],
});
const richBullet = (runs, level = 0) => new Paragraph({
  numbering: { reference: "bullets", level },
  spacing: { after: 80, line: 280 },
  children: runs,
});
const numberedItem = (text) => new Paragraph({
  numbering: { reference: "numbered", level: 0 },
  spacing: { after: 80, line: 280 },
  children: [new TextRun({ text, size: 22, font: "Calibri" })],
});

const blockquote = (text, attribution) => {
  const children = [new TextRun({ text, italics: true, size: 22, font: "Calibri" })];
  if (attribution) {
    children.push(new TextRun({ text: " — " + attribution, size: 20, font: "Calibri", color: "595959" }));
  }
  return new Paragraph({
    spacing: { before: 140, after: 140 },
    indent: { left: 720, right: 360 },
    shading: { type: ShadingType.CLEAR, fill: COLOR_QUOTE_BG },
    border: { left: { style: BorderStyle.SINGLE, size: 14, color: COLOR_HEADER_BG, space: 8 } },
    children,
  });
};

const tHead = (text, width) => new TableCell({
  borders: cellBorders(COLOR_HEADER_BG),
  shading: { type: ShadingType.CLEAR, fill: COLOR_HEADER_BG },
  width: { size: width, type: WidthType.DXA },
  margins: { top: 100, bottom: 100, left: 140, right: 140 },
  children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: COLOR_HEADER_TEXT, size: 22, font: "Calibri" })] })],
});

const tCell = (content, width, opts = {}) => {
  let kids;
  if (Array.isArray(content)) kids = content;
  else if (typeof content === "string") {
    kids = [new Paragraph({ spacing: { line: 280 }, children: [new TextRun({ text: content, size: 22, font: "Calibri", bold: opts.bold, color: opts.color })] })];
  } else kids = [content];
  return new TableCell({
    borders: cellBorders(),
    width: { size: width, type: WidthType.DXA },
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill } : undefined,
    margins: { top: 90, bottom: 90, left: 140, right: 140 },
    children: kids,
  });
};
const statusRun = (s, size) => {
  const r = resolveStatus(s);
  return new TextRun({ text: r.text, bold: true, size: size || 22, font: "Calibri", color: r.color });
};
const statusCell = (s, width) => tCell([new Paragraph({ children: [statusRun(s)] })], width);

// Two-column source/signal banner
const sourceBanner = (sourceLabel, signalLabel, signalStatus) => {
  const status = resolveStatus(signalStatus);
  return new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [4680, 4680],
    rows: [new TableRow({ children: [
      new TableCell({
        borders: cellBorders(),
        shading: { type: ShadingType.CLEAR, fill: COLOR_INFO_BG },
        width: { size: 4680, type: WidthType.DXA },
        margins: { top: 90, bottom: 90, left: 140, right: 140 },
        children: [new Paragraph({ children: [
          new TextRun({ text: "Data source: ", bold: true, size: 20, font: "Calibri" }),
          new TextRun({ text: sourceLabel, size: 20, font: "Calibri" }),
        ]})],
      }),
      new TableCell({
        borders: cellBorders(),
        shading: { type: ShadingType.CLEAR, fill: COLOR_BANNER_BG },
        width: { size: 4680, type: WidthType.DXA },
        margins: { top: 90, bottom: 90, left: 140, right: 140 },
        children: [new Paragraph({ children: [
          new TextRun({ text: "Signal: ", bold: true, size: 20, font: "Calibri" }),
          new TextRun({ text: signalLabel, bold: true, size: 20, font: "Calibri", color: status.color }),
        ]})],
      }),
    ]})],
  });
};

const calloutBanner = (children, fillColor, borderColor) => new Table({
  width: { size: CW, type: WidthType.DXA },
  columnWidths: [CW],
  rows: [new TableRow({ children: [
    new TableCell({
      borders: cellBorders(borderColor || COLOR_BANNER_BORDER),
      shading: { type: ShadingType.CLEAR, fill: fillColor },
      width: { size: CW, type: WidthType.DXA },
      margins: { top: 200, bottom: 200, left: 240, right: 240 },
      children,
    }),
  ]})],
});

const linkRun = (text) => new TextRun({ text, size: 22, font: "Calibri", color: "1155CC", underline: {} });
const link = (text, url) => new ExternalHyperlink({ link: url, children: [linkRun(text)] });

// Render a list of "evidence blocks" — a typed mini-language so the LLM can
// produce structured per-pointer evidence.
//   { type: "para",        text: "..." }
//   { type: "bullet",      text: "..." }
//   { type: "blockquote",  text: "...", attribution: "..." (optional) }
//   { type: "h3",          text: "..." }
//   { type: "table",       columnWidths: [...], rows: [[ "..." | { value, bold, fill } ]] }
//   { type: "kv",          rows: [["Label", "Value"], ...] }   // 2-col key-value table
//   { type: "richpara",    runs: [{text, bold?, italics?}] }
function renderBlock(block) {
  switch (block.type) {
    case "para":       return [para(block.text)];
    case "bullet":     return [bullet(block.text)];
    case "blockquote": return [blockquote(block.text, block.attribution)];
    case "h3":         return [h3(block.text)];
    case "richpara":   return [richPara(
      (block.runs || []).map(r => new TextRun({
        text: r.text, bold: r.bold, italics: r.italics, size: 22, font: "Calibri", color: r.color,
      }))
    )];
    case "table": {
      const widths = block.columnWidths;
      const rows = (block.rows || []).map((row, idx) => {
        const isHeader = idx === 0 && block.headerRow !== false;
        return new TableRow({ tableHeader: isHeader, children: row.map((cell, i) => {
          const w = widths[i];
          const v = (typeof cell === "string") ? { value: cell } : cell;
          if (isHeader) return tHead(v.value, w);
          if (v.status) return statusCell(v.status, w);
          return tCell(v.value || "", w, { bold: v.bold, fill: v.fill, color: v.color });
        })});
      });
      return [new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: widths, rows }), para("", { after: 80 })];
    }
    case "kv": {
      const rows = block.rows.map(([k, v]) => new TableRow({ children: [
        tCell(k, 3000, { bold: true }),
        tCell(v, 6360),
      ]}));
      return [new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: [3000, 6360], rows }), para("", { after: 80 })];
    }
    default:
      return [para(`(unsupported block type: ${block.type})`, { italics: true, color: "9C1B22" })];
  }
}

function renderBlocks(blocks) {
  return (blocks || []).flatMap(renderBlock);
}

// ---------- top-level builder ----------

function buildReport(data) {
  const m = data.meta || {};
  const exec = data.exec || {};
  // Defensive coercion: every section can come in as an object, an array, or
  // be missing entirely (depending on what the LLM produced). We normalize
  // each one here so the rest of the builder doesn't have to guard every map.
  const asArray = (v) => Array.isArray(v) ? v : [];
  const sec1 = data.section1 || {};
  const secQual = data.section2_qualitative || data.qualitative_flags || {};
  const sec3 = data.section3_risks || {};
  if (!Array.isArray(sec3.risks)) sec3.risks = asArray(sec3.risks);
  const sec4 = data.section4_framework || {};
  for (const k of ["step1", "step2", "disqualifiers", "summary_table", "step2_row_evidence"]) {
    sec4[k] = asArray(sec4[k]);
  }
  const sec5 = asArray(data.section5_pointers);
  const sec6 = data.section6_actions || {};
  sec6.actions = asArray(sec6.actions);
  sec6.branch_paragraphs = asArray(sec6.branch_paragraphs);
  const sec7 = data.section7_systemic || {};
  sec7.recommendations = asArray(sec7.recommendations);
  // section8_gaps may be {items:[...]} OR {gaps:[...]} OR a raw array OR a
  // free-form object the model invented. Coerce to a flat array of strings.
  const rawSec8 = data.section8_gaps;
  let sec8Items = [];
  if (Array.isArray(rawSec8)) sec8Items = rawSec8;
  else if (rawSec8 && Array.isArray(rawSec8.items)) sec8Items = rawSec8.items;
  else if (rawSec8 && Array.isArray(rawSec8.gaps)) sec8Items = rawSec8.gaps.map(g => typeof g === "string" ? g : (g.gap || g.label || g.description || JSON.stringify(g)));
  const sec8 = { intro: rawSec8?.intro || "", items: sec8Items };
  // section9_evidence may be {methodology_paragraphs,evidence_trail} OR
  // {items:[...]} OR {intro,items:[...]}. Coerce to the canonical shape.
  const rawSec9 = data.section9_evidence || {};
  const sec9 = {
    methodology_paragraphs: asArray(rawSec9.methodology_paragraphs),
    evidence_trail: asArray(rawSec9.evidence_trail).length > 0
      ? asArray(rawSec9.evidence_trail)
      : asArray(rawSec9.items).map(i => typeof i === "string" ? i : (i.content || i.label || JSON.stringify(i))),
  };
  const refs = data.references || {};
  refs.entries = asArray(refs.entries);
  refs.matching_keys = asArray(refs.matching_keys);

  // ----- COVER -----
  const coverPage = [
    new Paragraph({ spacing: { before: 1800, after: 240 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: m.classification_banner || "ZOCA · CONFIDENTIAL", bold: true, size: 22, font: "Calibri", color: COLOR_WARN, allCaps: true })]}),
    new Paragraph({ spacing: { after: 0 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: m.title || "Post-Payment Account Review", bold: true, size: 56, font: "Calibri", color: COLOR_HEADER_BG })]}),
    new Paragraph({ spacing: { after: 360 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: m.subtitle || "ICP Fit Assessment & Post-Payment Pointer Analysis", italics: true, size: 26, font: "Calibri", color: "595959" })]}),
    new Paragraph({ spacing: { after: 120 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Subject account", size: 20, font: "Calibri", color: "595959" })]}),
    new Paragraph({ spacing: { after: 720 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: m.subject_account || "—", bold: true, size: 36, font: "Calibri" })]}),
  ];

  // ----- TOC -----
  const tocEntry = (label) => new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: label, size: 22, font: "Calibri", bold: true })],
  });
  const tableOfContents = [
    h1("Table of contents"),
    tocEntry("Executive summary"),
    tocEntry("Section 1 · Subject account & data scope"),
    tocEntry("Section 2 · Verdict and recommended action"),
    tocEntry("Section 2.5 · Qualitative red flags (quick read)"),
    tocEntry("Section 3 · Quantified risk register"),
    tocEntry("Section 4 · Module 02 framework analysis"),
    tocEntry("Section 5 · Post-payment pointer analysis (11 pointers)"),
    tocEntry("Section 6 · Per-account action plan"),
    tocEntry("Section 7 · Systemic recommendations (organisational)"),
    tocEntry("Section 8 · Open data gaps"),
    tocEntry("Section 9 · Evidence trail and methodology"),
    tocEntry("Appendix A · Glossary of terms"),
    tocEntry("Appendix B · Module 02 framework summary"),
    tocEntry("Appendix C · References & data sources"),
  ];

  // ----- VERDICT BANNER (used in exec summary + section 2) -----
  const verdictColor = resolveStatus(exec.verdict_status || "FAIL").color;
  const verdictBanner = calloutBanner([
    new Paragraph({ spacing: { after: 120 }, children: [
      new TextRun({ text: "Verdict: ", bold: true, size: 32, font: "Calibri" }),
      new TextRun({ text: exec.verdict_label || "Not ICP", bold: true, size: 32, font: "Calibri", color: verdictColor }),
      new TextRun({ text: "  ·  ", size: 32, font: "Calibri" }),
      new TextRun({ text: exec.recommended_action_label || "AM-led recovery or refund within 7 days", bold: true, size: 26, font: "Calibri", color: COLOR_WARN }),
    ]}),
    new Paragraph({ spacing: { after: 120 }, children: [
      new TextRun({ text: "Driver: ", bold: true, size: 22, font: "Calibri" }),
      new TextRun({ text: exec.driver || "—", size: 22, font: "Calibri" }),
    ]}),
    new Paragraph({ spacing: { after: 120 }, children: [
      new TextRun({ text: "Reinforcing flags: ", bold: true, size: 22, font: "Calibri" }),
      new TextRun({ text: exec.reinforcing_flags || "—", size: 22, font: "Calibri" }),
    ]}),
    new Paragraph({ children: [
      new TextRun({ text: "Mitigating factors: ", bold: true, size: 22, font: "Calibri" }),
      new TextRun({ text: exec.mitigating_factors || "—", size: 22, font: "Calibri" }),
    ]}),
  ], COLOR_BANNER_BG, verdictColor);

  // ----- EXEC SUMMARY -----
  const execSummary = [
    h1("Executive summary"),
    ...(exec.summary_paragraphs || []).map(t => para(t)),
  ];

  // ----- SECTION 1 -----
  const subjectTable = sec1.subject_table ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [3120, 6240],
    rows: sec1.subject_table.map((row, idx) => {
      if (idx === 0) return new TableRow({ children: [tHead(row[0], 3120), tHead(row[1], 6240)] });
      return new TableRow({ children: [tCell(row[0], 3120, { bold: true }), tCell(row[1], 6240)] });
    }),
  }) : null;

  const sourcesTable = sec1.data_sources_table ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [2400, 2160, 4800],
    rows: sec1.data_sources_table.map((row, idx) => {
      if (idx === 0) return new TableRow({ children: [tHead(row[0], 2400), tHead(row[1], 2160), tHead(row[2], 4800)] });
      return new TableRow({ children: [tCell(row[0], 2400), tCell(row[1], 2160), tCell(row[2], 4800)] });
    }),
  }) : null;

  // ----- QUALITATIVE FLAGS (between Section 2 and Section 3) -----
  // A quick-scan grid of softer signals — price sensitivity, sales urgency,
  // engagement quality, etc. — that the quantified risk register misses.
  // Each row has: signal (label), reading (status pill), evidence (one-liner).
  const qualFlags = Array.isArray(secQual.flags) ? secQual.flags : [];
  const qualTable = qualFlags.length ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [2800, 1500, 5060],
    rows: [
      new TableRow({ children: [tHead("Signal area", 2800), tHead("Reading", 1500), tHead("Evidence / note", 5060)] }),
      ...qualFlags.map(f => new TableRow({ children: [
        tCell(f.signal, 2800, { bold: true }),
        statusCell(f.reading, 1500),
        tCell(f.evidence, 5060),
      ]})),
    ],
  }) : null;

  // ----- SECTION 3 -----
  const riskRegisterTable = (sec3.risks && sec3.risks.length) ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [400, 2400, 1300, 1300, 3960],
    rows: [
      new TableRow({ children: [tHead("ID", 400), tHead("Risk", 2400), tHead("Likelihood", 1300), tHead("Impact", 1300), tHead("Driver / mitigation", 3960)] }),
      ...sec3.risks.map(r => new TableRow({ children: [
        tCell(r.id, 400),
        tCell(r.risk, 2400),
        statusCell(r.likelihood, 1300),
        statusCell(r.impact, 1300),
        tCell(r.driver_mitigation, 3960),
      ]})),
    ],
  }) : null;

  // ----- SECTION 4 -----
  const tierRule = calloutBanner([
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "Step 1.2 — six-month lead-prediction tier rule (confirmed by Sales Ops):", bold: true, size: 24, font: "Calibri" })]}),
    richBullet([new TextRun({ text: "Below 30 leads: ", bold: true, size: 22, font: "Calibri" }), new TextRun({ text: "Not ICP. Automatic fail.", size: 22, font: "Calibri", color: COLOR_FAIL })]),
    richBullet([new TextRun({ text: "30 to 60 leads: ", bold: true, size: 22, font: "Calibri" }), new TextRun({ text: "Possible ICP. Requires evaluation against Step 2 and additional disqualifiers.", size: 22, font: "Calibri", color: COLOR_WARN })]),
    richBullet([new TextRun({ text: "Above 60 leads: ", bold: true, size: 22, font: "Calibri" }), new TextRun({ text: "Likely ICP.", size: 22, font: "Calibri", color: COLOR_PASS })]),
    new Paragraph({ spacing: { before: 80 }, children: [new TextRun({
      text: sec4.tier_application || "—",
      italics: true, size: 22, font: "Calibri",
    })]}),
  ], COLOR_INFO_BG, COLOR_HEADER_BG);

  const step1Table = (sec4.step1 && sec4.step1.length) ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [2400, 1500, 5460],
    rows: [
      new TableRow({ children: [tHead("Gate", 2400), tHead("Status", 1500), tHead("Evidence and source", 5460)] }),
      ...sec4.step1.map(g => new TableRow({ children: [
        tCell(g.gate, 2400),
        statusCell(g.status, 1500),
        tCell(renderBlocks(Array.isArray(g.evidence) ? g.evidence : [{ type: "para", text: String(g.evidence || "") }]), 5460),
      ]})),
    ],
  }) : null;

  const step2Table = (sec4.step2 && sec4.step2.length) ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [2400, 1500, 5460],
    rows: [
      new TableRow({ children: [tHead("Rule", 2400), tHead("Status", 1500), tHead("Evidence and source", 5460)] }),
      ...sec4.step2.map(r => new TableRow({ children: [
        tCell(r.rule, 2400),
        statusCell(r.status, 1500),
        tCell(r.evidence, 5460),
      ]})),
    ],
  }) : null;

  const dqTable = (sec4.disqualifiers && sec4.disqualifiers.length) ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [3000, 1500, 4860],
    rows: [
      new TableRow({ children: [tHead("Additional disqualifier", 3000), tHead("Status", 1500), tHead("Notes and source", 4860)] }),
      ...sec4.disqualifiers.map(d => new TableRow({ children: [
        tCell(d.label, 3000),
        statusCell(d.status, 1500),
        tCell(d.notes, 4860),
      ]})),
    ],
  }) : null;

  const summaryTable = sec4.summary_table ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [2400, 1500, 5460],
    rows: [
      new TableRow({ children: [tHead("Layer", 2400), tHead("Outcome", 1500), tHead("Detail", 5460)] }),
      ...sec4.summary_table.map(r => new TableRow({ children: [
        tCell(r.layer, 2400),
        statusCell(r.status, 1500),
        tCell(r.detail, 5460),
      ]})),
    ],
  }) : null;

  // ----- SECTION 5 (pointers) -----
  const pointerSections = sec5.flatMap((p, i) => [
    h2(`5.${i + 1} ${p.title}`),
    sourceBanner(p.source, p.signal, p.signal_status),
    para(""),
    ...renderBlocks(p.blocks),
  ]);

  // ----- SECTION 6 -----
  const actionPlanTable = (sec6.actions && sec6.actions.length) ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [400, 3460, 1800, 1500, 2200],
    rows: [
      new TableRow({ children: [tHead("ID", 400), tHead("Action", 3460), tHead("Owner", 1800), tHead("Deadline", 1500), tHead("Success criterion", 2200)] }),
      ...sec6.actions.map(a => new TableRow({ children: [
        tCell(a.id, 400),
        tCell(a.action, 3460),
        tCell(a.owner, 1800),
        tCell(a.deadline, 1500),
        tCell(a.success_criterion, 2200),
      ]})),
    ],
  }) : null;

  // ----- SECTION 7 -----
  const systemicRecsTable = (sec7.recommendations && sec7.recommendations.length) ? new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [400, 3460, 1800, 1500, 2200],
    rows: [
      new TableRow({ children: [tHead("ID", 400), tHead("Recommendation", 3460), tHead("Owner", 1800), tHead("Priority", 1500), tHead("Rationale", 2200)] }),
      ...sec7.recommendations.map(r => new TableRow({ children: [
        tCell(r.id, 400),
        tCell(r.recommendation, 3460),
        tCell(r.owner, 1800),
        tCell(r.priority, 1500),
        tCell(r.rationale, 2200),
      ]})),
    ],
  }) : null;

  // ----- APPENDIX C — references -----
  const linkRow = (label, identifier, url) => new TableRow({ children: [
    tCell(label, 2400),
    tCell(identifier, 2400),
    tCell([new Paragraph({ children: [link(url.length > 60 ? url.slice(0, 56) + "…" : url, url)] })], 4560),
  ]});

  const referencesTable = new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [2400, 2400, 4560],
    rows: [
      new TableRow({ children: [tHead("Data source", 2400), tHead("Identifier", 2400), tHead("URL / endpoint", 4560)] }),
      ...(refs.entries || []).map(e => linkRow(e.source, e.identifier, e.url)),
    ],
  });

  const matchingTable = new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [3000, 6360],
    rows: [
      new TableRow({ children: [tHead("Match key", 3000), tHead("Used to join", 6360)] }),
      ...(refs.matching_keys || []).map(k => new TableRow({ children: [
        tCell(k.key, 3000, { bold: true }),
        tCell(k.usage, 6360),
      ]})),
    ],
  });

  // ----- APPENDIX A — glossary (allow data override; default to canonical) -----
  const defaultGlossary = [
    ["AE", "Account Executive — the sales role that owns the prospect relationship up to first payment."],
    ["AM", "Account Manager — the post-sale role that owns customer success and retention."],
    ["BaseSheet", "Master enrichment table maintained in Metabase that links Chargebee customer IDs to Zoca entity IDs and surfaces business attributes (AM, AE, primary category, lead source, churn flags, etc.)."],
    ["Discovery / Discovery Agent", "Zoca's first-line product, sold under the SKU Discovery-Agent-USD-Monthly or Discovery-Agent-USD-Every-3-months. Drives Google Business Profile-visibility and lead generation for beauty / wellness service businesses."],
    ["Entity ID", "UUID identifying a Zoca-customer location. A single Chargebee customer ID can be associated with multiple entity IDs for multi-location businesses."],
    ["GBP", "Google Business Profile (formerly Google My Business). The local-search profile through which Discovery Agent drives lead generation."],
    ["ICP", "Ideal Customer Profile. Defined in Module 02 as a beauty or wellness business that passes Step 1 (device, lead-prediction, qualifying booking platform) AND matches one Step-2 row (multi-location, single-location + staff, or single-location + solo with revenue ≥ $100K) AND clears the additional disqualifiers."],
    ["Module 02", "Zoca's canonical sales-training and ICP-qualification module, currently at revisions R-05 through R-09 (distributed 2026-05-03). Replaces all prior framing."],
    ["PMU", "Permanent Makeup. Listed under Module 02 categories that are not yet confirmed as ICP — direction is not to pitch as ICP until Sales Ops confirms."],
    ["predicted_6_month_leads", "Modelled forecast of leads expected over the next six months. Source: review_metrics.csv. Sales Ops tier rule applies: Below 30 = Not ICP; 30–60 = Possible ICP; Above 60 = Likely ICP."],
    ["Step 1 / Step 2", "Module 02 framework structure. Step 1 = three hard rules that must all pass. Step 2 = match exactly one lead-shape row and its rules. Any failure in Step 1 OR Step 2 = Not ICP."],
    ["T_created", "Earliest of the Chargebee and Stripe customer-creation timestamps for a given customer. Used as the cutoff for the comms-before-payment window."],
  ];
  const glossaryRows = (data.glossary && data.glossary.length) ? data.glossary : defaultGlossary;
  const glossaryTable = new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [2400, 6960],
    rows: [
      new TableRow({ children: [tHead("Term", 2400), tHead("Definition", 6960)] }),
      ...glossaryRows.map(([t, d]) => new TableRow({ children: [tCell(t, 2400, { bold: true }), tCell(d, 6960)] })),
    ],
  });

  // ----- APPENDIX B — Module 02 framework summary (static) -----
  const appendixBContent = [
    para("Module 02 is the canonical reference. The condensed framework is reproduced here for completeness."),
    h2("Vertical lock"),
    para("Beauty and wellness only. In-vertical: hair, skin, nails (multi-location), eyelash (multi-location), braiders (multi-location), barbershop, med-spa, wellness (yoga, pilates, massage). Out-of-vertical: dental, restaurants, gyms, vets, chiropractors, contractors, beauty schools / supply stores. Unconfirmed (do NOT pitch as ICP): tattoo, piercing, permanent makeup."),
    h2("Step 1 — three hard rules (lead must pass ALL three)"),
    numberedItem("Device. Laptop or iPad in the shop. Required."),
    numberedItem("Six-month lead prediction. Tier rule: Below 30 = Not ICP (automatic fail). 30–60 = Possible ICP (requires evaluation). Above 60 = Likely ICP."),
    numberedItem("Booking platform. Must be one of the five qualifying platforms: Gloss Genius, Square, Mindbody, Fresha, or Vagaro. Anything else is a hard stop, regardless of size or revenue."),
    h2("Step 2 — match exactly one lead-shape row"),
    bullet("Multi-location (2+) — any category, no revenue floor. ICP if Step 1 passes."),
    bullet("Single-location + staff — must skip the four single-location carve-outs (threading-only, nails-only, eyelash-only, braiders). Otherwise ICP."),
    bullet("Single-location + solo — Rule A: must skip the four carve-outs. Rule B: revenue must be ≥ $100,000 per year. Both rules must pass."),
    h2("Additional disqualifiers (apply on top)"),
    bullet("No GBP, or GBP less than approximately three months old."),
    bullet("Fewer than 20 reviews (subjective) or rating below 4 stars."),
    bullet("Part-timer (1–2 days per week)."),
    bullet("Mobile / no fixed location."),
    bullet("Insufficient demand area."),
    bullet("Wrong category, product business, MLM-style, or pure online."),
    bullet("Employees with no plan to grow into ownership."),
    h2("Disqualification doctrine — Value 04: \"BE HONEST. FULL STOP.\""),
    para("A solo operator below the framework's bars should be told no — honestly, cleanly, today. The doctrine argues that an honest no saves the customer from wasted spend, saves Zoca from a guaranteed Day-90 churn that costs more than the revenue earned, and tends to produce a referral. The framing must always be the product's stage or limitation, not the customer's failing."),
  ];

  // ----- FINAL CTA -----
  const finalCTA = calloutBanner([
    new Paragraph({ spacing: { after: 80 }, children: [
      new TextRun({ text: "Net retention picture: ", bold: true, size: 28, font: "Calibri" }),
      new TextRun({ text: exec.net_retention_picture || "—", size: 22, font: "Calibri" }),
    ]}),
    new Paragraph({ children: [
      new TextRun({ text: "Most likely Module-02-correct outcome: ", bold: true, size: 22, font: "Calibri" }),
      new TextRun({ text: exec.likely_outcome || "—", size: 22, font: "Calibri" }),
    ]}),
  ], COLOR_BANNER_BG, COLOR_BANNER_BORDER);

  // ----- DOCUMENT -----
  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 30, bold: true, font: "Calibri", color: COLOR_HEADER_BG }, paragraph: { spacing: { before: 360, after: 180 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: "Calibri", color: COLOR_HEADER_BG }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 22, bold: true, font: "Calibri" }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 } },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: [
          { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
        ]},
        { reference: "numbered", levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        ]},
      ],
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: m.header_text || "Zoca · Confidential — Post-Payment Account Review", italics: true, size: 18, color: "595959", font: "Calibri" })]})]})},
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "CONFIDENTIAL · INTERNAL ONLY · Page ", size: 18, color: "595959", font: "Calibri" }),
        new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "595959", font: "Calibri" }),
        new TextRun({ text: " of ", size: 18, color: "595959", font: "Calibri" }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "595959", font: "Calibri" }),
      ]})]})},
      children: [
        ...coverPage,
        new Paragraph({ children: [new PageBreak()] }),

        ...tableOfContents,
        new Paragraph({ children: [new PageBreak()] }),

        ...execSummary,
        verdictBanner,

        h1("Section 1 · Subject account & data scope"),
        h2("1.1 Subject account"),
        ...(subjectTable ? [subjectTable] : [para("(no subject data)", { italics: true })]),
        h2("1.2 Data sources used in this review"),
        ...(sourcesTable ? [sourcesTable] : [para("(no sources data)", { italics: true })]),

        h1("Section 2 · Verdict and recommended action"),
        verdictBanner,
        finalCTA,

        h1("Section 2.5 · Qualitative red flags (quick read)"),
        para(secQual.intro || "A scannable read of qualitative signals from the comms record and the sales conversation. This complements the quantified register in Section 3 — it captures the softer signals (price sensitivity, sales urgency, engagement quality) that drive Day-90 retention but don't show up as numerical risk scores."),
        ...(qualTable ? [qualTable] : [para("(no qualitative signals captured)", { italics: true })]),
        ...(secQual.takeaway ? [para(""), richPara([
          new TextRun({ text: "Takeaway: ", bold: true, size: 22, font: "Calibri" }),
          new TextRun({ text: secQual.takeaway, size: 22, font: "Calibri" }),
        ])] : []),

        h1("Section 3 · Quantified risk register"),
        para(sec3.intro || "This register catalogues the residual risks associated with allowing this account to remain on Discovery without remediation."),
        ...(riskRegisterTable ? [riskRegisterTable] : [para("(no risks data)", { italics: true })]),

        h1("Section 4 · Module 02 framework analysis"),
        h2("4.1 Tier rule for Step 1.2 (six-month lead prediction)"),
        tierRule,
        h2("4.2 Vertical lock"),
        para(sec4.vertical_lock_text || "—"),
        h2("4.3 Step 1 — three hard rules"),
        ...(step1Table ? [step1Table] : []),
        ...(sec4.step1_conclusion ? [richPara([
          new TextRun({ text: "Step 1 conclusion: ", bold: true, size: 22, font: "Calibri" }),
          new TextRun({ text: sec4.step1_conclusion, size: 22, font: "Calibri" }),
        ])] : []),
        h2("4.4 Step 2 — match exactly one row"),
        ...(sec4.step2_row_evidence ? [
          h3("Row identification — " + (sec4.step2_row_label || "(row)")),
          ...((sec4.step2_row_evidence || []).map(t => para(t))),
        ] : []),
        ...(step2Table ? [step2Table] : []),
        h2("4.5 Additional disqualifiers"),
        ...(dqTable ? [dqTable] : []),
        h2("4.6 Quantitative summary"),
        ...(summaryTable ? [summaryTable] : []),
        ...(sec4.summary_takeaway ? [richPara([
          new TextRun({ text: "Module 02 binary rule applied: ", bold: true, size: 22, font: "Calibri" }),
          new TextRun({ text: sec4.summary_takeaway, size: 22, font: "Calibri" }),
        ])] : []),
        ...(sec4.one_line_blockquote ? [
          h2("4.7 Why this verdict, in one sentence"),
          blockquote(sec4.one_line_blockquote),
        ] : []),

        h1("Section 5 · Post-payment pointer analysis (11 pointers)"),
        para("Eleven pointers form the canonical post-payment audit. Each is sourced and evidenced individually."),
        ...pointerSections,

        h1("Section 6 · Per-account action plan"),
        para(sec6.intro || "Actions required to bring this account into Module 02 compliance or to terminate it cleanly with a refund and a re-entry trigger."),
        ...(actionPlanTable ? [actionPlanTable] : []),
        ...(sec6.am_script ? [
          h2("6.1 Verbatim AM script"),
          blockquote(sec6.am_script, sec6.am_script_attribution),
          ...((sec6.branch_paragraphs || []).map(t => para(t))),
        ] : []),

        h1("Section 7 · Systemic recommendations"),
        para(sec7.intro || "This account exposes systemic gaps that are likely to recur."),
        ...(systemicRecsTable ? [systemicRecsTable] : []),

        h1("Section 8 · Open data gaps"),
        para(sec8.intro || "The following items cannot be resolved by the validator alone and must be closed by the AM call or by the systemic recommendations in Section 7."),
        ...(sec8.items.map(t => numberedItem(typeof t === "string" ? t : (t.gap || t.label || JSON.stringify(t))))),

        h1("Section 9 · Evidence trail and methodology"),
        ...(sec9.methodology_paragraphs.map(t => para(typeof t === "string" ? t : JSON.stringify(t)))),
        h2("9.1 Evidence trail"),
        ...(sec9.evidence_trail.map(t => bullet(typeof t === "string" ? t : JSON.stringify(t)))),

        h1("Appendix A · Glossary of terms"),
        glossaryTable,

        h1("Appendix B · Module 02 framework summary"),
        ...appendixBContent,

        h1("Appendix C · References & data sources"),
        para(refs.intro || "Every claim in this report can be traced to one of the sources catalogued below. Wherever a source could not provide data for this entity, the gap is explicitly called out in the relevant section above (data gap)."),
        h2("C.1 Source registry"),
        referencesTable,
        h2("C.2 How sources are matched to this account"),
        matchingTable,
        h2("C.3 Reference framework"),
        ...((refs.framework_bullets || [
          "Title: Module 02 · Our ICP — Who We Sell To, Who We Don't",
          "Revisions in force: R-05 through R-09",
          "Distributed: 2026-05-03",
          "Source: internal sales-training deliverable, Sales Ops",
          "Two items still pending Sales Ops confirmation: (1) PMU / tattoo / piercing as ICP; (2) the carve-out treatment of waxing-only single-location.",
        ]).map(t => bullet(t))),
        h2("C.4 Pipeline that produced this report"),
        ...((refs.pipeline_bullets || [
          "Pipeline name: Zoca Payment Validator",
          "Cadence: every 30 minutes",
          "Trigger: new Chargebee customer with first-ever subscription on Discovery and customer.created_at on or after the configured floor date",
          "Output: structured account review per customer, evaluated against the Module 02 prompt (editable Markdown file in the validator directory)",
        ]).map(t => bullet(t))),
      ],
    }],
  });

  return doc;
}

module.exports = { buildReport };

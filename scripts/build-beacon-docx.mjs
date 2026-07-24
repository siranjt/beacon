// build-beacon-docx.mjs — one-shot markdown → docx renderer for docs/beacon.md.
// Uses the pre-installed `docx` package (no npm install).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  ExternalHyperlink,
  PageBreak,
  Header,
  Footer,
  PageNumber,
  LevelFormat,
  StyleLevel,
  TableOfContents,
} from "docx";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(REPO_ROOT, "docs", "beacon.md");
const OUT_PRIMARY = path.join(REPO_ROOT, "docs", "beacon.docx");
const OUT_BACKUP = process.env.OUT_BACKUP;

const TABLE_TOTAL_WIDTH_DXA = 9000;
const CODE_SHADING = { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" };
const CODE_CAPTION_SHADING = { type: ShadingType.CLEAR, color: "auto", fill: "E7E6E6" };
const HEADER_ROW_SHADING = { type: ShadingType.CLEAR, color: "auto", fill: "DDEBF7" };
const BLOCKQUOTE_LEFT_BORDER = {
  color: "808080",
  space: 6,
  style: BorderStyle.SINGLE,
  size: 12,
};
const THIN_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "9CA3AF" };
const CELL_BORDERS = {
  top: THIN_BORDER,
  bottom: THIN_BORDER,
  left: THIN_BORDER,
  right: THIN_BORDER,
};

// ---------------------------------------------------------------------------
// Inline parser — splits a run of text into TextRun / ExternalHyperlink parts.
// Handles nested combinations of **bold**, *italic*, `code`, [text](url).
// ---------------------------------------------------------------------------

function decodeMdEscapes(s) {
  return s.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1");
}

function makeTextRun(text, { bold = false, italics = false, code = false } = {}) {
  if (code) {
    return new TextRun({
      text,
      font: "Courier New",
      size: 20,
      shading: CODE_SHADING,
      bold,
      italics,
    });
  }
  return new TextRun({ text, bold, italics });
}

// Tokenize a line into inline segments (plain / bold / italic / code / link).
// The parser walks left-to-right and applies precedence:
//   1. backtick code (highest — no further parsing inside)
//   2. `[text](url)` link
//   3. `**bold**`
//   4. `*italic*` (with lookaround so lists / emphasis mid-word still work)
function parseInline(source, ctx = {}) {
  const runs = [];
  const text = source;
  let i = 0;
  let plainStart = 0;

  const flushPlain = (endExclusive) => {
    if (endExclusive > plainStart) {
      const chunk = decodeMdEscapes(text.slice(plainStart, endExclusive));
      if (chunk.length) runs.push(makeTextRun(chunk, ctx));
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Escape
    if (ch === "\\" && i + 1 < text.length) {
      // Preserve as literal; decodeMdEscapes handles it in the plain flush.
      i += 2;
      continue;
    }

    // Inline code
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flushPlain(i);
        const inner = text.slice(i + 1, end);
        runs.push(makeTextRun(inner, { ...ctx, code: true }));
        i = end + 1;
        plainStart = i;
        continue;
      }
    }

    // Link [text](url)
    if (ch === "[") {
      const closeBracket = findMatching(text, i, "[", "]");
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = findMatching(text, closeBracket + 1, "(", ")");
        if (closeParen !== -1) {
          flushPlain(i);
          const linkText = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen).trim();
          // Internal anchor links → render as styled text (no bookmark plumbing).
          if (url.startsWith("#")) {
            const inner = parseInline(linkText, ctx);
            for (const r of inner) runs.push(r);
          } else {
            const isExternal = /^https?:\/\//i.test(url) || /^mailto:/i.test(url);
            if (isExternal) {
              const linkRuns = parseInline(linkText, ctx).map((run) => {
                // Force link styling on every child run.
                return recolorRunForLink(run);
              });
              runs.push(
                new ExternalHyperlink({
                  link: url,
                  children: linkRuns,
                }),
              );
            } else {
              // Relative doc link — render as label + " (" + path + ")"
              const label = parseInline(linkText, ctx);
              for (const r of label) runs.push(r);
              runs.push(
                makeTextRun(` (${url})`, {
                  ...ctx,
                  italics: true,
                }),
              );
            }
          }
          i = closeParen + 1;
          plainStart = i;
          continue;
        }
      }
    }

    // Bold **...**
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1 && end > i + 2) {
        flushPlain(i);
        const inner = text.slice(i + 2, end);
        const innerRuns = parseInline(inner, { ...ctx, bold: true });
        for (const r of innerRuns) runs.push(r);
        i = end + 2;
        plainStart = i;
        continue;
      }
    }

    // Italic *...* — only when the leading * isn't attached to a word char run
    // that would mean multiplication / a list marker. We accept if surrounded
    // by non-word on the outside and non-space on the inside.
    if (ch === "*" && text[i + 1] !== "*") {
      const prevCh = i > 0 ? text[i - 1] : " ";
      if (!/\w/.test(prevCh)) {
        // Look for matching solitary *
        let j = i + 1;
        let found = -1;
        while (j < text.length) {
          if (text[j] === "*" && text[j + 1] !== "*" && text[j - 1] !== "*") {
            const nextCh = j + 1 < text.length ? text[j + 1] : " ";
            if (!/\w/.test(nextCh) && j > i + 1 && text[j - 1] !== " ") {
              found = j;
              break;
            }
          }
          j += 1;
        }
        if (found !== -1) {
          flushPlain(i);
          const inner = text.slice(i + 1, found);
          const innerRuns = parseInline(inner, { ...ctx, italics: true });
          for (const r of innerRuns) runs.push(r);
          i = found + 1;
          plainStart = i;
          continue;
        }
      }
    }

    i += 1;
  }

  flushPlain(text.length);
  return runs;
}

function findMatching(text, startIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function recolorRunForLink(run) {
  // If it's a TextRun-like from `makeTextRun`, we can just create a fresh one
  // with the link styling. External hyperlink expects TextRun children.
  const opts = extractRunOptions(run);
  return new TextRun({
    ...opts,
    style: "Hyperlink",
    color: "0563C1",
    underline: {},
  });
}

function extractRunOptions(run) {
  // We only ever build TextRun via makeTextRun above, so the properties we
  // want are on run.options — but docx runtime versions vary. Rebuild from
  // scratch by copying the exposed properties we've set.
  const props = run?.root?.[0]?.root ?? run?.options ?? {};
  // Fallback path — pull directly from what we passed in.
  return {
    text: run?.options?.text ?? run?.text ?? "",
    bold: run?.options?.bold ?? false,
    italics: run?.options?.italics ?? false,
    font: run?.options?.font,
    size: run?.options?.size,
  };
}

// ---------------------------------------------------------------------------
// Block parser — converts the whole markdown into a flat children[] array
// suitable for `Document.sections[0].children`.
// ---------------------------------------------------------------------------

class Parser {
  constructor(src) {
    this.lines = src.replace(/\r\n?/g, "\n").split("\n");
    this.i = 0;
    this.out = [];
  }

  peek(offset = 0) {
    return this.lines[this.i + offset];
  }

  consumeBlankLines() {
    while (this.i < this.lines.length && this.lines[this.i].trim() === "") {
      this.i += 1;
    }
  }

  run() {
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.trim() === "") {
        this.i += 1;
        continue;
      }

      // Fenced code block
      if (/^```/.test(line)) {
        this.consumeCodeBlock();
        continue;
      }

      // Horizontal rule
      if (/^---+\s*$/.test(line)) {
        this.out.push(makeHR());
        this.i += 1;
        continue;
      }

      // Heading
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        this.out.push(makeHeading(hm[1].length, hm[2].trim()));
        this.i += 1;
        continue;
      }

      // Table (line has `|` and next line is a divider row)
      if (this.looksLikeTable()) {
        this.consumeTable();
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        this.consumeBlockquote();
        continue;
      }

      // Unordered list
      if (/^(\s*)[-*+]\s+/.test(line)) {
        this.consumeList("bullet");
        continue;
      }

      // Ordered list
      if (/^(\s*)\d+\.\s+/.test(line)) {
        this.consumeList("ordered");
        continue;
      }

      // Regular paragraph — accumulate contiguous non-empty lines
      this.consumeParagraph();
    }
  }

  consumeCodeBlock() {
    const fence = this.lines[this.i];
    const lang = fence.replace(/^```/, "").trim();
    this.i += 1;
    const buf = [];
    while (this.i < this.lines.length && !/^```/.test(this.lines[this.i])) {
      buf.push(this.lines[this.i]);
      this.i += 1;
    }
    if (this.i < this.lines.length) this.i += 1; // consume closing fence

    if (lang) {
      const caption = lang.toLowerCase() === "mermaid" ? "Mermaid diagram" : lang;
      this.out.push(
        new Paragraph({
          spacing: { before: 120, after: 40 },
          children: [
            new TextRun({
              text: caption,
              italics: true,
              size: 18,
              color: "555555",
            }),
          ],
        }),
      );
    }

    for (const codeLine of buf) {
      this.out.push(
        new Paragraph({
          shading: CODE_SHADING,
          spacing: { before: 0, after: 0, line: 260 },
          children: [
            new TextRun({
              text: codeLine.length ? codeLine : " ",
              font: "Courier New",
              size: 20,
            }),
          ],
        }),
      );
    }
    // Trailing spacer
    this.out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
  }

  looksLikeTable() {
    const line = this.lines[this.i];
    if (!line.includes("|")) return false;
    const divider = this.lines[this.i + 1];
    if (!divider) return false;
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(divider);
  }

  consumeTable() {
    const header = splitTableRow(this.lines[this.i]);
    this.i += 2; // skip header + divider
    const rows = [];
    while (this.i < this.lines.length && this.lines[this.i].includes("|")) {
      const trimmed = this.lines[this.i].trim();
      if (trimmed === "") break;
      rows.push(splitTableRow(this.lines[this.i]));
      this.i += 1;
    }
    this.out.push(buildTable(header, rows));
  }

  consumeBlockquote() {
    const buf = [];
    while (this.i < this.lines.length && /^>\s?/.test(this.lines[this.i])) {
      buf.push(this.lines[this.i].replace(/^>\s?/, ""));
      this.i += 1;
    }
    const text = buf.join(" ").trim();
    const runs = parseInline(text, { italics: true });
    this.out.push(
      new Paragraph({
        border: { left: BLOCKQUOTE_LEFT_BORDER },
        indent: { left: 240 },
        spacing: { before: 120, after: 120 },
        children: runs,
      }),
    );
  }

  consumeList(kind) {
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.trim() === "") {
        // Check whether the next non-empty line is still part of the list
        let j = this.i + 1;
        while (j < this.lines.length && this.lines[j].trim() === "") j += 1;
        if (
          j < this.lines.length &&
          ((kind === "bullet" && /^(\s*)[-*+]\s+/.test(this.lines[j])) ||
            (kind === "ordered" && /^(\s*)\d+\.\s+/.test(this.lines[j])))
        ) {
          this.i = j;
          continue;
        }
        this.i += 1;
        return;
      }
      const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
      const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
      const match = kind === "bullet" ? bulletMatch : orderedMatch;
      if (!match) return;

      const indent = match[1].replace(/\t/g, "  ").length;
      const level = Math.min(2, Math.floor(indent / 2));
      const content = match[2];

      // Collect continuation lines (indented under this item, no marker)
      const contentLines = [content];
      let k = this.i + 1;
      while (k < this.lines.length) {
        const next = this.lines[k];
        if (next.trim() === "") break;
        if (/^(\s*)[-*+]\s+/.test(next) || /^(\s*)\d+\.\s+/.test(next)) break;
        if (/^#{1,6}\s+/.test(next)) break;
        if (/^```/.test(next)) break;
        if (/^---+\s*$/.test(next)) break;
        if (next.startsWith(" ".repeat(indent + 2)) || next.startsWith("\t")) {
          contentLines.push(next.trim());
          k += 1;
        } else {
          break;
        }
      }
      this.i = k;

      const runs = parseInline(contentLines.join(" "));
      const paraOptions = {
        spacing: { before: 40, after: 40 },
        children: runs,
      };
      if (kind === "bullet") {
        paraOptions.bullet = { level };
      } else {
        paraOptions.numbering = { reference: "ordered-list", level };
      }
      this.out.push(new Paragraph(paraOptions));
    }
  }

  consumeParagraph() {
    const buf = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.trim() === "") break;
      if (/^#{1,6}\s+/.test(line)) break;
      if (/^```/.test(line)) break;
      if (/^---+\s*$/.test(line)) break;
      if (/^>\s?/.test(line)) break;
      if (/^(\s*)[-*+]\s+/.test(line)) break;
      if (/^(\s*)\d+\.\s+/.test(line)) break;
      // Table start check
      if (
        line.includes("|") &&
        this.i + 1 < this.lines.length &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(this.lines[this.i + 1])
      ) {
        break;
      }
      buf.push(line);
      this.i += 1;
    }
    if (buf.length === 0) return;
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    this.out.push(
      new Paragraph({
        spacing: { before: 80, after: 80, line: 276 },
        children: parseInline(text),
      }),
    );
  }
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Split on `|` that isn't escaped or inside inline code
  const parts = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function buildTable(headerCells, bodyRows) {
  const colCount = Math.max(headerCells.length, ...bodyRows.map((r) => r.length));
  const columnWidths = distributeWidths(colCount, TABLE_TOTAL_WIDTH_DXA);

  const rows = [];
  rows.push(
    new TableRow({
      tableHeader: true,
      children: headerCells.map((text, idx) => {
        const width = columnWidths[idx] ?? Math.floor(TABLE_TOTAL_WIDTH_DXA / colCount);
        return new TableCell({
          width: { size: width, type: WidthType.DXA },
          shading: HEADER_ROW_SHADING,
          borders: CELL_BORDERS,
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              spacing: { before: 40, after: 40 },
              children: parseInline(text, { bold: true }),
            }),
          ],
        });
      }),
    }),
  );

  for (const row of bodyRows) {
    const padded = [...row];
    while (padded.length < colCount) padded.push("");
    rows.push(
      new TableRow({
        cantSplit: false,
        children: padded.map((cellText, idx) => {
          const width = columnWidths[idx] ?? Math.floor(TABLE_TOTAL_WIDTH_DXA / colCount);
          const cellParas = cellTextToParagraphs(cellText);
          return new TableCell({
            width: { size: width, type: WidthType.DXA },
            borders: CELL_BORDERS,
            children: cellParas,
          });
        }),
      }),
    );
  }

  return new Table({
    columnWidths,
    width: { size: TABLE_TOTAL_WIDTH_DXA, type: WidthType.DXA },
    rows,
  });
}

function cellTextToParagraphs(cellText) {
  const withBreaks = cellText.replace(/<br\s*\/?>/gi, "\n");
  const lines = withBreaks.split("\n");
  return lines.map(
    (line) =>
      new Paragraph({
        spacing: { before: 20, after: 20 },
        children: parseInline(line.trim()),
      }),
  );
}

function forceBoldOnRun(run) {
  if (run instanceof TextRun) {
    const opts = run.options ?? {};
    return new TextRun({ ...opts, bold: true });
  }
  return run;
}

function distributeWidths(colCount, total) {
  const each = Math.floor(total / colCount);
  const widths = new Array(colCount).fill(each);
  widths[widths.length - 1] = total - each * (colCount - 1);
  return widths;
}

function makeHeading(level, text) {
  const clampedLevel = Math.min(level, 4);
  const headingMap = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
  };
  const spacingBefore = { 1: 320, 2: 260, 3: 200, 4: 160 }[clampedLevel] ?? 160;
  const spacingAfter = { 1: 160, 2: 120, 3: 100, 4: 80 }[clampedLevel] ?? 80;

  return new Paragraph({
    heading: headingMap[clampedLevel],
    spacing: { before: spacingBefore, after: spacingAfter },
    children: parseInline(text),
  });
}

function makeHR() {
  return new Paragraph({
    spacing: { before: 200, after: 200 },
    border: {
      bottom: {
        color: "999999",
        space: 1,
        style: BorderStyle.SINGLE,
        size: 6,
      },
    },
    children: [],
  });
}

// ---------------------------------------------------------------------------
// Cover page + TOC + header + footer
// ---------------------------------------------------------------------------

function makeCoverPage(generatedDate) {
  return [
    new Paragraph({ spacing: { before: 3200 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: "Beacon platform",
          bold: true,
          size: 64,
          font: "Cambria",
          color: "1A3340",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: "engineering reference",
          bold: true,
          size: 48,
          font: "Cambria",
          color: "C8431D",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: "Umbrella app documentation · Reference document",
          italics: true,
          size: 26,
          color: "555555",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 800 },
      children: [
        new TextRun({
          text: `Generated ${generatedDate}`,
          size: 22,
          color: "6E5F50",
        }),
      ],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function makeTocSection() {
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 0, after: 200 },
      children: [
        new TextRun({
          text: "Table of contents",
          bold: true,
          font: "Cambria",
        }),
      ],
    }),
    new TableOfContents("Table of contents", {
      hyperlink: true,
      headingStyleRange: "1-4",
      stylesWithLevels: [
        new StyleLevel("Heading1", 1),
        new StyleLevel("Heading2", 2),
        new StyleLevel("Heading3", 3),
        new StyleLevel("Heading4", 4),
      ],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function makeRunningHeader() {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: "Beacon platform — engineering reference",
            size: 18,
            color: "6E5F50",
            italics: true,
          }),
        ],
      }),
    ],
  });
}

function makeRunningFooter() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
            size: 18,
            color: "6E5F50",
          }),
        ],
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const src = fs.readFileSync(SRC, "utf8");
  const parser = new Parser(src);
  parser.run();
  const body = parser.out;

  const generatedDate = new Date().toISOString().slice(0, 10);
  const cover = makeCoverPage(generatedDate);
  const toc = makeTocSection();

  const doc = new Document({
    creator: "Beacon docs",
    title: "Beacon platform — engineering reference",
    description: "Umbrella app documentation · Reference document",
    styles: {
      default: {
        document: {
          run: {
            font: "Calibri",
            size: 22,
          },
          paragraph: {
            spacing: { line: 276 },
          },
        },
        heading1: {
          run: { font: "Cambria", size: 40, bold: true, color: "1A3340" },
          paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 },
        },
        heading2: {
          run: { font: "Cambria", size: 30, bold: true, color: "1A3340" },
          paragraph: { spacing: { before: 260, after: 120 }, outlineLevel: 1 },
        },
        heading3: {
          run: { font: "Cambria", size: 26, bold: true, color: "2A4D5C" },
          paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 },
        },
        heading4: {
          run: { font: "Cambria", size: 22, bold: true, color: "2A4D5C" },
          paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 3 },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered-list",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 260 } } },
            },
            {
              level: 1,
              format: LevelFormat.LOWER_LETTER,
              text: "%2.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 1440, hanging: 260 } } },
            },
            {
              level: 2,
              format: LevelFormat.LOWER_ROMAN,
              text: "%3.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 2160, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
          },
        },
        headers: { default: makeRunningHeader() },
        footers: { default: makeRunningFooter() },
        children: [...cover, ...toc, ...body],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(OUT_PRIMARY, buf);
  console.log("Wrote", OUT_PRIMARY, "(", buf.length, "bytes )");
  if (OUT_BACKUP) {
    fs.mkdirSync(path.dirname(OUT_BACKUP), { recursive: true });
    fs.writeFileSync(OUT_BACKUP, buf);
    console.log("Wrote", OUT_BACKUP, "(", buf.length, "bytes )");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

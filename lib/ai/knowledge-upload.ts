/**
 * Beacon AI Knowledge Base — file ingest.
 *
 * Three sources accepted (more can be added later):
 *
 *   1. .docx — parsed via mammoth → HTML → naive markdown. Lossy but
 *      readable; tables become pipe-tables, bold/italic preserved,
 *      headings preserved. Lists OK.
 *   2. Image (.png / .jpg / .webp / .gif) — uploaded to Vercel Blob,
 *      then sent to Claude Vision (Haiku model) for OCR + description.
 *      The KB doc body becomes:
 *          ![filename](blob-url)
 *
 *          ### Description (auto-extracted from screenshot)
 *          <Haiku narrative>
 *
 *          ### Text extracted (OCR)
 *          <extracted text>
 *      Beacon AI reads the text portions in the excerpt; the chip
 *      popover can later show the image.
 *   3. PDF — deferred. Returns a clear "not supported yet" error so the
 *      user knows to paste the text manually until we add this.
 *
 * Returns { markdown, title, slug } that the upload route hands to
 * createDoc(). Failures throw with a user-readable message.
 */

import "server-only";
import { put as blobPut } from "@vercel/blob";
import Anthropic from "@anthropic-ai/sdk";

const VISION_MODEL =
  process.env.ANTHROPIC_VISION_MODEL ?? "claude-haiku-4-5-20251001";

export interface ParsedUpload {
  /** Markdown body to land in beacon_ai_docs.body. */
  markdown: string;
  /** Suggested title; user can edit before save. */
  title: string;
  /** Suggested slug; user can edit before save. */
  slug: string;
}

const SLUG_RX = /[^a-z0-9]+/g;

function makeSlug(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem
    .toLowerCase()
    .replace(SLUG_RX, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function makeTitle(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Very light HTML → markdown. Mammoth produces clean HTML (headings,
 * bold, italic, lists, tables, paragraphs). We don't need a full
 * commonmark converter — just enough to make the body readable + FTS-
 * indexable. Anything we don't understand passes through as plain text
 * after tag stripping.
 */
function htmlToMarkdown(html: string): string {
  let s = html;
  // Headings
  s = s.replace(/<h1[^>]*>(.*?)<\/h1>/gis, "\n\n# $1\n\n");
  s = s.replace(/<h2[^>]*>(.*?)<\/h2>/gis, "\n\n## $1\n\n");
  s = s.replace(/<h3[^>]*>(.*?)<\/h3>/gis, "\n\n### $1\n\n");
  s = s.replace(/<h4[^>]*>(.*?)<\/h4>/gis, "\n\n#### $1\n\n");
  // Bold + italic
  s = s.replace(/<strong[^>]*>(.*?)<\/strong>/gis, "**$1**");
  s = s.replace(/<b[^>]*>(.*?)<\/b>/gis, "**$1**");
  s = s.replace(/<em[^>]*>(.*?)<\/em>/gis, "*$1*");
  s = s.replace(/<i[^>]*>(.*?)<\/i>/gis, "*$1*");
  // Lists (very lossy — strips ul/ol containers, marks li with -)
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  s = s.replace(/<li[^>]*>(.*?)<\/li>/gis, "- $1\n");
  // Paragraphs + line breaks
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  s = s.replace(/<p[^>]*>/gi, "");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Tables — mammoth emits <table><tr><td>cell</td></tr></table>.
  // Convert to GFM pipe tables. This is naive (no header row detection)
  // but readable enough for the model to parse.
  s = s.replace(/<tr[^>]*>(.*?)<\/tr>/gis, (_, row) => {
    const cells = (row as string)
      .replace(/<\/?t[hd][^>]*>/gi, "|")
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    return "| " + cells.join(" | ") + " |\n";
  });
  s = s.replace(/<\/?table[^>]*>/gi, "\n");
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // HTML entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse triple+ newlines
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/**
 * Parse a .docx file buffer into markdown. mammoth handles the OOXML
 * unzip + XML parsing; we transform the HTML output to markdown.
 *
 * Note: types ship with mammoth's package; this import resolves once
 * `npm install` lands the dependency.
 */
async function parseDocx(buffer: Buffer): Promise<string> {
  // mammoth lands in node_modules at deploy via `npm install`; it's
  // declared in package.json. The dynamic specifier dodges TS's static
  // module resolution since we don't ship type declarations for it.
  const moduleId = "mammoth";
  const mammoth = (await import(/* webpackIgnore: true */ moduleId)) as {
    convertToHtml: (options: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const result = await mammoth.convertToHtml({ buffer });
  if (!result || typeof result.value !== "string") {
    throw new Error("mammoth returned no content");
  }
  const md = htmlToMarkdown(result.value);
  if (!md) {
    throw new Error("docx parsed but produced empty markdown");
  }
  return md;
}

/**
 * Send an image to Claude Vision and return a structured markdown
 * extraction: short narrative description + OCR'd text. The image
 * itself is stored separately at a Vercel Blob URL and embedded at the
 * top of the body.
 */
async function extractFromImage(
  imageBase64: string,
  mediaType: string,
  filename: string,
): Promise<{ description: string; ocrText: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      description: "(no Anthropic API key configured; image saved but not auto-described)",
      ocrText: "",
    };
  }
  const anthropic = new Anthropic({ apiKey, maxRetries: 2 });
  // Constrain media_type to the values the Anthropic SDK accepts.
  type AllowedMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  const normalizedType: AllowedMediaType =
    mediaType === "image/jpeg" ||
    mediaType === "image/png" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp"
      ? mediaType
      : "image/png";
  const prompt = `This screenshot will be stored in Zoca's internal knowledge base for Beacon AI to retrieve and cite. Produce two sections:

DESCRIPTION:
A 2-3 sentence summary of what this screenshot shows. Frame it like a doc title — what is this a screenshot OF, and what are its salient facts? Examples: "Chargebee invoice list filtered to past-due, showing 12 customers", "Slack thread about the auto-debit policy change", "Excel screenshot of the multi-month repeat list".

EXTRACTED TEXT:
Every piece of text visible in the screenshot, transcribed verbatim. Preserve table structure when present (use pipe-tables). Preserve hierarchy (headings, bullets). If text is partially obscured, indicate with [...]. If there's no text, write "(no text in image)".

Output exactly those two sections with those exact headers. No preamble.`;

  try {
    const message = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 1600,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: normalizedType,
                data: imageBase64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    // Find the first text block in the response.
    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("vision response had no text");
    }
    const raw = textBlock.text;

    // Split on the two known headers. Tolerant of casing + colon variants.
    const descMatch = raw.match(/DESCRIPTION:?\s*\n+([\s\S]*?)(?=\n\s*EXTRACTED TEXT:?|$)/i);
    const ocrMatch = raw.match(/EXTRACTED TEXT:?\s*\n+([\s\S]*)$/i);

    return {
      description: descMatch?.[1]?.trim() || `(auto-description unavailable for ${filename})`,
      ocrText: ocrMatch?.[1]?.trim() || "(no text extracted)",
    };
  } catch (err) {
    console.warn("[knowledge-upload] vision call failed:", err);
    return {
      description: `(vision extraction failed — image saved but not auto-described)`,
      ocrText: "",
    };
  }
}

/**
 * Parse an image upload: store in Vercel Blob, run vision OCR, return
 * markdown that embeds the image at top + structured description + OCR
 * underneath.
 */
async function parseImage(
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN not configured — image uploads require Vercel Blob",
    );
  }

  // Upload to Vercel Blob at a deterministic key.
  const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, "-").slice(0, 80);
  const key = `knowledge/${Date.now()}-${safeName}`;
  const uploaded = await blobPut(key, buffer, {
    access: "public",
    contentType,
    addRandomSuffix: false,
  });

  // Run Claude Vision OCR + description.
  const base64 = buffer.toString("base64");
  const { description, ocrText } = await extractFromImage(
    base64,
    contentType,
    filename,
  );

  // Compose markdown body.
  return [
    `![${filename}](${uploaded.url})`,
    "",
    "### Description (auto-extracted from screenshot)",
    description,
    "",
    "### Text extracted (OCR)",
    ocrText,
  ].join("\n");
}

/**
 * Dispatch by file content-type. Returns {markdown, title, slug} ready
 * to feed into createDoc(). Throws on unsupported types or parse errors.
 */
export async function parseUploadedFile(
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<ParsedUpload> {
  const lowerName = filename.toLowerCase();
  const isDocx =
    contentType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx");
  const isImage =
    contentType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/i.test(lowerName);
  const isPdf = contentType === "application/pdf" || lowerName.endsWith(".pdf");

  let markdown: string;
  if (isDocx) {
    markdown = await parseDocx(buffer);
  } else if (isImage) {
    // Normalize image content type by file extension when the upload
    // didn't set one cleanly.
    const inferredType =
      contentType.startsWith("image/")
        ? contentType
        : lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")
          ? "image/jpeg"
          : lowerName.endsWith(".gif")
            ? "image/gif"
            : lowerName.endsWith(".webp")
              ? "image/webp"
              : "image/png";
    markdown = await parseImage(buffer, filename, inferredType);
  } else if (isPdf) {
    throw new Error(
      "PDF upload isn't supported yet. Open the PDF, copy the text, and paste into a new doc manually for now.",
    );
  } else {
    throw new Error(
      `Unsupported file type "${contentType || "unknown"}". Supported: .docx, .png, .jpg, .jpeg, .gif, .webp`,
    );
  }

  return {
    markdown,
    title: makeTitle(filename),
    slug: makeSlug(filename),
  };
}

/**
 * Renders the Word doc from a structured report-data JSON, then uploads to
 * Vercel Blob and returns the public URL.
 *
 * The actual template lives in template.js (copied from the validator repo —
 * single source of truth). We import via require to use the existing JS.
 */

import { put, del } from "@vercel/blob";
import { Packer } from "docx";
// Template lives as a .js file (shared with the standalone validator's
// render_report.js). TS imports it cleanly because `allowJs: true` is set
// in tsconfig.json.
import { buildReport } from "./template";

export type RenderResult = {
  docxUrl: string;
  jsonUrl: string;
  mdUrl: string;
  bytes: number;
};

/**
 * Put a blob at a fixed, predictable key. If a blob already exists at that key,
 * delete it first then re-upload. Works across @vercel/blob versions whether or
 * not they support `allowOverwrite`.
 */
async function putAtFixedKey(
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<{ url: string }> {
  const opts = { access: "public" as const, contentType, addRandomSuffix: false };
  try {
    return await put(key, body, opts);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // Vercel Blob throws on duplicate key when addRandomSuffix is false.
    if (msg.toLowerCase().includes("already exists") || msg.toLowerCase().includes("blob exists")) {
      await del(key).catch(() => undefined);
      return await put(key, body, opts);
    }
    throw e;
  }
}

export async function renderAndUpload(args: {
  cbCustomerId: string;
  reportData: any;
  markdown: string;
}): Promise<RenderResult> {
  // Cast through `any`: template.js is a .js file (shared with the standalone
  // validator), and TS's structural type check distinguishes the Document class
  // it infers from there vs. the one in our local docx import (private-field
  // identity quirk). Functionally identical class.
  const doc: any = buildReport(args.reportData);
  const buf = await Packer.toBuffer(doc);

  const baseKey = `reports/${args.cbCustomerId}`;
  const [docxResult, jsonResult, mdResult] = await Promise.all([
    putAtFixedKey(
      `${baseKey}.docx`,
      buf,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    putAtFixedKey(
      `${baseKey}.report_data.json`,
      JSON.stringify(args.reportData, null, 2),
      "application/json",
    ),
    putAtFixedKey(
      `${baseKey}.analysis.md`,
      // Vercel Blob put() rejects empty-string bodies. Guarantee a non-empty
      // payload so the upload always succeeds even if the model produced no
      // text content alongside its tool call.
      args.markdown && args.markdown.length > 0 ? args.markdown : `_(no narrative content recorded for ${args.cbCustomerId})_`,
      "text/markdown; charset=utf-8",
    ),
  ]);

  return {
    docxUrl: docxResult.url,
    jsonUrl: jsonResult.url,
    mdUrl: mdResult.url,
    bytes: buf.length,
  };
}

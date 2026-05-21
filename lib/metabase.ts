/**
 * Metabase Dataset API client.
 *
 * Hits POST /api/dataset on metabase.zoca.ai using the API key. Each call
 * runs a native SQL string against the chosen database id, with optional
 * {{template_tags}} substituted from `params`.
 *
 * Why Dataset API and not card-by-card calls: the public-share CSV endpoints
 * return the entire card output (megabytes), which is unworkable on a
 * serverless runtime. Dataset lets us filter by entity at the database
 * layer and stream back exactly the slice the report needs.
 */

const DEFAULT_BASE_URL = "https://metabase.zoca.ai";

/** Database IDs in metabase.zoca.ai (verified 2026-04-28). */
export const DB = {
  /** Zoca Aurora — production warehouse. Hosts gbp.*, local_seo.*, entities.* */
  AURORA: 7,
  /** Zoca Postgres — operational app DB. Hosts website.booking_enquiries, etc. */
  POSTGRES: 2,
  /** Zoca Staging — not used by the report. */
  STAGING: 3,
} as const;

export type Row = Record<string, unknown>;

export type RunQueryOptions = {
  database: number;
  sql: string;
  /** Values for any {{template_tags}} in the SQL. */
  params?: Record<string, string | number | boolean>;
};

function readEnv() {
  const baseUrl = process.env.METABASE_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "METABASE_API_KEY is not set. Add it to .env.local (and Vercel env)."
    );
  }
  return { baseUrl, apiKey };
}

type MetabaseTemplateTag = {
  id: string;
  name: string;
  "display-name": string;
  type: "text" | "number" | "date" | "dimension";
  required: boolean;
};

type MetabaseParameter = {
  type: "category" | "number/=" | "date/single";
  target: ["variable", ["template-tag", string]];
  value: string | number | boolean;
};

/**
 * Runs native SQL against a Metabase database and returns rows mapped
 * from arrays-of-values to plain objects keyed by column name.
 */
export async function runQuery<T extends Row = Row>({
  database,
  sql,
  params,
}: RunQueryOptions): Promise<T[]> {
  const { baseUrl, apiKey } = readEnv();

  const templateTags: Record<string, MetabaseTemplateTag> = {};
  const parameters: MetabaseParameter[] = [];

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      const isNumber = typeof value === "number";
      templateTags[name] = {
        id: name,
        name,
        "display-name": name,
        type: isNumber ? "number" : "text",
        required: true,
      };
      parameters.push({
        type: isNumber ? "number/=" : "category",
        target: ["variable", ["template-tag", name]],
        value,
      });
    }
  }

  const body = {
    database,
    type: "native",
    native: {
      query: sql,
      "template-tags": templateTags,
    },
    parameters,
  };

  const res = await fetch(`${baseUrl}/api/dataset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(
      `Metabase /api/dataset ${res.status}: ${text.slice(0, 500)}`
    );
  }

  const json = (await res.json()) as {
    data?: { rows?: unknown[][]; cols?: Array<{ name: string }> };
    error?: string;
    error_type?: string;
  };

  if (json.error) {
    throw new Error(`Metabase query error: ${json.error}`);
  }
  if (!json.data) {
    throw new Error("Metabase response missing data");
  }

  const colNames = json.data.cols?.map((c) => c.name) ?? [];
  const rows = json.data.rows ?? [];

  return rows.map((row) => {
    const obj: Row = {};
    colNames.forEach((name, i) => {
      obj[name] = row[i];
    });
    return obj as T;
  });
}

/** Health-check: trivial SELECT against Aurora. */
export async function ping(): Promise<{
  ok: true;
  database: number;
  ts: string;
}> {
  await runQuery({ database: DB.AURORA, sql: "SELECT 1 AS ok" });
  return { ok: true, database: DB.AURORA, ts: new Date().toISOString() };
}

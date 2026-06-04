/**
 * Beacon Brain — bootstrap module.
 *
 * Reads the latest customer snapshot (already enriched with BaseSheet +
 * Chargebee + location_insights data via the nightly Stage A pipeline)
 * and seeds the Brain with high-confidence auto-confirmed facts.
 *
 * Wave 1 scope: only the unambiguous fields. AMs validate the messy
 * stuff (notes-derived facts) in Wave 1.5 once we ship the Haiku
 * extraction + Validate inbox.
 *
 * Fields auto-confirmed at bootstrap:
 *   identity/sold_by/sold_by_ae         ← snapshot.ae_name (when present)
 *   identity/sold_by/sold_at            ← snapshot.ob_date (onboarding date)
 *   operational/contract/contract_start ← snapshot.activated_at (Chargebee)
 *   operational/contract/mrr_amount     ← snapshot.plan_amount / mrr_basesheet
 *
 * Auto-confirm rationale:
 *   - All four come from systems-of-record (BaseSheet + Chargebee)
 *     that AMs already trust as truth.
 *   - The Validate inbox would be a graveyard if AMs had to confirm
 *     900 × 4 = 3,600 facts that they already know.
 *   - If a fact turns out wrong, the AM edits via the Brain panel and
 *     the version log captures the change.
 *
 * Idempotent by design: re-running this writes nothing if the snapshot's
 * values match what's already in the Brain (writeBrainFact short-circuits
 * on identical-value writes).
 */

import { readLatestSnapshotV2 } from "../customer/postgres";
import { writeBrainFact } from "./repo";

const SYSTEM_EMAIL = "system+bootstrap@beacon.zoca";

export interface BootstrapResult {
  customers_processed: number;
  customers_skipped: number;
  facts_written: number;
  facts_failed: number;
  errors: string[];
}

/**
 * Read the latest snapshot, iterate every customer, write auto-confirmed
 * Brain facts for the four bootstrap fields above. Idempotent: identical
 * re-runs are a no-op.
 *
 * `dryRun=true` reports what WOULD be written without touching the DB.
 *
 * Skips customers with empty/missing customer_id (snapshot rows without
 * a Chargebee handle aren't bootable into the Brain — there's no key).
 */
export async function bootstrapBrainFromSnapshot(
  opts: { dryRun?: boolean } = {},
): Promise<BootstrapResult> {
  const snap = await readLatestSnapshotV2();
  if (!snap || !snap.customers || snap.customers.length === 0) {
    return {
      customers_processed: 0,
      customers_skipped: 0,
      facts_written: 0,
      facts_failed: 0,
      errors: ["no snapshot available"],
    };
  }

  const result: BootstrapResult = {
    customers_processed: 0,
    customers_skipped: 0,
    facts_written: 0,
    facts_failed: 0,
    errors: [],
  };

  for (const c of snap.customers) {
    const customer_id = (c.customer_id || "").trim();
    if (!customer_id) {
      result.customers_skipped++;
      continue;
    }

    // The AM-of-record at the time of bootstrap. Owns every fact written
    // for this customer until an AM transition rewrites ownership.
    const owning_am_email = (() => {
      // BaseSheet stores AM display name (e.g., "Bikash Mishra"), not email.
      // For now, fall back to a tagged placeholder. A future migration
      // will populate owning_am_email properly via the am_name → email
      // mapping we already have in lib/customer/auth-mapping.ts.
      // For Wave 1, leave null — manager-only viewport handles this.
      const am = (c.am_name || "").trim();
      return am ? null : null;
    })();
    void owning_am_email; // intentionally unused for Wave 1; will wire in Wave 1.5

    const promises: Promise<unknown>[] = [];

    // ─── identity/sold_by/sold_by_ae ──────────────────────────────────
    const aeName = (c.ae_name || "").trim();
    if (aeName) {
      promises.push(
        writeFactSafe(
          {
            customer_id,
            topic_category: "identity",
            topic_subcategory: "sold_by",
            field_name: "sold_by_ae",
            value: aeName,
            source_type: "basesheet",
            source_ref: null,
            owning_am_email: null,
            confirmed_by_email: SYSTEM_EMAIL,
          },
          opts,
          result,
        ),
      );
    }

    // ─── identity/sold_by/sold_at (onboarding date) ───────────────────
    const obDate = (c.ob_date || "").trim();
    if (obDate && obDate !== "N/A") {
      promises.push(
        writeFactSafe(
          {
            customer_id,
            topic_category: "identity",
            topic_subcategory: "sold_by",
            field_name: "sold_at",
            value: obDate,
            source_type: "basesheet",
            source_ref: null,
            owning_am_email: null,
            confirmed_by_email: SYSTEM_EMAIL,
          },
          opts,
          result,
        ),
      );
    }

    // ─── operational/contract/contract_start (Chargebee activated_at) ─
    const activatedAt = (c.activated_at || "").trim();
    if (activatedAt) {
      promises.push(
        writeFactSafe(
          {
            customer_id,
            topic_category: "operational",
            topic_subcategory: "contract",
            field_name: "contract_start",
            value: activatedAt,
            source_type: "chargebee",
            source_ref: customer_id,
            owning_am_email: null,
            confirmed_by_email: SYSTEM_EMAIL,
          },
          opts,
          result,
        ),
      );
    }

    // ─── operational/contract/mrr_amount ──────────────────────────────
    // Prefer Chargebee plan_amount (current actual MRR), fall back to
    // mrr_basesheet (manually-entered MRR string).
    let mrrValue: string | null = null;
    if (typeof c.plan_amount === "number" && c.plan_amount > 0) {
      mrrValue = `$${c.plan_amount}/mo (Chargebee plan_amount)`;
    } else if (c.mrr_basesheet && c.mrr_basesheet.trim() !== "") {
      mrrValue = `${c.mrr_basesheet} (BaseSheet)`;
    }
    if (mrrValue) {
      promises.push(
        writeFactSafe(
          {
            customer_id,
            topic_category: "operational",
            topic_subcategory: "contract",
            field_name: "mrr_amount",
            value: mrrValue,
            source_type:
              typeof c.plan_amount === "number" && c.plan_amount > 0
                ? "chargebee"
                : "basesheet",
            source_ref: customer_id,
            owning_am_email: null,
            confirmed_by_email: SYSTEM_EMAIL,
          },
          opts,
          result,
        ),
      );
    }

    await Promise.all(promises);
    result.customers_processed++;
  }

  return result;
}

/**
 * Internal helper that wraps writeBrainFact in error handling and result
 * accounting. Records per-customer errors as strings rather than letting
 * them bubble up — bootstrap should be partial-failure tolerant.
 */
async function writeFactSafe(
  input: Parameters<typeof writeBrainFact>[0],
  opts: { dryRun?: boolean },
  result: BootstrapResult,
): Promise<void> {
  if (opts.dryRun) {
    result.facts_written++;
    return;
  }
  try {
    const row = await writeBrainFact(input);
    if (row) result.facts_written++;
    else result.facts_failed++;
  } catch (err) {
    result.facts_failed++;
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(
      `${input.customer_id} ${input.field_name}: ${msg.slice(0, 200)}`,
    );
  }
}

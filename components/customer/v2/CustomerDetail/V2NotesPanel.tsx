"use client";

import NotesField from "@/components/customer/v2/NotesField";

type Props = {
  amName: string;
  entityId: string;
  customerId: string | null;
  bizname: string | null;
};

/**
 * Phase 28 — Notes (private) panel.
 *
 * Thin wrapper around the existing NotesField. The note text is scoped per
 * (AM, customer) and only visible to the AM who wrote it.
 */
function V2NotesPanel({ amName, entityId, customerId, bizname }: Props) {
  return (
    <section
      className="rounded-zoca-lg border border-zoca-border bg-zoca-bg-soft p-4 md:p-5"
      aria-label="Private notes"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zoca-text-2">
          Notes (private)
        </h3>
        <span className="text-[10px] text-zoca-text-2">only you can see this</span>
      </div>
      <NotesField
        amName={amName}
        entityId={entityId}
        customerId={customerId}
        bizname={bizname}
      />
    </section>
  );
}

export default V2NotesPanel;

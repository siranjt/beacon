"use client";
import { useState } from "react";
import type { OneOnOneActionItem } from "@/lib/customer/one-on-one";

type Props = {
  saving: boolean;
  onSave: (payload: {
    notes: string;
    action_items: OneOnOneActionItem[];
    manager_email: string;
  }) => Promise<void>;
};

export default function V2OneOnOneNotes({ saving, onSave }: Props) {
  const [notes, setNotes] = useState("");
  const [managerEmail, setManagerEmail] = useState("");
  const [items, setItems] = useState<OneOnOneActionItem[]>([]);

  function addItem() {
    setItems((prev) => [...prev, { text: "", done: false, assignee: "" }]);
  }
  function removeItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }
  function updateItem(idx: number, patch: Partial<OneOnOneActionItem>) {
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    );
  }

  async function handleSave() {
    const cleaned = items
      .map((it) => ({
        text: (it.text || "").trim(),
        done: !!it.done,
        assignee: (it.assignee || "").trim() || undefined,
      }))
      .filter((it) => it.text);
    await onSave({
      notes: notes.trim(),
      action_items: cleaned,
      manager_email: managerEmail.trim(),
    });
    // Reset after save
    setNotes("");
    setItems([]);
  }

  return (
    <section
      className="mb-4 rounded-zoca-lg bg-zoca-bg-soft p-4 md:p-5"
      style={{ border: "0.5px solid var(--zoca-border)" }}
    >
      <header className="mb-3">
        <h2
          className="font-extrabold text-zoca-text"
          style={{ fontSize: "15px", letterSpacing: "-0.01em" }}
        >
          Capture this 1:1
        </h2>
        <p className="mt-0.5 text-[11px] text-zoca-text-2">
          Notes + action items. Saved to the 1:1 log so the next prep can
          compare deltas.
        </p>
      </header>

      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-zoca-text-2">
            Manager email (optional)
          </label>
          <input
            type="email"
            value={managerEmail}
            onChange={(e) => setManagerEmail(e.target.value)}
            placeholder="success@zoca.com"
            className="mt-1 w-full rounded-lg px-3 py-2 text-[12.5px]"
            style={{
              border: "0.5px solid var(--zoca-border)",
              background: "var(--zoca-bg-soft)",
              outline: "none",
            }}
          />
        </div>

        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-zoca-text-2">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What did you discuss? Anything to remember for next time?"
            className="mt-1 w-full rounded-lg px-3 py-2 text-[12.5px]"
            style={{
              border: "0.5px solid var(--zoca-border)",
              background: "var(--zoca-bg-soft)",
              outline: "none",
              resize: "vertical",
            }}
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-zoca-text-2">
              Action items
            </label>
            <button
              type="button"
              onClick={addItem}
              className="rounded-full px-3 py-1 text-[11.5px] font-semibold transition"
              style={{
                background: "rgba(200, 67, 29, 0.08)",
                color: "var(--zoca-blue)",
                border: "1px solid rgba(200, 67, 29, 0.22)",
                cursor: "pointer",
              }}
            >
              + Add
            </button>
          </div>
          {items.length === 0 ? (
            <div className="mt-2 rounded-lg bg-[color:var(--zoca-bg-soft)] px-3 py-3 text-[12px] text-zoca-text-2">
              No action items yet. Add one if anything came out of the 1:1.
            </div>
          ) : (
            <ul className="mt-2 space-y-2">
              {items.map((it, idx) => (
                <li
                  key={idx}
                  className="rounded-lg p-2"
                  style={{ border: "0.5px solid var(--zoca-border)" }}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={it.done}
                      onChange={(e) => updateItem(idx, { done: e.target.checked })}
                      className="mt-1"
                      style={{ cursor: "pointer" }}
                    />
                    <div className="flex-1 space-y-1">
                      <input
                        type="text"
                        value={it.text}
                        onChange={(e) => updateItem(idx, { text: e.target.value })}
                        placeholder="Action item description"
                        className="w-full rounded-lg px-2 py-1 text-[12px]"
                        style={{
                          border: "0.5px solid var(--zoca-border)",
                          background: "var(--zoca-bg-soft)",
                          outline: "none",
                        }}
                      />
                      <input
                        type="text"
                        value={it.assignee || ""}
                        onChange={(e) => updateItem(idx, { assignee: e.target.value })}
                        placeholder="Assignee (optional)"
                        className="w-full rounded-lg px-2 py-1 text-[11.5px]"
                        style={{
                          border: "0.5px solid var(--zoca-border)",
                          background: "var(--zoca-bg-soft)",
                          outline: "none",
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      aria-label="Remove"
                      className="rounded p-1 text-[14px] text-zoca-text-soft transition hover:text-zoca-pink"
                      style={{ background: "transparent", border: 0, cursor: "pointer" }}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-full px-4 py-2 text-[12.5px] font-semibold transition"
            style={{
              background: saving ? "var(--zoca-bg-soft)" : "var(--zoca-blue)",
              color: saving ? "var(--zoca-text-soft)" : "#fff",
              border: "1px solid var(--zoca-blue)",
              cursor: saving ? "default" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save 1:1"}
          </button>
        </div>
      </div>
    </section>
  );
}

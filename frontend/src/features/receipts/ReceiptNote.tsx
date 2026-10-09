import type { FormEvent, KeyboardEvent } from "react";
import { useState } from "react";

import type { Receipt } from "../../types";

/** The server's limit, repeated so the box stops taking text instead of refusing it. */
const MAX_NOTE_LENGTH = 500;

interface ReceiptNoteProps {
  receipt: Receipt;
  /**
   * Whether this user may write or change the note.
   *
   * Reading is for everybody who can see the receipt — that is the point of it.
   * Writing rides on the same permission as recording a payment: the clerk who
   * took the money is the one who leaves the message.
   */
  canWrite: boolean;
  /** Rejects with the message to show when the server refuses. */
  onSave: (note: string | null) => Promise<void>;
}

/**
 * The message left on a receipt for whoever reads it next.
 *
 * It sits beside the document in the Recibos panel and never on it. It used to
 * be printed at the foot of the receipt, which is also the picture sent to the
 * customer over WhatsApp — so a note meant for the office reached the person it
 * was about, and nobody not holding the paper ever saw it.
 *
 * Mount it with `key={receipt.id}`: an edit in progress belongs to one receipt,
 * and picking another row must not carry half a sentence over to it.
 */
export function ReceiptNote({ receipt, canWrite, onSave }: ReceiptNoteProps) {
  const [isEditing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // Nothing written and nothing the user could write: no empty box to look at.
  if (receipt.note === null && !canWrite) {
    return null;
  }

  const startEditing = () => {
    setDraft(receipt.note ?? "");
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();

    const next = draft.trim() === "" ? null : draft.trim();

    // Unchanged is not a save: no request, and nothing for the Historial.
    if (next === receipt.note) {
      cancel();
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await onSave(next);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the note.");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !isSaving) {
      event.stopPropagation();
      cancel();
    }
  };

  return (
    <section
      className={`receipt-memo${receipt.note === null && !isEditing ? " is-empty" : ""}`}
      aria-label="Receipt note"
    >
      <div className="receipt-memo-head">
        <p className="receipt-memo-label">Team note</p>

        {canWrite && !isEditing && (
          <button type="button" className="btn-secondary is-small" onClick={startEditing}>
            {receipt.note === null ? "Add note" : "Edit"}
          </button>
        )}
      </div>

      {isEditing ? (
        <form onSubmit={(event) => void save(event)}>
          <textarea
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            value={draft}
            autoFocus
            aria-label="Receipt note"
            placeholder="e.g. Will pay the rest on Friday. Proof is missing."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />

          <p className="receipt-memo-hint">
            Visible to all users. Not printed on the receipt or sent to the customer.
          </p>

          {error && <p className="form-error">{error}</p>}

          <div className="receipt-memo-actions">
            <button
              type="button"
              className="btn-secondary is-small"
              onClick={cancel}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary is-small" disabled={isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : (
        receipt.note !== null && <p className="receipt-memo-text">{receipt.note}</p>
      )}
    </section>
  );
}

import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Lot } from "../../types";

const MINIMUM_REASON_LENGTH = 10;

interface LotArchiveDialogProps {
  lot: Lot;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (reason: string) => Promise<void>;
}

/**
 * Archiving, not deleting.
 *
 * A lot that has ever carried a contract cannot be removed without tearing a
 * hole in the financial history, so Lindero hides it instead of destroying it.
 * The reason is required because this is one of the few actions somebody may
 * genuinely need explained back to them months later.
 */
export function LotArchiveDialog({ lot, onCancel, onConfirm }: LotArchiveDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isArchiving, setArchiving] = useState(false);

  const isBlocked = lot.holding !== null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Please provide a reason with at least ${MINIMUM_REASON_LENGTH} characters.`);
      return;
    }

    setArchiving(true);

    try {
      await onConfirm(reason.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to archive the lot.");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Archive lot ${lot.code}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">Archive lot</p>
            <h2>{lot.code}</h2>
            <p className="modal-description">
              The lot will no longer appear in active inventory, but its history is kept.
              Nothing is deleted.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {isBlocked ? (
            <p className="form-blocked full-width">
              This lot can't be archived because it has an active contract or reservation
              ({lot.holding?.contractCode}). Cancel the contract first.
            </p>
          ) : (
            <div className="form-field full-width">
              <label htmlFor="archive-reason">
                Reason<span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <textarea
                id="archive-reason"
                rows={3}
                value={reason}
                placeholder="e.g. Lot entered twice by mistake on August 12."
                onChange={(event) => setReason(event.target.value)}
              />
              <span className="field-hint">
                This will be saved in the history with your name and the date.
              </span>
            </div>
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isArchiving}>
            Cancel
          </button>
          <button type="submit" className="btn-danger" disabled={isBlocked || isArchiving}>
            {isArchiving ? "Archiving…" : "Archive lot"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

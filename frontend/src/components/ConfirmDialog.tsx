import type { ReactNode } from "react";
import { useState } from "react";

import { Dialog } from "./Dialog";
import { IconClose } from "./Icons";

interface ConfirmDialogProps {
  /** The small uppercase line above the title. Names the ACT, not the thing. */
  eyebrow: string;
  /** What is about to be acted on — a filename, a person, a code. */
  title: string;
  /** One line of context under the title: who filed it, when, how big. */
  description?: string;
  /** The warning itself. A node, so it can name things in bold. */
  children: ReactNode;
  /** The danger button's label. A verb and its object: "Quitar documento". */
  confirmLabel: string;
  /** What that button says while the request is in flight. */
  busyLabel: string;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: () => Promise<void>;
}

/**
 * "Are you sure?", for the destructive actions that do not need a typed motive.
 *
 * Lindero's heavier confirmations — deleting a customer, voiding a receipt,
 * cancelling a contract — each ask for a reason, because each writes a line of
 * history that has to explain itself later. This is for the ones where the
 * record is the file itself and there is nothing to explain: the only thing
 * needed is a deliberate second press.
 *
 * It exists because a destructive control was sitting next to a close button.
 * That is not a thing to fix twice, in two features, by remembering to: the
 * confirmation lives in one component and the callers hand it copy, so a new
 * place that removes a stored file cannot quietly ship without one.
 *
 * The danger button is NOT focused on mount. `Dialog` puts focus on the panel,
 * and that is deliberate here — a confirmation whose destructive button answers
 * the Enter key of somebody still typing is a confirmation that confirms
 * accidents rather than preventing them.
 */
export function ConfirmDialog({
  eyebrow,
  title,
  description,
  children,
  confirmLabel,
  busyLabel,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [isWorking, setWorking] = useState(false);

  const confirm = async () => {
    setError(null);
    setWorking(true);

    try {
      await onConfirm();
    } catch (caught) {
      // Left open on failure, with the reason. Closing would look like it
      // worked, and the next thing the user does is check whether it did.
      setError(caught instanceof Error ? caught.message : "Unable to complete the action.");
      setWorking(false);
    }
  };

  return (
    <Dialog ariaLabel={`${eyebrow}: ${title}`} onClose={onCancel}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow danger-eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          {description && <p className="modal-description">{description}</p>}
        </div>
        <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-warning full-width">{children}</p>
        {error && <p className="form-error full-width">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={isWorking}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-danger"
          disabled={isWorking}
          onClick={() => void confirm()}
        >
          {isWorking ? busyLabel : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { ROLE_LABELS } from "../../lib/permissions";
import type { UserAccount } from "./api";

interface UserDeactivateDialogProps {
  account: UserAccount;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: () => Promise<void>;
}

/**
 * Switch an account off — what happens when somebody leaves.
 *
 * Deliberately NOT a delete, and the dialog explains why rather than just
 * saying no: this person's name is on every payment they took and every line
 * of the history they wrote. Removing the account would either break those
 * references or quietly turn a year of receipts into money nobody received.
 *
 * No motive field, unlike archiving a lot. Somebody leaving is not a judgement
 * that needs defending later, and the history already records who did it and
 * when. Asking for a reason here would train people to type "x", which is how
 * the reason fields that DO matter stop being read.
 */
export function UserDeactivateDialog({ account, onCancel, onConfirm }: UserDeactivateDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);

    try {
      await onConfirm();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : `Unable to deactivate ${account.name}.`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Deactivate ${account.name}'s account`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">Deactivate account</p>
            <h2>{account.name}</h2>
            <p className="modal-description">
              {ROLE_LABELS[account.role]} · {account.email}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <p className="form-warning full-width">
            {account.name} will lose access immediately, even if the app is open right now.
          </p>

          <p className="field-hint full-width">
            The account is not deleted on purpose: payments recorded and other actions by{" "}
            {account.name} will remain attributed to them in the history. If they return, you
            can reactivate the account from this screen, and their password will stay the same.
          </p>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="btn-danger" disabled={isSaving}>
            {isSaving ? "Deactivating…" : "Deactivate account"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

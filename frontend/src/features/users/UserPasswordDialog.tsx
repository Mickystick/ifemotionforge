import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { UserAccount } from "./api";
import { MINIMUM_PASSWORD_LENGTH, PasswordFields, describePasswordProblem } from "./PasswordFields";

interface UserPasswordDialogProps {
  account: UserAccount;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (password: string) => Promise<void>;
}

/**
 * Set somebody's password, which is the only thing a supervisor can do about a
 * forgotten one: there is nothing to recover, only a hash.
 *
 * The dialog says out loud that it ends the person's sessions, because that is
 * the surprising part. A supervisor resetting a password for a colleague who is
 * mid-shift should know they are about to interrupt them.
 */
export function UserPasswordDialog({ account, onCancel, onConfirm }: UserPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const problem = describePasswordProblem(password, confirmation);

    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);

    try {
      await onConfirm(password);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to change the password.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Change ${account.name}'s password`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Change password</p>
            <h2>{account.name}</h2>
            <p className="modal-description">
              {account.isSelf
                ? "You're changing your own account password. You'll be signed out on your " +
                  "other devices."
                : `The old password will stop working immediately, and ${account.name} ` +
                  "will be signed out on all devices."}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <p className="form-warning full-width">
            No one can retrieve the current password: the system only stores a fingerprint of
            it. This replaces the password rather than recovering it—write it down and deliver
            it in person.
          </p>

          <PasswordFields
            idPrefix="user-reset"
            password={password}
            confirmation={confirmation}
            onPasswordChange={setPassword}
            onConfirmationChange={setConfirmation}
            hint={`At least ${MINIMUM_PASSWORD_LENGTH} characters.`}
          />

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>{isSaving ? "Saving…" : "Change password"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

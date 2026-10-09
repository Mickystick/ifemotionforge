import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Role } from "../../lib/permissions";
import { ROLE_LABELS } from "../../lib/permissions";
import type { UserAccount, UserDraft } from "./api";
import { MINIMUM_PASSWORD_LENGTH, PasswordFields, describePasswordProblem } from "./PasswordFields";

interface UserFormDialogProps {
  /** `null` creates an account; an account edits that one. */
  account: UserAccount | null;
  /** Everyone already on file, so a taken email is caught before the round trip. */
  users: UserAccount[];
  /** Whether this dialog is editing the signed-in supervisor's own account. */
  isSelf: boolean;
  onCancel: () => void;
  /**
   * Rejects when the server refuses; the message is shown in the dialog.
   * `password` is present only when creating — an edit never touches it.
   */
  onSave: (draft: UserDraft & { password?: string }) => Promise<void>;
}

const ROLE_HINTS: Record<Role, string> = {
  owner:
    "Can do everything, including create accounts and edit permissions. Keep at least two " +
    "owners so no one is locked out if one forgets their password.",
  staff:
    "Handles day-to-day work. Their exact permissions are set on the Permissions screen and " +
    "apply equally to all staff members.",
};

/**
 * Create or edit an account — one dialog for both, like CustomerFormDialog.
 *
 * The password appears only when creating. Changing it later is a separate,
 * deliberate action with its own dialog, because it signs the person out
 * everywhere and that should never be a side effect of fixing a typo in a name.
 */
export function UserFormDialog({
  account,
  users,
  isSelf,
  onCancel,
  onSave,
}: UserFormDialogProps) {
  const isEditing = account !== null;

  const [name, setName] = useState(account?.name ?? "");
  const [email, setEmail] = useState(account?.email ?? "");
  const [role, setRole] = useState<Role>(account?.role ?? "staff");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // One address, one account — it is what somebody types to sign in, so a
  // duplicate is not a tidiness problem but two people who cannot both get in.
  const typedEmail = email.trim().toLowerCase();

  const duplicate =
    typedEmail === ""
      ? undefined
      : users.find((other) => other.id !== account?.id && other.email.toLowerCase() === typedEmail);

  const passwordProblem = isEditing
    ? null
    : describePasswordProblem(password, confirmation);

  const isDirty =
    name !== (account?.name ?? "") ||
    email !== (account?.email ?? "") ||
    role !== (account?.role ?? "staff") ||
    password !== "" ||
    confirmation !== "";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Name is required; it will appear in the history.");
      return;
    }
    if (typedEmail === "" || !typedEmail.includes("@")) {
      setError("Enter a valid email address. This person will use it to sign in.");
      return;
    }
    if (duplicate) {
      setError(`The email ${typedEmail} is already used by ${duplicate.name}'s account.`);
      return;
    }
    if (passwordProblem) {
      setError(passwordProblem);
      return;
    }

    setSaving(true);

    try {
      await onSave({
        name: name.trim(),
        email: typedEmail,
        role,
        ...(isEditing ? {} : { password }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the account.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={isEditing ? `Edit ${account.name}'s account` : "New account"}
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">{isEditing ? "Edit account" : "New account"}</p>
            <h2>{name.trim() || "No name"}</h2>
            <p className="modal-description">
              {isEditing
                ? "You can't edit the password here. Changing it is a separate action because " +
                  "it signs this person out on all their devices."
                : "Give the password to the person in person or through a trusted channel. The " +
                  "system won't email it or show it again after the account is created."}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field">
            <label htmlFor="user-name">Full name</label>
            <input
              id="user-name"
              value={name}
              placeholder="e.g. Ana Lucia Paz"
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">
              This is how their name will appear in the history alongside their activity.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="user-email">Email</label>
            <input
              id="user-email"
              type="email"
              value={email}
              placeholder="ana@example.com"
              autoComplete="off"
              aria-invalid={duplicate !== undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
            {duplicate ? (
              <span className="field-error">Already used by {duplicate.name}'s account.</span>
            ) : (
              <span className="field-hint">They'll use this to sign in. Nothing will be sent to them.</span>
            )}
          </div>

          <div className="form-field full-width">
            <label htmlFor="user-role">Role</label>
            <select
              id="user-role"
              value={role}
              // Nobody changes their own role: the server refuses it, because a
              // supervisor who demotes themselves loses the permission needed
              // to put it back — including on the very next request.
              disabled={isEditing && isSelf}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option value="staff">{ROLE_LABELS.staff}</option>
              <option value="owner">{ROLE_LABELS.owner}</option>
            </select>
            <span className="field-hint">
              {isEditing && isSelf
                ? "You can't change your own role. Ask another owner to do it so you don't lose " +
                  "access to your account."
                : ROLE_HINTS[role]}
            </span>
          </div>

          {!isEditing && (
            <PasswordFields
              idPrefix="user-new"
              password={password}
              confirmation={confirmation}
              onPasswordChange={setPassword}
              onConfirmationChange={setConfirmation}
              hint={
                `At least ${MINIMUM_PASSWORD_LENGTH} characters. A short phrase only this ` +
                "person knows is better than a short, complicated password."
              }
            />
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary modal-submit"
            disabled={isSaving || duplicate !== undefined}
          >
            <span>{isSaving ? "Saving…" : isEditing ? "Save changes" : "Create account"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

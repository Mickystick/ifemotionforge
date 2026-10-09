import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { businessYear } from "../../lib/businessTime";
import {
  COUNTRY_CODES,
  DEFAULT_DIAL,
  describePhoneProblem,
  joinPhone,
  splitPhone,
} from "../../lib/phone";
import type { CustomerRecord } from "../../types";
import type { CustomerDraft } from "./api";

interface CustomerFormDialogProps {
  /** `null` creates a customer; a customer edits that one. */
  customer: CustomerRecord | null;
  /**
   * Everyone already on file, so an identity number that is taken can be caught
   * here rather than on the round trip. The server checks the same thing.
   */
  customers: CustomerRecord[];
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (draft: CustomerDraft) => Promise<void>;
}

/** Blank means "not recorded", which is a different thing from an empty string. */
const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/**
 * Create or edit a customer. One dialog for both, like ProjectFormDialog: the
 * fields are identical and only the wording and the starting values differ.
 */
export function CustomerFormDialog({
  customer,
  customers,
  onCancel,
  onSave,
}: CustomerFormDialogProps) {
  const isEditing = customer !== null;

  const [fullName, setFullName] = useState(customer?.fullName ?? "");
  const [identification, setIdentification] = useState(customer?.identification ?? "");
  // The country code and the national number are edited as two fields rather
  // than one. Typed as one string, "+504" is eight keystrokes nobody wants on a
  // phone keypad and the commonest thing to leave out — and a number saved
  // without it cannot be dialled by WhatsApp later.
  const [dialCode, setDialCode] = useState(
    () => (customer?.phone ? splitPhone(customer.phone).dialCode : DEFAULT_DIAL),
  );
  const [national, setNational] = useState(
    () => (customer?.phone ? splitPhone(customer.phone).national : ""),
  );
  const [email, setEmail] = useState(customer?.email ?? "");
  const [address, setAddress] = useState(customer?.address ?? "");
  const [customerSince, setCustomerSince] = useState(
    String(customer?.customerSince ?? businessYear()),
  );
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // What the number will actually be stored as, and what is wrong with it if
  // anything. The phone is optional, so a blank field is never a problem —
  // this only has something to say once digits have actually been typed.
  const phoneProblem = describePhoneProblem(dialCode, national);

  // One person, one identity number. Entering somebody twice splits their
  // contracts across two records and quietly breaks both balances, so this is
  // caught before saving as well as by the server.
  //
  // Only once a number has actually been typed. The identidad is optional, and
  // every customer who has not given one would otherwise match every other
  // customer who has not given one — turning the commonest legitimate case into
  // a duplicate warning.
  const typedIdentification = identification.trim();

  const duplicate =
    typedIdentification === ""
      ? undefined
      : customers.find(
          (other) =>
            other.id !== customer?.id &&
            other.identification?.trim().toLowerCase() === typedIdentification.toLowerCase(),
        );

  // Has anything actually been typed? Compared against the pristine values
  // above rather than "is any field non-empty", so an edit that opens
  // pre-filled does not lock the dialog before a single keystroke.
  const isDirty =
    fullName !== (customer?.fullName ?? "") ||
    identification !== (customer?.identification ?? "") ||
    dialCode !== (customer?.phone ? splitPhone(customer.phone).dialCode : DEFAULT_DIAL) ||
    national !== (customer?.phone ? splitPhone(customer.phone).national : "") ||
    email !== (customer?.email ?? "") ||
    address !== (customer?.address ?? "") ||
    customerSince !== String(customer?.customerSince ?? businessYear()) ||
    notes !== (customer?.notes ?? "");

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const year = Number(customerSince);

    if (!fullName.trim()) {
      setError("Customer name is required.");
      return;
    }
    if (duplicate) {
      setError(`ID number ${typedIdentification} is already registered to ${duplicate.fullName}.`);
      return;
    }
    if (phoneProblem) {
      setError(phoneProblem);
      return;
    }
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      setError("The year the person became a customer doesn't look right.");
      return;
    }

    setSaving(true);

    try {
      await onSave({
        fullName: fullName.trim(),
        // Blank travels as blank; the server stores it as NULL. See the note on
        // `identification` in backend/src/db/schema.ts for why not "".
        identification: typedIdentification,
        // Blank travels as blank, same as identification above — the server
        // stores it as NULL. Otherwise sent with its country code already
        // attached; the server normalises it again and its answer is the
        // stored one, so there is only ever one implementation that counts.
        phone: national.trim() === "" ? "" : joinPhone(dialCode, national),
        email: orNull(email),
        address: orNull(address),
        customerSince: year,
        notes: orNull(notes),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the customer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={isEditing ? `Edit ${customer.fullName}` : "New customer"}
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">{isEditing ? "Edit customer" : "New customer"}</p>
            <h2>{fullName.trim() || "No name"}</h2>
            <p className="modal-description">
              Contracts and balances aren't entered here; they're calculated from recorded
              contracts and payments.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field full-width">
            <label htmlFor="customer-name">Full name</label>
            <input
              id="customer-name"
              value={fullName}
              placeholder="e.g. Maria Fernandez"
              onChange={(event) => setFullName(event.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="customer-id">ID number (optional)</label>
            <input
              id="customer-id"
              value={identification}
              placeholder="0801-1990-11207"
              aria-invalid={duplicate !== undefined}
              onChange={(event) => setIdentification(event.target.value)}
            />
            {duplicate ? (
              <span className="field-error">Already registered to {duplicate.fullName}.</span>
            ) : (
              /* Said out loud, because a blank field with no hint reads as one
                 the user forgot rather than one they are allowed to leave. */
              <span className="field-hint">
                Leave this blank if the customer hasn't provided it. One person, one ID number.
              </span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="customer-phone">Phone (optional)</label>
            <div className="phone-input">
              <select
                className="phone-dial"
                value={dialCode}
                aria-label="Country code"
                onChange={(event) => setDialCode(event.target.value)}
              >
                {COUNTRY_CODES.map((country) => (
                  <option key={country.dial} value={country.dial}>
                    {country.dial === "+" ? "+ Other" : `${country.dial} ${country.label}`}
                  </option>
                ))}
              </select>
              <input
                id="customer-phone"
                inputMode="tel"
                autoComplete="tel-national"
                value={national}
                placeholder="9982-4471"
                aria-invalid={phoneProblem !== null}
                onChange={(event) => setNational(event.target.value)}
              />
            </div>
            {phoneProblem ? (
              <span className="field-error">{phoneProblem}</span>
            ) : national.trim() === "" ? (
              /* Said out loud, same as the identidad hint above: a blank field
                 with no explanation reads as one the user forgot rather than
                 one they are allowed to leave. */
              <span className="field-hint">
                Leave this blank if you have never needed to contact this customer.
              </span>
            ) : (
              <span className="field-hint">
                {dialCode === "+504"
                  ? "Honduras. Change this if the customer is in another country."
                  : `It will be saved as ${joinPhone(dialCode, national)}.`}
              </span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="customer-email">Email</label>
            <input
              id="customer-email"
              type="email"
              value={email}
              placeholder="Optional"
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="customer-since">Customer since</label>
            <input
              id="customer-since"
              type="number"
              inputMode="numeric"
              min="1900"
              max="2200"
              value={customerSince}
              onChange={(event) => setCustomerSince(event.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="customer-address">Address</label>
            <input
              id="customer-address"
              value={address}
              placeholder="Optional"
              onChange={(event) => setAddress(event.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="customer-notes">Notes</label>
            <textarea
              id="customer-notes"
              rows={3}
              value={notes}
              placeholder="e.g. Prefers WhatsApp messages in the afternoon."
              onChange={(event) => setNotes(event.target.value)}
            />
            <span className="field-hint">
              Useful details to remember: how they pay, who to call, or what was agreed verbally.
            </span>
          </div>

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
            <span>
              {isSaving ? "Saving…" : isEditing ? "Save changes" : "Create customer"}
            </span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

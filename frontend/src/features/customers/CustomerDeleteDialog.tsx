import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { customerLine } from "../../lib/identification";
import type { CustomerRecord } from "../../types";

const MINIMUM_REASON_LENGTH = 10;

interface CustomerDeleteDialogProps {
  customer: CustomerRecord;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (reason: string) => Promise<void>;
}

/**
 * Deleting a customer — the one thing in Lindero that really is deleted.
 *
 * Lots and projects are archived because they carry financial history. A person
 * who has never been on a contract carries none: nothing points at them, and
 * keeping an empty record forever only makes the list harder to search. So the
 * row goes, and the audit entry — with the motive typed here — is what remains.
 *
 * The moment a contract exists the answer is no, and the dialog says so before
 * the user types anything. The server refuses this too; this is the courtesy of
 * saying it early rather than after the click.
 */
export function CustomerDeleteDialog({
  customer,
  onCancel,
  onConfirm,
}: CustomerDeleteDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  // Only ACTIVE contracts arrive with the customer list. A person whose
  // contracts have all ended looks empty from here, so the server's own check —
  // which counts every contract they have ever been on — has the final say, and
  // its refusal is shown below.
  const activeContracts = customer.contracts;
  const isBlocked = activeContracts.length > 0;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Please provide a reason with at least ${MINIMUM_REASON_LENGTH} characters.`);
      return;
    }

    setDeleting(true);

    try {
      await onConfirm(reason.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete the customer.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog ariaLabel={`Delete ${customer.fullName}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">Delete customer</p>
            <h2>{customer.fullName}</h2>
            <p className="modal-description">{customerLine(customer)}</p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {isBlocked ? (
            <p className="form-blocked full-width">
              {customer.fullName} has {activeContracts.length} active contract
              {activeContracts.length === 1 ? "" : "s"} (
              {activeContracts.map((contract) => contract.contractCode).join(", ")}). Cancel
              the contract first; deleting the customer would leave{" "}
              {activeContracts.length === 1 ? "that lot" : "those lots"}{" "}
              without an owner.
            </p>
          ) : (
            <>
              <p className="form-warning full-width">
                This permanently deletes {customer.fullName}'s record. This is not archiving:
                it can't be undone. Only the history entry you write here will remain.
              </p>

              <div className="form-field full-width">
                <label htmlFor="customer-delete-reason">
                  Reason<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <textarea
                  id="customer-delete-reason"
                  rows={3}
                  value={reason}
                  placeholder="e.g. Entered twice on August 12; this record is empty."
                  onChange={(event) => setReason(event.target.value)}
                />
                <span className="field-hint">
                  This will be saved in the history with your name and the date.
                </span>
              </div>
            </>
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </button>
          <button type="submit" className="btn-danger" disabled={isBlocked || isDeleting}>
            {isDeleting ? "Deleting…" : "Delete customer"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

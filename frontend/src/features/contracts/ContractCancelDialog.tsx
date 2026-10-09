import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import type { Contract } from "../../types";
import type { CancelSettlement } from "./api";

const MINIMUM_REASON_LENGTH = 10;

/**
 * Cancelling and defaulting are the same dialog: the lot comes back, nothing is
 * deleted, and the same question is asked about money already paid. They differ
 * only in wording — a cancellation is a sale unwound by agreement, a default is
 * the business writing off what it is owed.
 */
type Mode = "cancel" | "default";

interface ContractCancelDialogProps {
  contract: Contract;
  money: MoneyView;
  mode?: Mode;
  /** May this user reverse payments? Gates the "refund" option. */
  canRefund: boolean;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (reason: string, settlement?: CancelSettlement) => Promise<void>;
}

const COPY: Record<
  Mode,
  { eyebrow: string; submit: string; busy: string; placeholder: string; moneyHint: string }
> = {
  cancel: {
    eyebrow: "Cancel contract",
    submit: "Cancel contract",
    busy: "Canceling…",
    placeholder: "e.g. The customer changed their mind, and we agreed to refund the down payment.",
    moneyHint: "What should happen to that money?",
  },
  default: {
    eyebrow: "Mark as defaulted",
    submit: "Mark as defaulted",
    busy: "Saving…",
    placeholder: "e.g. The customer lost their job and said they can no longer make payments.",
    moneyHint: "What should happen to the amount already paid? It's usually kept as income.",
  },
};

const SETTLEMENT_OPTIONS: Array<{
  value: CancelSettlement;
  title: string;
  detail: string;
  needsRefundRight?: boolean;
}> = [
  {
    value: "none",
    title: "Keep as income",
    detail: "Nothing is refunded. The amount paid stays in the accounts.",
  },
  {
    value: "held",
    title: "Hold temporarily",
    detail: "It still counts for now and is marked for a decision later.",
  },
  {
    value: "refunded",
    title: "Refund to customer",
    detail:
      "Payments are reversed immediately: they stop counting, and the receipt they covered is voided.",
    needsRefundRight: true,
  },
];

export function ContractCancelDialog({
  contract,
  money,
  mode = "cancel",
  canRefund,
  onCancel,
  onConfirm,
}: ContractCancelDialogProps) {
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState<CancelSettlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  const copy = COPY[mode];
  const hasMoney = contract.paidToDate > 0;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Please provide a reason with at least ${MINIMUM_REASON_LENGTH} characters.`);
      return;
    }

    if (hasMoney && settlement === null) {
      setError("Choose what should happen to the amount the customer already paid.");
      return;
    }

    setSubmitting(true);

    try {
      await onConfirm(reason.trim(), hasMoney ? (settlement ?? undefined) : undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to complete the action.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog ariaLabel={`${copy.eyebrow} ${contract.code}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">{copy.eyebrow}</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              Lot {contract.lot.code} will become available again. The contract and its payments
              remain in the history; nothing is deleted.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {hasMoney && (
            <fieldset className="form-field full-width settlement-choice">
              <legend>
                {contract.customer.fullName} has already paid {formatMoney(contract.paidToDate, money)}
                toward this contract. {copy.moneyHint}
                <span className="required-mark" aria-hidden="true"> *</span>
              </legend>

              {SETTLEMENT_OPTIONS.map((option) => {
                const disabled = option.needsRefundRight === true && !canRefund;

                return (
                  <label
                    key={option.value}
                    className={disabled ? "settlement-option is-disabled" : "settlement-option"}
                  >
                    <input
                      type="radio"
                      name="settlement"
                      value={option.value}
                      checked={settlement === option.value}
                      disabled={disabled}
                      onChange={() => setSettlement(option.value)}
                    />
                    <span>
                      <span className="settlement-title">{option.title}</span>
                      <span className="settlement-detail">
                        {option.detail}
                        {disabled && " Your account can't reverse payments."}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          <div className="form-field full-width">
            <label htmlFor="cancel-reason">
              Reason<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="cancel-reason"
              rows={3}
              value={reason}
              placeholder={copy.placeholder}
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              This will be saved in the history with your name and the date.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSubmitting}>
            Back
          </button>
          <button type="submit" className="btn-danger" disabled={isSubmitting}>
            {isSubmitting ? copy.busy : copy.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

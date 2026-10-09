import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import type { Receipt } from "../../types";
import { voidReceipt } from "./api";

interface ReceiptVoidDialogProps {
  receipt: Receipt;
  money: MoneyView;
  onClose: () => void;
  onVoided: () => void;
}

const MINIMUM_REASON = 10;

/**
 * Anular un recibo.
 *
 * Worth being precise about what this does, because "anular" sounds like
 * "delete" and is the opposite of it. The document stays, the number stays, and
 * both remain visible as a void — a missing receipt number cannot be told apart
 * from a hidden one, and a customer holding the printed copy has to be able to
 * be shown why it no longer stands.
 *
 * What changes is that the money stops counting. The payments keep their
 * amount, their date and their rate; every balance in the app already ignores a
 * reversed payment, so the contract, the customer's total and every receipt
 * issued after this one re-derive on their own.
 */
export function ReceiptVoidDialog({ receipt, money, onClose, onVoided }: ReceiptVoidDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= MINIMUM_REASON && !isSaving;

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await voidReceipt(receipt.id, trimmed);
      onVoided();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not void the receipt.");
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Void receipt ${receipt.code}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow danger-eyebrow">Void receipt</p>
          <h2>{receipt.code}</h2>
          <p className="modal-description">
            {receipt.customer.fullName} · {formatMoney(receipt.totalPaid, money)}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <p className="form-note full-width">
          The receipt is not deleted and its number is never reused; it remains visible as voided.
          The money no longer counts, so the contract balance and all later receipts are
          recalculated.
        </p>

        <div className="form-field full-width">
          <label htmlFor="void-reason">
            Reason <span className="required-mark">*</span>
          </label>
          <textarea
            id="void-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. The customer's check was rejected by the bank."
          />
          <span className="field-hint">
            Printed on the voided receipt and kept in the history. This explains to the customer why
            their copy is no longer valid.
          </span>
          {trimmed.length > 0 && trimmed.length < MINIMUM_REASON && (
            <span className="field-error">Enter at least {MINIMUM_REASON} characters.</span>
          )}
        </div>

        {error && <p className="form-error full-width">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-danger modal-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {isSaving ? "Voiding…" : "Void receipt"}
        </button>
      </div>
    </Dialog>
  );
}

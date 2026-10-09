import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { AreaUnit } from "../../lib/area";
import type { MoneyView } from "../../lib/money";
import type { Contract, Lot } from "../../types";
import { LotPicker } from "./ContractPartyPickers";

const MINIMUM_REASON_LENGTH = 10;

interface ContractReassignLotDialogProps {
  contract: Contract;
  lots: Lot[];
  unitByProject: Map<string, AreaUnit>;
  money: MoneyView;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (lotId: string, reason: string) => Promise<void>;
}

/**
 * Correcting the lot on a signed contract — for the one case `ContractEditDialog`
 * turns away: a lot mistyped at signing, with payments already recorded
 * against it.
 *
 * Deliberately a dialog of its own rather than an unlocked field on the terms
 * form. "A different lot is a different sale" stays true even for a mistake —
 * this is still a distinct, heavily-audited act. What it spares the office is
 * undoing every payment already posted to the wrong lot: nothing in this app
 * stores a lot id anywhere but on the contract itself, so moving it here is
 * the whole correction — every balance and every past receipt for this
 * contract, old and new, reads the lot it points to now.
 */
export function ContractReassignLotDialog({
  contract,
  lots,
  unitByProject,
  money,
  onCancel,
  onConfirm,
}: ContractReassignLotDialogProps) {
  const [lot, setLot] = useState<Lot | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isDirty = lot !== null || reason.trim() !== "";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!lot) {
      setError("Choose the correct lot.");
      return;
    }
    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Please provide a reason with at least ${MINIMUM_REASON_LENGTH} characters.`);
      return;
    }

    setSaving(true);

    try {
      await onConfirm(lot.id, reason.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reassign the lot.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={`Reassign the lot for ${contract.code}`}
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Correct lot</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              {contract.customer.fullName} · Current lot {contract.lot.code} ·{" "}
              {contract.lot.projectName}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <p className="form-blocked full-width">
            Use this to correct an incorrectly entered lot, not to sell a different lot—that
            requires a new contract. Payments already recorded stay with this contract; lot{" "}
            {contract.lot.code} will become available as soon as you save.
          </p>

          <div className="form-field full-width">
            <label>Correct lot</label>
            <LotPicker
              lots={lots}
              unitByProject={unitByProject}
              money={money}
              selected={lot}
              onSelect={setLot}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="reassign-reason">
              Reason<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="reassign-reason"
              rows={3}
              value={reason}
              placeholder="e.g. Lot B-12 was entered by mistake; the customer bought B-21."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Required: this will be saved in the history with your name, the date, and this reason.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving || !lot}>
            <span>{isSaving ? "Saving…" : "Reassign lot"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

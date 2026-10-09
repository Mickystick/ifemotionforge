import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { AREA_UNIT_INFO, toAreaInput, toSquareMetres } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { fromCurrencyUnits, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Lot } from "../../types";

interface LotEditDialogProps {
  lot: Lot;
  /**
   * Every active lot, so a number that is already taken can be caught here
   * rather than on the round trip. The server checks the same thing and its
   * answer is the one that counts — this only spares the user a failed save.
   */
  lots: Lot[];
  /** The area unit each project is captured in — see lib/area.ts. */
  unitByProject: Map<string, AreaUnit>;
  /**
   * Whether this user may reprice a lot that is under contract.
   *
   * The server has always enforced this, but nothing asked here — so a user
   * without it could retype the price, write a justification, press Guardar and
   * only then be told no. Locking the field turns a refused save into a
   * sentence read before any typing starts.
   */
  canChangePrice: boolean;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (changes: {
    code: string;
    projectName: string;
    areaM2: number;
    basePriceCents: number;
    reason?: string;
  }) => Promise<void>;
}

export function LotEditDialog({
  lot,
  lots,
  unitByProject,
  canChangePrice,
  onCancel,
  onSave,
}: LotEditDialogProps) {
  // The lot is shown in its project's unit, and converted back to the stored
  // square metres on save.
  const unit = unitByProject.get(lot.projectName) ?? "m2";
  const unitInfo = AREA_UNIT_INFO[unit];

  const [code, setCode] = useState(lot.code);
  const [projectName, setProjectName] = useState(lot.projectName);
  const [area, setArea] = useState(() => toAreaInput(lot.areaM2, unit));
  // Money is edited in lempiras, with thousand separators, and converted to
  // centavos on save.
  const [basePrice, setBasePrice] = useState(() => toMoneyInput(lot.basePrice));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // Repricing a lot that is under contract is allowed — prices get
  // renegotiated, especially in the first months — but it is the one lot edit
  // that touches money, so it asks for a written reason and is filed in the
  // history under its own action.
  const priceChanged = fromCurrencyUnits(parseMoneyInput(basePrice) || 0) !== lot.basePrice;
  const needsJustification = lot.holding !== null && priceChanged;
  // The capability only bites on a lot that is under contract — an available
  // lot's list price is ordinary inventory upkeep, not a change to what
  // anybody owes, and the server draws the line in the same place.
  const priceLocked = lot.holding !== null && !canChangePrice;

  // Lot numbers are unique WITHIN a project, so moving a lot to another project
  // can collide exactly as renaming it can. Both are measured against whichever
  // project is selected right now, not the one the lot started in.
  const duplicate = lots.some(
    (other) =>
      other.id !== lot.id &&
      other.projectName === projectName.trim() &&
      other.code.toUpperCase() === code.trim().toUpperCase(),
  );

  const isDirty =
    code !== lot.code ||
    projectName !== lot.projectName ||
    area !== toAreaInput(lot.areaM2, unit) ||
    basePrice !== toMoneyInput(lot.basePrice) ||
    reason.trim() !== "";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const areaValue = Number(area);
    const price = parseMoneyInput(basePrice);

    if (!code.trim()) {
      setError("Lot number is required.");
      return;
    }
    if (!projectName.trim()) {
      setError("The project is required.");
      return;
    }
    if (duplicate) {
      setError(`Lot ${code.trim()} already exists in ${projectName.trim()}. Use a different number.`);
      return;
    }
    if (area.trim() === "" || !Number.isFinite(areaValue) || areaValue <= 0) {
      setError("Area must be a number greater than zero.");
      return;
    }
    // An unreadable amount and a negative one are different mistakes, and a
    // blank field told "no puede ser negativo" reads like a bug.
    if (!Number.isFinite(price)) {
      setError("Enter the base price in lempiras.");
      return;
    }
    if (price < 0) {
      setError("Base price can't be negative.");
      return;
    }
    if (needsJustification && reason.trim().length < 10) {
      setError("Please explain the price change (at least 10 characters).");
      return;
    }

    setSaving(true);

    try {
      await onSave({
        code: code.trim(),
        projectName: projectName.trim(),
        areaM2: toSquareMetres(areaValue, unit),
        basePriceCents: fromCurrencyUnits(price),
        ...(needsJustification ? { reason: reason.trim() } : {}),
      });
    } catch (caught) {
      // The server enforces the same rules independently, so this is where a
      // permission refusal — or a number held by a lot this screen cannot see,
      // an archived one — surfaces.
      setError(caught instanceof Error ? caught.message : "Unable to save the lot.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={`Edit lot ${lot.code}`}
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Edit lot</p>
            <h2>{lot.code}</h2>
            <p className="modal-description">
              Changes are recorded in the history with your name and the date.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field">
            <label htmlFor="lot-code">Lot</label>
            <input
              id="lot-code"
              value={code}
              aria-invalid={duplicate}
              onChange={(e) => setCode(e.target.value)}
            />
            {duplicate && (
              <span className="field-error">
                Lot {code.trim()} already exists in {projectName.trim()}.
              </span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="lot-area">Area</label>
            <div className="input-with-suffix">
              <input
                id="lot-area"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={area}
                onChange={(e) => setArea(e.target.value)}
              />
              <span className="unit-suffix">{unitInfo.symbol}</span>
            </div>
            <span className="field-hint">{unitInfo.label}, the unit used by {lot.projectName}.</span>
          </div>

          <div className="form-field full-width">
            <label htmlFor="lot-project">Project</label>
            <input
              id="lot-project"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="lot-price">Base price</label>
            <MoneyInput
              id="lot-price"
              value={basePrice}
              onChange={setBasePrice}
              readOnly={priceLocked}
            />
            <span className="field-hint">
              {priceLocked
                ? `This lot has active contract ${lot.holding?.contractCode}, and your account ` +
                "can't change the price of a lot with a contract. You can still edit the other fields."
                : "Always in lempiras. Changing the base price won't change what customers already owe: " +
                "each contract keeps its own sale price."}
            </span>
          </div>

          {needsJustification && (
            <div className="form-field full-width">
              <p className="form-blocked">
                This lot has active contract <strong>{lot.holding?.contractCode}</strong>. The
                price change will be recorded in the history with your name, the date, and the
                reason.
              </p>
              <label htmlFor="lot-price-reason">
                Reason for price change
                <span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <textarea
                id="lot-price-reason"
                rows={3}
                value={reason}
                placeholder="e.g. Price renegotiated with the customer on August 12."
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
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
            disabled={isSaving || duplicate}
          >
            <span>{isSaving ? "Saving…" : "Save changes"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import type { MoneyView } from "../../lib/money";
import {
  cents,
  formatMoney,
  fromCurrencyUnits,
  parseMoneyInput,
  toMoneyInput,
} from "../../lib/money";
import type { Contract, HoldingKind, SaleType } from "../../types";
import type { ContractTermsDraft } from "./api";
import { KIND_LABELS, SALE_TYPE_LABELS, formatDate } from "./contractPresentation";
import { clampDueDayInput, parseIntOrNull, suggestMonthlyPayment } from "./contractSchedule";

const MINIMUM_REASON_LENGTH = 10;

interface ContractEditDialogProps {
  contract: Contract;
  money: MoneyView;
  /**
   * Whether this user may move the sale price.
   *
   * A separate switch from being allowed to edit at all: changing a due day and
   * changing what somebody owes are different powers, and an owner may well
   * hand over the first without the second. The server enforces the same split
   * — locking the field here only spares the user a refused save.
   */
  canReprice: boolean;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (draft: ContractTermsDraft) => Promise<void>;
}

/**
 * Correcting the terms of a signed contract.
 *
 * Every edit here demands a written motive, which is not how the lot and
 * customer forms behave — and the difference is deliberate. A lot's area is a
 * FACT somebody is fixing. A contract's terms are an AGREEMENT two people
 * signed, so "who moved the plazo from 24 months to 30, and why?" is a question
 * that gets asked months later, long after whoever typed it has forgotten.
 *
 * What cannot be changed here is the customer, and the lot cannot be changed
 * through this form either. A different lot bought by the same customer is a
 * different sale — a new contract and a cancellation, not an edit. But a lot
 * mistyped at signing is a correction, and that one has its own dialog,
 * `ContractReassignLotDialog`, with its own capability and its own audit
 * action, precisely because "wrong lot" and "different lot" need to stay two
 * different questions rather than one unlocked field.
 */
export function ContractEditDialog({
  contract,
  money,
  canReprice,
  onCancel,
  onSave,
}: ContractEditDialogProps) {
  const [kind, setKind] = useState<HoldingKind>(contract.kind);
  const [saleType, setSaleType] = useState<SaleType>(contract.saleType);
  const [salePrice, setSalePrice] = useState(() => toMoneyInput(contract.terms.salePrice));
  const [downPayment, setDownPayment] = useState(() => toMoneyInput(contract.terms.downPayment));
  const [termMonths, setTermMonths] = useState(
    contract.terms.termMonths === null ? "" : String(contract.terms.termMonths),
  );
  const [monthlyPayment, setMonthlyPayment] = useState(() =>
    contract.terms.monthlyPayment === null ? "" : toMoneyInput(contract.terms.monthlyPayment),
  );
  const [dueDay, setDueDay] = useState(
    contract.terms.dueDay === null ? "" : String(contract.terms.dueDay),
  );
  const [signedOn, setSignedOn] = useState(contract.terms.signedOn);
  // The NEGOTIATED first due date, not the computed one. Binding to the
  // computed value would write it into the column and pin it there, so a later
  // correction to the signing date would stop moving the schedule with it.
  const [firstDueOn, setFirstDueOn] = useState(contract.terms.firstDueOnAgreed ?? "");
  const [expiresOn, setExpiresOn] = useState(contract.terms.expiresOn ?? "");
  const [notes, setNotes] = useState(contract.notes ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isFinanced = saleType === "financed";
  const isReservation = kind === "reservation";

  const priceCents = fromCurrencyUnits(parseMoneyInput(salePrice) || 0);
  const isRepricing = priceCents !== contract.terms.salePrice;

  /*
   * What the cuota WOULD be under the figures currently in the form.
   *
   * The create form has offered this from the start; correcting a contract
   * never did, and the gap was doing real damage. The stored cuota is a plain
   * value in state here: raise the price by L 40,000, cut the plazo in half,
   * change the prima — the field kept whatever was typed into it months ago and
   * said nothing at all. The schedule below then paid that stale cuota out
   * against the new financed amount, and the last installment silently absorbed
   * the entire difference.
   *
   * It stays a SUGGESTION, and that is deliberate rather than timid. The real
   * figure is negotiated and rounded — L 47,000 over 13 months is L 3,615.38,
   * which nobody pays — so the app must never quietly overwrite what was
   * signed. All it can do is notice the arithmetic has moved and offer the new
   * number, which is what the button below is.
   */
  const financedCents = Math.max(
    0,
    priceCents - fromCurrencyUnits(parseMoneyInput(downPayment) || 0),
  );
  const suggestedMonthly = (() => {
    const months = parseIntOrNull(termMonths);

    if (!isFinanced || months === null || !Number.isFinite(months)) {
      return null;
    }

    return suggestMonthlyPayment(financedCents, months);
  })();

  /*
   * Only worth saying when it differs from what is in the field.
   *
   * Offering "usar esa cuota" for the number already written there is noise,
   * and it would show up on every contract whose cuota happens to be the even
   * split — which is most of them, and exactly the ones where nothing is wrong.
   */
  const monthlyCents = fromCurrencyUnits(parseMoneyInput(monthlyPayment) || 0);
  const suggestionDiffers = suggestedMonthly !== null && suggestedMonthly !== monthlyCents;

  /*
   * Has anything actually been changed?
   *
   * This form opens pre-filled, so "is there text in it" is always yes and
   * would lock the dialog the instant it appeared. What matters is whether any
   * field has MOVED off what the contract says — plus the reason, which exists
   * only because somebody started writing one.
   */
  const isDirty =
    kind !== contract.kind ||
    saleType !== contract.saleType ||
    priceCents !== contract.terms.salePrice ||
    fromCurrencyUnits(parseMoneyInput(downPayment) || 0) !== contract.terms.downPayment ||
    (parseIntOrNull(termMonths) ?? null) !== contract.terms.termMonths ||
    monthlyCents !== (contract.terms.monthlyPayment ?? 0) ||
    (parseIntOrNull(dueDay) ?? null) !== contract.terms.dueDay ||
    signedOn !== contract.terms.signedOn ||
    firstDueOn !== (contract.terms.firstDueOnAgreed ?? "") ||
    expiresOn !== (contract.terms.expiresOn ?? "") ||
    notes !== (contract.notes ?? "") ||
    reason.trim() !== "";
  // Locked rather than hidden: somebody who cannot change the price still has
  // to see what it is to make sense of everything else on the form.
  const priceLocked = !canReprice;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const price = parseMoneyInput(salePrice);
    // Zero unless the sale is financed: contado is settled in full at signing
    // and a donation at zero, so neither shows a prima field, and a value left
    // in state from before the forma de pago was changed must not be sent.
    const down = isFinanced ? parseMoneyInput(downPayment) : 0;
    const months = parseIntOrNull(termMonths);
    const monthly = monthlyPayment.trim() === "" ? null : parseMoneyInput(monthlyPayment);
    const day = parseIntOrNull(dueDay);

    if (!Number.isFinite(price) || price < 0) {
      setError("Enter the sale price in lempiras.");
      return;
    }

    // The same relationships the server checks in `termsProblem`, mirrored here
    // so a mistake is caught before the round trip rather than after it.
    if (isFinanced) {
      if (!Number.isFinite(down) || down < 0) {
        setError("Enter the down payment in lempiras.");
        return;
      }
      if (down > price) {
        setError("The down payment can't exceed the sale price.");
        return;
      }
      if (months === null || !Number.isFinite(months) || months < 1) {
        setError("A financed contract requires a term in months.");
        return;
      }
      if (monthly === null || !Number.isFinite(monthly) || monthly <= 0) {
        setError("A financed contract requires a monthly installment.");
        return;
      }
      if (day === null || !Number.isFinite(day) || day < 1 || day > 31) {
        setError("Due day must be between 1 and 31.");
        return;
      }
      if (down === price) {
        setError("If the down payment covers the full price, this is a cash sale, not a financed sale.");
        return;
      }
    }
    // No matching `else` refusing a stray plazo, cuota or día de pago, which is
    // what the server checks for. Those three fields, and the primera cuota
    // below, only EXIST on this form while the sale is financed — so a contract
    // switched from crédito to contado still holds the old values in state with
    // nothing on screen to clear them by, and an error about an invisible field
    // is an error nobody can act on. They are sent as null instead.

    if (saleType === "donation" && (price > 0 || down > 0)) {
      setError("A donation is recorded with a price and down payment of zero.");
      return;
    }
    if (isReservation && expiresOn.trim() === "") {
      setError("A reservation requires an expiration date.");
      return;
    }
    if (isFinanced && firstDueOn.trim() !== "" && firstDueOn < signedOn) {
      setError("The first installment can't be due before the contract is signed.");
      return;
    }
    if (isReservation && expiresOn.trim() !== "" && expiresOn < signedOn) {
      setError("The reservation can't expire before the signing date.");
      return;
    }
    if (fromCurrencyUnits(price) < contract.paidToDate) {
      setError(
        `This contract already has ${formatMoney(contract.paidToDate, money)} in payments. ` +
          "The price can't be lower than that amount.",
      );
      return;
    }
    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Please provide a reason with at least ${MINIMUM_REASON_LENGTH} characters.`);
      return;
    }

    setSaving(true);

    try {
      await onSave({
        kind,
        saleType,
        salePriceCents: fromCurrencyUnits(price),
        downPaymentCents: isFinanced ? fromCurrencyUnits(down) : 0,
        termMonths: isFinanced ? months : null,
        monthlyPaymentCents: isFinanced && monthly !== null ? fromCurrencyUnits(monthly) : null,
        dueDay: isFinanced ? day : null,
        signedOn,
        // Blank means "let it follow from the signing date", which is a
        // different instruction from any particular date.
        firstDueOn: isFinanced && firstDueOn.trim() !== "" ? firstDueOn : null,
        expiresOn: isReservation && expiresOn.trim() !== "" ? expiresOn : null,
        notes: notes.trim() === "" ? null : notes.trim(),
        reason: reason.trim(),
      });
    } catch (caught) {
      // The server checks every one of these rules independently, so this is
      // where a permission refusal surfaces too.
      setError(caught instanceof Error ? caught.message : "Could not save the contract.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={`Edit contract ${contract.code}`}
      /* A correction is typed off a document in somebody's hand, same as the
         contract was. The X and Cancelar are the way out. */
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Edit contract</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              {contract.customer.fullName} · Lot {contract.lot.code} ·{" "}
              {contract.lot.projectName}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {/* Said before anything is typed. The lot and the customer are the
              two things this form cannot move, and somebody who opened it to
              fix the wrong lot should find that out now rather than after
              filling in nine fields. */}
          <p className="form-blocked full-width">
            You can't change the customer here: a different customer means a different sale, not
            a correction. The lot can't be changed in this form either—if it was entered
            incorrectly, use “Correct lot” on the contract. All other changes are recorded in
            the history with your name, the date, and the reason you enter below.
          </p>

          <div className="form-field">
            <label htmlFor="contract-kind">Type</label>
            <select
              id="contract-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as HoldingKind)}
            >
              {(Object.keys(KIND_LABELS) as HoldingKind[]).map((value) => (
                <option key={value} value={value}>
                  {KIND_LABELS[value]}
                </option>
              ))}
            </select>
            <span className="field-hint">A reservation holds a lot; a contract is the sale.</span>
          </div>

          <div className="form-field">
            <label htmlFor="contract-sale-type">Payment type</label>
            <select
              id="contract-sale-type"
              value={saleType}
              onChange={(event) => setSaleType(event.target.value as SaleType)}
            >
              {(Object.keys(SALE_TYPE_LABELS) as SaleType[]).map((value) => (
                <option key={value} value={value}>
                  {SALE_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Financed sales have a down payment, term, installments, and due day. Cash sales are
              paid in full when signed.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="contract-price">Sale price</label>
            <MoneyInput
              id="contract-price"
              value={salePrice}
              onChange={setSalePrice}
              readOnly={priceLocked}
            />
            <span className="field-hint">
              {priceLocked
                ? "Your account can't change a contract's price. Ask an owner."
                : "This is the price for THIS sale, separate from the lot's list price."}
            </span>
          </div>

          {/* Only on a credit sale, for the reason the Nuevo contrato form
              gives: a prima is the part of the price that is not financed, and
              a venta de contado finances nothing. Switching a contract to
              contado therefore clears the agreed prima the same way it clears
              the plazo — the money already received as prima keeps its own
              record in the payments. */}
          {isFinanced && (
            <div className="form-field">
              <label htmlFor="contract-down">Agreed down payment</label>
              <MoneyInput id="contract-down" value={downPayment} onChange={setDownPayment} />
              <span className="field-hint">
                Lo acordado, no lo cobrado. Van {formatMoney(contract.downPaymentPaid, money)}{" "}
                recibidos.
              </span>
            </div>
          )}

          {isFinanced && (
            <>
              <div className="form-field">
                <label htmlFor="contract-term">Term in months</label>
                <input
                  id="contract-term"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="600"
                  value={termMonths}
                  onChange={(event) => setTermMonths(event.target.value)}
                />
              </div>

              <div className="form-field">
                <label htmlFor="contract-monthly">Monthly installment</label>
                <MoneyInput
                  id="contract-monthly"
                  value={monthlyPayment}
                  onChange={setMonthlyPayment}
                />
                <span className="field-hint">
                  {suggestedMonthly !== null && suggestionDiffers ? (
                    <>
                      Con el precio, la prima y el plazo de arriba, repartido en partes iguales
                      would be {formatMoney(cents(suggestedMonthly), money)}.{" "}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => setMonthlyPayment(toMoneyInput(cents(suggestedMonthly)))}
                      >
                        Usar esa cuota
                      </button>
                      {" · "}Or keep the agreed amount; the last payment covers the difference.
                    </>
                  ) : (
                    "The agreed installment. The last payment accounts for rounding."
                  )}
                </span>
              </div>

              <div className="form-field">
                <label htmlFor="contract-due-day">Due day</label>
                <input
                  id="contract-due-day"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="31"
                  value={dueDay}
                  onChange={(event) => setDueDay(clampDueDayInput(event.target.value))}
                />
                <span className="field-hint">
                  Los meses cortos se ajustan solos: el 31 vence el 28 en febrero.
                </span>
              </div>
            </>
          )}

          <div className="form-field">
            <label htmlFor="contract-signed">Signing date</label>
            <input
              id="contract-signed"
              type="date"
              value={signedOn}
              onChange={(event) => setSignedOn(event.target.value)}
            />
            <span className="field-hint">The payment schedule starts from this date.</span>
          </div>

          {isFinanced && (
            <div className="form-field">
              <label htmlFor="contract-first-due">First installment</label>
              <input
                id="contract-first-due"
                type="date"
                value={firstDueOn}
                onChange={(event) => setFirstDueOn(event.target.value)}
              />
              <span className="field-hint">
                {firstDueOn.trim() === "" && contract.terms.firstDueOn
                  ? `Optional. If left blank, it's due ${formatDate(contract.terms.firstDueOn)}, one month after signing.`
                  : "Only if negotiated separately. Leave blank to set it one month after signing."}
              </span>
            </div>
          )}

          {isReservation && (
            <div className="form-field">
              <label htmlFor="contract-expires">
                Reservation expires<span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <input
                id="contract-expires"
                type="date"
                value={expiresOn}
                onChange={(event) => setExpiresOn(event.target.value)}
              />
              <span className="field-hint">
                A reservation without an expiration date keeps the lot off the market indefinitely.
              </span>
            </div>
          )}

          <div className="form-field full-width">
            <label htmlFor="contract-notes">Notes</label>
            <textarea
              id="contract-notes"
              rows={2}
              value={notes}
              placeholder="e.g. Pays by bank transfer in the first few days of the month."
              onChange={(event) => setNotes(event.target.value)}
            />
            <span className="field-hint">
              Se ve en la lista de contratos, debajo del nombre del cliente.
            </span>
          </div>

          {/* Only once the price has actually moved, and only when there is
              money behind it. A warning that is always on screen is a warning
              nobody reads. */}
          {isRepricing && contract.paidToDate > 0 && (
            <p className="form-warning full-width">
              Este contrato ya tiene {formatMoney(contract.paidToDate, money)} pagados. Cambiar el
              precio cambia el saldo de {contract.customer.fullName} de inmediato, y no mueve ni
              devuelve un solo pago.
            </p>
          )}

          <div className="form-field full-width">
            <label htmlFor="contract-reason">
              Reason for change<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="contract-reason"
              rows={3}
              value={reason}
              placeholder="e.g. Signed contract says the 15th; the 5th was entered by mistake."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Required for all changes: this is what was signed, not a detail to change without
              explanation.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>{isSaving ? "Saving…" : "Save changes"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

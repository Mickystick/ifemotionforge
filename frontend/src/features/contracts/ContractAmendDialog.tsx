import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, fromCurrencyUnits, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Contract } from "../../types";
import type { AmendmentDraft } from "./api";
import type { SplitMode } from "./amendmentMath";
import { nextAmendedCode, planAmendment } from "./amendmentMath";
import { SALE_TYPE_LABELS, formatDate } from "./contractPresentation";
import { clampDueDayInput, firstDueDate, parseIntOrNull, summarizeSchedule } from "./contractSchedule";

const MINIMUM_REASON_LENGTH = 10;

const SPLIT_OPTIONS: Array<{ value: SplitMode; title: string; detail: string }> = [
  { value: "equal", title: "Equal shares", detail: "The same price for each lot." },
  { value: "area", title: "By area", detail: "In proportion to each lot's area." },
  { value: "manual", title: "Manual", detail: "Enter a price for each lot." },
];

interface ContractAmendDialogProps {
  /** The running contracts the adenda can cover — one purchase, all vigentes. */
  contracts: Contract[];
  /** Every contract number on file, to foresee the ones the new contracts get. */
  existingCodes: string[];
  money: MoneyView;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onSave: (draft: AmendmentDraft) => Promise<void>;
}

/** A money field's value in centavos, zero when blank or unreadable. */
function centsOf(text: string): number {
  const value = parseMoneyInput(text);
  return Number.isFinite(value) && value > 0 ? fromCurrencyUnits(value) : 0;
}

/** "320", "338.58" — an area as it is read aloud, not as it is stored. */
function formatArea(areaM2: number): string {
  return areaM2.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * An adenda: new terms for contracts that are already running.
 *
 * The screen that answers "the customer and the owner agreed something new" —
 * a new total for the whole purchase, a new plazo — without pretending the old
 * agreement never happened. Nothing here edits a contract. Saving closes the
 * chosen contracts as «Reemplazado», with every payment and every receipt left
 * exactly as it was, and opens new contracts on the same lots with the terms
 * below. The money paid under the old terms stays with the old contracts as
 * income, which is the deal being recorded: kept, not refunded, and not
 * credited to the new price.
 *
 * The agreement is typed the way it was made — one total, one plazo, one day
 * of the month — and the dialog does the division between the lots, in the
 * open, before anything is saved. That is the half of this screen that replaces
 * a calculator and a sheet of paper.
 */
export function ContractAmendDialog({
  contracts,
  existingCodes,
  money,
  onCancel,
  onSave,
}: ContractAmendDialogProps) {
  const customerName = contracts[0]?.customer.fullName ?? "";
  // The día de pago carries over when the lots already share one, which they
  // do whenever they were bought together.
  const sharedDueDay =
    new Set(contracts.map((contract) => contract.terms.dueDay)).size === 1
      ? (contracts[0]?.terms.dueDay ?? null)
      : null;
  const [initialToday] = useState(() => businessToday());

  const [included, setIncluded] = useState<ReadonlySet<string>>(
    () => new Set(contracts.map((contract) => contract.id)),
  );
  const [effectiveOn, setEffectiveOn] = useState(initialToday);
  const [authorizedBy, setAuthorizedBy] = useState("");
  const [total, setTotal] = useState("");
  const [mode, setMode] = useState<SplitMode>("equal");
  const [manualPrices, setManualPrices] = useState<Record<string, string>>({});
  const [saleType, setSaleType] = useState<"financed" | "cash">("financed");
  const [downPayment, setDownPayment] = useState("");
  const [termMonths, setTermMonths] = useState("");
  const [dueDay, setDueDay] = useState(sharedDueDay === null ? "" : String(sharedDueDay));
  const [firstDueOn, setFirstDueOn] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const chosen = contracts.filter((contract) => included.has(contract.id));
  const isFinanced = saleType === "financed";
  const months = parseIntOrNull(termMonths);
  const day = parseIntOrNull(dueDay);
  const validMonths = months !== null && Number.isFinite(months) && months >= 1 ? months : null;
  const validDay = day !== null && Number.isFinite(day) && day >= 1 && day <= 31 ? day : null;

  const plan = planAmendment({
    mode,
    totalCents: centsOf(total),
    downPaymentTotalCents: isFinanced ? centsOf(downPayment) : 0,
    lots: chosen.map((contract) => ({
      areaM2: contract.lot.areaM2,
      manualPriceCents:
        manualPrices[contract.id] === undefined || manualPrices[contract.id]!.trim() === ""
          ? Number.NaN
          : centsOf(manualPrices[contract.id]!),
    })),
    financed: isFinanced,
    termMonths: validMonths,
  });
  const lineFor = (contractId: string) => {
    const index = chosen.findIndex((contract) => contract.id === contractId);
    return index === -1 ? null : (plan.lines[index] ?? null);
  };

  // The first cuota as the server will derive it when none is typed: a month
  // after the agreement, on the día de pago.
  const derivedFirstDue =
    validDay !== null && effectiveOn !== "" ? firstDueDate(effectiveOn, validDay, null) : null;
  const firstDue = firstDueOn.trim() !== "" ? firstDueOn : derivedFirstDue;

  const paidBefore = chosen.reduce((sum, contract) => sum + contract.paidToDate, 0);
  const oldTotal = chosen.reduce((sum, contract) => sum + contract.terms.salePrice, 0);
  const downTotal = plan.lines.reduce((sum, line) => sum + line.downPaymentCents, 0);
  const financedTotal = plan.lines.reduce((sum, line) => sum + line.financedCents, 0);
  const monthlyTotal = plan.lines.reduce((sum, line) => sum + (line.monthlyPaymentCents ?? 0), 0);
  const latestSigning = chosen.reduce(
    (latest, contract) => (contract.terms.signedOn > latest ? contract.terms.signedOn : latest),
    "",
  );
  const newCodes = chosen.map((contract) => nextAmendedCode(contract.code, existingCodes));

  const isDirty =
    effectiveOn !== initialToday ||
    authorizedBy.trim() !== "" ||
    total.trim() !== "" ||
    mode !== "equal" ||
    saleType !== "financed" ||
    downPayment.trim() !== "" ||
    termMonths.trim() !== "" ||
    dueDay !== (sharedDueDay === null ? "" : String(sharedDueDay)) ||
    firstDueOn !== "" ||
    reason.trim() !== "" ||
    included.size !== contracts.length;

  /*
   * Moving to "a mano" starts from the prices already on screen rather than
   * from blanks, so adjusting one lot by a few lempiras is one edit instead of
   * three. Leaving it keeps the total that was built by hand.
   */
  const chooseMode = (next: SplitMode) => {
    if (next === mode) {
      return;
    }

    if (next === "manual") {
      setManualPrices(
        Object.fromEntries(
          chosen.map((contract) => {
            const price = lineFor(contract.id)?.salePriceCents ?? 0;
            return [contract.id, price > 0 ? toMoneyInput(cents(price)) : ""];
          }),
        ),
      );
    } else if (mode === "manual" && plan.totalCents > 0) {
      setTotal(toMoneyInput(cents(plan.totalCents)));
    }

    setMode(next);
  };

  const toggleIncluded = (contractId: string) => {
    setIncluded((current) => {
      const next = new Set(current);
      if (!next.delete(contractId)) {
        next.add(contractId);
      }
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (chosen.length === 0) {
      setError("Choose at least one lot for the amendment.");
      return;
    }
    if (effectiveOn === "") {
      setError("Enter the date the agreement was made.");
      return;
    }
    if (effectiveOn > businessToday()) {
      setError("The amendment date can't be in the future; it must be the date the agreement was made.");
      return;
    }
    if (effectiveOn < latestSigning) {
      setError(`The amendment can't predate the signing date (${formatDate(latestSigning)}).`);
      return;
    }
    if (mode !== "manual" && centsOf(total) === 0) {
      setError("Enter the new agreement's total price.");
      return;
    }
    if (plan.lines.some((line) => line.salePriceCents <= 0)) {
      setError("Each lot needs a price greater than zero.");
      return;
    }
    if (isFinanced) {
      if (validMonths === null) {
        setError("A financed agreement requires a term in months.");
        return;
      }
      if (validDay === null) {
        setError("Due day must be between 1 and 31.");
        return;
      }
      if (plan.lines.some((line) => line.downPaymentCents >= line.salePriceCents)) {
        setError("The down payment can't cover the full price; that would be a cash sale.");
        return;
      }
      if (firstDueOn.trim() !== "" && firstDueOn < effectiveOn) {
        setError("The first installment can't be due before the agreement date.");
        return;
      }
    }
    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Please provide a reason with at least ${MINIMUM_REASON_LENGTH} characters.`);
      return;
    }

    setSaving(true);

    try {
      await onSave({
        effectiveOn,
        saleType,
        termMonths: isFinanced ? validMonths : null,
        dueDay: isFinanced ? validDay : null,
        // Blank means "a month after the agreement", which the server works
        // out itself — a different instruction from any particular date.
        firstDueOn: isFinanced && firstDueOn.trim() !== "" ? firstDueOn : null,
        lines: chosen.map((contract, index) => ({
          contractId: contract.id,
          salePriceCents: plan.lines[index]!.salePriceCents,
          downPaymentCents: plan.lines[index]!.downPaymentCents,
          monthlyPaymentCents: plan.lines[index]!.monthlyPaymentCents,
        })),
        authorizedBy: authorizedBy.trim() === "" ? null : authorizedBy.trim(),
        reason: reason.trim(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to record the amendment.");
    } finally {
      setSaving(false);
    }
  };

  const oldCodes = chosen.map((contract) => contract.code).join(", ");

  return (
    <Dialog
      ariaLabel={`Amendment for ${customerName}`}
      size="wide"
      // Twenty figures agreed with a customer. The X and Cancelar are the way
      // out; a stray click on the backdrop is not.
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Amendment · new agreement</p>
            <h2>{customerName}</h2>
            <p className="modal-description">
              {contracts.length === 1
                ? `Lot ${contracts[0]!.lot.code} · ${contracts[0]!.code}`
                : `${contracts.length} lots in one purchase`}{" "}
              · current total {formatMoney(cents(oldTotal), money)}, paid{" "}
              {formatMoney(cents(paidBefore), money)}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {/* Said before anything is typed: what this does to the contracts
              that exist, and what becomes of the money already paid. */}
          <p className="form-blocked full-width">
            An amendment doesn't edit the contracts: it closes them as “Replaced,” keeping their
            payments and receipts as they are, and opens new contracts for the same lots with the
            terms below. The amount already paid ({formatMoney(cents(paidBefore), money)}) stays
            as income; it isn't refunded or applied to the new price.
          </p>

          <div className="form-field">
            <label htmlFor="amend-date">
              Agreement date<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <input
              id="amend-date"
              type="date"
              value={effectiveOn}
              max={initialToday}
              onChange={(event) => setEffectiveOn(event.target.value)}
            />
            <span className="field-hint">
              The date the agreement was made. New contracts will use this signing date, and
              payments on the previous contract must be dated on or before it.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="amend-authorized">Authorized by</label>
            <input
              id="amend-authorized"
              type="text"
              maxLength={120}
              value={authorizedBy}
              placeholder="e.g. Mr. Julio (owner)"
              onChange={(event) => setAuthorizedBy(event.target.value)}
            />
            <span className="field-hint">Who approved the new agreement. Optional.</span>
          </div>

          <div className="form-field">
            <label htmlFor="amend-total">
              New total price<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <MoneyInput
              id="amend-total"
              value={mode === "manual" ? toMoneyInput(cents(plan.totalCents)) : total}
              onChange={setTotal}
              placeholder="e.g. 800,000"
              readOnly={mode === "manual"}
            />
            <span className="field-hint">
              {mode === "manual"
                ? "The sum of the prices you enter for each lot."
                : chosen.length === 1
                  ? "The new price for this lot."
                  : `The combined price for all ${chosen.length} lots.`}
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="amend-sale-type">Payment type</label>
            <select
              id="amend-sale-type"
              value={saleType}
              onChange={(event) => setSaleType(event.target.value as "financed" | "cash")}
            >
              <option value="financed">{SALE_TYPE_LABELS.financed}</option>
              <option value="cash">{SALE_TYPE_LABELS.cash}</option>
            </select>
            <span className="field-hint">
              {isFinanced
                ? "Down payment and installments on the dates below."
                : "Pay the full new price at once, with no installments."}
            </span>
          </div>

          {chosen.length > 1 && (
            <fieldset className="form-field full-width settlement-choice">
              <legend>Split the price between lots</legend>
              <div className="amend-split-choice">
                {SPLIT_OPTIONS.map((option) => (
                  <label key={option.value} className="settlement-option">
                    <input
                      type="radio"
                      name="amend-split"
                      value={option.value}
                      checked={mode === option.value}
                      onChange={() => chooseMode(option.value)}
                    />
                    <span>
                      <span className="settlement-title">{option.title}</span>
                      <span className="settlement-detail">{option.detail}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {isFinanced && (
            <>
              <div className="form-field">
                <label htmlFor="amend-down">Down payment for the new agreement</label>
                <MoneyInput
                  id="amend-down"
                  value={downPayment}
                  onChange={setDownPayment}
                  placeholder="e.g. 150,000"
                />
                <span className="field-hint">
                  The amount paid when the agreement is signed. If the customer has already paid
                  toward this agreement, enter it here; installments are calculated on the
                  remainder. Those payments are recorded later as regular receipts on the new contracts.
                </span>
              </div>

              <div className="form-field">
                <label htmlFor="amend-term">
                  Term in months<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <input
                  id="amend-term"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="600"
                  value={termMonths}
                  placeholder="e.g. 3"
                  onChange={(event) => setTermMonths(event.target.value)}
                />
              </div>

              <div className="form-field">
                <label htmlFor="amend-due-day">
                  Due day<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <input
                  id="amend-due-day"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="31"
                  value={dueDay}
                  onChange={(event) => setDueDay(clampDueDayInput(event.target.value))}
                />
              </div>

              <div className="form-field">
                <label htmlFor="amend-first-due">First installment</label>
                <input
                  id="amend-first-due"
                  type="date"
                  value={firstDueOn}
                  min={effectiveOn || undefined}
                  onChange={(event) => setFirstDueOn(event.target.value)}
                />
                <span className="field-hint">
                  {firstDueOn.trim() === "" && derivedFirstDue
                    ? `Optional. If left blank, it's due ${formatDate(derivedFirstDue)}, one month after the agreement.`
                    : "Only if negotiated separately."}
                </span>
              </div>
            </>
          )}

          <div className="form-field full-width">
            <span className="amend-table-title">New terms for each lot</span>
            <div className="amend-table-scroll">
              <table className="amend-table">
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>Current</th>
                    <th className="col-money">New price</th>
                    {isFinanced && <th className="col-money">Down payment</th>}
                    <th>{isFinanced ? "Installments" : "New contract"}</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((contract) => {
                    const line = lineFor(contract.id);
                    const index = chosen.findIndex((candidate) => candidate.id === contract.id);
                    const schedule =
                      line && isFinanced && validMonths !== null && validDay !== null && firstDue
                        ? summarizeSchedule(
                            line.financedCents,
                            validMonths,
                            line.monthlyPaymentCents ?? 0,
                            firstDue,
                            validDay,
                          )
                        : null;

                    return (
                      <tr key={contract.id} className={line ? undefined : "is-excluded"}>
                        <td data-label="Lot">
                          {contracts.length > 1 ? (
                            <label className="amend-include">
                              <input
                                type="checkbox"
                                checked={included.has(contract.id)}
                                onChange={() => toggleIncluded(contract.id)}
                                aria-label={`Include lot ${contract.lot.code}`}
                              />
                              <span className="code-badge">{contract.lot.code}</span>
                            </label>
                          ) : (
                            <span className="code-badge">{contract.lot.code}</span>
                          )}
                          <span className="cell-sub">{formatArea(contract.lot.areaM2)} m²</span>
                        </td>
                        <td data-label="Current">
                          <span className="cell-money">
                            {formatMoney(contract.terms.salePrice, money)}
                          </span>
                          <span className="cell-sub">
                          {contract.code} · paid {formatMoney(contract.paidToDate, money)}
                          </span>
                        </td>
                        <td data-label="New price" className="col-money">
                          {!line ? (
                            <span className="cell-sub">Unchanged</span>
                          ) : mode === "manual" ? (
                            <MoneyInput
                              id={`amend-price-${contract.id}`}
                              value={manualPrices[contract.id] ?? ""}
                              onChange={(value) =>
                                setManualPrices((current) => ({ ...current, [contract.id]: value }))
                              }
                              placeholder="Price"
                            />
                          ) : (
                            <span className="cell-money">
                              {formatMoney(cents(line.salePriceCents), money)}
                            </span>
                          )}
                          {line && <span className="cell-sub">{newCodes[index]}</span>}
                        </td>
                        {isFinanced && (
                          <td data-label="Down payment" className="col-money">
                            {line && (
                              <span className="cell-money">
                                {formatMoney(cents(line.downPaymentCents), money)}
                              </span>
                            )}
                          </td>
                        )}
                        <td data-label={isFinanced ? "Installments" : "New contract"}>
                          {!line ? null : !isFinanced ? (
                            <span className="cell-sub">{newCodes[index]} · cash</span>
                          ) : schedule && line.monthlyPaymentCents !== null ? (
                            <>
                              <span className="cell-money">
                                {schedule.count} ×{" "}
                                {formatMoney(cents(line.monthlyPaymentCents), money)}
                              </span>
                              <span className="cell-sub">
                                {schedule.lastAmountCents !== line.monthlyPaymentCents
                                  ? `last payment ${formatMoney(cents(schedule.lastAmountCents), money)}, `
                                  : ""}
                                through {formatDate(schedule.lastDueOn)}
                              </span>
                            </>
                          ) : (
                            <span className="cell-sub">Term not set</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {chosen.length > 0 && plan.totalCents > 0 && (
              <p className="field-hint amend-total-line">
                New total {formatMoney(cents(plan.totalCents), money)}
                {isFinanced && downTotal > 0 && ` · down payment ${formatMoney(cents(downTotal), money)}`}
                {isFinanced &&
                  validMonths !== null &&
                  ` · ${formatMoney(cents(financedTotal), money)} over ${validMonths} ${
                    validMonths === 1 ? "installment" : "installments"
                  } at about ${formatMoney(cents(monthlyTotal), money)} per month`}
                . {oldCodes} will close and {newCodes.join(", ")} will open.
              </p>
            )}
          </div>

          <div className="form-field full-width">
            <label htmlFor="amend-reason">
              Reason<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="amend-reason"
              rows={3}
              value={reason}
              placeholder="e.g. Will pay for all 3 lots by year-end; agreed total price is L 800,000."
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Saved on the new and replaced contracts, and in the history.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>{isSaving ? "Saving…" : "Record amendment"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}

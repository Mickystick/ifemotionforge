import { useMemo, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, formatMoneyInput, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Contract, Receipt } from "../../types";
import { redistributeReceipt } from "./api";

interface ReceiptRedistributeDialogProps {
  receipt: Receipt;
  /** Every contract the app knows about; filtered to this customer's below. */
  contracts: Contract[];
  money: MoneyView;
  onClose: () => void;
  onRedistributed: () => void;
}

const MINIMUM_REASON = 10;

/** One lot that can hold part of this receipt, whether or not it does today. */
interface Target {
  contractId: string;
  contractCode: string;
  lotCode: string;
  projectName: string;
  /** What this lot holds of THIS receipt right now. Zero for a lot being added. */
  currentCents: number;
  /** Already on the receipt, as opposed to offered as somewhere to move money. */
  isOnReceipt: boolean;
}

/**
 * Repartir un recibo entre lotes.
 *
 * The screen for the situation the owner described: a customer pays one prima
 * covering two lots, only one of the lots is in the system that day, so the
 * whole amount is filed against it. The second lot is created weeks later and
 * joined to the same purchase — and the money is still sitting where it was
 * put, because "Repartir" used to exist only while writing a receipt.
 *
 * ---
 *
 * The rule the whole form is built around: THE TOTAL DOES NOT CHANGE. What is
 * being corrected is which lots the money landed on, never how much of it there
 * was — the customer is holding a printed total and it has to keep being true.
 * So the submit button stays refused until the lines add up to the receipt
 * exactly, and the running total says how far off it is rather than letting
 * somebody discover it after pressing.
 *
 * The server enforces the same rule; this is the half that explains it.
 */
export function ReceiptRedistributeDialog({
  receipt,
  contracts,
  money,
  onClose,
  onRedistributed,
}: ReceiptRedistributeDialogProps) {
  /*
   * Every lot the money could sit on: the ones already on this receipt, plus
   * the customer's other open contracts.
   *
   * The receipt's own lines come first and are listed whatever their contract's
   * status is — money that IS somewhere has to be shown there, even if that
   * contract has since been closed, or the form would quietly propose losing
   * it.
   */
  const targets = useMemo<Target[]>(() => {
    const onReceipt: Target[] = receipt.lines.map((line) => ({
      contractId: line.contractId,
      contractCode: line.contractCode ?? "",
      lotCode: line.lotCode ?? "",
      projectName: line.projectName ?? "",
      currentCents: line.amount,
      isOnReceipt: true,
    }));

    const already = new Set(onReceipt.map((target) => target.contractId));

    const others: Target[] = contracts
      .filter(
        (contract) =>
          contract.customer.id === receipt.customer.id &&
          contract.status === "active" &&
          !already.has(contract.id),
      )
      .map((contract) => ({
        contractId: contract.id,
        contractCode: contract.code,
        lotCode: contract.lot.code,
        projectName: contract.lot.projectName,
        currentCents: 0,
        isOnReceipt: false,
      }))
      .sort((a, b) => a.lotCode.localeCompare(b.lotCode));

    return [...onReceipt, ...others];
  }, [receipt, contracts]);

  /** Keyed by contract id, as typed. Formatted money strings, not numbers. */
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      targets.map((target) => [
        target.contractId,
        target.currentCents > 0 ? toMoneyInput(cents(target.currentCents)) : "",
      ]),
    ),
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const parsed = useMemo(
    () =>
      targets.map((target) => ({
        target,
        amountCents: parseMoneyInput(amounts[target.contractId] ?? ""),
      })),
    [targets, amounts],
  );

  const assignedCents = parsed.reduce((total, line) => total + line.amountCents, 0);
  const receiptCents = receipt.totalPaid as number;
  const differenceCents = assignedCents - receiptCents;
  const balances = differenceCents === 0;

  const trimmedReason = reason.trim();
  const hasChanged = parsed.some((line) => line.amountCents !== line.target.currentCents);
  const canSubmit =
    balances && hasChanged && trimmedReason.length >= MINIMUM_REASON && !isSaving;

  const setAmount = (contractId: string, raw: string) => {
    setAmounts((current) => ({ ...current, [contractId]: formatMoneyInput(raw) }));
  };

  /*
   * Divide what is on the receipt evenly across the lots that currently hold
   * some of it, or across every lot once somebody has typed into a new one.
   *
   * A convenience, never a decision — every line stays editable afterwards,
   * the same way the split proposal works when a receipt is first written.
   */
  const splitEvenly = () => {
    const chosen = parsed.filter(
      (line) => line.target.isOnReceipt || line.amountCents > 0,
    );

    if (chosen.length === 0) {
      return;
    }

    // Equal to the centavo, the same rule as a new receipt. Centavos that do
    // not divide go one each to the first lots, so the parts sum to the total.
    const share = Math.floor(receiptCents / chosen.length);
    const oddCentavos = receiptCents - share * chosen.length;
    const next: Record<string, string> = {};

    for (const target of targets) {
      next[target.contractId] = "";
    }

    chosen.forEach((line, index) => {
      const amount = share + (index < oddCentavos ? 1 : 0);
      next[line.target.contractId] = toMoneyInput(cents(amount));
    });

    setAmounts(next);
  };

  const submit = async () => {
    setError(null);
    setSaving(true);

    try {
      await redistributeReceipt(
        receipt.id,
        parsed
          .filter((line) => line.amountCents > 0)
          .map((line) => ({ contractId: line.target.contractId, amountCents: line.amountCents })),
        trimmedReason,
      );
      onRedistributed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not redistribute the receipt.");
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={`Redistribute receipt ${receipt.code} across lots`}
      size="wide"
      /* Rewriting where posted money sits, with a written reason attached. A
         click beside the panel must not throw that away — see `dismissible` in
         Dialog.tsx. */
      dismissible={!hasChanged && trimmedReason === "" && !isSaving}
      onClose={onClose}
    >
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Redistribute between lots</p>
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
          This moves the money from this receipt between the customer's lots. The total does not
          change and no new receipt is issued: the customer keeps the same receipt for{" "}
          {formatMoney(receipt.totalPaid, money)}; only the amount assigned to each lot changes.
          Contract balances are recalculated.
        </p>

        <div className="redistribute-lines full-width">
          {targets.map((target) => {
            const value = amounts[target.contractId] ?? "";

            return (
              <div className="redistribute-line" key={target.contractId}>
                <div className="redistribute-lot">
                  <span className="redistribute-lot-code">{target.lotCode}</span>
                  <span className="redistribute-lot-meta">
                    {target.projectName}
                    {target.contractCode !== "" && ` · ${target.contractCode}`}
                  </span>
                  {!target.isOnReceipt && (
                    <span className="redistribute-lot-new">Not on this receipt</span>
                  )}
                </div>

                <div className="redistribute-amount">
                  {/* Labelled by the lot it belongs to rather than by a visible
                      <label>: the lot code is already on the row, and a second
                      copy of it would be read out twice. */}
                  <input
                    id={`share-${target.contractId}`}
                    inputMode="decimal"
                    value={value}
                    placeholder="0.00"
                    aria-label={`Amount for lot ${target.lotCode}`}
                    onChange={(event) => setAmount(target.contractId, event.target.value)}
                  />
                  {target.isOnReceipt && (
                    <span className="redistribute-current">
                      Current: {formatMoney(cents(target.currentCents), money)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className={`redistribute-total full-width${balances ? " is-balanced" : ""}`}>
          <span>
            Assigned {formatMoney(cents(assignedCents), money)} of{" "}
            {formatMoney(receipt.totalPaid, money)}
          </span>
          {/* The gap, named and signed. "No cuadra" on its own sends somebody
              back to add up four inputs by hand. */}
          {!balances && (
            <strong className="redistribute-gap">
              {differenceCents > 0 ? "Over by " : "Short by "}
              {formatMoney(cents(Math.abs(differenceCents)), money)}
            </strong>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={splitEvenly}
            disabled={isSaving}
          >
            Split evenly
          </button>
        </div>

        <div className="form-field full-width">
          <label htmlFor="redistribute-reason">
            Reason <span className="required-mark">*</span>
          </label>
          <textarea
            id="redistribute-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. The down payment covered two lots; the second was recorded later."
          />
          <span className="field-hint">
            Kept in the history of each transaction moved. This explains later why the receipt is
            allocated differently from when it was issued.
          </span>
          {trimmedReason.length > 0 && trimmedReason.length < MINIMUM_REASON && (
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
          className="btn-primary modal-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {isSaving ? "Redistributing…" : "Redistribute"}
        </button>
      </div>
    </Dialog>
  );
}

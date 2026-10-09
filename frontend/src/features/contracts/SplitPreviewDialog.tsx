import { useEffect, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput } from "../../lib/money";
import type { Contract } from "../../types";
import type { SplitLine } from "./api";
import { fetchSplit } from "./api";

interface SplitPreviewDialogProps {
  /** The contracts of one purchase. All share a sale group. */
  contracts: Contract[];
  money: MoneyView;
  onClose: () => void;
}

/**
 * What one receipt would do to each lot of a purchase — before anything is
 * posted.
 *
 * The customer hands over a single amount for three lots and expects a single
 * receipt, but the money has to land on three contracts. The division is worked
 * out by the SERVER, so this screen and the payment that eventually gets
 * recorded cannot disagree about the arithmetic: equal shares to the centavo,
 * except that a lot never gets more than it owes nor less than its own next
 * installment (see src/lib/allocation.ts).
 *
 * Nothing here writes anything. Recording the payment arrives with the
 * transactions screen; this is the preview that makes the rule visible first.
 */
export function SplitPreviewDialog({ contracts, money, onClose }: SplitPreviewDialogProps) {
  const saleGroupId = contracts[0]?.saleGroupId ?? null;
  const customerName = contracts[0]?.customer.fullName ?? "";

  const [amountText, setAmountText] = useState("");
  const [lines, setLines] = useState<SplitLine[]>([]);
  const [unallocated, setUnallocated] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);

  const amount = parseMoneyInput(amountText);
  const amountCents = Number.isNaN(amount) ? 0 : Math.round(amount * 100);

  useEffect(() => {
    if (saleGroupId === null || amountCents <= 0) {
      setLines([]);
      setUnallocated(0);
      setError(null);
      return;
    }

    // A typed amount changes on every keystroke, so a stale answer can arrive
    // after a newer one. `cancelled` makes the outdated response drop itself
    // instead of overwriting the current split.
    let cancelled = false;
    setLoading(true);

    fetchSplit(saleGroupId, amountCents)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setLines(result.lines);
        setUnallocated(result.unallocatedCents);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setError(caught instanceof Error ? caught.message : "Unable to calculate the split.");
        setLines([]);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [saleGroupId, amountCents]);

  const totalBalance = contracts.reduce((sum, contract) => sum + contract.balance, 0);

  return (
    <Dialog ariaLabel={`Split a payment for ${customerName}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Split payment</p>
          <h2>{customerName}</h2>
          <p className="modal-description">
            {contracts.length} lots in one purchase · total balance{" "}
            {formatMoney(cents(totalBalance), money)}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <div className="form-field full-width">
          <label htmlFor="split-amount">Receipt amount</label>
          <MoneyInput
            id="split-amount"
            value={amountText}
            onChange={setAmountText}
            placeholder="e.g. 25,000"
          />
          <span className="field-hint">
            Equal shares, down to the cent. A lot's share changes only if it would leave that
            customer paying less than their next installment or more than they owe; the rest is
            split equally among the others.
          </span>
        </div>

        {error && <p className="form-error full-width">{error}</p>}
      </div>

      {lines.length > 0 && (
        <div className="split-preview">
          <table className="split-table">
            <thead>
              <tr>
                <th>Lot</th>
                <th className="col-money">Share</th>
                <th className="col-money">Balance after</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.contractId}>
                  <td>
                    <span className="code-badge">{line.lotCode}</span>
                    <span className="cell-sub">{line.contractCode}</span>
                  </td>
                  <td className="col-money">
                    <span className="cell-money">
                      {formatMoney(cents(line.amountCents), money)}
                    </span>
                  </td>
                  <td className="col-money">
                    <span className="cell-money is-balance">
                      {formatMoney(cents(line.balanceAfter), money)}
                    </span>
                    <span className="cell-sub">
                      before {formatMoney(cents(line.balanceBefore), money)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {unallocated > 0 && (
            // Handed back rather than absorbed: pushing the extra onto a lot
            // that is already paid off is how a customer ends up with a credit
            // nobody can explain.
            <p className="form-blocked">
              {formatMoney(cents(unallocated), money)} remains: the purchase no longer owes that
              much. Decide where that money goes before recording the payment.
            </p>
          )}

          {(() => {
            const short = lines.filter((line) => line.belowMinimum);

            if (short.length === 0) {
              return null;
            }

            // The total simply is not enough to cover every lot's current
            // cuota, even after the server favored the smallest ones first.
            const codes = short.map((line) => line.lotCode).join(", ");

            return (
              <p className="form-blocked">
                The amount isn't enough to cover the full installment for {codes}.{" "}
                {short.length > 1 ? "Those lots will be overdue" : "That lot will be overdue"}{" "}
                if recorded this way.
              </p>
            );
          })()}
        </div>
      )}

      {isLoading && lines.length === 0 && <p className="state-message">Calculating…</p>}

      <div className="modal-actions">
        {/* Registering the payment belongs to the transactions screen. Showing
            a disabled button here would promise something this screen cannot
            do yet, so it says so instead — and it sits first, so the button
            stays where a button belongs. */}
        <span className="field-hint modal-foot-note">
          Payment recording is available on the Transactions screen.
        </span>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

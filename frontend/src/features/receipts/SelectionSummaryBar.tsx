import type { Cents, MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";

interface SelectionSummaryBarProps {
  count: number;
  /**
   * How many receipts those rows came off.
   *
   * Shown because the count above moves on its own: checking one line of a
   * receipt that covers three lots checks all three, and "3 seleccionadas"
   * with no explanation looks like a misfire rather than the rule it is.
   */
  receiptCount: number;
  sumCents: Cents;
  averageCents: Cents;
  money: MoneyView;
  /** Everything the current search and filters let through. */
  selectableCount: number;
  onSelectAll: () => void;
  onClear: () => void;
}

/**
 * What the checked rows add up to.
 *
 * The same question Excel or Airtable answers the moment a few cells are
 * dragged across — asked here of whichever receipts somebody has picked by
 * hand, which is a different question from "the total of everything the
 * filters let through" above it.
 *
 * Pinned under the header while it is on screen — see `.selection-bar`. The
 * figures are the entire reason somebody selects forty rows, and a total that
 * scrolls away answers the question only for selections small enough not to
 * have needed it.
 */
export function SelectionSummaryBar({
  count,
  receiptCount,
  sumCents,
  averageCents,
  money,
  selectableCount,
  onSelectAll,
  onClear,
}: SelectionSummaryBarProps) {
  const isEverything = count >= selectableCount;

  return (
    <div className="selection-bar">
      <span className="selection-bar-count">
        {count} selected
        {/* Only where it tells you something. On one-lot receipts the two
            numbers are the same, and saying both twice over is noise. */}
        {receiptCount !== count && (
          <span className="selection-bar-receipts">
            {" · "}
            {receiptCount} receipt{receiptCount === 1 ? "" : "s"}
          </span>
        )}
      </span>

      <span className="selection-bar-figure">
        Total <strong>{formatMoney(sumCents, money)}</strong>
      </span>
      <span className="selection-bar-figure">
        Average <strong>{formatMoney(averageCents, money)}</strong>
      </span>

      <span className="selection-bar-actions">
        {/*
          Named with its number, because "seleccionar todo" in a list of four
          thousand payments reads as a promise to select four thousand. What it
          actually takes is what the search and the filters left on screen, and
          the count is how that gets said without a sentence of explanation.

          Gone once it would do nothing — see `isEverything`.
        */}
        {!isEverything && (
          <button type="button" className="link-btn" onClick={onSelectAll}>
            Select all {selectableCount} shown
          </button>
        )}

        <button type="button" className="link-btn" onClick={onClear}>
          Clear selection
        </button>
      </span>
    </div>
  );
}

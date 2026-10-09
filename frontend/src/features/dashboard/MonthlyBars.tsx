import { useMemo, useState } from "react";

import type { Cents, MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import { compactMoney, formatMonth, formatMonthAxis } from "./dashboardPresentation";

/** One column: what arrived, and — where there is one — what was scheduled. */
export interface BarColumn {
  month: string;
  valueCents: Cents;
  /**
   * Drawn as a reference tick across the column rather than as a second bar.
   *
   * Two bars per month would double the number of marks to compare what is
   * really one question — did this month hit its number — and the eye has to
   * measure two lengths against each other instead of reading one against a
   * line. Omitted where nothing was scheduled.
   */
  targetCents?: Cents;
}

interface MonthlyBarsProps {
  columns: BarColumn[];
  money: MoneyView;
  /** Names the bars. Also the legend entry. */
  valueLabel: string;
  /** Names the reference tick. Omit when no column carries a target. */
  targetLabel?: string;
  /** Drawn as selected, and announced as the current reading. */
  selectedMonth?: string;
  /** Clicking a column reports that month. Omit for a chart with nothing behind it. */
  onSelectMonth?: (month: string) => void;
  /** Sentence under the table view, saying what the rows are. */
  tableCaption: string;
}

/**
 * The nearest round number at or above `value`, for the top of the scale.
 *
 * A bar chart whose tallest column runs to the exact maximum has no headroom
 * and no honest gridline to hang a figure off. Stepping to 1 / 2 / 2.5 / 5 × a
 * power of ten gives an axis whose labels are numbers a person would say out
 * loud, which is the whole point of an axis.
 */
function niceCeiling(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));

  for (const step of [1, 2, 2.5, 5]) {
    if (value <= step * magnitude) {
      return step * magnitude;
    }
  }

  return 10 * magnitude;
}

/**
 * Money over the months, as columns against what was scheduled.
 *
 * Built from ordinary elements rather than an SVG or a charting library: the
 * columns have to be focusable and clickable, they carry a text label, and they
 * must reflow on a phone — all of which the browser does for free here and
 * none of which is free in an SVG. It also keeps the app's dependency list
 * where it is.
 *
 * Every value on screen is reachable three ways: the column's own accessible
 * name, the readout that follows the pointer and the keyboard, and the table
 * underneath. Nothing here is gated behind a hover.
 */
export function MonthlyBars({
  columns,
  money,
  valueLabel,
  targetLabel,
  selectedMonth,
  onSelectMonth,
  tableCaption,
}: MonthlyBarsProps) {
  /*
   * Which column the pointer or the keyboard is on.
   *
   * The readout it drives sits in a fixed slot in the chart's header rather than
   * floating beside the cursor. A floating tooltip over a twelve-column chart in
   * a card this width spends its life being clipped by the card's edge or
   * covering the column next to the one being read; a fixed slot cannot be
   * clipped, never moves, and is in the same place for a keyboard user.
   */
  const [readingMonth, setReadingMonth] = useState<string | null>(null);

  const ceiling = useMemo(
    () =>
      niceCeiling(
        Math.max(
          0,
          ...columns.map((column) => Math.max(column.valueCents, column.targetCents ?? 0)),
        ),
      ),
    [columns],
  );

  const reading =
    columns.find((column) => column.month === readingMonth) ??
    columns.find((column) => column.month === selectedMonth);

  const hasAnything = columns.some(
    (column) => column.valueCents > 0 || (column.targetCents ?? 0) > 0,
  );

  /** The column's accessible name — the whole reading, for a screen reader. */
  const describe = (column: BarColumn) =>
    [
      formatMonth(column.month),
      `${valueLabel} ${formatMoney(column.valueCents, money)}`,
      column.targetCents === undefined
        ? null
        : `${targetLabel ?? "expected"} ${formatMoney(column.targetCents, money)}`,
    ]
      .filter((part) => part !== null)
      .join(", ");

  return (
    <div className="chart">
      <div className="chart-head">
        <div className="chart-legend">
          <span className="chart-key">
            <span className="chart-key-bar" />
            {valueLabel}
          </span>
          {targetLabel && (
            <span className="chart-key">
              <span className="chart-key-tick" />
              {targetLabel}
            </span>
          )}
        </div>

        {/* The readout keeps its space whether or not anything is being read,
            so the chart below never shifts up and down under the pointer. */}
        <p className="chart-readout" aria-live="polite">
          {reading && (
            <>
              <span className="chart-readout-month">{formatMonth(reading.month)}</span>
              <span className="chart-readout-value">{formatMoney(reading.valueCents, money)}</span>
              {reading.targetCents !== undefined && (
                <span className="chart-readout-target">
                  of {formatMoney(reading.targetCents, money)}
                </span>
              )}
            </>
          )}
        </p>
      </div>

      {hasAnything ? (
        <div className="chart-body">
          {/* Two hairlines and their figures. They carry the values that are not
              directly labelled, which is every column but the selected one. */}
          <div className="chart-grid" aria-hidden="true">
            <span className="chart-gridline" style={{ bottom: "100%" }}>
              <i>{compactMoney(ceiling as Cents, money)}</i>
            </span>
            <span className="chart-gridline" style={{ bottom: "50%" }}>
              <i>{compactMoney((ceiling / 2) as Cents, money)}</i>
            </span>
          </div>

          <ol className="chart-columns" onMouseLeave={() => setReadingMonth(null)}>
            {columns.map((column, index) => {
              const isSelected = column.month === selectedMonth;
              const target = column.targetCents;

              return (
                <li key={column.month} className="chart-column">
                  <button
                    type="button"
                    className={isSelected ? "chart-slot is-selected" : "chart-slot"}
                    aria-label={describe(column)}
                    aria-current={isSelected ? "true" : undefined}
                    onMouseEnter={() => setReadingMonth(column.month)}
                    onFocus={() => setReadingMonth(column.month)}
                    onBlur={() => setReadingMonth(null)}
                    onClick={onSelectMonth ? () => onSelectMonth(column.month) : undefined}
                  >
                    <span className="chart-track">
                      {/* A month that collected nothing draws NO bar. The 2px
                          floor in the stylesheet keeps a tiny amount visible;
                          applied to zero it puts a mark on the baseline that
                          reads as "a little came in" for a month where nothing
                          did. */}
                      {column.valueCents > 0 && (
                        <span
                          className="chart-bar"
                          style={{ height: `${(column.valueCents / ceiling) * 100}%` }}
                        />
                      )}
                      {target !== undefined && target > 0 && (
                        <span
                          className="chart-target"
                          style={{ bottom: `${Math.min(100, (target / ceiling) * 100)}%` }}
                        />
                      )}
                    </span>
                    <span className="chart-axis">{formatMonthAxis(column.month, index === 0)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p className="state-message">There is no activity for this period yet.</p>
      )}

      {/* Not an extra: it is what makes every figure readable without a pointer,
          and the only way to read an exact amount off a chart drawn to scale. */}
      <details className="chart-table">
        <summary>View the figures</summary>
        <table>
          <caption className="sr-only">{tableCaption}</caption>
          <thead>
            <tr>
              <th>Month</th>
              <th className="col-money">{valueLabel}</th>
              {targetLabel && <th className="col-money">{targetLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.month}>
                <td>{formatMonth(column.month)}</td>
                <td className="col-money mono">{formatMoney(column.valueCents, money)}</td>
                {targetLabel && (
                  <td className="col-money mono">
                    {column.targetCents === undefined
                      ? "—"
                      : formatMoney(column.targetCents, money)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

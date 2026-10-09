import type { SortDirection, SortRule } from "../../lib/sortRules";
import { compareByRules } from "../../lib/sortRules";
import type { Customer, Lot, LotStatus } from "../../types";
import { lotStatus } from "./lotStatus";
import { parseLotCode } from "./lotCode";

export type { SortDirection };

/** The columns worth ordering by. Each maps to a column in the table. */
export type SortField = "code" | "project" | "area" | "price" | "status" | "customer";

/**
 * The screen's whole sort, as a list of levels tried in order — "by project,
 * then by lot" — not just one field. See lib/sortRules.ts.
 */
export type LotSort = SortRule<SortField>[];

export const DEFAULT_SORT: LotSort = [{ field: "code", direction: "asc" }];

/**
 * How each option reads, and what its two directions are called.
 *
 * "A → Z" means nothing for a price, and "menor a mayor" means nothing for a
 * name, so the wording follows the data rather than being one generic pair
 * reused everywhere.
 */
export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  { field: "code", label: "Lot", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "project", label: "Project", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "area", label: "Area", ascLabel: "Smallest first", descLabel: "Largest first" },
  { field: "price", label: "Base price", ascLabel: "Lowest first", descLabel: "Highest first" },
  {
    field: "status",
    label: "Status",
    ascLabel: "Available first",
    descLabel: "Sold or donated first",
  },
  { field: "customer", label: "Customer", ascLabel: "A → Z", descLabel: "Z → A" },
];

/**
 * The order the inventory moves through: free, held, being paid for, gone.
 *
 * Sold and donated share the last step rather than being ranked against each
 * other — both mean the lot has left us, and neither comes "after" the other.
 * The lot code breaks the tie, as it does for every other equal pair.
 */
const STATUS_ORDER: Record<LotStatus, number> = {
  available: 0,
  reserved: 1,
  financed: 2,
  sold: 3,
  donated: 3,
};

/**
 * Compare two lot codes the way a person reads them.
 *
 * Plain text sorting puts "A-10" before "A-2", because it compares "1" against
 * "2" one character at a time. Splitting the code into its letters and its
 * number — the same split the new-lot form makes — sorts A-2 before A-10, which
 * is the only order anybody expects from a list of lots.
 *
 * Codes that do not fit that shape (a manually typed ID) fall back to plain
 * text comparison and sort after the structured ones, so they stay together
 * instead of scattering through the list.
 */
export function compareLotCodes(a: string, b: string): number {
  const left = parseLotCode(a);
  const right = parseLotCode(b);

  if (left && right) {
    return left.prefix.localeCompare(right.prefix, "en") || left.number - right.number;
  }

  if (left) {
    return -1;
  }
  if (right) {
    return 1;
  }

  return a.localeCompare(b, "en");
}

/**
 * Order the lots.
 *
 * Area always compares STORED square metres, never the number on screen. Two
 * projects can be written in different units, and sorting 1.5 mz above 400 m²
 * because 400 is the bigger numeral would be nonsense.
 *
 * Every comparison falls back to the lot code, so lots that tie — the same
 * price, the same project — keep a stable, predictable order instead of
 * shuffling between renders.
 */
export function sortLots(
  lots: Lot[],
  sort: LotSort,
  customersById: Map<string, Customer>,
): Lot[] {
  const holderName = (lot: Lot) =>
    lot.holding ? (customersById.get(lot.holding.customerId)?.fullName ?? "") : "";

  /**
   * One rule's comparison, direction already applied — see `compareByRules`.
   *
   * "customer" is the one field direction does not apply to uniformly. A lot
   * with nobody on it has nothing to compare, and sinks to the bottom in BOTH
   * directions — the behaviour of every spreadsheet people have used. Applying
   * the rule's direction the same way every other field does would send blanks
   * to the TOP on a descending sort, so that "Cliente Z → A" opens on a screen
   * full of empty cells.
   */
  const compareField = (a: Lot, b: Lot, rule: SortRule<SortField>): number => {
    if (rule.field === "customer") {
      const nameA = holderName(a);
      const nameB = holderName(b);
      const blankA = nameA === "";
      const blankB = nameB === "";

      if (blankA !== blankB) {
        return blankA ? 1 : -1;
      }
      if (blankA) {
        return 0;
      }

      const raw = nameA.localeCompare(nameB, "en");
      return rule.direction === "asc" ? raw : -raw;
    }

    const raw = ((): number => {
      switch (rule.field) {
        case "project":
          return a.projectName.localeCompare(b.projectName, "en");
        case "area":
          return a.areaM2 - b.areaM2;
        case "price":
          return a.basePrice - b.basePrice;
        case "status":
          return STATUS_ORDER[lotStatus(a)] - STATUS_ORDER[lotStatus(b)];
        case "code":
        default:
          return compareLotCodes(a.code, b.code);
      }
    })();

    return rule.direction === "asc" ? raw : -raw;
  };

  // A copy: sorting the array we were handed would mutate the caller's state.
  return [...lots].sort((a, b) => {
    const primary = compareByRules(a, b, sort, compareField);

    if (primary !== 0) {
      return primary;
    }

    // The tiebreaker is NOT flipped by direction, so reversing the sort does
    // not also reverse groups of equal rows for no visible reason.
    return compareLotCodes(a.code, b.code);
  });
}

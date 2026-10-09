import type { SortDirection, SortRule } from "../../lib/sortRules";
import { compareByRules } from "../../lib/sortRules";
import type { CustomerRecord } from "../../types";

export type { SortDirection };

/** The columns worth ordering by. Each maps to something visible in the table. */
export type SortField = "name" | "identification" | "since" | "contracts" | "lot" | "project";

/**
 * The screen's whole sort, as a list of levels tried in order — "by name,
 * then by contracts" — not just one field. See lib/sortRules.ts.
 */
export type CustomerSort = SortRule<SortField>[];

/** Alphabetical, which is how the server already sends the list. */
export const DEFAULT_SORT: CustomerSort = [{ field: "name", direction: "asc" }];

/**
 * How each option reads, and what its two directions are called.
 *
 * As in `lotSort.ts`, the wording follows the data: "A → Z" means nothing for a
 * year, and "más antiguos" means nothing for a name.
 */
export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  { field: "name", label: "Customer", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "identification", label: "ID number", ascLabel: "A → Z", descLabel: "Z → A" },
  {
    field: "since",
    label: "Customer since",
    ascLabel: "Oldest first",
    descLabel: "Newest first",
  },
  {
    field: "contracts",
    label: "Active contracts",
    ascLabel: "Fewest first",
    descLabel: "Most first",
  },
  { field: "lot", label: "Lot", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "project", label: "Project", ascLabel: "A → Z", descLabel: "Z → A" },
];

/**
 * Compare two possibly-blank strings the way `lotSort.ts`'s "customer" field
 * does: whichever side has nothing there sinks to the bottom in BOTH
 * directions, rather than jumping to the top on "Z → A". An identidad nobody
 * has entered, or a customer holding no contract, is not a value to rank.
 */
function compareBlankSinking(a: string, b: string, direction: SortDirection): number {
  const blankA = a === "";
  const blankB = b === "";

  if (blankA !== blankB) {
    return blankA ? 1 : -1;
  }
  if (blankA) {
    return 0;
  }

  const raw = a.localeCompare(b, "en");
  return direction === "asc" ? raw : -raw;
}

/**
 * Order the customers.
 *
 * "Contratos" counts the ACTIVE contracts the server sent, which is the number
 * printed in that column — sorting by anything else would order the table by a
 * figure nobody can see. A customer with none is a real zero, not a blank, so
 * unlike "lot" and "project" below there is nothing to sink to the bottom.
 *
 * "Lote" and "Proyecto" read off the FIRST active contract — a customer with
 * three lots does not have one answer to either question, but the table
 * already lists that person's contracts in the same order, so "first" here
 * agrees with what the row itself shows on top.
 *
 * Every comparison falls back to the name, so customers who tie — the same
 * year, the same number of contracts — keep a stable order instead of shuffling
 * between renders.
 */
export function sortCustomers(
  customers: CustomerRecord[],
  sort: CustomerSort,
): CustomerRecord[] {
  const byName = (a: CustomerRecord, b: CustomerRecord) =>
    a.fullName.localeCompare(b.fullName, "en");

  const compareField = (a: CustomerRecord, b: CustomerRecord, rule: SortRule<SortField>): number => {
    switch (rule.field) {
      case "identification":
        return compareBlankSinking(
          a.identification?.trim() ?? "",
          b.identification?.trim() ?? "",
          rule.direction,
        );
      case "lot":
        return compareBlankSinking(a.contracts[0]?.lotCode ?? "", b.contracts[0]?.lotCode ?? "", rule.direction);
      case "project":
        return compareBlankSinking(
          a.contracts[0]?.projectName ?? "",
          b.contracts[0]?.projectName ?? "",
          rule.direction,
        );
    }

    const raw = ((): number => {
      switch (rule.field) {
        case "since":
          return a.customerSince - b.customerSince;
        case "contracts":
          return a.contracts.length - b.contracts.length;
        case "name":
        default:
          return byName(a, b);
      }
    })();

    return rule.direction === "asc" ? raw : -raw;
  };

  // A copy: sorting the array we were handed would mutate the caller's state.
  return [...customers].sort((a, b) => {
    const result = compareByRules(a, b, sort, compareField);

    if (result !== 0) {
      return result;
    }

    // The tiebreaker is NOT flipped by direction, so reversing the sort does
    // not also reverse groups of equal rows for no visible reason.
    return byName(a, b);
  });
}

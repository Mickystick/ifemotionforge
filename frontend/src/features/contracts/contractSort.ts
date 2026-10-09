import type { Cents } from "../../lib/money";
import { cents } from "../../lib/money";
import type { SortRule } from "../../lib/sortRules";
import { compareByRules } from "../../lib/sortRules";
import type { Contract } from "../../types";
import { compareLotCodes } from "../lots/lotSort";

export type SortField =
  | "customer"
  | "balance"
  | "health"
  | "nextDue"
  | "code"
  | "groupSize"
  | "lot"
  | "project";

/**
 * The screen's whole sort, as a list of levels tried in order — "by customer,
 * then by lot" — not just one field. See lib/sortRules.ts.
 */
export type ContractSort = SortRule<SortField>[];

/**
 * Opens on how many contracts each customer holds, fewest first.
 *
 * A customer with three lots is easy to miss buried among everyone with one —
 * sorting that way clusters them at the bottom of the list instead, so the
 * people worth a second look (a family building out a second or third lot)
 * stand out as their own visible block rather than scattered alphabetically.
 */
export const DEFAULT_SORT: ContractSort = [{ field: "groupSize", direction: "asc" }];

export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  {
    field: "groupSize",
    label: "Contracts per customer",
    ascLabel: "One first",
    descLabel: "Multiple first",
  },
  { field: "health", label: "Payment status", ascLabel: "Current first", descLabel: "Overdue first" },
  { field: "customer", label: "Customer", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "balance", label: "Balance", ascLabel: "Lowest first", descLabel: "Highest first" },
  { field: "nextDue", label: "Next installment", ascLabel: "Soonest first", descLabel: "Latest first" },
  { field: "code", label: "Contract date", ascLabel: "Oldest first", descLabel: "Newest first" },
  { field: "lot", label: "Lot", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "project", label: "Project", ascLabel: "A → Z", descLabel: "Z → A" },
];

/** Worst first when sorting descending, so the severity order is explicit. */
const HEALTH_SEVERITY: Record<Contract["health"]["status"], number> = {
  current: 0,
  due_soon: 1,
  overdue: 2,
  at_risk: 3,
};

/** How many contracts (within the list being sorted) each customer holds. */
function customerCounts(contracts: Contract[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const contract of contracts) {
    counts.set(contract.customer.id, (counts.get(contract.customer.id) ?? 0) + 1);
  }

  return counts;
}

function compare(a: Contract, b: Contract, field: SortField, counts: Map<string, number>): number {
  switch (field) {
    case "customer":
      return a.customer.fullName.localeCompare(b.customer.fullName, "en");
    case "balance":
      return a.balance - b.balance;
    case "health":
      return HEALTH_SEVERITY[a.health.status] - HEALTH_SEVERITY[b.health.status];
    case "nextDue":
      // A contract with nothing left to pay has no next due date. It sorts last
      // either way rather than jumping to the top as an empty string would.
      return (a.health.nextDueOn ?? "9999-12-31").localeCompare(b.health.nextDueOn ?? "9999-12-31");
    case "code":
      return a.code.localeCompare(b.code, "en");
    case "groupSize":
      return (counts.get(a.customer.id) ?? 1) - (counts.get(b.customer.id) ?? 1);
    case "lot":
      // Same comparator the Lotes screen sorts its own code column with, so
      // A-2 comes before A-10 here too rather than reading as plain text.
      return compareLotCodes(a.lot.code, b.lot.code);
    case "project":
      return a.lot.projectName.localeCompare(b.lot.projectName, "en");
  }
}

export function sortContracts(contracts: Contract[], sort: ContractSort): Contract[] {
  const counts = customerCounts(contracts);

  return [...contracts].sort((a, b) => {
    const primary = compareByRules(a, b, sort, (x, y, rule) => {
      const raw = compare(x, y, rule.field, counts);

      return rule.direction === "asc" ? raw : -raw;
    });

    if (primary !== 0) {
      return primary;
    }

    // A stable tie-break, so rows never shuffle between renders. The customer
    // name keeps a person's contracts adjacent, which is what the grouping
    // below depends on.
    return (
      a.customer.fullName.localeCompare(b.customer.fullName, "en") ||
      a.code.localeCompare(b.code, "en")
    );
  });
}

/**
 * One customer's contracts, kept together.
 *
 * The table's row is still the CONTRACT — that is where the money lives — but a
 * customer with three lots is one person to call, one conversation and one
 * receipt, so their rows are collected under a header carrying the totals.
 *
 * Order is taken from the sorted list: a group sits wherever its first contract
 * landed, so sorting by "atrasados primero" still puts the worst customer at
 * the top rather than quietly reverting to alphabetical.
 */
export interface ContractGroup {
  customerId: string;
  customerName: string;
  contracts: Contract[];
  /** Summed across the group — the figure the customer actually recognises. */
  totalBalance: Cents;
  totalMonthly: Cents;
  /** The whole purchase, for the group header's Precio and Prima columns. */
  totalPrice: Cents;
  totalDownPayment: Cents;
  /** The worst health in the group: one lot behind means the customer is behind. */
  worst: Contract;
  /** True when these lots were bought as ONE purchase, not just by one person. */
  isOnePurchase: boolean;
}

export function groupByCustomer(contracts: Contract[]): ContractGroup[] {
  const groups = new Map<string, Contract[]>();

  for (const contract of contracts) {
    const existing = groups.get(contract.customer.id);

    if (existing) {
      existing.push(contract);
    } else {
      groups.set(contract.customer.id, [contract]);
    }
  }

  return [...groups.entries()].map(([customerId, list]) => {
    const first = list[0]!;
    const saleGroupIds = new Set(list.map((contract) => contract.saleGroupId));

    return {
      customerId,
      customerName: first.customer.fullName,
      contracts: list,
      // Re-branded through `cents()` rather than left as a bare sum: adding
      // two `Cents` gives a plain number back, and money that has lost its
      // brand is money that can be passed somewhere expecting lempiras.
      totalBalance: cents(list.reduce((sum, contract) => sum + contract.balance, 0)),
      totalMonthly: cents(
        list.reduce((sum, contract) => sum + (contract.terms.monthlyPayment ?? 0), 0),
      ),
      totalPrice: cents(list.reduce((sum, contract) => sum + contract.terms.salePrice, 0)),
      totalDownPayment: cents(
        list.reduce((sum, contract) => sum + contract.terms.downPayment, 0),
      ),
      worst: list.reduce((worst, contract) =>
        HEALTH_SEVERITY[contract.health.status] > HEALTH_SEVERITY[worst.health.status]
          ? contract
          : worst,
      ),
      // Every lot on the same sale group id, and that id is not null: one
      // signature, one payment, one receipt. Two lots bought years apart are
      // the same person but not the same purchase, and the split must not
      // treat them as one.
      isOnePurchase: saleGroupIds.size === 1 && first.saleGroupId !== null,
    };
  });
}

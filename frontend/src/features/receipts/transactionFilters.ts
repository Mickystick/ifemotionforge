import type { Transaction } from "../../types";

/** How the money arrived. Matches `payments.method` on the server. */
export type MethodFilter = "cash" | "transfer" | "card";

/**
 * The state of a transaction, as this screen asks about it.
 *
 * Three genuinely different things, which is why they are one list rather than
 * a boolean each: "con recibo" is money that has a printed document, "sin
 * recibo" is real money that never got one, and "anulada" is money that has
 * stopped counting. Somebody chasing a missing document wants the second;
 * somebody auditing wants the third.
 */
export type StatusFilter = "receipted" | "unreceipted" | "reversed";

export interface TransactionFilters {
  /** Empty means every method. */
  methods: MethodFilter[];
  /** Empty means every state. */
  statuses: StatusFilter[];
  /** Empty means every project. */
  projects: string[];
  /** Date range on `paidOn`, inclusive. Null at either end means open. */
  fromDate: string | null;
  toDate: string | null;
}

export const NO_TRANSACTION_FILTERS: TransactionFilters = {
  methods: [],
  statuses: [],
  projects: [],
  fromDate: null,
  toDate: null,
};

export const METHOD_LABELS: Array<{ value: MethodFilter; label: string }> = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank transfer" },
  { value: "card", label: "Card" },
];

export const STATUS_LABELS: Array<{ value: StatusFilter; label: string }> = [
  { value: "receipted", label: "Receipt issued" },
  { value: "unreceipted", label: "No receipt" },
  { value: "reversed", label: "Voided" },
];

/** How many restrictions are active — the number on the Filtros button. */
export function countActiveFilters(filters: TransactionFilters): number {
  let count = 0;

  if (filters.methods.length > 0) {
    count += 1;
  }
  if (filters.statuses.length > 0) {
    count += 1;
  }
  if (filters.projects.length > 0) {
    count += 1;
  }
  // A date range is one restriction whether one end is set or both.
  if (filters.fromDate !== null || filters.toDate !== null) {
    count += 1;
  }

  return count;
}

export function hasActiveFilters(filters: TransactionFilters): boolean {
  return countActiveFilters(filters) > 0;
}

function matchesStatus(transaction: Transaction, status: StatusFilter): boolean {
  switch (status) {
    case "receipted":
      return transaction.receiptId !== null && transaction.reversedAt === null;
    case "unreceipted":
      return transaction.receiptId === null && transaction.reversedAt === null;
    case "reversed":
      return transaction.reversedAt !== null;
  }
}

export function matchesFilters(
  transaction: Transaction,
  filters: TransactionFilters,
): boolean {
  if (
    filters.methods.length > 0 &&
    !filters.methods.includes(transaction.method as MethodFilter)
  ) {
    return false;
  }

  if (filters.statuses.length > 0) {
    if (!filters.statuses.some((status) => matchesStatus(transaction, status))) {
      return false;
    }
  } else if (transaction.reversedAt !== null) {
    // No status chosen means "the money that still counts" — an anulada has
    // stopped counting, so it stays off the log unless someone explicitly
    // asks for "Anuladas". It is never gone: Historial keeps the record.
    return false;
  }

  if (filters.projects.length > 0 && !filters.projects.includes(transaction.projectName)) {
    return false;
  }

  // Dates are YYYY-MM-DD, so a string comparison IS a date comparison — and it
  // is the only one that cannot be shifted by a timezone.
  if (filters.fromDate !== null && transaction.paidOn < filters.fromDate) {
    return false;
  }

  if (filters.toDate !== null && transaction.paidOn > filters.toDate) {
    return false;
  }

  return true;
}

/**
 * How many transactions are in scope before the search and the filters narrow
 * them — the "de N" the toolbar counts down from.
 *
 * Not `transactions.length`, and that is the whole point of this function
 * existing. With no status chosen the list hides anuladas by default (see
 * `matchesFilters` above), so a screen with three voided payments and nothing
 * filtered would read "128 de 131" — which says a filter is on when none is,
 * and sends somebody to the filter panel to clear something that is not there.
 *
 * Once a status IS chosen the person has opted into seeing reversed rows, so
 * the scope widens to everything and "3 de 131" correctly reads as a narrow
 * slice of the whole history.
 */
export function transactionsInScope(
  transactions: Transaction[],
  filters: TransactionFilters,
): number {
  if (filters.statuses.length > 0) {
    return transactions.length;
  }

  return transactions.filter((transaction) => transaction.reversedAt === null).length;
}

export function filterTransactions(
  transactions: Transaction[],
  filters: TransactionFilters,
): Transaction[] {
  return transactions.filter((transaction) => matchesFilters(transaction, filters));
}

/** Everything about a transaction somebody might type into the search box. */
export function searchTransactions(
  transactions: Transaction[],
  search: string,
): Transaction[] {
  const query = search.trim().toLowerCase();

  if (query === "") {
    return transactions;
  }

  // Every word has to match something, so "ana valle" narrows rather than
  // widening — which is how people expect a search box to behave.
  const words = query.split(/\s+/);

  return transactions.filter((transaction) => {
    const text = [
      transaction.customerName,
      transaction.customerIdentification,
      transaction.lotCode,
      transaction.projectName,
      transaction.contractCode,
      transaction.receiptCode ?? "",
      transaction.reference ?? "",
      transaction.notes ?? "",
      transaction.receiptNote ?? "",
    ]
      .join(" ")
      .toLowerCase();

    return words.every((word) => text.includes(word));
  });
}

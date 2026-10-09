import type { SortDirection, SortRule } from "../../lib/sortRules";
import { compareByRules } from "../../lib/sortRules";
import { parseTimestamp } from "../../lib/time";
import type { ContractStatus, Transaction } from "../../types";

export type { SortDirection };

/** The columns worth ordering by. Each maps to something visible in the list. */
export type SortField = "date" | "customer" | "amount" | "lot" | "project";

/**
 * The screen's whole sort, as a list of levels tried in order — "by customer,
 * then by date" — not just one field. See lib/sortRules.ts.
 */
export type TransactionSort = SortRule<SortField>[];

/**
 * Newest first, which is what a transactions screen is for.
 *
 * Somebody opening this tab is nearly always looking for something that
 * happened today or yesterday, not for the first payment ever taken.
 */
export const DEFAULT_SORT: TransactionSort = [{ field: "date", direction: "desc" }];

/**
 * How each option reads, and what its two directions are called.
 *
 * The wording follows the data, as in `customerSort.ts`: "A → Z" means nothing
 * for an amount, and "más recientes" means nothing for a name.
 */
export const SORT_OPTIONS: Array<{
  field: SortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  {
    field: "date",
    label: "Payment date",
    ascLabel: "Oldest first",
    descLabel: "Newest first",
  },
  { field: "customer", label: "Customer", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "amount", label: "Amount", ascLabel: "Lowest first", descLabel: "Highest first" },
  { field: "lot", label: "Lot", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "project", label: "Project", ascLabel: "A → Z", descLabel: "Z → A" },
];

/**
 * When a transaction happened, to the finest resolution the data has.
 *
 * `paidOn` is a calendar DATE, so three payments taken on 30 August all tie on
 * it — and a tie is not a detail here, it is most of the screen: a busy day is
 * exactly when several payments share a date. `createdAt` breaks the tie with
 * the order they were entered.
 *
 * This is the first two parts of the three-part key `backend/src/lib/ledger.ts`
 * orders a contract's ledger by, and it is deliberately the same one. A list
 * that disagrees with the ledger about which of two payments came first is a
 * list that disagrees with the receipts printed from it.
 */
function compareWhen(a: Transaction, b: Transaction): number {
  return (
    a.paidOn.localeCompare(b.paidOn) ||
    parseTimestamp(a.createdAt) - parseTimestamp(b.createdAt)
  );
}

/**
 * LEDGER ORDER: `paidOn`, then `createdAt`, then the id. Oldest first.
 *
 * The whole key, and the same three parts in the same order as
 * `compareLedgerOrder` in backend/src/lib/ledger.ts. Exported because the
 * correction dialog's history has to be this exact sequence — it is the order
 * the server replays a contract in, so it is the order the balances either side
 * of an edit were derived from.
 *
 * The id is arbitrary — a `randomUUID()` — and only ever settles a genuine dead
 * heat. Two payments tie that far when they share a `paidOn` AND a `createdAt`
 * to the millisecond, which is not an exotic case: a receipt covering three
 * lots writes three payments inside one database transaction, all stamped from
 * the same `new Date()`. What the id buys is not meaning, it is TOTALITY — a
 * comparison that never returns zero, so there is exactly one order and every
 * screen reads the same one.
 */
export function compareLedgerOrder(a: Transaction, b: Transaction): number {
  return compareWhen(a, b) || a.id.localeCompare(b.id);
}

/**
 * One rule's comparison, direction already applied — see `compareByRules`.
 *
 * "date" is the one field this cannot be a plain `(a.x - b.x) * direction`
 * for: it compares ledger order, whole, with the direction applied to ALL
 * THREE parts of the key — so "más recientes primero" is the exact reverse of
 * "más antiguos primero", and of the history in the correction dialog. That is
 * a stronger promise than it sounds, and it is the one that was broken:
 *
 * The list used to reverse `paidOn` and `createdAt` but leave the final id
 * comparison ascending. Rows that tie on the first two parts therefore came out
 * in the SAME relative order whichever direction was chosen — and a receipt
 * covering three lots produces exactly such a tie, three payments stamped from
 * one `new Date()`. So the bottom row of a newest-first list was the LAST of
 * those three, while the oldest-first history put it third. Scroll to the foot
 * of a customer's payments, open the one that has to be their first, and the
 * dialog highlighted the third. Nothing was miscounted; the two screens were
 * reading one ambiguity in two directions.
 *
 * Because it carries the id, a "date" rule never ties — so if it is one of
 * several levels, nothing after it in the chain ever runs, which is exactly
 * right: there is nothing left for a later level to break a tie on.
 */
function compareTransactionField(a: Transaction, b: Transaction, rule: SortRule<SortField>): number {
  if (rule.field === "date") {
    const raw = compareLedgerOrder(a, b);
    return rule.direction === "asc" ? raw : -raw;
  }

  const raw = ((): number => {
    switch (rule.field) {
      case "customer":
        return a.customerName.localeCompare(b.customerName, "es");
      case "amount":
        return a.amount - b.amount;
      case "project":
        return a.projectName.localeCompare(b.projectName, "es");
      case "lot":
      default:
        return a.lotCode.localeCompare(b.lotCode, "es");
    }
  })();

  return rule.direction === "asc" ? raw : -raw;
}

/**
 * Order the transactions.
 *
 * Every level is tried in turn — see `compareByRules` — and rows every level
 * leaves tied fall back to ledger order REVERSED — newest first — un-flipped
 * by any level's own direction: asking for "menor a mayor" on the amount
 * should not also reverse the two payments that tie at L 5,000, for no visible
 * reason. That fallback never actually runs when "date" is one of the levels,
 * since a "date" comparison never ties — see `compareTransactionField`.
 */
export function sortTransactions(
  transactions: Transaction[],
  sort: TransactionSort,
): Transaction[] {
  // A copy: sorting the array we were handed would mutate the caller's state.
  return [...transactions].sort(
    (a, b) => compareByRules(a, b, sort, compareTransactionField) || -compareLedgerOrder(a, b),
  );
}

/**
 * The customers who have at least one transaction, each with theirs.
 *
 * Built from the same array the flat list uses, so the two views can never
 * disagree about what exists. Customers with no payments simply do not appear —
 * this is a list of money that moved, not a directory of people.
 */
/** One contract's slice of a customer's total — see `CustomerGroup.byContract`. */
export interface ContractSubtotal {
  contractId: string;
  contractCode: string;
  contractStatus: ContractStatus;
  /** Non-reversed only, same filter as `CustomerGroup.totalCents`. */
  totalCents: number;
}

export interface CustomerGroup {
  customerId: string;
  customerName: string;
  customerIdentification: string;
  transactions: Transaction[];
  /** Non-reversed only: what this person has actually paid. */
  totalCents: number;
  /**
   * `totalCents`, split by the contract each payment actually landed on —
   * ordered by contract code, which puts a predecessor right before the
   * successor(s) an adenda gave it ("CT-2026-011" < "CT-2026-011-A1"). Length
   * 1 for the common case of one lot never renegotiated; longer when the
   * customer holds several lots, or a lot's contract was replaced.
   *
   * `contractStatus` is read live off the join in `GET /transactions`, not
   * frozen at payment time — so a payment made while a contract was still
   * `active` shows up here under `replaced` once an adenda later closes it.
   * That is the point: this reflects what the contract IS now, which is what
   * "part of the old contract vs. the new adenda" is actually asking.
   */
  byContract: ContractSubtotal[];
  /** Any contract behind this total was closed by an adenda. */
  hasAmendment: boolean;
  /** The most recent payment, for the collapsed summary line. */
  lastPaidOn: string;
}

export function groupByCustomer(
  transactions: Transaction[],
  sort: TransactionSort,
): CustomerGroup[] {
  const groups = new Map<string, CustomerGroup>();

  for (const transaction of transactions) {
    const existing = groups.get(transaction.customerId);

    if (existing) {
      existing.transactions.push(transaction);
    } else {
      groups.set(transaction.customerId, {
        customerId: transaction.customerId,
        customerName: transaction.customerName,
        customerIdentification: transaction.customerIdentification,
        transactions: [transaction],
        totalCents: 0,
        byContract: [],
        hasAmendment: false,
        lastPaidOn: transaction.paidOn,
      });
    }
  }

  for (const group of groups.values()) {
    // Inside a customer, the chosen sort still applies — somebody who opened
    // "mayor a menor" expects it to hold within the person they expand.
    group.transactions = sortTransactions(group.transactions, sort);

    const settled = group.transactions.filter((transaction) => transaction.reversedAt === null);

    group.totalCents = settled.reduce((sum, transaction) => sum + transaction.amount, 0);

    const byContract = new Map<string, ContractSubtotal>();
    for (const transaction of settled) {
      const existing = byContract.get(transaction.contractId);
      if (existing) {
        existing.totalCents += transaction.amount;
      } else {
        byContract.set(transaction.contractId, {
          contractId: transaction.contractId,
          contractCode: transaction.contractCode,
          contractStatus: transaction.contractStatus as ContractStatus,
          totalCents: transaction.amount,
        });
      }
    }
    group.byContract = [...byContract.values()].sort((a, b) =>
      a.contractCode.localeCompare(b.contractCode, "es"),
    );
    group.hasAmendment = group.byContract.some((entry) => entry.contractStatus === "replaced");

    group.lastPaidOn = group.transactions.reduce(
      (latest, transaction) => (transaction.paidOn > latest ? transaction.paidOn : latest),
      group.transactions[0]?.paidOn ?? "",
    );
  }

  const ordered = [...groups.values()];

  // The GROUPS are ordered by the same choice where it makes sense. Sorting
  // people by "lote" or "proyecto" is meaningless — one person can have
  // transactions on several — so those fall back to the most recent payment,
  // which is the useful answer when the question is about a person.
  const compareGroupField = (a: CustomerGroup, b: CustomerGroup, rule: SortRule<SortField>): number => {
    const raw = ((): number => {
      switch (rule.field) {
        case "customer":
          return a.customerName.localeCompare(b.customerName, "es");
        case "amount":
          return a.totalCents - b.totalCents;
        case "date":
        case "lot":
        case "project":
        default:
          return a.lastPaidOn.localeCompare(b.lastPaidOn);
      }
    })();

    return rule.direction === "asc" ? raw : -raw;
  };

  ordered.sort((a, b) => {
    const result = compareByRules(a, b, sort, compareGroupField);

    // Two people whose last payment fell on the same day, or who have paid the
    // same total, are separated by name rather than by whichever the server
    // listed first. Same reason as the flat list: an order nobody can explain
    // reads as an order that means something.
    return (
      result ||
      a.customerName.localeCompare(b.customerName, "es") ||
      a.customerId.localeCompare(b.customerId)
    );
  });

  return ordered;
}

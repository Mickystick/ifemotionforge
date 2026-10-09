import type { Contract, ContractStatus, PaymentHealth, SaleType } from "../../types";

/**
 * How the three status concepts read on screen, defined once.
 *
 * The wording and the colour live here rather than being scattered
 * through JSX, for the same reason `lotStatus.ts` exists: a label that appears
 * in a table, a filter chip and a detail panel has to say the same word in all
 * three, and the only way to guarantee that is to have one copy of it.
 */

/**
 * Payment health, escalating through four steps.
 *
 * Note that `due_soon` covers the five-day grace as well as the week before an
 * installment falls due. That is deliberate: green would tell staff there is
 * nothing to do on day three of the grace, when a phone call is exactly what is
 * wanted. Amber says "worth a call", red says "this is now a debt".
 */
export const HEALTH_PRESENTATION: Record<
  PaymentHealth,
  { label: string; stampClass: string; hint: string }
> = {
  current: {
    label: "Current",
    stampClass: "stamp success",
    hint: "No overdue payments.",
  },
  due_soon: {
    label: "Due soon",
    stampClass: "stamp warning",
    hint: "An installment is coming due or within the five-day grace period.",
  },
  overdue: {
    label: "Overdue",
    stampClass: "stamp clay",
    hint: "The five-day grace period has passed without a payment.",
  },
  at_risk: {
    label: "At risk",
    stampClass: "stamp danger",
    hint: "Two or more months without a payment.",
  },
};

/** The contract's own lifecycle — a different question from payment health. */
export const STATUS_PRESENTATION: Record<
  ContractStatus,
  { label: string; stampClass: string }
> = {
  draft: { label: "Draft", stampClass: "stamp neutral" },
  active: { label: "Active", stampClass: "stamp success" },
  paid_off: { label: "Paid off", stampClass: "stamp neutral" },
  cancelled: { label: "Canceled", stampClass: "stamp neutral" },
  defaulted: { label: "Defaulted", stampClass: "stamp danger" },
  replaced: { label: "Replaced", stampClass: "stamp neutral" },
};

/** Financing / Cash / Donation. */
export const SALE_TYPE_LABELS: Record<SaleType, string> = {
  financed: "Financed",
  cash: "Cash",
  donation: "Donation",
};

/** What became of money already paid, when a contract was cancelled. */
export const SETTLEMENT_LABELS: Record<"none" | "held" | "refunded", string> = {
  none: "Kept as income",
  held: "Temporarily held",
  refunded: "Refunded to customer",
};

/** A hold versus a signed sale. */
export const KIND_LABELS: Record<Contract["kind"], string> = {
  reservation: "Reservation",
  contract: "Contract",
};

/**
 * The one chip the Estado column shows.
 *
 * Health and lifecycle stay separate everywhere else, but a single column has
 * to pick. The rule: a contract that is no longer active is described by its
 * lifecycle, because "al día" on a cancelled contract is true and useless. A
 * lapsed reservation says so; a contract that owes nothing says so. Everything
 * else — the overwhelming majority — shows its payment health, which is the
 * question the screen exists to answer.
 */
export function primaryStamp(contract: Contract): { label: string; stampClass: string } {
  if (contract.status !== "active") {
    return STATUS_PRESENTATION[contract.status];
  }

  // A reservation past its expiry date. The row still says "active", but the
  // hold is over and the lot is back on the market.
  if (contract.expired) {
    return { label: "Expired", stampClass: "stamp neutral" };
  }

  if (contract.health.settled) {
    return { label: "Paid", stampClass: "stamp neutral" };
  }

  return HEALTH_PRESENTATION[contract.health.status];
}

/**
 * The short sentence under the chip: how far behind or ahead this customer is.
 *
 * Empty when there is nothing to say, so a healthy row stays quiet instead of
 * carrying a reassuring line nobody reads.
 */
export function healthDetail(contract: Contract): string {
  const { monthsBehind, monthsAhead } = contract.health;

  if (monthsBehind > 0) {
    return monthsBehind === 1 ? "1 month overdue" : `${monthsBehind} months overdue`;
  }

  if (monthsAhead > 0) {
    return monthsAhead === 1 ? "1 month ahead" : `${monthsAhead} months ahead`;
  }

  return "";
}

/*
 * Dates arrive as plain YYYY-MM-DD calendar dates, never as instants.
 *
 * They are split by hand rather than handed to `new Date(value)`, which reads a
 * bare date as UTC midnight and then prints it in the local zone — turning
 * "2026-03-05" into 4 March for everyone west of Greenwich, Honduras included.
 * A due date that moves depending on where the browser is is not a due date.
 */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Mar 05, 2026". */
export function formatDate(isoDate: string | null): string {
  if (!isoDate) {
    return "—";
  }

  const [year, month, day] = isoDate.split("-");

  if (!year || !month || !day) {
    return isoDate;
  }

  return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}, ${year}`;
}

/** "L 6,700 · due day 5", or an em dash for a sale with no schedule. */
export function formatSchedule(contract: Contract, formatted: string | null): string {
  if (contract.terms.monthlyPayment === null || contract.terms.dueDay === null) {
    return "—";
  }

  return `${formatted ?? ""} · due day ${contract.terms.dueDay}`;
}

/** How far through the price this contract is, 0–100, for the progress bar. */
export function paidPercent(contract: Contract): number {
  if (contract.terms.salePrice <= 0) {
    return 100;
  }

  return Math.min(100, Math.round((contract.paidToDate / contract.terms.salePrice) * 100));
}

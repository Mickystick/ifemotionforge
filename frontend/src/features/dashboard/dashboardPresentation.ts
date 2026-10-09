import type { Cents, MoneyView } from "../../lib/money";

/**
 * How the Panel General words itself, defined once.
 *
 * The same month, the same comparison and the same collection rate appear in a
 * heading, a stat tile and a chart label, and the only way to guarantee all
 * three say the same thing is to have one copy of each.
 */

/*
 * Months are handled as "YYYY-MM" strings and split by hand, never handed to
 * `new Date(value)` — which reads a bare date as UTC midnight and then prints it
 * in the local zone, turning "2026-03" into February for everyone west of
 * Greenwich, Honduras included.
 */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function monthIndex(month: string): number {
  return Number(month.slice(5, 7)) - 1;
}

/** "septiembre 2026". */
export function formatMonth(month: string): string {
  return `${MONTH_NAMES[monthIndex(month)] ?? month} ${month.slice(0, 4)}`;
}

/** "septiembre" — for a sentence that has already established the year. */
export function formatMonthName(month: string): string {
  return MONTH_NAMES[monthIndex(month)] ?? month;
}

/**
 * "sep", or "sep 26" in January and for the first column of a chart.
 *
 * The year appears only where the axis crosses into a new one, so a twelve-month
 * axis says it once or twice rather than twelve times.
 */
export function formatMonthAxis(month: string, isFirst: boolean): string {
  const abbreviation = MONTH_ABBREVIATIONS[monthIndex(month)] ?? month;

  return isFirst || monthIndex(month) === 0
    ? `${abbreviation} ${month.slice(2, 4)}`
    : abbreviation;
}

/**
 * An amount short enough for a chart's axis: "L 340 k", "$ 1.2 M".
 *
 * Rounded on purpose, and only ever used on a gridline. An axis is a sense of
 * scale, not a figure anybody quotes — the exact amount is in the readout above
 * the chart and in the table below it, both to the centavo.
 *
 * Goes through the same `MoneyView` as every other amount on screen, so the
 * axis follows the currency toggle instead of quietly staying in lempiras.
 */
export function compactMoney(amount: Cents, view: MoneyView): string {
  const units = view.currency === "USD" ? amount / 100 / view.usdRate : amount / 100;
  const symbol = view.currency === "USD" ? "$" : "L";

  if (Math.abs(units) >= 1_000_000) {
    return `${symbol} ${(units / 1_000_000).toFixed(1)} M`;
  }

  if (Math.abs(units) >= 1_000) {
    return `${symbol} ${Math.round(units / 1_000)} k`;
  }

  return `${symbol} ${Math.round(units)}`;
}

/* -------------------------------------------------------------------------- */
/* Comparisons                                                                 */
/* -------------------------------------------------------------------------- */

/** Which way a change points. Every use of this on the screen is "up is good". */
export type DeltaTone = "up" | "down" | "flat";

export interface Delta {
  tone: DeltaTone;
  /** "+18 %", "−7 %", "sin cambio", or "sin comparación". */
  label: string;
}

/**
 * This month against last, as a percentage.
 *
 * `unknown` rather than "+100 %" when the previous month was zero, which is the
 * case that makes every naive percentage-change function lie: the first month a
 * project collects anything is not infinite growth, and a business that took a
 * month off did not improve by 100 % on its return.
 */
export function compareToPrevious(current: number, previous: number): Delta {
  if (previous === 0) {
    return {
      tone: current > 0 ? "up" : "flat",
      label: current > 0 ? "no comparison" : "no change",
    };
  }

  const change = Math.round(((current - previous) / previous) * 100);

  if (change === 0) {
    return { tone: "flat", label: "no change" };
  }

  // A true minus sign, not a hyphen: these sit beside figures, and a hyphen at
  // this size reads as a dash between two numbers rather than as a sign.
  return {
    tone: change > 0 ? "up" : "down",
    label: `${change > 0 ? "+" : "−"}${Math.abs(change)} %`,
  };
}

/** How many days a month has. Built through UTC, like every other date here. */
export function daysInMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

/**
 * What the month-over-month figure is actually comparing.
 *
 * Halfway through September the comparison is against the first fifteen days of
 * August, not against August — and saying so is the difference between a reader
 * trusting the number and a reader wondering why the business collapsed.
 * Once the span covers the whole of the previous month it says the plain thing.
 */
export function describeComparison(previousMonth: string, comparisonDays: number): string {
  const name = formatMonthName(previousMonth);

  if (comparisonDays >= daysInMonth(previousMonth)) {
    return `compared with ${name}`;
  }

  // "los primeros 1 días" is what a template gets you on the first of the month,
  // which is exactly the day this sentence is read most.
  if (comparisonDays === 1) {
    return `compared with the first day of ${name}`;
  }

  return `compared with the first ${comparisonDays} days of ${name}`;
}

/**
 * How much of what was scheduled actually arrived, as a percentage.
 *
 * NOT capped at 100. A month where customers paid ahead genuinely collected
 * 184 % of what was due, and that is the good news the screen exists to
 * deliver — reporting it as a flat "100 %" would hide the best month of the
 * year behind the same figure as a month that merely broke even. It is the
 * METER that clamps its own width, because a bar running past its track reads
 * as a rendering bug; the number beside it stays true.
 *
 * `null` when nothing was scheduled — a month with no installments falling due
 * has no collection rate, and rendering that as 0 % would report a quiet month
 * as a failed one.
 */
export function collectionRate(collected: Cents, expected: Cents): number | null {
  if (expected <= 0) {
    return null;
  }

  return Math.round((collected / expected) * 100);
}

/** "14 clientes", "1 cliente" — Spanish plurals the app writes out by hand. */
export function pluralise(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/*
 * Dates arrive as plain YYYY-MM-DD calendar dates, never as instants — the same
 * rule and the same reason as features/contracts/contractPresentation.ts.
 */

/** "Mar 05, 2026". */
export function formatDate(isoDate: string | null): string {
  if (!isoDate) {
    return "—";
  }

  const [year, month, day] = isoDate.split("-");

  if (!year || !month || !day) {
    return isoDate;
  }

  return `${MONTH_ABBREVIATIONS[Number(month) - 1] ?? month} ${day}, ${year}`;
}

/**
 * Whole days from `from` to `to`; negative when `to` is already past.
 *
 * Both sides are parsed as UTC so the answer cannot change with the reader's
 * timezone, which is the same reason the server does its date arithmetic in UTC.
 */
export function daysBetween(from: string, to: string): number {
  const parse = (date: string) =>
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** "due in 6 days", "was due 3 days ago", "due today". */
export function describeExpiry(expiresOn: string, asOf: string): string {
  const days = daysBetween(asOf, expiresOn);

  if (days === 0) {
    return "due today";
  }

  if (days < 0) {
    return `was due ${pluralise(Math.abs(days), "day", "days")} ago`;
  }

  return `due in ${pluralise(days, "day", "days")}`;
}

/* -------------------------------------------------------------------------- */
/* Opening a figure into the rows behind it                                    */
/* -------------------------------------------------------------------------- */

/** "Mar 15" — a day inside a month whose heading has already named it. */
export function shortDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  // `timeZone: "UTC"` against a UTC-constructed date, for the reason at the top
  // of this file: without it the formatter reads midnight UTC in the device's
  // own zone and prints the day before, all through the Americas.
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  transfer: "Bank transfer",
  card: "Card",
};

/**
 * One person and everything they paid in the month being reported.
 *
 * Generic in the payment so the panel keeps the full `MonthPayment` — lot code,
 * date, method — while this file only ever needs the three fields it groups by.
 */
export interface Payer<T extends PayerPayment> {
  customerId: string;
  customerName: string;
  totalCents: Cents;
  rows: T[];
}

/**
 * The fields `groupPayers` needs of a payment.
 *
 * Structural rather than the full `MonthPayment`, so this function — and its
 * tests — do not have to care about the six other fields the panel renders.
 */
export interface PayerPayment {
  customerId: string;
  customerName: string;
  amountCents: Cents;
}

/**
 * The month's payments grouped into the people who made them.
 *
 * One row per customer, because the tile above this panel counts CUSTOMERS: a
 * panel that opened into forty payments under a figure reading "23" would not
 * be the same question in more detail, it would be a different question, and
 * the reader would be left to work out which of the two numbers is wrong.
 *
 * Ranked by money, like every other list on this screen that ranks people, with
 * the name as the tie-break so the order is stable between refreshes rather
 * than following whatever order the rows arrived in.
 */
export function groupPayers<T extends PayerPayment>(payments: readonly T[]): Array<Payer<T>> {
  const byCustomer = new Map<string, Payer<T>>();

  for (const payment of payments) {
    const existing = byCustomer.get(payment.customerId);

    if (existing) {
      existing.totalCents = (existing.totalCents + payment.amountCents) as Cents;
      existing.rows.push(payment);
      continue;
    }

    byCustomer.set(payment.customerId, {
      customerId: payment.customerId,
      customerName: payment.customerName,
      totalCents: payment.amountCents,
      rows: [payment],
    });
  }

  return [...byCustomer.values()].sort(
    (a, b) => b.totalCents - a.totalCents || a.customerName.localeCompare(b.customerName, "es"),
  );
}

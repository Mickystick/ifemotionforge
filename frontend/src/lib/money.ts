/**
 * Money handling for Lindero.
 *
 * RULE: money is ALWAYS stored and passed around as whole centavos (integers).
 * Never as 185000.50 floating-point. Floating point cannot represent decimal
 * money exactly: in JavaScript, 0.1 + 0.2 === 0.30000000000000004. Over
 * thousands of payments those errors accumulate into balances that do not match
 * what the customer actually paid.
 *
 * So: L. 185,000.00 is stored as the integer 18500000.
 */

/**
 * `Cents` is a "branded type". At runtime it is just a number, but TypeScript
 * treats it as its own type, so it becomes a compile error to accidentally pass
 * a raw price like `185000` where centavos are expected. You must go through
 * `cents()` or `fromCurrencyUnits()`, which forces you to think about the unit.
 */
declare const centsBrand: unique symbol;
export type Cents = number & { readonly [centsBrand]: true };

/** Wrap an integer number of centavos as `Cents`. */
export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new Error(`Money must be a whole number of centavos, received ${value}`);
  }
  return value as Cents;
}

/** Convert a human amount (185000.50 lempiras) into `Cents` (18500050). */
export function fromCurrencyUnits(value: number): Cents {
  return cents(Math.round(value * 100));
}

export type Currency = "HNL" | "USD";

/**
 * The lempira-per-dollar rate to fall back on before the server has told us
 * one — the first paint, or an unreachable API. The real value comes from
 * GET /api/exchange-rate and is maintained by the market feed or by a
 * supervisor.
 */
export const FALLBACK_USD_RATE = 24.7;

/**
 * How money should be displayed right now: which currency the user picked, and
 * the rate to use if that currency is dollars.
 *
 * The two travel together, as one prop, on purpose. When they were separate,
 * adding the rate meant remembering to thread it into every component that
 * formats money, and the one that was forgotten would keep converting at a
 * stale rate with nothing to show it was wrong.
 *
 * The rate is DISPLAY ONLY. It converts figures on screen so a buyer can be
 * told roughly what a lot costs in dollars. Balances are never computed from
 * it: each payment stores the rate it was actually settled at.
 */
export interface MoneyView {
  currency: Currency;
  /** Lempiras per one US dollar. */
  usdRate: number;
}

const hnlFormat = new Intl.NumberFormat("en-HN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

// USD here is an estimate, so we show whole dollars and no misleading precision.
const usdFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format centavos for display. `currency` is the currency the USER chose to
 * view in, not the currency the amount is stored in (amounts are stored in
 * lempira centavos for now).
 */
export function formatMoney(amount: Cents, view: MoneyView): string {
  const lempiras = amount / 100;

  if (view.currency === "USD") {
    return `$ ${usdFormat.format(lempiras / view.usdRate)}`;
  }

  return `L. ${hnlFormat.format(lempiras)}`;
}

const documentFormat = new Intl.NumberFormat("en-HN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Money as a DOCUMENT states it: always two decimals.
 *
 * `formatMoney` above drops trailing zeros, which is right on a screen full of
 * figures and wrong on a receipt. "L. 5,000" sitting above "L. 5,000.50" reads
 * as two different kinds of number, and a printed amount with no centavos looks
 * like one somebody forgot to finish. Two decimals is also what the official
 * receipt has always printed, so this is what matches the paper already in
 * customers' hands.
 *
 * Dollars are left to `formatMoney`, which deliberately shows no cents: that
 * figure is a conversion at today's rate, not an amount anybody handed over,
 * and decimals on it would claim a precision it does not have.
 */
export function formatDocumentMoney(amount: Cents, view: MoneyView): string {
  if (view.currency === "USD") {
    return formatMoney(amount, view);
  }

  return `L. ${documentFormat.format(amount / 100)}`;
}

/**
 * Same as `formatMoney`, but returns the currency symbol and the number
 * separately so the UI can style them differently — Lindero tints the symbol
 * and keeps the digits in full-strength ink, which makes columns of money much
 * easier to scan.
 */
export function formatMoneyParts(
  amount: Cents,
  view: MoneyView,
): { symbol: string; value: string } {
  const lempiras = amount / 100;

  if (view.currency === "USD") {
    return { symbol: "$", value: usdFormat.format(lempiras / view.usdRate) };
  }

  return { symbol: "L.", value: hnlFormat.format(lempiras) };
}

/**
 * Subtract money safely. Both sides are whole centavos, so the result is too —
 * this exists mainly so balance arithmetic reads clearly at the call site and
 * stays inside the `Cents` type instead of silently becoming a plain number.
 */
export function subtractMoney(minuend: Cents, subtrahend: Cents): Cents {
  return cents(minuend - subtrahend);
}

const rateFormat = new Intl.NumberFormat("en-HN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** "26.8226" — the rate itself, not an amount of money. */
export function formatRate(rate: number): string {
  return rateFormat.format(rate);
}

/* -------------------------------------------------------------------------- */
/* Typing money in                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Money is typed into a TEXT field, not a number field, so it can carry
 * thousand separators while you type: "1750000" and "175000" are genuinely hard
 * to tell apart, and "1,750,000" and "175,000" are not. A native number input
 * cannot show separators at all, which is why these helpers exist.
 *
 * The functions below work on the raw string the user is typing. Nothing is
 * rounded or converted until the form submits.
 */

const groupFormat = new Intl.NumberFormat("en-HN", { maximumFractionDigits: 0 });

/**
 * Add thousand separators to what the user has typed so far, leaving the
 * decimal part alone.
 *
 * Formatting mid-typing has to be forgiving: a trailing "." in "1750." is a
 * user who is not finished, not an error, so it is preserved rather than
 * cleaned away under their cursor. Everything that is not a digit or a dot is
 * dropped, which is what makes a pasted "L. 1,750,000.00" work.
 *
 * Only the LAST dot can be the decimal point — earlier ones are always noise,
 * like the dot in a pasted "L.". Taking the first one instead would read
 * "L. 175,000.50" as 0.17, and simply dropping every leading dot would read a
 * typed ".50" as 50. Both are silent ten-thousand-fold errors in a price.
 */
function formatDecimalInput(raw: string, maxDecimals: number): string {
  const cleaned = raw.replace(/[^\d.]/g, "");

  if (cleaned === "") {
    return "";
  }

  const lastDot = cleaned.lastIndexOf(".");
  const whole = (lastDot === -1 ? cleaned : cleaned.slice(0, lastDot)).replace(/\./g, "");
  const decimals =
    lastDot === -1 ? "" : cleaned.slice(lastDot + 1).replace(/\./g, "").slice(0, maxDecimals);
  const grouped = whole === "" ? "" : groupFormat.format(Number(whole));

  if (lastDot === -1) {
    return grouped;
  }

  return `${grouped}.${decimals}`;
}

export function formatMoneyInput(raw: string): string {
  return formatDecimalInput(raw, 2);
}

/**
 * The same, for an exchange rate rather than an amount.
 *
 * A rate needs more than two decimals: the market feed quotes 26.822577, and
 * rounding that to 26.82 while showing it back as "the current rate" would let
 * a supervisor who only opened the popover to look at it save a quietly
 * different number. Centavos stop at two decimals; a rate does not.
 */
export function formatRateInput(raw: string): string {
  return formatDecimalInput(raw, 4);
}

/** The number behind a formatted input, or `NaN` if there is nothing usable. */
export function parseMoneyInput(formatted: string): number {
  const cleaned = formatted.replace(/,/g, "").trim();
  return cleaned === "" ? Number.NaN : Number(cleaned);
}

/** Fill an edit field from stored centavos, with separators already in place. */
export function toMoneyInput(amount: Cents): string {
  return formatMoneyInput((amount / 100).toFixed(2));
}

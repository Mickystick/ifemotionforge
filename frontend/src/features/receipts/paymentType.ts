/**
 * What KIND of money a payment is, and what kind this one probably is.
 *
 * The four types have always existed on a payment, but until now the only
 * place they were visible was "Corregir transacción" — so the type was
 * something you discovered by editing a payment you had already recorded.
 * "Nueva transacción" picked one silently and never said which. That is the
 * wrong way round: the person at the window knows whether the customer is
 * settling the prima or paying a cuota, and they know it BEFORE the money is
 * posted, not after.
 *
 * Split out of `NewReceiptDialog` so the rule can be tested directly, the way
 * `receiptBlocker` was.
 */

/** The four kinds a posted payment can be. Matches the backend's PAYMENT_TYPES. */
export type PaymentType = "down_payment" | "installment" | "full_payment" | "adjustment";

/**
 * The same words, in the same order, as the picker in "Corregir transacción".
 *
 * Deliberately one list for both screens: a payment recorded as "Prima" and a
 * payment corrected to "Prima" have to be the same thing, and two lists drift.
 */
export const PAYMENT_TYPE_OPTIONS: Array<{ value: PaymentType; label: string }> = [
  { value: "down_payment", label: "Down payment" },
  { value: "installment", label: "Installment" },
  { value: "full_payment", label: "Full payment" },
  { value: "adjustment", label: "Adjustment" },
];

/**
 * What to call one on screen.
 *
 * Takes a plain `string` rather than a `PaymentType` because that is what a
 * posted transaction carries: `Transaction.type` comes off the wire and the
 * schema allows a fifth value, `reversal`. Falling back to the stored word
 * keeps a row the frontend has never heard of readable instead of blank —
 * blank is what makes somebody think the payment has no type at all.
 */
export function paymentTypeLabel(type: string): string {
  return PAYMENT_TYPE_OPTIONS.find((entry) => entry.value === type)?.label ?? type;
}

/** Just enough of a contract to decide, so tests need no fixtures. */
export interface TypeableContract {
  saleType: "financed" | "cash" | "donation";
  terms: { downPayment: number };
  /** Summed from payments already recorded as `down_payment`. */
  downPaymentPaid: number;
}

/**
 * How much of the agreed prima has still not arrived. Zero once it is settled.
 *
 * Floored at zero: a customer who handed over more than the agreed prima has
 * not created a negative one.
 */
export function outstandingDownPayment(contract: TypeableContract): number {
  return Math.max(0, contract.terms.downPayment - contract.downPaymentPaid);
}

/**
 * The type this payment is most likely to be, from the contract alone.
 *
 * Deliberately NOT from the amount being typed. A suggestion that re-decides
 * itself while somebody is typing into the field next to it is a control that
 * cannot be trusted — you look away to count the cash and it has changed its
 * mind. This depends only on the contract, so it is settled the moment the
 * customer is chosen and stays put until the user changes it by hand.
 *
 * The order matters:
 *
 *  1. The prima is its own kind of money. It is the term of the contract the
 *     customer is settling, not one of the cuotas that follow it — and it is
 *     what `downPaymentPaid` is summed from, so getting this wrong is what
 *     makes a contract look like its prima was never paid.
 *  2. A contract that is not financed has no schedule to have cuotas in — a
 *     cash sale is settled at signing. Calling its payment a "cuota" names an
 *     installment that does not exist anywhere in the contract.
 *  3. Everything else is a cuota, which is the overwhelming majority of the
 *     money this business takes.
 */
export function suggestPaymentType(contract: TypeableContract): PaymentType {
  if (outstandingDownPayment(contract) > 0) {
    return "down_payment";
  }

  if (contract.saleType !== "financed") {
    return "full_payment";
  }

  return "installment";
}

/**
 * The one type a set of lots is all on, or `null` when they are not.
 *
 * What the "Tipo" field at the top of "Nueva transacción" displays. That field
 * is a READING of the lines below rather than a setting of its own, and this is
 * the rule that keeps it honest: a control showing "Cuota" while one of the
 * lines filed a prima would be wrong in the field `downPaymentPaid` is summed
 * from, silently and for the life of the contract.
 *
 * `null` — rendered as "Varios" — is the truthful answer for a customer
 * settling the prima on the lot they bought last month while paying a cuota on
 * the first. An empty list has no shared answer to give either.
 */
export function sharedPaymentType(types: readonly PaymentType[]): PaymentType | null {
  const [first, ...rest] = types;

  if (first === undefined) {
    return null;
  }

  return rest.every((type) => type === first) ? first : null;
}

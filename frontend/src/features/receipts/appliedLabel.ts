import type { ReceiptLine } from "../../types";

/** Everything the label below reads. A whole `ReceiptLine` is more than it needs. */
export type AppliedLabelLine = Pick<ReceiptLine, "appliedTo" | "installmentCount">;

/**
 * "cuota 7 de 24" — one cuota, always.
 *
 * The single most useful line on the document: "recibí L 5,000" is a number,
 * "cuota 7 de 24" is an answer.
 *
 * ONE cuota even when the money technically touched two. A payment covers a
 * RANGE of the schedule, and that range routinely clips the next cuota by a few
 * centavos: `splitEvenly` hands the odd centavo of an uneven division to one
 * contract (and older payments were rounded to whole hundreds), so a customer
 * paying on a sale group ends up a few centavos past every cuota boundary for
 * the rest of the term.
 * This line once read "cuotas 4 y 5 de 12" on the strength of THREE CENTAVOS
 * landing in cuota 5 — naming a cuota the customer had not started paying,
 * because of a rounding crumb left by a payment months earlier.
 *
 * A threshold ("ignore slivers under a lempira") would have needed a number
 * nobody could justify. Naming the cuota that took the MOST of this money needs
 * none, and answers the question the customer is actually asking. A tie — a
 * payment split exactly across two cuotas — keeps the earlier one, which is the
 * one being caught up on.
 *
 * Deliberately just the position. `appliedTo` also carries `settled`, and this
 * line used to mark an unfinished cuota "(parcial)" and print the lot's own
 * `saldo antes → después` beside it — accurate, and more than the line could
 * carry. What a customer wants from a receipt is how far through the schedule
 * they are; how much is left is the boxed figure at the bottom, and the size of
 * a cuota is that figure over the cuotas still to come. The extra clauses were
 * qualifying an answer nobody had asked for yet.
 *
 * The consequence, stated because it is a real one: on a receipt covering
 * several lots, the per-lot balances are no longer on the paper. The summary's
 * "Balance Anterior" and "Nuevo Balance Pendiente" are the total across the
 * lots on the receipt, so a three-lot customer reads one combined figure rather
 * than three. Every per-lot balance is still derived and still on the screen —
 * see the Contratos tab — it just is not printed here.
 */
export function appliedLabel(line: AppliedLabelLine): string | null {
  if (line.appliedTo.length === 0) {
    return null;
  }

  // Strictly greater, so an exact tie keeps the earlier cuota: `appliedTo`
  // arrives in schedule order.
  const principal = line.appliedTo.reduce((best, installment) =>
    installment.applied > best.applied ? installment : best,
  );

  // "de 24" only when we know the total. A cash sale has no schedule, and
  // "cuota 3 de 0" is worse than saying nothing.
  const total = line.installmentCount > 0 ? ` de ${line.installmentCount}` : "";

  return `Installment ${principal.number}${total ? ` of ${line.installmentCount}` : ""}`;
}

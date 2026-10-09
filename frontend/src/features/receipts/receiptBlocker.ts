/**
 * What stops a receipt draft from being issued, and which field fixes it.
 *
 * Split out of `NewReceiptDialog` so the rule can be tested directly. The
 * question it answers is the one the form used to answer by going quiet: the
 * submit button was `disabled` whenever the draft was incomplete, which looked
 * tidy and told the user nothing. Somebody who picks a customer, forgets the
 * monto and presses "Registrar y emitir recibo" got no response at all — and a
 * dead button is indistinguishable from a frozen page, or from a receipt that
 * saved without saying so.
 */

import { parseMoneyInput } from "../../lib/money";

/** Just enough of a payable contract to decide, so tests need no fixtures. */
export interface BlockerContract {
  id: string;
}

export interface BlockerInput {
  customerId: string;
  /** Active contracts for the chosen customer — what money can be put on. */
  payable: BlockerContract[];
  /** How many lines the draft actually produced (amount typed and above zero). */
  lineCount: number;
  /**
   * The raw text in each lot's "Recibe" field, by contract id.
   *
   * Only populated with several lots. One lot has no per-lot field at all —
   * `amountText` is that lot's amount, and there is nothing for it to disagree
   * with.
   */
  amountByContract: Record<string, string>;
  /** The raw text in "Monto": the whole payment, for one lot or for five. */
  amountText: string;
}

export interface Blocker {
  /** Said to the user, in full sentences. */
  message: string;
  /** The DOM id of the field that fixes it, so the caret can be put there. */
  focus: string;
}

export const CUSTOMER_FIELD = "receipt-customer";
export const AMOUNT_FIELD = "receipt-amount";

/** The DOM id `NewReceiptDialog` gives one lot's amount input. */
export function amountFieldId(contractId: string): string {
  return `receipt-amount-${contractId}`;
}

/**
 * `null` when the draft is ready to submit.
 *
 * Ordered from the top of the form down, so a draft missing several things
 * names the one the user would reach first rather than the last one checked.
 */
export function receiptBlocker(input: BlockerInput): Blocker | null {
  const { customerId, payable, lineCount, amountByContract, amountText } = input;

  if (customerId === "") {
    return { message: "Select the customer making the payment.", focus: CUSTOMER_FIELD };
  }

  if (payable.length === 0) {
    return {
      message:
        "This customer has no contracts that can accept payments.",
      focus: CUSTOMER_FIELD,
    };
  }

  if (lineCount > 0) {
    return null;
  }

  const isMultiLot = payable.length > 1;

  if (amountText.trim() === "") {
    return { message: "Enter the payment amount.", focus: AMOUNT_FIELD };
  }

  // Typed, but nothing a receipt can be made of — a lone "0", or a field
  // cleared back to a stray separator. Checked before the split, because a
  // zero at the top is not a distribution problem and saying "falta repartir"
  // would send somebody to press a button that cannot help them.
  const typed = parseMoneyInput(amountText);

  if (Number.isNaN(typed) || typed <= 0) {
    return { message: "The amount must be greater than zero.", focus: AMOUNT_FIELD };
  }

  // From here the amount is real, so with one lot there would already be a
  // line: anything left is about the division.
  const firstAmount = amountFieldId(payable[0]!.id);

  if (payable.some((contract) => (amountByContract[contract.id] ?? "").trim() !== "")) {
    return {
      message: "No amount is assigned to any lot. Enter an amount for at least one lot.",
      focus: firstAmount,
    };
  }

  // The amount is filled in but never divided, so every line is still empty.
  // Worth its own sentence: the form looks complete from across the counter,
  // and the fix is one button away.
  if (isMultiLot) {
    return {
      message:
        "The amount has not been split. Select “Split amount between lots” or enter an amount for each lot.",
      focus: firstAmount,
    };
  }

  /* One lot, a positive amount and still no line is not reachable through the
     form — it would mean `lines` and this disagreed about the same figure. Say
     something true rather than nothing. */
  return { message: "Enter the payment amount.", focus: AMOUNT_FIELD };
}

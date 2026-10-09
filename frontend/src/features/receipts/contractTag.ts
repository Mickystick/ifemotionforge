import type { Transaction } from "../../types";

/** Which side of an adenda a payment sits on. */
export type ContractTagSide = "adenda" | "replaced";

export interface ContractTag {
  side: ContractTagSide;
  /** The contract the money actually landed on — "CT-2026-011-A1". */
  code: string;
  /** What the code cannot say by itself: where this contract came from, or went. */
  title: string;
}

/**
 * The tag that says which contract a payment belongs to — but only when that
 * takes saying.
 *
 * Most lots have one contract for their whole life, and a code repeated on
 * every row of a list of sixty would be noise beside the lot and project the
 * row already names. The code earns its place when a lot has TWO, which is what
 * an adenda makes: the money paid before it stays on the old contract, the
 * money after lands on the new one, and the two rows otherwise look identical.
 *
 * - `adenda`: the payment is on the contract an adenda wrote. Identified by the
 *   link the server sends (`replacesContractCode`), not by the "-A1" in the
 *   code, which is a display convention and not a fact.
 * - `replaced`: the payment is on the contract an adenda closed. Read from the
 *   contract's status as it is NOW, so money paid while it was still active
 *   shows here once an adenda later closes it — same as the per-customer
 *   breakdown.
 *
 * A contract in the middle of a chain (A1 once A2 replaced it) is `adenda`:
 * it came from another contract, which is the more useful thing to say.
 */
export function contractTag(transaction: Transaction): ContractTag | null {
  if (transaction.replacesContractCode !== null) {
    return {
      side: "adenda",
      code: transaction.contractCode,
      title: `Amendment to ${transaction.replacesContractCode}: this payment is under the new contract`,
    };
  }

  if (transaction.contractStatus === "replaced") {
    return {
      side: "replaced",
      code: transaction.contractCode,
      title: "Contract replaced by an amendment: this payment predates it",
    };
  }

  return null;
}

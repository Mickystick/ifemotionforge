import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appliedLabel } from "../src/features/receipts/appliedLabel";
import type { AppliedLabelLine } from "../src/features/receipts/appliedLabel";
import { cents } from "../src/lib/money";

/*
 * The one line on a printed receipt that answers "where am I in the schedule?".
 *
 * Pinned because it went wrong in production and the wrongness was plausible: a
 * receipt for a single L 25,000 cuota read "cuotas 4 y 5 de 12", which a
 * customer reads as being two cuotas further along than they are. The cause was
 * three centavos of the payment landing in cuota 5, left over from `splitEvenly`
 * rounding a sale-group share down to a whole L 100 months earlier.
 */

function line(
  applied: Array<[number, number]>,
  installmentCount = 12,
): AppliedLabelLine {
  return {
    installmentCount,
    appliedTo: applied.map(([number, amount]) => ({
      number,
      dueOn: "2026-08-18",
      applied: cents(amount),
      settled: false,
    })),
  };
}

describe("appliedLabel", () => {
  it("names the cuota a plain payment went to", () => {
    assert.equal(appliedLabel(line([[4, 2_500_000]])), "Installment 4 of 12");
  });

  it("ignores a rounding crumb in the next cuota", () => {
    // The production receipt: L 24,999.97 of cuota 4 and three centavos of
    // cuota 5. It used to read "cuotas 4 y 5 de 12".
    assert.equal(appliedLabel(line([[4, 2_499_997], [5, 3]])), "Installment 4 of 12");
  });

  it("names the cuota that took the most when a payment covers two", () => {
    // Mostly cuota 5: the customer was a hundred lempiras short on 4.
    assert.equal(appliedLabel(line([[4, 10_000], [5, 2_490_000]])), "Installment 5 of 12");
  });

  it("keeps the earlier cuota when a payment splits exactly across two", () => {
    // The one being caught up on is the one worth naming.
    assert.equal(appliedLabel(line([[4, 2_500_000], [5, 2_500_000]])), "Installment 4 of 12");
  });

  it("names the cuota a partial payment went towards", () => {
    assert.equal(appliedLabel(line([[4, 500_000]])), "Installment 4 of 12");
  });

  it("drops the total when the contract has no schedule", () => {
    // A cash sale: "cuota 1 de 0" would be worse than no total at all.
    assert.equal(appliedLabel(line([[1, 2_500_000]], 0)), "Installment 1");
  });

  it("says nothing when the money went to no cuota at all", () => {
    // A prima, or a payment on a contract with no schedule to place it in.
    assert.equal(appliedLabel(line([])), null);
  });
});

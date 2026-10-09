import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PAYMENT_TYPE_OPTIONS,
  outstandingDownPayment,
  paymentTypeLabel,
  sharedPaymentType,
  suggestPaymentType,
} from "../src/features/receipts/paymentType";

/*
 * The rule behind the Tipo the receipt form fills in for you.
 *
 * Worth pinning because it is a default nobody looks at: the whole point of
 * the column is that in the ordinary case the user reads "Cuota", agrees, and
 * moves on. A wrong default that nobody notices is a contract whose prima
 * reads as unpaid for the rest of its life — `downPaymentPaid` is summed from
 * exactly this field.
 */

/** A financed contract with the prima agreed at L 25,000 and none of it paid. */
const financed = {
  saleType: "financed" as const,
  terms: { downPayment: 2_500_000 },
  downPaymentPaid: 0,
};

describe("suggestPaymentType", () => {
  it("calls it a prima while any of the prima is still owed", () => {
    assert.equal(suggestPaymentType(financed), "down_payment");
  });

  it("still calls it a prima when only part of it has arrived", () => {
    assert.equal(
      suggestPaymentType({ ...financed, downPaymentPaid: 2_499_900 }),
      "down_payment",
    );
  });

  it("moves to cuota the moment the prima is settled", () => {
    assert.equal(suggestPaymentType({ ...financed, downPaymentPaid: 2_500_000 }), "installment");
  });

  it("treats an overpaid prima as settled rather than as owing a negative", () => {
    assert.equal(suggestPaymentType({ ...financed, downPaymentPaid: 3_000_000 }), "installment");
  });

  it("calls it a cuota when the contract agreed no prima at all", () => {
    assert.equal(
      suggestPaymentType({ ...financed, terms: { downPayment: 0 } }),
      "installment",
    );
  });

  /*
   * A cash sale is settled at signing and has no schedule, so it has no cuotas
   * to be one of — see buildSchedule in the backend. "Cuota" there names an
   * installment that exists nowhere in the contract.
   */
  it("calls a payment on a contract with no schedule a pago total", () => {
    assert.equal(
      suggestPaymentType({ ...financed, saleType: "cash", terms: { downPayment: 0 } }),
      "full_payment",
    );
  });

  it("puts the prima ahead of the sale type when one was agreed and is unpaid", () => {
    assert.equal(suggestPaymentType({ ...financed, saleType: "cash" }), "down_payment");
  });
});

describe("outstandingDownPayment", () => {
  it("is what is left of the agreed prima", () => {
    assert.equal(outstandingDownPayment({ ...financed, downPaymentPaid: 1_000_000 }), 1_500_000);
  });

  it("is zero, never negative, once more than the prima has been paid", () => {
    assert.equal(outstandingDownPayment({ ...financed, downPaymentPaid: 3_000_000 }), 0);
  });
});

describe("PAYMENT_TYPE_OPTIONS", () => {
  /* The picker in "Corregir transacción" offers these four, in this order. A
     type recordable here but not correctable there would be a trap. */
  it("offers the same four types the correction dialog does", () => {
    assert.deepEqual(
      PAYMENT_TYPE_OPTIONS.map((entry) => entry.value),
      ["down_payment", "installment", "full_payment", "adjustment"],
    );
  });
});

describe("paymentTypeLabel", () => {
  it("names the four the form can record", () => {
    assert.equal(paymentTypeLabel("down_payment"), "Down payment");
    assert.equal(paymentTypeLabel("installment"), "Installment");
  });

  /* `Transaction.type` is a plain string off the wire and the schema allows a
     fifth value. A blank chip would read as "this payment has no type". */
  it("shows the stored word for a type it has never heard of", () => {
    assert.equal(paymentTypeLabel("reversal"), "reversal");
  });
});

/*
 * What the "Tipo" field at the top of "Nueva transacción" is allowed to say.
 *
 * The field sits in the top grid for a receipt of one lot or of five, which it
 * can only do because it reads the lines rather than deciding for them. The
 * case that matters is the last one: with lots on different types there is no
 * single true answer, and inventing one would file a prima as a cuota in the
 * field `downPaymentPaid` is summed from.
 */
describe("sharedPaymentType", () => {
  it("gives the type when a single lot is the whole receipt", () => {
    assert.equal(sharedPaymentType(["down_payment"]), "down_payment");
  });

  it("gives the type when every lot is on it", () => {
    assert.equal(sharedPaymentType(["installment", "installment", "installment"]), "installment");
  });

  it("refuses to name one when the lots disagree", () => {
    // The receipt this whole feature exists for: a prima on the lot bought
    // last month, a cuota on the first. The field shows "Varios".
    assert.equal(sharedPaymentType(["down_payment", "installment"]), null);
  });

  it("refuses on a disagreement anywhere in the list, not just the front", () => {
    assert.equal(sharedPaymentType(["installment", "installment", "adjustment"]), null);
  });

  it("has no answer for no lots at all", () => {
    // No customer chosen yet. The form supplies its own opening default.
    assert.equal(sharedPaymentType([]), null);
  });
});

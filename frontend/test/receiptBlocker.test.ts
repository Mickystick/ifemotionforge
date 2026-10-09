import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AMOUNT_FIELD,
  CUSTOMER_FIELD,
  amountFieldId,
  receiptBlocker,
} from "../src/features/receipts/receiptBlocker";

/*
 * The rule behind the notice on "Registrar y emitir recibo".
 *
 * Worth pinning because the failure it replaced was silent: an incomplete
 * draft used to disable the button and say nothing, so the form being wrong
 * was invisible to a test AND to the user. Every case below is a sentence
 * somebody at the window needs to read.
 */

const ONE_LOT = [{ id: "c1" }];
const THREE_LOTS = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];

/**
 * A draft that is ready to go, so each test can spoil exactly one thing.
 *
 * One lot, so `amountByContract` is empty: the "Recibe" column only exists
 * when there are several lots to divide between, and the Monto at the top of
 * the form is that single lot's amount.
 */
const ready = {
  customerId: "cust-1",
  payable: ONE_LOT,
  lineCount: 1,
  amountByContract: {},
  amountText: "5,000",
};

describe("receiptBlocker", () => {
  it("lets a complete draft through", () => {
    assert.equal(receiptBlocker(ready), null);
  });

  it("asks for the customer first, before anything else is knowable", () => {
    const blocker = receiptBlocker({ ...ready, customerId: "", payable: [], lineCount: 0 });

    assert.equal(blocker?.focus, CUSTOMER_FIELD);
    assert.match(blocker!.message, /customer/i);
  });

  it("names the missing monto, and points at the field that takes it", () => {
    const blocker = receiptBlocker({ ...ready, lineCount: 0, amountText: "" });

    assert.equal(blocker?.focus, AMOUNT_FIELD);
    assert.match(blocker!.message, /payment amount/i);
  });

  it("says a typed zero is not an amount, rather than repeating 'falta el monto'", () => {
    const blocker = receiptBlocker({ ...ready, lineCount: 0, amountText: "0" });

    assert.match(blocker!.message, /greater than zero/i);
    assert.equal(blocker?.focus, AMOUNT_FIELD);
  });

  it("treats whitespace as nothing typed at all", () => {
    const blocker = receiptBlocker({ ...ready, lineCount: 0, amountText: "   " });

    assert.match(blocker!.message, /enter the payment amount/i);
  });

  it("tells a customer with no payable contracts apart from one with no monto", () => {
    const blocker = receiptBlocker({ ...ready, payable: [], lineCount: 0 });

    assert.equal(blocker?.focus, CUSTOMER_FIELD);
    assert.match(blocker!.message, /no contracts/i);
  });

  describe("several lots", () => {
    it("sends an empty form to the monto, which is the fast path", () => {
      const blocker = receiptBlocker({
        ...ready,
        payable: THREE_LOTS,
        lineCount: 0,
        amountText: "",
      });

      assert.equal(blocker?.focus, AMOUNT_FIELD);
    });

    it("catches a monto that was typed but never distributed", () => {
      const blocker = receiptBlocker({
        ...ready,
        payable: THREE_LOTS,
        lineCount: 0,
        amountText: "25,000",
      });

      assert.match(blocker!.message, /has not been split/i);
      assert.equal(blocker?.focus, amountFieldId("c1"));
    });

    /* A zero at the top is not a distribution problem, and "falta repartir"
       would send somebody to press a button that cannot help them. */
    it("blames the monto, not the split, when the monto itself is zero", () => {
      const blocker = receiptBlocker({
        ...ready,
        payable: THREE_LOTS,
        lineCount: 0,
        amountText: "0",
      });

      assert.match(blocker!.message, /greater than zero/i);
      assert.equal(blocker?.focus, AMOUNT_FIELD);
    });

    it("is satisfied by one lot receiving money, not all of them", () => {
      assert.equal(
        receiptBlocker({
          ...ready,
          payable: THREE_LOTS,
          lineCount: 1,
          amountText: "25,000",
          amountByContract: { c2: "5,000" },
        }),
        null,
      );
    });

    it("reports a split that leaves every lot at zero", () => {
      const blocker = receiptBlocker({
        ...ready,
        payable: THREE_LOTS,
        lineCount: 0,
        amountText: "25,000",
        amountByContract: { c3: "0" },
      });

      assert.match(blocker!.message, /No amount is assigned to any lot/i);
      assert.equal(blocker?.focus, amountFieldId("c1"));
    });
  });
});

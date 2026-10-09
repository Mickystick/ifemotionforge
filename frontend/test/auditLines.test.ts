import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatAuditLine, formatAuditList } from "../src/features/audit/auditLines";
import type { MoneyView } from "../src/lib/money";
import { cents, formatMoney } from "../src/lib/money";

/*
 * What the Historial prints for the lines of a receipt.
 *
 * A void restates the whole receipt, and the lines are a list of objects — which
 * the screen used to print as "[object Object]". These pin that every part a
 * person would read survives, and that nothing unrecognised is swallowed.
 */

const money: MoneyView = { currency: "HNL", usdRate: 24.6 };

/** An amount the way the screen writes it — asked of `formatMoney`, not retyped here. */
const l = (amountCents: number) => formatMoney(cents(amountCents), money);

describe("formatAuditLine", () => {
  it("says the lot, the contract, the kind of money and the amount", () => {
    assert.equal(
      formatAuditLine(
        { lotCode: "A-07", contractCode: "CT-2026-004", type: "installment", amountCents: 500_000 },
        money,
      ),
      `A-07 · CT-2026-004 · Installment · ${l(500_000)}`,
    );
  });

  it("reads a redistribution's line, which has no lot code", () => {
    assert.equal(
      formatAuditLine(
        { paymentId: "p1", contractId: "k1", contractCode: "CT-2026-004", type: "down_payment", amountCents: 1_000_000 },
        money,
      ),
      `CT-2026-004 · Down payment · ${l(1_000_000)}`,
    );
  });

  it("keeps a lot that has lost its contract code rather than dropping the line", () => {
    assert.equal(
      formatAuditLine({ lotCode: "A-07", contractCode: null, type: "installment", amountCents: 500_000 }, money),
      `A-07 · Installment · ${l(500_000)}`,
    );
  });

  it("shows an unrecognised object as it is, and a bare value as itself", () => {
    assert.equal(formatAuditLine({ something: "else" }, money), '{"something":"else"}');
    // An older void listed the ids of the payments it reversed.
    assert.equal(formatAuditLine("5f0c-uuid", money), "5f0c-uuid");
    assert.equal(formatAuditLine(null, money), "null");
  });
});

describe("formatAuditList", () => {
  it("puts every line of a receipt on one string, in order", () => {
    assert.equal(
      formatAuditList(
        [
          { lotCode: "A-07", contractCode: "CT-1", type: "down_payment", amountCents: 1_000_000 },
          { lotCode: "B-02", contractCode: "CT-2", type: "installment", amountCents: 250_000 },
        ],
        money,
      ),
      `A-07 · CT-1 · Down payment · ${l(1_000_000)}; B-02 · CT-2 · Installment · ${l(250_000)}`,
    );
  });

  it("is empty for a list with nothing in it", () => {
    assert.equal(formatAuditList([], money), "");
  });
});

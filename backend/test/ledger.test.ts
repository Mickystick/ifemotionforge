import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LedgerCharge, LedgerCredit } from "../src/lib/ledger.js";
import {
  compareLedgerOrder,
  orderLedger,
  receiptFigures,
  replayContract,
} from "../src/lib/ledger.js";
import {
  allocateReceiptCode,
  RECEIPT_CODE_PATTERN,
  generateLookupCode,
  nextReceiptNumber,
  normalizeLookupCode,
  toStoredLookupCode,
} from "../src/lib/receipts.js";

/** L 1 = 100 centavos, as everywhere else in the app. */
const lempiras = (amount: number) => Math.round(amount * 100);

interface TestCredit extends LedgerCredit {
  contractId: string;
}

/** A payment, with the boilerplate the ledger does not care about filled in. */
function credit(overrides: Partial<TestCredit> & { id: string; paidOn: string }): TestCredit {
  return {
    contractId: "contract-1",
    amountCents: lempiras(5_000),
    // Application-written rows carry a full ISO instant; see src/lib/time.ts.
    createdAt: `${overrides.paidOn}T12:00:00.000Z`,
    reversedAt: null,
    ...overrides,
  };
}

describe("ledger order", () => {
  it("orders by the date the money moved, not the date it was typed in", () => {
    // The February payment was entered LAST, months late. It still belongs in
    // February — that is the whole point of recording `paidOn` separately.
    const entered = [
      credit({ id: "a", paidOn: "2026-01-15", createdAt: "2026-01-15T09:00:00.000Z" }),
      credit({ id: "c", paidOn: "2026-03-15", createdAt: "2026-03-15T09:00:00.000Z" }),
      credit({ id: "b", paidOn: "2026-02-15", createdAt: "2026-04-02T16:30:00.000Z" }),
    ];

    assert.deepEqual(
      orderLedger(entered).map((entry) => entry.id),
      ["a", "b", "c"],
    );
  });

  it("breaks a same-day tie by when each was entered", () => {
    const morning = credit({ id: "b", paidOn: "2026-01-15", createdAt: "2026-01-15T09:00:00.000Z" });
    const evening = credit({ id: "a", paidOn: "2026-01-15", createdAt: "2026-01-15T18:00:00.000Z" });

    assert.deepEqual(
      orderLedger([evening, morning]).map((entry) => entry.id),
      ["b", "a"],
    );
  });

  it("compares SQLite's timestamp format against the application's correctly", () => {
    // A row written by the CURRENT_TIMESTAMP default says "2026-01-15 09:00:00"
    // and a row written by the app says "2026-01-15T18:00:00.000Z". Compared as
    // plain strings the space sorts before the T, which would put every
    // default-written row first regardless of its actual time. Here the earlier
    // instant must win on the merits, not on punctuation.
    const sqliteMorning = credit({
      id: "b",
      paidOn: "2026-01-15",
      createdAt: "2026-01-15 09:00:00",
    });
    const appEvening = credit({
      id: "a",
      paidOn: "2026-01-15",
      createdAt: "2026-01-15T18:00:00.000Z",
    });

    assert.ok(compareLedgerOrder(sqliteMorning, appEvening) < 0);

    // And the other way round: the SQLite row is genuinely later this time.
    const sqliteEvening = credit({
      id: "b",
      paidOn: "2026-01-15",
      createdAt: "2026-01-15 20:00:00",
    });

    assert.ok(compareLedgerOrder(sqliteEvening, appEvening) > 0);
  });

  it("falls back to the id so the order can never be ambiguous", () => {
    const first = credit({ id: "aaa", paidOn: "2026-01-15", createdAt: "2026-01-15 09:00:00" });
    const second = credit({ id: "bbb", paidOn: "2026-01-15", createdAt: "2026-01-15 09:00:00" });

    assert.ok(compareLedgerOrder(first, second) < 0);
    assert.ok(compareLedgerOrder(second, first) > 0);
    assert.equal(compareLedgerOrder(first, first), 0);
  });

  it("does not mutate what it was given", () => {
    const entries = [
      credit({ id: "c", paidOn: "2026-03-15" }),
      credit({ id: "a", paidOn: "2026-01-15" }),
    ];

    orderLedger(entries);

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["c", "a"],
    );
  });
});

describe("replaying a contract", () => {
  const salePriceCents = lempiras(185_000);

  it("walks the balance down one transaction at a time", () => {
    const ledger = replayContract({
      salePriceCents,
      credits: [
        credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(25_000) }),
        credit({ id: "b", paidOn: "2026-02-05", amountCents: lempiras(6_700) }),
        credit({ id: "c", paidOn: "2026-03-05", amountCents: lempiras(6_700) }),
      ],
    });

    assert.deepEqual(
      ledger.lines.map((line) => [line.balanceBeforeCents, line.balanceAfterCents]),
      [
        [lempiras(185_000), lempiras(160_000)],
        [lempiras(160_000), lempiras(153_300)],
        [lempiras(153_300), lempiras(146_600)],
      ],
    );

    assert.equal(ledger.balanceCents, lempiras(146_600));
    assert.equal(ledger.totalCreditedCents, lempiras(38_400));
  });

  it("re-derives every later balance when an OLD payment changes", () => {
    // The exact scenario the Recibos tab exists for: two months of on-time
    // payments, and then the January amount is corrected upward because the
    // customer really handed over L 30,000, not L 25,000.
    const before = replayContract({
      salePriceCents,
      credits: [
        credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(25_000) }),
        credit({ id: "b", paidOn: "2026-02-05", amountCents: lempiras(6_700) }),
        credit({ id: "c", paidOn: "2026-03-05", amountCents: lempiras(6_700) }),
      ],
    });

    const after = replayContract({
      salePriceCents,
      credits: [
        credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(30_000) }),
        credit({ id: "b", paidOn: "2026-02-05", amountCents: lempiras(6_700) }),
        credit({ id: "c", paidOn: "2026-03-05", amountCents: lempiras(6_700) }),
      ],
    });

    // Every figure after the correction moved by exactly the correction, and
    // nothing had to be unlocked, re-frozen or remembered.
    assert.equal(before.lines[2]!.balanceAfterCents, lempiras(146_600));
    assert.equal(after.lines[2]!.balanceAfterCents, lempiras(141_600));
    assert.equal(before.balanceCents - after.balanceCents, lempiras(5_000));

    // The receipt BEFORE the corrected one is untouched, because it sits
    // earlier in the ledger.
    assert.equal(before.lines[0]!.balanceBeforeCents, after.lines[0]!.balanceBeforeCents);
  });

  it("slots a back-dated payment into its real place in history", () => {
    // Recorded today, but the money arrived in February. Every receipt issued
    // after February must move; the January one must not.
    const ledger = replayContract({
      salePriceCents,
      credits: [
        credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(25_000) }),
        credit({ id: "c", paidOn: "2026-03-05", amountCents: lempiras(6_700) }),
        credit({
          id: "b",
          paidOn: "2026-02-20",
          amountCents: lempiras(4_000),
          createdAt: "2026-08-30T10:00:00.000Z",
        }),
      ],
    });

    assert.deepEqual(
      ledger.lines.map((line) => line.entry.id),
      ["a", "b", "c"],
    );

    // The January receipt still opens at the full price.
    assert.equal(ledger.lines[0]!.balanceBeforeCents, lempiras(185_000));
    // March now opens L 4,000 lower than it did before the back-dated entry.
    assert.equal(ledger.lines[2]!.balanceBeforeCents, lempiras(156_000));
  });

  it("leaves reversed payments out of the arithmetic entirely", () => {
    const ledger = replayContract({
      salePriceCents,
      credits: [
        credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(25_000) }),
        credit({
          id: "b",
          paidOn: "2026-02-05",
          amountCents: lempiras(6_700),
          reversedAt: "2026-02-06T10:00:00.000Z",
        }),
        credit({ id: "c", paidOn: "2026-03-05", amountCents: lempiras(6_700) }),
      ],
    });

    assert.deepEqual(
      ledger.lines.map((line) => line.entry.id),
      ["a", "c"],
    );
    assert.equal(ledger.balanceCents, lempiras(153_300));
  });

  it("reports an overpayment instead of driving the balance negative", () => {
    const ledger = replayContract({
      salePriceCents: lempiras(10_000),
      credits: [credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(12_000) })],
    });

    assert.equal(ledger.balanceCents, 0);
    assert.equal(ledger.overpaidCents, lempiras(2_000));
    assert.equal(ledger.lines[0]!.balanceAfterCents, 0);
  });

  it("opens at the sale price even when a deposit predates the signing", () => {
    // A deposit taken the week before the contract was signed must not replay
    // against a balance of zero and print a first receipt claiming the customer
    // previously owed nothing.
    const ledger = replayContract({
      salePriceCents,
      credits: [credit({ id: "a", paidOn: "2025-12-20", amountCents: lempiras(5_000) })],
    });

    assert.equal(ledger.lines[0]!.balanceBeforeCents, salePriceCents);
  });

  it("has no lines and the full balance when nothing has been paid", () => {
    const ledger = replayContract({ salePriceCents, credits: [] });

    assert.deepEqual(ledger.lines, []);
    assert.equal(ledger.balanceCents, salePriceCents);
    assert.equal(ledger.overpaidCents, 0);
  });
});

describe("the charges seam", () => {
  // Nothing in the app populates `charges` yet. These tests pin down what
  // happens the day late fees or legal fees arrive, so that adding them is a
  // matter of writing rows rather than revisiting this arithmetic.
  const salePriceCents = lempiras(100_000);

  const lateFee = (id: string, incurredOn: string, amount: number): LedgerCharge => ({
    id,
    incurredOn,
    amountCents: lempiras(amount),
    kind: "late_fee",
  });

  it("adds a charge to what is owed", () => {
    const ledger = replayContract({
      salePriceCents,
      charges: [lateFee("f1", "2026-02-10", 500)],
      credits: [credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(10_000) })],
    });

    assert.equal(ledger.totalChargesCents, lempiras(100_500));
    assert.equal(ledger.balanceCents, lempiras(90_500));
  });

  it("counts a charge in the previous balance of the payment that follows it", () => {
    const ledger = replayContract({
      salePriceCents,
      charges: [lateFee("f1", "2026-02-10", 500)],
      credits: [
        credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(10_000) }),
        credit({ id: "b", paidOn: "2026-03-05", amountCents: lempiras(5_000) }),
      ],
    });

    // January is untouched: the fee had not been incurred yet.
    assert.equal(ledger.lines[0]!.balanceBeforeCents, lempiras(100_000));
    assert.equal(ledger.lines[0]!.chargesAppliedCents, 0);

    // March opens at 90,000 + the 500 fee, so the receipt's own arithmetic
    // works: previous − paid = new.
    assert.equal(ledger.lines[1]!.balanceBeforeCents, lempiras(90_500));
    assert.equal(ledger.lines[1]!.chargesAppliedCents, lempiras(500));
    assert.equal(ledger.lines[1]!.balanceAfterCents, lempiras(85_500));
  });

  it("still counts a charge incurred after the last payment", () => {
    const ledger = replayContract({
      salePriceCents,
      charges: [lateFee("f1", "2026-12-01", 500)],
      credits: [credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(10_000) })],
    });

    assert.equal(ledger.balanceCents, lempiras(90_500));
  });

  it("changes nothing at all when there are no charges", () => {
    const withEmpty = replayContract({
      salePriceCents,
      charges: [],
      credits: [credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(10_000) })],
    });
    const withNone = replayContract({
      salePriceCents,
      credits: [credit({ id: "a", paidOn: "2026-01-15", amountCents: lempiras(10_000) })],
    });

    assert.deepEqual(withEmpty, withNone);
  });
});

describe("what a receipt prints", () => {
  const salePriceByContract = new Map([
    ["lote-a", lempiras(100_000)],
    ["lote-b", lempiras(80_000)],
  ]);

  it("shows each lot's own before and after, and the totals across them", () => {
    // One customer, two lots, one payment of L 15,000 split 8,000 / 7,000.
    const customerCredits: TestCredit[] = [
      credit({
        id: "p1",
        contractId: "lote-a",
        paidOn: "2026-01-15",
        amountCents: lempiras(8_000),
      }),
      credit({
        id: "p2",
        contractId: "lote-b",
        paidOn: "2026-01-15",
        amountCents: lempiras(7_000),
      }),
    ];

    const figures = receiptFigures({
      paymentIds: ["p1", "p2"],
      customerCredits,
      salePriceByContract,
    });

    assert.equal(figures.totalPaidCents, lempiras(15_000));
    assert.equal(figures.previousBalanceCents, lempiras(180_000));
    assert.equal(figures.newBalanceCents, lempiras(165_000));
    assert.equal(figures.cumulativePaidCents, lempiras(15_000));

    assert.deepEqual(
      figures.lines.map((line) => [line.contractId, line.balanceBeforeCents, line.balanceAfterCents]),
      [
        ["lote-a", lempiras(100_000), lempiras(92_000)],
        ["lote-b", lempiras(80_000), lempiras(73_000)],
      ],
    );

    // previous − paid = new, on the face of the document.
    assert.equal(
      figures.previousBalanceCents - figures.totalPaidCents,
      figures.newBalanceCents,
    );
  });

  it("counts the customer's cumulative total across every lot they hold", () => {
    const customerCredits: TestCredit[] = [
      credit({ id: "p1", contractId: "lote-a", paidOn: "2026-01-15", amountCents: lempiras(8_000) }),
      credit({ id: "p2", contractId: "lote-b", paidOn: "2026-01-15", amountCents: lempiras(7_000) }),
      credit({ id: "p3", contractId: "lote-a", paidOn: "2026-02-15", amountCents: lempiras(4_000) }),
      credit({ id: "p4", contractId: "lote-b", paidOn: "2026-02-15", amountCents: lempiras(3_000) }),
    ];

    const january = receiptFigures({
      paymentIds: ["p1", "p2"],
      customerCredits,
      salePriceByContract,
    });
    const february = receiptFigures({
      paymentIds: ["p3", "p4"],
      customerCredits,
      salePriceByContract,
    });

    // January's receipt counts only what had been paid by January, even though
    // February's payments are in the same array.
    assert.equal(january.cumulativePaidCents, lempiras(15_000));
    assert.equal(february.cumulativePaidCents, lempiras(22_000));
  });

  it("re-derives an OLD receipt when a payment before it is corrected", () => {
    // The February receipt was printed and handed over. Afterwards, January is
    // corrected from 8,000 to 10,000 because the customer had paid more.
    const withOriginalJanuary: TestCredit[] = [
      credit({ id: "p1", contractId: "lote-a", paidOn: "2026-01-15", amountCents: lempiras(8_000) }),
      credit({ id: "p2", contractId: "lote-a", paidOn: "2026-02-15", amountCents: lempiras(4_000) }),
    ];
    const withCorrectedJanuary: TestCredit[] = [
      credit({ id: "p1", contractId: "lote-a", paidOn: "2026-01-15", amountCents: lempiras(10_000) }),
      credit({ id: "p2", contractId: "lote-a", paidOn: "2026-02-15", amountCents: lempiras(4_000) }),
    ];

    const before = receiptFigures({
      paymentIds: ["p2"],
      customerCredits: withOriginalJanuary,
      salePriceByContract,
    });
    const after = receiptFigures({
      paymentIds: ["p2"],
      customerCredits: withCorrectedJanuary,
      salePriceByContract,
    });

    // February's receipt now opens L 2,000 lower, and still balances.
    assert.equal(before.previousBalanceCents, lempiras(92_000));
    assert.equal(after.previousBalanceCents, lempiras(90_000));
    assert.equal(after.previousBalanceCents - after.totalPaidCents, after.newBalanceCents);
    assert.equal(after.cumulativePaidCents, lempiras(14_000));
  });

  it("re-derives when the down payment itself is corrected", () => {
    // The owner's other stated case: the prima was recorded as L 25,000 and
    // the customer actually handed over L 30,000, discovered two months in.
    const corrected: TestCredit[] = [
      credit({
        id: "prima",
        contractId: "lote-a",
        paidOn: "2026-01-05",
        amountCents: lempiras(30_000),
      }),
      credit({ id: "p2", contractId: "lote-a", paidOn: "2026-02-05", amountCents: lempiras(5_000) }),
      credit({ id: "p3", contractId: "lote-a", paidOn: "2026-03-05", amountCents: lempiras(5_000) }),
    ];

    const march = receiptFigures({
      paymentIds: ["p3"],
      customerCredits: corrected,
      salePriceByContract,
    });

    assert.equal(march.previousBalanceCents, lempiras(65_000));
    assert.equal(march.newBalanceCents, lempiras(60_000));
    assert.equal(march.cumulativePaidCents, lempiras(40_000));
  });

  it("ignores a reversed payment when working out what a later receipt says", () => {
    const customerCredits: TestCredit[] = [
      credit({ id: "p1", contractId: "lote-a", paidOn: "2026-01-15", amountCents: lempiras(8_000) }),
      credit({
        id: "p2",
        contractId: "lote-a",
        paidOn: "2026-02-15",
        amountCents: lempiras(4_000),
        reversedAt: "2026-02-16T09:00:00.000Z",
      }),
      credit({ id: "p3", contractId: "lote-a", paidOn: "2026-03-15", amountCents: lempiras(4_000) }),
    ];

    const march = receiptFigures({
      paymentIds: ["p3"],
      customerCredits,
      salePriceByContract,
    });

    assert.equal(march.previousBalanceCents, lempiras(92_000));
    assert.equal(march.cumulativePaidCents, lempiras(12_000));
  });

  it("orders its lines the same way every time it is asked", () => {
    const customerCredits: TestCredit[] = [
      credit({ id: "p2", contractId: "lote-b", paidOn: "2026-01-15", amountCents: lempiras(7_000) }),
      credit({ id: "p1", contractId: "lote-a", paidOn: "2026-01-15", amountCents: lempiras(8_000) }),
    ];

    const first = receiptFigures({ paymentIds: ["p1", "p2"], customerCredits, salePriceByContract });
    const second = receiptFigures({
      paymentIds: ["p2", "p1"],
      customerCredits: [...customerCredits].reverse(),
      salePriceByContract,
    });

    assert.deepEqual(first, second);
  });
});

describe("receipt identifiers", () => {
  it("numbers from the highest issued, never from a count", () => {
    // A count would hand out 3 again after receipt 3 was voided, and two
    // documents claiming the same number is unrecoverable.
    assert.equal(nextReceiptNumber(null), 1);
    assert.equal(nextReceiptNumber(0), 1);
    assert.equal(nextReceiptNumber(41), 42);
  });

  it("prints a code that is always twelve digits and never the sequence", () => {
    const seen = new Set<string>();

    for (let index = 0; index < 2_000; index += 1) {
      const code = allocateReceiptCode(() => false);

      assert.match(code, RECEIPT_CODE_PATTERN);
      // Fixed width: no receipt is ever "IM-42" or "IM-0000000000042".
      assert.equal(code.length, 15);
      seen.add(code);
    }

    // Random, not sequential. 2,000 draws from 10^12 repeating even once would
    // be extraordinary; repeating often means the generator is not random.
    assert.ok(seen.size > 1_995, `only ${seen.size} distinct codes in 2,000`);
  });

  it("draws again rather than issuing a receipt code that is already in the book", () => {
    const taken = new Set<string>();
    let draws = 0;

    // Every code is taken for the first three draws, so the loop has to keep
    // going: a collision must not become a failed payment at the window.
    const code = allocateReceiptCode((candidate) => {
      draws += 1;
      if (draws <= 3) {
        taken.add(candidate);
        return true;
      }
      return false;
    });

    assert.equal(draws, 4);
    assert.equal(taken.has(code), false);
    assert.match(code, RECEIPT_CODE_PATTERN);
  });

  it("gives up rather than spinning when no code is ever free", () => {
    assert.throws(() => allocateReceiptCode(() => true), /unique/);
  });

  it("mints lookup codes that are unguessable and never repeat", () => {
    const seen = new Set<string>();

    for (let index = 0; index < 2_000; index += 1) {
      const code = generateLookupCode();

      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal(seen.has(code), false);
      seen.add(code);
    }
  });

  it("forgives the characters people misread off a printed receipt", () => {
    // A customer reading "0" as "O" and "1" as "I" still finds their receipt.
    assert.equal(normalizeLookupCode("k7m2-9xqr"), "K7M29XQR");
    assert.equal(toStoredLookupCode("k7m2 9xqr"), "K7M2-9XQR");
    assert.equal(toStoredLookupCode("K7MZ-9XQO"), "K7MZ-9XQ0");
    assert.equal(toStoredLookupCode("K7MI-9XQR"), "K7M1-9XQR");
  });

  it("refuses anything that is not a lookup code rather than querying for it", () => {
    assert.equal(toStoredLookupCode(""), null);
    assert.equal(toStoredLookupCode("REC-2026-00042"), null);
    assert.equal(toStoredLookupCode("K7M2"), null);
  });
});

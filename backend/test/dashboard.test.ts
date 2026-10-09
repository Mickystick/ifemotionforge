import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { eq } from "drizzle-orm";

import type { Db } from "../src/db/client.js";
import { contracts, lots, payments } from "../src/db/schema.js";
import { monthEnd, monthOf, shiftMonth } from "../src/lib/dashboard.js";
import { businessToday } from "../src/lib/time.js";

/** The zone buildTestApp configures — the office's own, as production runs in. */
const TEST_TIME_ZONE = "America/Tegucigalpa";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/** L 1 = 100 centavos, as everywhere else in the app. */
const lempiras = (amount: number) => Math.round(amount * 100);

/*
 * Every date below is computed from the day the test runs, never written out.
 *
 * A dashboard is a screen about "this month", so a fixture with hard-coded
 * dates passes today and starts failing on the first of next month — which is
 * the single most annoying way for a test suite to rot.
 *
 * Through `businessToday`, and not `toISOString()`, for the same reason the app
 * does: between six in the evening and midnight in Tegucigalpa the two answer
 * with different days, and a fixture that disagreed with the server about what
 * day it is would fail every evening.
 */
const TODAY = businessToday(TEST_TIME_ZONE);
const THIS_MONTH = monthOf(TODAY);
const LAST_MONTH = shiftMonth(THIS_MONTH, -1);

/** A day inside a month that is safely in the past, whatever length it is. */
const dayIn = (month: string, day: number) => `${month}-${String(day).padStart(2, "0")}`;

interface ContractOptions {
  lotCode: string;
  salePriceCents: number;
  downPaymentCents: number;
  termMonths: number | null;
  monthlyPaymentCents: number | null;
  dueDay: number | null;
  signedOn: string;
  saleType?: "financed" | "cash" | "donation";
  kind?: "reservation" | "contract";
  status?: string;
  expiresOn?: string | null;
}

function addContract(db: Db, projectId: string, customerId: string, options: ContractOptions) {
  const lotId = randomUUID();
  const contractId = randomUUID();

  db.insert(lots)
    .values({
      id: lotId,
      projectId,
      code: options.lotCode,
      areaM2: 250,
      basePriceCents: options.salePriceCents,
    })
    .run();

  db.insert(contracts)
    .values({
      id: contractId,
      code: `CT-${options.lotCode}`,
      lotId,
      customerId,
      kind: options.kind ?? "contract",
      saleType: options.saleType ?? "financed",
      status: options.status ?? "active",
      salePriceCents: options.salePriceCents,
      downPaymentCents: options.downPaymentCents,
      termMonths: options.termMonths,
      monthlyPaymentCents: options.monthlyPaymentCents,
      dueDay: options.dueDay,
      signedOn: options.signedOn,
      expiresOn: options.expiresOn ?? null,
    })
    .run();

  return { contractId, lotId };
}

function addPayment(
  db: Db,
  contractId: string,
  recordedBy: string,
  options: {
    amountCents: number;
    paidOn: string;
    type?: string;
    method?: string;
    reversedAt?: string | null;
    reference?: string | null;
  },
) {
  const id = randomUUID();

  db.insert(payments)
    .values({
      id,
      contractId,
      amountCents: options.amountCents,
      originalAmountCents: options.amountCents,
      originalCurrency: "HNL",
      exchangeRate: "1",
      paidOn: options.paidOn,
      method: options.method ?? "cash",
      type: options.type ?? "installment",
      reference: options.reference ?? null,
      reversedAt: options.reversedAt ?? null,
      recordedBy,
    })
    .run();

  return id;
}

/** The response body, typed loosely — the shape itself is what is under test. */
type Dashboard = Record<string, any>;

async function readDashboard(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  cookie: string,
  month?: string,
): Promise<Dashboard> {
  const response = await app.inject({
    method: "GET",
    url: month ? `/api/dashboard?month=${month}` : "/api/dashboard",
    headers: { cookie },
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.json();
}

describe("panel general — who may read it", () => {
  it("allows anonymous read-only access without user-specific controls", async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ method: "GET", url: "/api/dashboard" });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.control, null);
    assert.equal(body.layout, null);
    await app.close();
  });

  it("opens for an associate, but without the control band", async () => {
    const { app } = await buildTestApp();
    const staff = await login(app, "staff@test.hn", STAFF_PASSWORD);
    const owner = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // Who collected how much cash, and which receipts were voided, is the same
    // question the change history answers — and that is the supervisor's.
    assert.equal((await readDashboard(app, staff)).control, null);
    assert.notEqual((await readDashboard(app, owner)).control, null);

    await app.close();
  });
});

describe("panel general — an empty business", () => {
  it("answers with zeroes rather than falling over", async () => {
    const { app, db } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // The state a brand-new installation is in on its first morning: accounts
    // exist, nothing has been sold, and somebody opens the Panel General. Every
    // rate, share and projection on this screen divides by something that is
    // zero here.
    db.delete(payments).run();
    db.delete(contracts).run();

    const body = await readDashboard(app, cookie);

    assert.equal(body.income.collectedCents, 0);
    assert.equal(body.income.expectedCents, 0);
    assert.equal(body.income.stillDueCents, 0);
    assert.equal(body.collections.worklist.length, 0);
    assert.equal(body.collections.settledContracts, 0);
    assert.deepEqual(
      body.collections.buckets.map((bucket: Dashboard) => bucket.contracts),
      [0, 0, 0, 0],
    );
    // The windows are still the right length: an empty chart is twelve empty
    // months, not an empty array the axis has nothing to draw from.
    assert.equal(body.history.length, 12);
    assert.equal(body.upcoming.projection.length, 6);
    assert.equal(body.projects.length, 0);
    assert.equal(body.upcoming.unpaidPrimas.amountCents, 0);
    assert.equal(body.control.unprovenTransfers.count, 0);

    await app.close();
  });
});

describe("panel general — which month", () => {
  it("defaults to the month we are living in", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const body = await readDashboard(app, cookie);

    assert.equal(body.month, THIS_MONTH);
    assert.equal(body.previousMonth, LAST_MONTH);
    assert.equal(body.isCurrentMonth, true);
    // The current month reads from today, so the buckets match the Contratos tab.
    assert.equal(body.asOf, TODAY);

    await app.close();
  });

  it("reads a past month from the day that month ended", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const body = await readDashboard(app, cookie, LAST_MONTH);

    assert.equal(body.isCurrentMonth, false);
    assert.equal(body.asOf, monthEnd(LAST_MONTH));

    await app.close();
  });

  it("refuses a month that has not happened", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const response = await app.inject({
      method: "GET",
      url: `/api/dashboard?month=${shiftMonth(THIS_MONTH, 1)}`,
      headers: { cookie },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "future_month");

    await app.close();
  });

  it("refuses a month that is not a month", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    for (const month of ["2026-13", "2026", "agosto", "2026-1"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/dashboard?month=${month}`,
        headers: { cookie },
      });

      assert.equal(response.statusCode, 400, `accepted ${month}`);
    }

    await app.close();
  });
});

describe("panel general — the month's money", () => {
  it("counts a payment in the month it was PAID, not the month it was typed", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const before = await readDashboard(app, cookie);
    const beforeLast = before.history.find((row: Dashboard) => row.month === LAST_MONTH);

    // Entered right now, dated last month — the back-dated payment that makes
    // "July versus August" meaningless if the row's insert time is used.
    //
    // The 1st, so it also falls inside the like-for-like comparison span
    // whatever day of the month this test runs on. Which payments that span
    // covers is the next test's subject, not this one's.
    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(7_000),
      paidOn: dayIn(LAST_MONTH, 1),
    });

    const after = await readDashboard(app, cookie);
    const afterLast = after.history.find((row: Dashboard) => row.month === LAST_MONTH);

    assert.equal(afterLast.collectedCents - beforeLast.collectedCents, lempiras(7_000));
    // And nothing landed in the month it was entered in.
    assert.equal(after.income.collectedCents, before.income.collectedCents);
    assert.equal(
      after.income.previousToDateCents,
      before.income.previousToDateCents + lempiras(7_000),
    );

    await app.close();
  });

  it("compares the same span of both months, not one day against thirty-one", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const asOfDay = Number(TODAY.slice(8, 10));

    // Last month, on a day we have not yet reached this month. Without a
    // like-for-like span this would be counted against a month that is a few
    // days old, and the first of every month would report "−100 %".
    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(50_000),
      paidOn: dayIn(LAST_MONTH, 28),
    });
    // And one from a day we HAVE reached, which must count.
    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(4_000),
      paidOn: dayIn(LAST_MONTH, 1),
    });

    const body = await readDashboard(app, cookie);

    assert.equal(body.income.comparisonDays, asOfDay);

    if (asOfDay < 28) {
      // The late payment is outside the span; the first-of-the-month one is in.
      assert.equal(body.income.previousToDateCents, lempiras(4_000));
    } else {
      assert.equal(body.income.previousToDateCents, lempiras(54_000));
    }

    // Reported against a PAST month the span is that month's last day, so the
    // whole of the month before it is included and the rule needs no exception.
    const past = await readDashboard(app, cookie, LAST_MONTH);
    assert.equal(past.income.comparisonDays, Number(monthEnd(LAST_MONTH).slice(8, 10)));

    await app.close();
  });

  it("stops counting a payment once it is reversed", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const before = await readDashboard(app, cookie);

    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(3_000),
      paidOn: dayIn(THIS_MONTH, 2),
    });
    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(9_000),
      paidOn: dayIn(THIS_MONTH, 3),
      reversedAt: new Date().toISOString(),
    });

    const after = await readDashboard(app, cookie);

    // The reversed row keeps its amount and its date and simply stops counting,
    // exactly as every balance in the app already treats it.
    assert.equal(after.income.collectedCents - before.income.collectedCents, lempiras(3_000));

    await app.close();
  });

  it("splits the month's money by what it was for and how it arrived", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(40_000),
      paidOn: dayIn(THIS_MONTH, 4),
      type: "down_payment",
      method: "transfer",
    });
    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(5_000),
      paidOn: dayIn(THIS_MONTH, 6),
      type: "installment",
      method: "cash",
    });

    const body = await readDashboard(app, cookie);

    // The distinction the headline figure cannot make: a month carried by one
    // large prima is not a month that repeats.
    assert.equal(body.income.byType.downPayment, lempiras(40_000));
    assert.equal(body.income.byType.installment, lempiras(5_000));
    assert.equal(body.income.byMethod.transfer, lempiras(40_000));
    assert.equal(body.income.byMethod.cash, lempiras(5_000));

    await app.close();
  });

  it("keeps a past month's total free of money that arrived later", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(11_000),
      paidOn: dayIn(THIS_MONTH, 5),
    });

    const lastMonthView = await readDashboard(app, cookie, LAST_MONTH);

    // Paging back to last month must show last month, not last month's figures
    // topped up with this month's takings.
    assert.equal(lastMonthView.month, LAST_MONTH);
    assert.equal(
      lastMonthView.history.some((row: Dashboard) => row.month === THIS_MONTH),
      false,
    );

    await app.close();
  });
});

describe("panel general — what was scheduled", () => {
  it("expects the prima in the signing month and each cuota in its own", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // Signed on the 10th of last month, due the 10th: the first cuota lands in
    // the month we are in now.
    addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-01",
      salePriceCents: lempiras(120_000),
      downPaymentCents: lempiras(20_000),
      termMonths: 20,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 10,
      signedOn: dayIn(LAST_MONTH, 10),
    });

    const thisMonthView = await readDashboard(app, cookie);
    const lastMonthView = await readDashboard(app, cookie, LAST_MONTH);

    assert.equal(lastMonthView.income.expectedCents, lempiras(20_000));
    assert.equal(thisMonthView.income.expectedCents, lempiras(5_000));

    // And the months after this one are the projection, six of them.
    assert.equal(thisMonthView.upcoming.projection.length, 6);
    assert.equal(thisMonthView.upcoming.projection[0].month, shiftMonth(THIS_MONTH, 1));
    assert.equal(thisMonthView.upcoming.projection[0].expectedCents, lempiras(5_000));
    assert.equal(thisMonthView.upcoming.projection[0].contracts, 1);

    await app.close();
  });

  it("stops expecting anything from a cancelled contract", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const { contractId } = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-02",
      salePriceCents: lempiras(60_000),
      downPaymentCents: 0,
      termMonths: 12,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 10,
      signedOn: dayIn(shiftMonth(THIS_MONTH, -2), 10),
    });

    const before = await readDashboard(app, cookie);
    assert.equal(before.income.expectedCents, lempiras(5_000));

    db.update(contracts)
      .set({ status: "cancelled", closedAt: `${dayIn(LAST_MONTH, 20)}T00:00:00.000Z` })
      .where(eq(contracts.id, contractId))
      .run();

    const after = await readDashboard(app, cookie);

    // Money nobody is ever going to hand over must not sit in the "esperado"
    // line, or the collection rate beside it means nothing.
    assert.equal(after.income.expectedCents, 0);
    // The month it was still standing in keeps its expectation.
    const lastMonthView = await readDashboard(app, cookie, LAST_MONTH);
    assert.equal(lastMonthView.income.expectedCents, lempiras(5_000));

    await app.close();
  });
});

describe("panel general — collections", () => {
  it("buckets every live contract exactly once and totals the arrears", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // Signed four months ago, nothing paid since the prima: three cuotas due,
    // which is squarely "en riesgo".
    const { contractId } = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-03",
      salePriceCents: lempiras(100_000),
      downPaymentCents: lempiras(10_000),
      termMonths: 18,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 1,
      signedOn: dayIn(shiftMonth(THIS_MONTH, -4), 1),
    });

    addPayment(db, contractId, ids.ownerId, {
      amountCents: lempiras(10_000),
      paidOn: dayIn(shiftMonth(THIS_MONTH, -4), 1),
      type: "down_payment",
    });

    const body = await readDashboard(app, cookie);

    const bucketed = body.collections.buckets.reduce(
      (total: number, bucket: Dashboard) => total + bucket.contracts,
      0,
    );
    // The seeded reservation plus this one. Nothing is counted twice and
    // nothing falls between the buckets.
    assert.equal(bucketed + body.collections.settledContracts, 2);

    const atRisk = body.collections.buckets.find((b: Dashboard) => b.status === "at_risk");
    assert.equal(atRisk.contracts, 1);
    assert.ok(atRisk.arrearsCents > 0);

    // And the debtor is on the worklist with a phone number to call.
    assert.equal(body.collections.worklist.length, 1);
    assert.equal(body.collections.worklist[0].contractCode, "CT-E-03");
    assert.equal(body.collections.worklist[0].phone, "+50499990000");
    assert.equal(body.collections.worklist[0].arrearsCents, atRisk.arrearsCents);
    assert.equal(body.collections.worklist[0].lastPaymentOn, dayIn(shiftMonth(THIS_MONTH, -4), 1));

    await app.close();
  });

  it("orders the worklist by money owed, not by months behind", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // Four months late on a small cuota.
    addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-04",
      salePriceCents: lempiras(40_000),
      downPaymentCents: 0,
      termMonths: 20,
      monthlyPaymentCents: lempiras(2_000),
      dueDay: 1,
      signedOn: dayIn(shiftMonth(THIS_MONTH, -5), 1),
    });

    // Two months late on a large one — fewer months, far more money.
    addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-05",
      salePriceCents: lempiras(300_000),
      downPaymentCents: 0,
      termMonths: 20,
      monthlyPaymentCents: lempiras(15_000),
      dueDay: 1,
      signedOn: dayIn(shiftMonth(THIS_MONTH, -3), 1),
    });

    const body = await readDashboard(app, cookie);

    // The point of the list is the order to make the calls in, and that order
    // is decided by the money at stake.
    assert.equal(body.collections.worklist[0].contractCode, "CT-E-05");
    assert.ok(
      body.collections.worklist[0].arrearsCents > body.collections.worklist[1].arrearsCents,
    );

    await app.close();
  });

  it("notices who slipped and who came back", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    /*
     * Reported against LAST month, so both ends of the comparison are month
     * ends and the answer does not depend on what day the test runs.
     *
     * Asking the same question of the CURRENT month is right but untestable
     * this way: it compares the end of last month against today, so on the 1st
     * the window is a day wide and nobody has slipped yet. That is correct —
     * "se atrasaron en septiembre" should be empty on 1 September — and it is
     * why the screen labels the list with the month rather than leaving an
     * empty box to be read as a broken one.
     */
    const month = LAST_MONTH;
    const signedOn = dayIn(shiftMonth(month, -4), 1);
    // Installments fall due on the 1st of each month from three months before
    // `month`, so three are due by the previous month's end and four by this
    // one's — with the five-day grace comfortably inside both.
    const terms = {
      salePriceCents: lempiras(90_000),
      downPaymentCents: 0,
      termMonths: 18,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 1,
      signedOn,
    };

    // Paid up to the end of the previous month, then stopped.
    const slipping = addContract(db, ids.projectId, ids.customerId, {
      ...terms,
      lotCode: "E-06",
    });
    addPayment(db, slipping.contractId, ids.ownerId, {
      amountCents: lempiras(15_000),
      paidOn: dayIn(shiftMonth(month, -3), 1),
    });

    // A month behind at the previous month's end, then cleared it mid-month.
    const recovering = addContract(db, ids.projectId, ids.customerId, {
      ...terms,
      lotCode: "E-11",
    });
    addPayment(db, recovering.contractId, ids.ownerId, {
      amountCents: lempiras(10_000),
      paidOn: dayIn(shiftMonth(month, -3), 1),
    });
    addPayment(db, recovering.contractId, ids.ownerId, {
      amountCents: lempiras(10_000),
      paidOn: dayIn(month, 15),
    });

    const body = await readDashboard(app, cookie, month);

    // The earliest warning this data can give: a level barely moves, a crossing
    // is a signal.
    assert.deepEqual(
      body.collections.slipped.map((row: Dashboard) => row.contractCode),
      ["CT-E-06"],
    );
    assert.deepEqual(
      body.collections.recovered.map((row: Dashboard) => row.contractCode),
      ["CT-E-11"],
    );

    await app.close();
  });
});

describe("panel general — what is coming", () => {
  it("warns about a reservation about to lapse, and one that already has", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-07",
      kind: "reservation",
      salePriceCents: lempiras(50_000),
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
      saleType: "cash",
      signedOn: dayIn(LAST_MONTH, 1),
      expiresOn: dayIn(LAST_MONTH, 20),
    });

    // Far enough out that it is not this month's problem.
    addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-08",
      kind: "reservation",
      salePriceCents: lempiras(50_000),
      downPaymentCents: 0,
      termMonths: null,
      monthlyPaymentCents: null,
      dueDay: null,
      saleType: "cash",
      signedOn: TODAY,
      expiresOn: shiftMonth(THIS_MONTH, 4) + "-01",
    });

    const body = await readDashboard(app, cookie);
    const codes = body.upcoming.expiringReservations.map((row: Dashboard) => row.contractCode);

    // A hold with an expiry nobody watches keeps a lot off the market forever.
    assert.ok(codes.includes("CT-E-07"));
    assert.ok(!codes.includes("CT-E-08"));

    await app.close();
  });

  it("lists contracts about to be paid off", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const { contractId } = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-09",
      salePriceCents: lempiras(50_000),
      downPaymentCents: 0,
      termMonths: 10,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 1,
      signedOn: dayIn(shiftMonth(THIS_MONTH, -9), 1),
    });

    // Eight of the ten cuotas paid: two left.
    addPayment(db, contractId, ids.ownerId, {
      amountCents: lempiras(40_000),
      paidOn: dayIn(shiftMonth(THIS_MONTH, -1), 1),
    });

    const body = await readDashboard(app, cookie);

    assert.equal(body.upcoming.finishingSoon.length, 1);
    assert.equal(body.upcoming.finishingSoon[0].contractCode, "CT-E-09");
    assert.equal(body.upcoming.finishingSoon[0].installmentsLeft, 2);
    assert.equal(body.upcoming.finishingSoon[0].balanceCents, lempiras(10_000));

    await app.close();
  });

  it("totals the primas that were agreed and never collected", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const { contractId } = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "E-10",
      salePriceCents: lempiras(100_000),
      downPaymentCents: lempiras(20_000),
      termMonths: 16,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 1,
      signedOn: dayIn(LAST_MONTH, 1),
    });

    // Half the prima arrived. The shortfall is what is owed, not the whole.
    addPayment(db, contractId, ids.ownerId, {
      amountCents: lempiras(8_000),
      paidOn: dayIn(LAST_MONTH, 2),
      type: "down_payment",
    });

    const body = await readDashboard(app, cookie);

    assert.equal(body.upcoming.unpaidPrimas.contracts, 1);
    assert.equal(body.upcoming.unpaidPrimas.amountCents, lempiras(12_000));

    await app.close();
  });
});

describe("panel general — control", () => {
  it("reports who took the money and how much of it was cash", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    addPayment(db, ids.contractId, ids.staffId, {
      amountCents: lempiras(6_000),
      paidOn: dayIn(THIS_MONTH, 2),
      method: "cash",
    });
    addPayment(db, ids.contractId, ids.staffId, {
      amountCents: lempiras(4_000),
      paidOn: dayIn(THIS_MONTH, 3),
      method: "transfer",
      reference: "TRF-99",
    });

    const body = await readDashboard(app, cookie);
    const staffRow = body.control.byUser.find((row: Dashboard) => row.userName === "Staff");

    assert.equal(staffRow.collectedCents, lempiras(10_000));
    // Cash is singled out because it is the only figure that passed through
    // somebody's hands rather than a bank's.
    assert.equal(staffRow.cashCents, lempiras(6_000));
    assert.equal(staffRow.payments, 2);

    await app.close();
  });

  it("flags a transfer with nothing to reconcile it against", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(15_000),
      paidOn: dayIn(THIS_MONTH, 7),
      method: "transfer",
      reference: null,
    });
    // This one carries the bank's confirmation number, so it is provable.
    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(25_000),
      paidOn: dayIn(THIS_MONTH, 8),
      method: "transfer",
      reference: "TRF-123456",
    });
    // Cash is not a transfer and has no bank statement to match against.
    addPayment(db, ids.contractId, ids.ownerId, {
      amountCents: lempiras(35_000),
      paidOn: dayIn(THIS_MONTH, 9),
      method: "cash",
    });

    const body = await readDashboard(app, cookie);

    assert.equal(body.control.unprovenTransfers.count, 1);
    assert.equal(body.control.unprovenTransfers.amountCents, lempiras(15_000));

    await app.close();
  });
});

describe("panel general — arranging the screen", () => {
  it("has no arrangement until somebody chooses one", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // `null`, not the default order. The two have to stay different: a user who
    // has never chosen follows the default as it changes in later releases.
    assert.equal((await readDashboard(app, cookie)).layout, null);

    await app.close();
  });

  it("saves an order and hands it back with the screen", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const layout = { order: ["worklist", "collections", "income"], hidden: ["control"] };

    const saved = await app.inject({
      method: "PUT",
      url: "/api/dashboard/layout",
      headers: { cookie },
      payload: layout,
    });

    assert.equal(saved.statusCode, 200);
    // Sent with the data rather than fetched separately, so the first paint is
    // already in the reader's order.
    assert.deepEqual((await readDashboard(app, cookie)).layout, layout);

    await app.close();
  });

  it("replaces the arrangement rather than collecting them", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    for (const first of ["income", "projects", "worklist"]) {
      await app.inject({
        method: "PUT",
        url: "/api/dashboard/layout",
        headers: { cookie },
        payload: { order: [first], hidden: [] },
      });
    }

    // One row per user per key. Without the upsert this is where a second row
    // appears and the reader gets whichever SQLite returns first.
    assert.deepEqual((await readDashboard(app, cookie)).layout, {
      order: ["worklist"],
      hidden: [],
    });

    await app.close();
  });

  it("is one person's own, and cannot be written for anybody else", async () => {
    const { app } = await buildTestApp();
    const owner = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const staff = await login(app, "staff@test.hn", STAFF_PASSWORD);

    await app.inject({
      method: "PUT",
      url: "/api/dashboard/layout",
      headers: { cookie: staff },
      // A user id in the body is ignored: the row written is the one belonging
      // to the session, so there is no request that rearranges another screen.
      payload: { order: ["worklist"], hidden: [], userId: "somebody-else" },
    });

    assert.deepEqual((await readDashboard(app, staff)).layout, {
      order: ["worklist"],
      hidden: [],
    });
    assert.equal((await readDashboard(app, owner)).layout, null);

    await app.close();
  });

  it("refuses a body that is not an arrangement", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const bodies = [
      { order: ["income", "income"], hidden: [] },
      { order: ["Income"], hidden: [] },
      { order: ["../../etc/passwd"], hidden: [] },
      { order: Array.from({ length: 41 }, (_, index) => `s${index}`), hidden: [] },
      { order: "income", hidden: [] },
      { hidden: [] },
    ];

    for (const payload of bodies) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/dashboard/layout",
        headers: { cookie },
        payload,
      });

      assert.equal(response.statusCode, 400, `accepted ${JSON.stringify(payload)}`);
    }

    await app.close();
  });

  it("stores an id it does not recognise, rather than refusing it", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    // The server deliberately does not know which bands exist — that is what
    // lets a new one ship without a migration, and stops a tab running last
    // week's code from being answered with a 400 it cannot recover from. The
    // interface drops what it cannot render.
    const response = await app.inject({
      method: "PUT",
      url: "/api/dashboard/layout",
      headers: { cookie },
      payload: { order: ["income", "a-band-from-the-future"], hidden: [] },
    });

    assert.equal(response.statusCode, 200);

    await app.close();
  });

  it("forgets the arrangement rather than freezing today's default", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await app.inject({
      method: "PUT",
      url: "/api/dashboard/layout",
      headers: { cookie },
      payload: { order: ["worklist", "income"], hidden: [] },
    });

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/dashboard/layout",
      headers: { cookie },
    });

    assert.equal(cleared.statusCode, 200);
    // Back to `null` — following the default — not storing a copy of it.
    assert.equal((await readDashboard(app, cookie)).layout, null);

    await app.close();
  });

  it("is nobody's business but a signed-in user's", async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/dashboard/layout",
      payload: { order: ["income"], hidden: [] },
    });

    assert.equal(response.statusCode, 401);

    await app.close();
  });
});

/*
 * The drill-downs.
 *
 * The Panel General opens three of its figures into the rows they were summed
 * from, and the whole point of returning those rows from the same pass that did
 * the summing is that a breakdown cannot disagree with its own total. These
 * tests are about exactly that: not "does the list have items", but "does the
 * list add up to the number printed above it".
 */
describe("panel general — the rows behind the figures", () => {
  it("returns the month's payments, and they sum to what was collected", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const first = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "D-01",
      salePriceCents: lempiras(90_000),
      downPaymentCents: 0,
      termMonths: 18,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 5,
      signedOn: dayIn(LAST_MONTH, 5),
    });

    addPayment(db, first.contractId, ids.ownerId, {
      amountCents: lempiras(5_000),
      paidOn: dayIn(THIS_MONTH, 3),
    });
    addPayment(db, first.contractId, ids.ownerId, {
      amountCents: lempiras(2_500),
      paidOn: dayIn(THIS_MONTH, 9),
      method: "transfer",
    });

    // A reversed payment is in neither the total nor the list, or the panel
    // would explain a figure using money that was taken back.
    addPayment(db, first.contractId, ids.ownerId, {
      amountCents: lempiras(9_999),
      paidOn: dayIn(THIS_MONTH, 4),
      reversedAt: `${dayIn(THIS_MONTH, 4)}T12:00:00.000Z`,
    });

    // And neither is last month's, when this month is the one being read.
    addPayment(db, first.contractId, ids.ownerId, {
      amountCents: lempiras(4_000),
      paidOn: dayIn(LAST_MONTH, 20),
    });

    const view = await readDashboard(app, cookie);
    const rows = view.income.payments;

    assert.equal(rows.length, 2);
    assert.equal(
      rows.reduce((total: number, row: any) => total + row.amountCents, 0),
      view.income.collectedCents,
    );

    // Each row carries what the panel needs to name it without a second request.
    const [newest] = rows;
    assert.equal(newest.paidOn, dayIn(THIS_MONTH, 9));
    assert.equal(newest.lotCode, "D-01");
    assert.equal(newest.contractCode, "CT-D-01");
    assert.equal(newest.method, "transfer");
    assert.ok(typeof newest.customerName === "string" && newest.customerName.length > 0);

    await app.close();
  });

  it("groups into exactly the customers the payer count reports", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const contract = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "D-02",
      salePriceCents: lempiras(60_000),
      downPaymentCents: 0,
      termMonths: 12,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 5,
      signedOn: dayIn(LAST_MONTH, 5),
    });

    // One customer, three payments. "Clientes que pagaron" counts people, so the
    // panel that opens under it must group to one row and not to three.
    for (const day of [2, 11, 21]) {
      addPayment(db, contract.contractId, ids.ownerId, {
        amountCents: lempiras(1_000),
        paidOn: dayIn(THIS_MONTH, day),
      });
    }

    const view = await readDashboard(app, cookie);
    const customers = new Set(view.income.payments.map((row: any) => row.customerId));

    assert.equal(view.income.payments.length, 3);
    assert.equal(customers.size, view.income.payingCustomers);

    await app.close();
  });

  it("splits by project so a project's own rows sum to its collected figure", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const contract = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "D-03",
      salePriceCents: lempiras(40_000),
      downPaymentCents: 0,
      termMonths: 8,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 5,
      signedOn: dayIn(LAST_MONTH, 5),
    });

    addPayment(db, contract.contractId, ids.ownerId, {
      amountCents: lempiras(3_000),
      paidOn: dayIn(THIS_MONTH, 6),
    });

    const view = await readDashboard(app, cookie);

    for (const project of view.projects) {
      const mine = view.income.payments.filter((row: any) => row.projectId === project.projectId);

      assert.equal(
        mine.reduce((total: number, row: any) => total + row.amountCents, 0),
        project.collectedCents,
        `project ${project.projectName} does not add up to its own payments`,
      );
    }

    await app.close();
  });

  it("returns the contracts signed this month, summing to the reported value", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    addContract(db, ids.projectId, ids.customerId, {
      lotCode: "D-04",
      salePriceCents: lempiras(150_000),
      downPaymentCents: lempiras(30_000),
      termMonths: 24,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 5,
      signedOn: dayIn(THIS_MONTH, 2),
    });

    // Signed last month: counted there, and absent from this month's list.
    addContract(db, ids.projectId, ids.customerId, {
      lotCode: "D-05",
      salePriceCents: lempiras(80_000),
      downPaymentCents: 0,
      termMonths: 16,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 5,
      signedOn: dayIn(LAST_MONTH, 14),
    });

    const view = await readDashboard(app, cookie);
    const signed = view.income.signed;

    assert.equal(signed.length, view.income.signedCount);
    assert.equal(
      signed.reduce((total: number, row: any) => total + row.salePriceCents, 0),
      view.income.signedValueCents,
    );

    const mine = signed.find((row: any) => row.lotCode === "D-04");
    assert.ok(mine, "the contract signed this month is missing from the list");
    assert.equal(mine.salePriceCents, lempiras(150_000));
    assert.equal(mine.downPaymentCents, lempiras(30_000));
    assert.ok(!signed.some((row: any) => row.lotCode === "D-05"));

    await app.close();
  });

  it("opens a past month into that month's rows, not this one's", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const contract = addContract(db, ids.projectId, ids.customerId, {
      lotCode: "D-06",
      salePriceCents: lempiras(70_000),
      downPaymentCents: 0,
      termMonths: 14,
      monthlyPaymentCents: lempiras(5_000),
      dueDay: 5,
      signedOn: dayIn(shiftMonth(LAST_MONTH, -1), 5),
    });

    addPayment(db, contract.contractId, ids.ownerId, {
      amountCents: lempiras(6_000),
      paidOn: dayIn(LAST_MONTH, 12),
    });
    addPayment(db, contract.contractId, ids.ownerId, {
      amountCents: lempiras(1_500),
      paidOn: dayIn(THIS_MONTH, 12),
    });

    const past = await readDashboard(app, cookie, LAST_MONTH);
    const rows = past.income.payments;

    assert.ok(rows.every((row: any) => monthOf(row.paidOn) === LAST_MONTH));
    assert.equal(
      rows.reduce((total: number, row: any) => total + row.amountCents, 0),
      past.income.collectedCents,
    );

    await app.close();
  });
});

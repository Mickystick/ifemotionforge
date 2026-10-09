import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import {
  attachments,
  contracts,
  customers,
  lots,
  payments,
  projects,
  receipts,
  users,
} from "../db/schema.js";
import { roleCan } from "../lib/capabilities.js";
import { DASHBOARD_LAYOUT, clearPreference, readPreference, writePreference } from "../lib/preferences.js";
import { businessToday } from "../lib/time.js";
import type { ContractTerms, PaymentHealth, SaleType } from "../lib/contracts.js";
import { assessContract, outstandingInstallments, shiftDays } from "../lib/contracts.js";
import {
  HEALTH_ORDER,
  Tally,
  expectedByMonth,
  isBehind,
  monthEnd,
  monthOf,
  monthsAfter,
  monthsEndingAt,
  monthsOfStock,
  shiftMonth,
} from "../lib/dashboard.js";

/** What this plugin needs from the configuration — see routes/contracts.ts. */
interface DashboardRoutesOptions {
  /** IANA name — see `timeZone` in src/config/env.ts. */
  timeZone: string;
}

/* -------------------------------------------------------------------------- */
/* How much of each thing the screen shows                                     */
/* -------------------------------------------------------------------------- */

/** Months of history behind the bar chart — a full year, so seasons are visible. */
const HISTORY_MONTHS = 12;

/**
 * Months of income projected forward.
 *
 * Six, because the thing this is for is spotting the cliff: eight contracts
 * finishing in December means January collects far less, and nobody finds that
 * out from any other screen until January. Twelve would be a forecast nobody
 * should trust that far out on terms that can still be renegotiated.
 */
const PROJECTION_MONTHS = 6;

/** The trailing window the per-project sale rate is averaged over. */
const SALE_RATE_MONTHS = 6;

/** How far ahead a reservation's expiry is worth warning about. */
const EXPIRY_HORIZON_DAYS = 30;

/** Installments left at which a contract counts as "about to finish". */
const FINISHING_INSTALLMENTS = 3;

/**
 * How many debtors the worklist carries.
 *
 * Capped because this is a list somebody works through this week, not a report.
 * The bucket counters beside it always state the real total, so a book with 200
 * overdue contracts says 200 and hands over the twelve worth calling first.
 */
const WORKLIST_SIZE = 12;

/* -------------------------------------------------------------------------- */
/* Reading the contracts                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every contract, with the four paid-to-date figures this screen needs.
 *
 * All four are SUMs computed on read, exactly as routes/contracts.ts does it —
 * there is no balance column anywhere in Lindero and this screen does not
 * invent one. They are asked for separately because they answer different
 * questions, and a screen that used one where it meant another would be wrong
 * in a way nobody could see:
 *
 * - `paidToDateCents`         everything, ever. What the Contratos tab uses.
 * - `paidThroughAsOfCents`    what had arrived by the reported month's end.
 * - `paidThroughPreviousCents` the same, a month earlier — the comparison that
 *                             makes "who slipped this month" answerable at all.
 * - `downPaymentPaidCents`    the prima that actually arrived, which is a
 *                             different fact from the prima that was agreed.
 */
function contractRows(db: Db, asOf: string, previousAsOf: string) {
  const paidThrough = (limit: string) => sql<number>`
    COALESCE((
      SELECT SUM(${payments.amountCents})
      FROM ${payments}
      WHERE ${payments.contractId} = ${contracts.id}
        AND ${payments.reversedAt} IS NULL
        AND ${payments.paidOn} <= ${limit}
    ), 0)
  `;

  return db
    .select({
      id: contracts.id,
      code: contracts.code,
      kind: contracts.kind,
      saleType: contracts.saleType,
      status: contracts.status,
      salePriceCents: contracts.salePriceCents,
      downPaymentCents: contracts.downPaymentCents,
      termMonths: contracts.termMonths,
      monthlyPaymentCents: contracts.monthlyPaymentCents,
      dueDay: contracts.dueDay,
      signedOn: contracts.signedOn,
      firstDueOn: contracts.firstDueOn,
      expiresOn: contracts.expiresOn,
      closedAt: contracts.closedAt,
      createdAt: contracts.createdAt,
      lotId: lots.id,
      lotCode: lots.code,
      projectId: projects.id,
      projectName: projects.name,
      customerId: customers.id,
      customerName: customers.fullName,
      customerPhone: customers.phone,
      paidToDateCents: sql<number>`
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
        ), 0)
      `,
      paidThroughAsOfCents: paidThrough(asOf),
      paidThroughPreviousCents: paidThrough(previousAsOf),
      downPaymentPaidCents: sql<number>`
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
            AND ${payments.type} = 'down_payment'
        ), 0)
      `,
      lastPaymentOn: sql<string | null>`(
        SELECT MAX(${payments.paidOn})
        FROM ${payments}
        WHERE ${payments.contractId} = ${contracts.id}
          AND ${payments.reversedAt} IS NULL
      )`,
    })
    .from(contracts)
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .innerJoin(customers, eq(customers.id, contracts.customerId))
    .all();
}

type ContractRow = ReturnType<typeof contractRows>[number];

/**
 * A contract with everything the screen asks of it worked out once.
 *
 * Assembled up front rather than recomputed inside each band, because the same
 * contract is looked at by the income totals, the health buckets, the project
 * table and the projection, and `assessContract` is not free.
 */
interface Assessed {
  row: ContractRow;
  terms: ContractTerms;
  /** Health at the reported month's end — or right now, for the current month. */
  status: PaymentHealth;
  balanceCents: number;
  arrearsCents: number;
  monthsBehind: number;
  settled: boolean;
  /** Health a month earlier. The only reason "slipped" and "recovered" exist. */
  previousStatus: PaymentHealth;
  /** What this contract is scheduled to bring in, month by month. */
  expected: Map<string, number>;
  /** What should have arrived by the end of the reported month. */
  expectedThroughMonthCents: number;
  /** Paid-to-date at the position this screen is being read from. */
  paidCents: number;
  /** Installments still owing money. Empty for a cash sale or a donation. */
  outstandingCount: number;
}

/**
 * Which paid-to-date to read the current position from.
 *
 * For a PAST month it has to be the figure as of that month's end, or the
 * screen would report July using money that arrived in August and call
 * everybody current.
 *
 * For the month we are living in it is the unfiltered total, and that is not
 * the same as filtering on today's date: a payment somebody dated next week has
 * already been received, and routes/contracts.ts counts it. Filtering it out
 * here would make this screen call a customer overdue while the contract row
 * two clicks away calls them al día, and two screens disagreeing about one
 * person is worse than either being a few days early.
 */
function assess(
  row: ContractRow,
  month: string,
  asOf: string,
  previousAsOf: string,
  isCurrentMonth: boolean,
): Assessed {
  const terms: ContractTerms = {
    saleType: row.saleType as SaleType,
    salePriceCents: row.salePriceCents,
    downPaymentCents: row.downPaymentCents,
    termMonths: row.termMonths,
    monthlyPaymentCents: row.monthlyPaymentCents,
    dueDay: row.dueDay,
    // The same fallback routes/contracts.ts applies: contracts written before
    // `signed_on` existed were backfilled from their creation date.
    signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
    firstDueOn: row.firstDueOn,
  };

  const paidCents = isCurrentMonth ? row.paidToDateCents : row.paidThroughAsOfCents;
  const health = assessContract(terms, paidCents, asOf);
  const expected = expectedByMonth(terms);

  let expectedThroughMonthCents = 0;

  // Every installment due in a month is due by that month's last day, so summing
  // the months up to and including this one IS "what should have arrived by the
  // end of it" — no second walk of the schedule needed to ask the same thing.
  for (const [dueMonth, amountCents] of expected) {
    if (dueMonth <= month) {
      expectedThroughMonthCents += amountCents;
    }
  }

  return {
    row,
    terms,
    status: health.status,
    balanceCents: health.balanceCents,
    arrearsCents: health.arrearsCents,
    monthsBehind: health.monthsBehind,
    settled: health.settled,
    previousStatus: assessContract(terms, row.paidThroughPreviousCents, previousAsOf).status,
    expected,
    expectedThroughMonthCents,
    paidCents,
    outstandingCount: outstandingInstallments(terms, paidCents).length,
  };
}

/**
 * Does this contract's schedule still stand in `month`?
 *
 * A draft is not a sale yet, and a contract cancelled in June is not expected to
 * pay in July — counting either would put money in the "esperado" line that
 * nobody is ever going to hand over, which is the one thing that would make the
 * collection rate beside it useless.
 *
 * Money that actually ARRIVED is never filtered this way. A payment is a fact
 * about the past whatever later became of the contract.
 */
function scheduleStands(row: ContractRow, month: string): boolean {
  return row.status !== "draft" && (row.closedAt === null || monthOf(row.closedAt) >= month);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One band's id, as the interface names it.
 *
 * Checked for SHAPE and nothing else. Which ids exist is the interface's
 * business — the server storing a list it does not interpret is what lets a new
 * band ship without a migration, and what stops a stale id from a previous
 * release becoming a 400 for somebody who has not reloaded. The pattern and the
 * length caps are here to keep this a settings row rather than a place to park
 * arbitrary data.
 */
const sectionId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Invalid identifier.");

/** No duplicates: an id twice in the order would render the same band twice. */
const uniqueSections = z
  .array(sectionId)
  .max(40)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "A section cannot appear more than once in the list.",
  });

const layoutBody = z.object({
  /** Every band the user can see, in the order they want them. */
  order: uniqueSections,
  /** The ones folded away. A subset of `order` in practice, not enforced. */
  hidden: uniqueSections,
});

export type DashboardLayout = z.infer<typeof layoutBody>;

const dashboardQuery = z.object({
  /** Which month to report. Defaults to the one we are living in. */
  month: z
    .string()
    .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "Month must use the YYYY-MM format.")
    .optional(),
});

/* -------------------------------------------------------------------------- */
/* The route                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Panel General, in one request.
 *
 * One endpoint rather than eight, because every band is built from the same
 * contracts and the same payments, and eight requests would read them eight
 * times and could still disagree with each other if a payment landed between
 * two of them. A dashboard whose bands contradict one another is worse than no
 * dashboard.
 *
 * The whole of it is derived on read. Nothing here is stored, cached or
 * summarised into a table, so a payment corrected this afternoon moves every
 * figure on this screen — including last March's — the next time it is opened.
 * That is the same property receipts have, for the same reason.
 */
export const dashboardRoutes: FastifyPluginAsync<DashboardRoutesOptions> = async (
  app,
  options,
) => {
  app.get("/dashboard", async (request, reply) => {
    const parsed = dashboardQuery.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_query",
        message: parsed.error.issues[0]?.message ?? "Invalid parameters.",
      });
    }

    // Today in the office's calendar. Deriving it from UTC would open the
    // Panel General on next month from six in the evening onwards.
    const asOfToday = businessToday(options.timeZone);
    const currentMonth = monthOf(asOfToday);
    const month = parsed.data.month ?? currentMonth;

    if (month > currentMonth) {
      // Not a 404: the month exists, there is simply nothing to report from it
      // yet. Saying so is more use than an empty screen of zeroes that looks
      // like a business which has stopped selling.
      return reply.code(400).send({
        error: "future_month",
        message: "There is nothing to report for a month that has not arrived yet.",
      });
    }

    const isCurrentMonth = month === currentMonth;
    /*
     * Where the screen is being read FROM.
     *
     * Today for the current month, so the buckets match the Contratos tab. The
     * last day of the month otherwise, which is what makes paging back to July
     * show July as it stood when July ended, rather than July's money against
     * today's arrears. The pure functions in lib/contracts.ts take an `asOf`
     * precisely so this is possible: no health is stored, so any position in
     * time can be reconstructed.
     */
    const asOf = isCurrentMonth ? asOfToday : monthEnd(month);
    const previousMonth = shiftMonth(month, -1);
    const previousAsOf = monthEnd(previousMonth);

    const history = monthsEndingAt(month, HISTORY_MONTHS);
    const projectionMonths = monthsAfter(month, PROJECTION_MONTHS);
    const windowStart = `${history[0]}-01`;

    const rows = contractRows(app.db, asOf, previousAsOf);
    const assessed = rows.map((row) => assess(row, month, asOf, previousAsOf, isCurrentMonth));

    /*
     * The payments behind the chart and the month's breakdowns.
     *
     * Bounded to the window actually being drawn rather than "every payment
     * ever", so the cost of this screen does not grow with the age of the
     * business. Everything that genuinely needs all of history — each
     * contract's paid-to-date — is a SUM in the query above, which SQLite
     * answers from the (contract_id, paid_on) index without handing us rows.
     */
    const paymentRows = app.db
      .select({
        id: payments.id,
        customerId: contracts.customerId,
        customerName: customers.fullName,
        contractId: contracts.id,
        contractCode: contracts.code,
        lotCode: lots.code,
        amountCents: payments.amountCents,
        paidOn: payments.paidOn,
        type: payments.type,
        method: payments.method,
        recordedBy: payments.recordedBy,
        recorderName: users.name,
        projectId: projects.id,
        projectName: projects.name,
      })
      .from(payments)
      .innerJoin(contracts, eq(contracts.id, payments.contractId))
      .innerJoin(customers, eq(customers.id, contracts.customerId))
      .innerJoin(lots, eq(lots.id, contracts.lotId))
      .innerJoin(projects, eq(projects.id, lots.projectId))
      .innerJoin(users, eq(users.id, payments.recordedBy))
      .where(
        and(
          isNull(payments.reversedAt),
          gte(payments.paidOn, windowStart),
          // Never past the month being reported: paging back to July must not
          // show August's money in July's total.
          lte(payments.paidOn, monthEnd(month)),
        ),
      )
      .all();

    const activeLots = app.db
      .select({ id: lots.id, projectId: lots.projectId })
      .from(lots)
      .where(isNull(lots.archivedAt))
      .all();

    /* ---------------------------------------------------------------------- */
    /* Band 1 — the month                                                      */
    /* ---------------------------------------------------------------------- */

    const collectedByMonth = new Tally<string>();
    const collectedByProject = new Tally<string>();
    const previousByProject = new Tally<string>();
    /*
     * The previous month counted only as far into it as we have got into this
     * one — the first nine days of August against the first nine of September.
     *
     * Comparing a month that is one day old against a month that is complete
     * would print "−100 % frente a agosto" on the first of every month, for
     * every project, forever. That reading is arithmetically true and tells the
     * reader nothing except that months have a beginning.
     *
     * For a PAST month `asOf` is that month's last day, so the day-of-month
     * cutoff is 28–31 and the whole previous month is included. The same rule
     * therefore gives a like-for-like comparison in both cases, with no special
     * case for "is this the current month".
     */
    const asOfDay = Number(asOf.slice(8, 10));
    const withinSameSpan = (paidOn: string) => Number(paidOn.slice(8, 10)) <= asOfDay;
    let previousToDateCents = 0;
    const byType = new Tally<string>();
    const byMethod = new Tally<string>();
    const byUser = new Map<
      string,
      { name: string; collectedCents: number; cashCents: number; count: number }
    >();
    const payingCustomers = new Set<string>();
    const previousPayingCustomers = new Set<string>();

    /*
     * The month's payments, one row each, exactly as they were counted above.
     *
     * This is what the two breakdowns on the screen open into: "Clientes que
     * pagaron" groups it by customer, and a project's "Cobrado" filters it by
     * project. Both are groupings of THIS array rather than second queries of
     * their own, which is the only way a breakdown is guaranteed to add up to
     * the total it hangs under — a separate query, run a moment later or with
     * one predicate spelled differently, is free to disagree.
     *
     * It is filled inside the loop that does the summing, so a row cannot be in
     * the total and missing from the list.
     */
    const monthPayments: Array<{
      id: string;
      customerId: string;
      customerName: string;
      contractId: string;
      contractCode: string;
      lotCode: string;
      projectId: string;
      projectName: string;
      amountCents: number;
      paidOn: string;
      type: string;
      method: string;
    }> = [];

    for (const payment of paymentRows) {
      const paidMonth = monthOf(payment.paidOn);

      collectedByMonth.add(paidMonth, payment.amountCents);

      if (paidMonth === month) {
        collectedByProject.add(payment.projectId, payment.amountCents);
        monthPayments.push({
          id: payment.id,
          customerId: payment.customerId,
          customerName: payment.customerName,
          contractId: payment.contractId,
          contractCode: payment.contractCode,
          lotCode: payment.lotCode,
          projectId: payment.projectId,
          projectName: payment.projectName,
          amountCents: payment.amountCents,
          paidOn: payment.paidOn,
          type: payment.type,
          method: payment.method,
        });
        byType.add(payment.type, payment.amountCents);
        byMethod.add(payment.method, payment.amountCents);
        payingCustomers.add(payment.customerId);

        const recorder = byUser.get(payment.recordedBy) ?? {
          name: payment.recorderName,
          collectedCents: 0,
          cashCents: 0,
          count: 0,
        };
        recorder.collectedCents += payment.amountCents;
        // Cash is singled out because it is the only figure here that passed
        // through somebody's hands rather than a bank's.
        recorder.cashCents += payment.method === "cash" ? payment.amountCents : 0;
        recorder.count += 1;
        byUser.set(payment.recordedBy, recorder);
      }

      if (paidMonth === previousMonth && withinSameSpan(payment.paidOn)) {
        previousToDateCents += payment.amountCents;
        previousByProject.add(payment.projectId, payment.amountCents);
        previousPayingCustomers.add(payment.customerId);
      }
    }

    /** What was scheduled to arrive in a given month, across the whole book. */
    const expectedIn = (target: string) =>
      assessed.reduce(
        (total, entry) =>
          scheduleStands(entry.row, target) ? total + (entry.expected.get(target) ?? 0) : total,
        0,
      );

    /** Contracts signed in a month that are still standing. */
    const signedIn = (target: string) =>
      assessed.filter(
        (entry) => monthOf(entry.terms.signedOn) === target && scheduleStands(entry.row, target),
      );

    const signedThisMonth = signedIn(month);

    // Live contracts only: a settled or cancelled contract cannot owe this month.
    const live = assessed.filter((entry) => entry.row.status === "active" && !entry.settled);

    const stillDueCents = live.reduce(
      (total, entry) => total + Math.max(0, entry.expectedThroughMonthCents - entry.paidCents),
      0,
    );
    const stillDueContracts = live.filter(
      (entry) => entry.expectedThroughMonthCents > entry.paidCents,
    ).length;

    /* ---------------------------------------------------------------------- */
    /* Band 2 — collections                                                    */
    /* ---------------------------------------------------------------------- */

    const buckets = HEALTH_ORDER.map((status) => {
      const inBucket = live.filter((entry) => entry.status === status);

      return {
        status,
        contracts: inBucket.length,
        customers: new Set(inBucket.map((entry) => entry.row.customerId)).size,
        balanceCents: inBucket.reduce((total, entry) => total + entry.balanceCents, 0),
        arrearsCents: inBucket.reduce((total, entry) => total + entry.arrearsCents, 0),
      };
    });

    /** One row of the debtor worklist, and of the two change lists beside it. */
    const debtor = (entry: Assessed) => ({
      contractId: entry.row.id,
      contractCode: entry.row.code,
      customerId: entry.row.customerId,
      customerName: entry.row.customerName,
      phone: entry.row.customerPhone,
      lotCode: entry.row.lotCode,
      projectName: entry.row.projectName,
      status: entry.status,
      arrearsCents: entry.arrearsCents,
      balanceCents: entry.balanceCents,
      monthsBehind: entry.monthsBehind,
      lastPaymentOn: entry.row.lastPaymentOn,
    });

    const behind = live.filter((entry) => isBehind(entry.status));

    const worklist = [...behind]
      // By MONEY, not by months behind. Somebody four months late on L 1,800 a
      // month matters less than somebody two months late on L 12,000, and the
      // point of this list is the order to make the calls in.
      .sort((a, b) => b.arrearsCents - a.arrearsCents || b.monthsBehind - a.monthsBehind)
      .slice(0, WORKLIST_SIZE)
      .map(debtor);

    /*
     * Who CHANGED, which is the earliest warning this data can give.
     *
     * "14 atrasados" is a level and it barely moves. "3 se atrasaron este mes"
     * is a signal, and a customer who has just missed their first installment is
     * far more recoverable than one six months gone. Both lists are naturally
     * short — they can only hold people who crossed the line inside one month —
     * so neither is capped.
     */
    const slipped = live
      .filter((entry) => isBehind(entry.status) && !isBehind(entry.previousStatus))
      .sort((a, b) => b.arrearsCents - a.arrearsCents)
      .map(debtor);

    const recovered = assessed
      .filter(
        (entry) =>
          entry.row.status === "active" &&
          isBehind(entry.previousStatus) &&
          !isBehind(entry.status),
      )
      .map(debtor);

    /* ---------------------------------------------------------------------- */
    /* Band 3 — by project                                                     */
    /* ---------------------------------------------------------------------- */

    const takenLotIds = new Set(
      assessed.filter((entry) => entry.row.status === "active").map((entry) => entry.row.lotId),
    );
    const saleRateWindow = monthsEndingAt(month, SALE_RATE_MONTHS);

    const projectSummaries = [...new Map(rows.map((row) => [row.projectId, row.projectName]))]
      .map(([projectId, projectName]) => {
        const projectLive = live.filter((entry) => entry.row.projectId === projectId);
        const projectLots = activeLots.filter((lot) => lot.projectId === projectId);
        const lotsAvailable = projectLots.filter((lot) => !takenLotIds.has(lot.id)).length;
        const soldInWindow = saleRateWindow.reduce(
          (total, target) =>
            total +
            signedIn(target).filter((entry) => entry.row.projectId === projectId).length,
          0,
        );

        return {
          projectId,
          projectName,
          collectedCents: collectedByProject.get(projectId),
          previousToDateCents: previousByProject.get(projectId),
          outstandingCents: projectLive.reduce((total, entry) => total + entry.balanceCents, 0),
          arrearsCents: projectLive.reduce((total, entry) => total + entry.arrearsCents, 0),
          activeContracts: projectLive.length,
          behindContracts: projectLive.filter((entry) => isBehind(entry.status)).length,
          lotsTotal: projectLots.length,
          lotsAvailable,
          soldInWindow,
          monthsOfStock: monthsOfStock(lotsAvailable, soldInWindow, SALE_RATE_MONTHS),
        };
      })
      .sort(
        (a, b) =>
          b.collectedCents - a.collectedCents ||
          a.projectName.localeCompare(b.projectName, "es"),
      );

    /* ---------------------------------------------------------------------- */
    /* Band 4 — what is coming                                                 */
    /* ---------------------------------------------------------------------- */

    const expiryLimit = shiftDays(asOf, EXPIRY_HORIZON_DAYS);

    const expiringReservations = assessed
      .filter(
        (entry) =>
          entry.row.kind === "reservation" &&
          entry.row.status === "active" &&
          entry.row.expiresOn !== null &&
          entry.row.expiresOn <= expiryLimit,
      )
      .sort((a, b) => (a.row.expiresOn! < b.row.expiresOn! ? -1 : 1))
      .map((entry) => ({
        contractId: entry.row.id,
        contractCode: entry.row.code,
        customerName: entry.row.customerName,
        lotCode: entry.row.lotCode,
        projectName: entry.row.projectName,
        expiresOn: entry.row.expiresOn,
      }));

    /*
     * Contracts about to be paid off.
     *
     * Two jobs at once, and neither has a home anywhere else in the app: the
     * lot is about to need its escritura, and the customer is about to have
     * money free and a reason to buy again.
     */
    const finishingSoon = live
      .filter(
        (entry) =>
          entry.outstandingCount > 0 && entry.outstandingCount <= FINISHING_INSTALLMENTS,
      )
      .sort((a, b) => a.outstandingCount - b.outstandingCount || a.balanceCents - b.balanceCents)
      .map((entry) => ({
        contractId: entry.row.id,
        contractCode: entry.row.code,
        customerName: entry.row.customerName,
        lotCode: entry.row.lotCode,
        projectName: entry.row.projectName,
        balanceCents: entry.balanceCents,
        installmentsLeft: entry.outstandingCount,
      }));

    // The prima that was agreed against the prima that arrived. The Contratos
    // tab says this per row; only here can it be totalled.
    const unpaidPrimas = assessed.filter(
      (entry) =>
        entry.row.status === "active" &&
        entry.row.downPaymentCents > entry.row.downPaymentPaidCents,
    );

    /* ---------------------------------------------------------------------- */
    /* Band 5 — control                                                        */
    /* ---------------------------------------------------------------------- */

    /*
     * Gated on `audit:view` rather than on a capability of its own.
     *
     * Everything in this band answers the same question the change history
     * answers — what did the people with access to the money actually do — and
     * it is already the capability that defaults to the supervisor alone.
     * Inventing a second switch for the same question would mean two ways to
     * grant one thing, and a supervisor who revoked one and not the other.
     */
    const control = request.user && roleCan(app.db, request.user.role, "audit:view")
      ? {
          byUser: [...byUser]
            .map(([userId, totals]) => ({
              userId,
              userName: totals.name,
              collectedCents: totals.collectedCents,
              cashCents: totals.cashCents,
              payments: totals.count,
            }))
            .sort((a, b) => b.collectedCents - a.collectedCents),

          voidedReceipts: app.db
            .select({
              id: receipts.id,
              code: receipts.code,
              issuedOn: receipts.issuedOn,
              voidedAt: receipts.voidedAt,
              voidReason: receipts.voidReason,
              customerName: customers.fullName,
            })
            .from(receipts)
            .innerJoin(customers, eq(customers.id, receipts.customerId))
            // Both timestamp shapes this database contains — the application's
            // ISO string and SQLite's own "2026-08-26 15:02:23" — start with
            // the same "YYYY-MM", so one prefix match catches both.
            .where(sql`${receipts.voidedAt} LIKE ${`${month}%`}`)
            .all()
            .map((row) => ({ ...row })),

          /*
           * Transfers with nothing to reconcile them against.
           *
           * Money booked as arriving by bank, carrying neither the bank's
           * confirmation number nor a photo of the slip. Every one of these is
           * a figure that cannot be matched to a statement later, which is
           * exactly when somebody comes asking.
           */
          unprovenTransfers: app.db
            .select({
              count: sql<number>`COUNT(*)`,
              amountCents: sql<number>`COALESCE(SUM(${payments.amountCents}), 0)`,
            })
            .from(payments)
            .where(
              sql`${payments.reversedAt} IS NULL
                AND ${payments.method} = 'transfer'
                AND ${payments.paidOn} BETWEEN ${`${month}-01`} AND ${monthEnd(month)}
                AND (${payments.reference} IS NULL OR TRIM(${payments.reference}) = '')
                AND NOT EXISTS (
                  SELECT 1 FROM ${attachments}
                  WHERE ${attachments.receiptId} = ${payments.receiptId}
                )`,
            )
            .get() ?? { count: 0, amountCents: 0 },
        }
      : null;

    /* ---------------------------------------------------------------------- */

    return reply.send({
      month,
      previousMonth,
      /*
       * Sent with the data rather than fetched separately: the layout decides
       * the order the bands below are rendered in, so a second request would
       * mean a first paint in the default order that then rearranges itself
       * under the reader.
       *
       * `null` for somebody who has never customised it, which is different
       * from an empty layout and has to stay different — see `clearPreference`.
       */
      layout: request.user
        ? readPreference<DashboardLayout>(app.db, request.user.id, DASHBOARD_LAYOUT)
        : null,
      today: asOfToday,
      asOf,
      isCurrentMonth,

      income: {
        collectedCents: collectedByMonth.get(month),
        /** The previous month over the same span — see `withinSameSpan`. */
        previousToDateCents,
        /** How many days of the previous month that span covers. */
        comparisonDays: asOfDay,
        expectedCents: expectedIn(month),
        stillDueCents,
        stillDueContracts,
        payingCustomers: payingCustomers.size,
        previousPayingCustomers: previousPayingCustomers.size,
        signedCount: signedThisMonth.length,
        signedValueCents: signedThisMonth.reduce(
          (total, entry) => total + entry.terms.salePriceCents,
          0,
        ),
        /*
         * The two counters above, opened up.
         *
         * Same rule as `monthPayments`: each list is built from exactly the
         * rows its counter was derived from, so "8 contratos nuevos" opens into
         * eight rows and never into seven or nine.
         */
        payments: [...monthPayments].sort(
          (a, b) => b.paidOn.localeCompare(a.paidOn) || a.customerName.localeCompare(b.customerName, "es"),
        ),
        signed: [...signedThisMonth]
          .sort(
            (a, b) =>
              b.terms.signedOn.localeCompare(a.terms.signedOn) ||
              b.terms.salePriceCents - a.terms.salePriceCents,
          )
          .map((entry) => ({
            contractId: entry.row.id,
            contractCode: entry.row.code,
            customerId: entry.row.customerId,
            customerName: entry.row.customerName,
            lotCode: entry.row.lotCode,
            projectName: entry.row.projectName,
            saleType: entry.row.saleType,
            signedOn: entry.terms.signedOn,
            salePriceCents: entry.terms.salePriceCents,
            downPaymentCents: entry.terms.downPaymentCents,
          })),
        // Where the month's money came from. A month carried by one large prima
        // is not a month that repeats, and the headline figure cannot say so.
        byType: {
          downPayment: byType.get("down_payment"),
          installment: byType.get("installment"),
          fullPayment: byType.get("full_payment"),
          adjustment: byType.get("adjustment"),
        },
        byMethod: {
          cash: byMethod.get("cash"),
          transfer: byMethod.get("transfer"),
          card: byMethod.get("card"),
        },
      },

      history: history.map((target) => ({
        month: target,
        collectedCents: collectedByMonth.get(target),
        expectedCents: expectedIn(target),
        signedCount: signedIn(target).length,
      })),

      collections: {
        buckets,
        settledContracts: assessed.filter(
          (entry) => entry.row.status === "active" && entry.settled,
        ).length,
        worklist,
        slipped,
        recovered,
      },

      projects: projectSummaries,

      upcoming: {
        projection: projectionMonths.map((target) => ({
          month: target,
          expectedCents: expectedIn(target),
          contracts: assessed.filter(
            (entry) => scheduleStands(entry.row, target) && (entry.expected.get(target) ?? 0) > 0,
          ).length,
        })),
        expiringReservations,
        finishingSoon,
        unpaidPrimas: {
          contracts: unpaidPrimas.length,
          amountCents: unpaidPrimas.reduce(
            (total, entry) =>
              total + (entry.row.downPaymentCents - entry.row.downPaymentPaidCents),
            0,
          ),
        },
      },

      control,
    });
  });

  /*
   * Save this user's arrangement of the screen.
   *
   * No capability guard: arranging your own dashboard is not an action on
   * anybody's data, and a supervisor who had to grant it would be granting the
   * right to have a preference. What DOES matter is whose settings are written,
   * and that is never taken from the body — `request.user` comes from the
   * session, so there is no request that rearranges somebody else's screen.
   */
  app.put("/dashboard/layout", { onRequest: app.requireUser }, async (request, reply) => {
    const parsed = layoutBody.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        message: parsed.error.issues[0]?.message ?? "Could not save the order.",
      });
    }

    writePreference(app.db, request.user!.id, DASHBOARD_LAYOUT, parsed.data);

    return reply.send({ layout: parsed.data });
  });

  /** Go back to following the default order, rather than freezing today's. */
  app.delete("/dashboard/layout", { onRequest: app.requireUser }, async (request, reply) => {
    clearPreference(app.db, request.user!.id, DASHBOARD_LAYOUT);

    return reply.send({ layout: null });
  });
};

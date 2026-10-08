/**
 * The arithmetic behind the Panel General.
 *
 * Every screen in Lindero except this one asks about a ROW: this contract, this
 * customer, this lot. The Panel General is the only place that asks questions
 * needing an answer across all of them at once, or across time — "did August
 * beat July", "who stopped paying since last month", "what falls due in
 * November". That is the whole reason the screen exists, and it is why nothing
 * here duplicates what a row can already answer for itself.
 *
 * Nothing in this file reads or writes the database, so all of it is testable
 * against plain objects. The database work lives in routes/dashboard.ts.
 *
 * Two rules carry through everything below:
 *
 * - A month is decided by `paidOn`, the day the money actually moved — never by
 *   the day the row was typed in. A July payment entered in August belongs to
 *   July, and a comparison between the two months is worthless otherwise.
 * - Amounts are the lempira centavos on the payment, which were converted at
 *   the rate that payment was really settled at. Nothing here re-converts
 *   anything at today's rate; doing so would silently rewrite last year.
 */
import { buildSchedule } from "./contracts.js";
/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */
/*
 * Months are handled as "YYYY-MM" strings and built through UTC, for the same
 * reason src/lib/contracts.ts handles dates that way: `new Date("2026-03-01")`
 * on a machine set to Tegucigalpa is the 29th of February at 18:00 local, and a
 * month boundary that moves with the server's timezone is not a boundary.
 */
/** The month a calendar date or an ISO timestamp falls in: "2026-08". */
export function monthOf(isoDate) {
    return isoDate.slice(0, 7);
}
/** The last day of a month, whatever length that month happens to be. */
export function monthEnd(month) {
    const year = Number(month.slice(0, 4));
    // Day 0 of the FOLLOWING month is the last day of this one, which is also
    // what makes February come out right in a leap year without a special case.
    const monthNumber = Number(month.slice(5, 7));
    return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}
/** `delta` months from `month`, forwards or backwards. The year rolls itself. */
export function shiftMonth(month, delta) {
    const year = Number(month.slice(0, 4));
    const monthIndex = Number(month.slice(5, 7)) - 1;
    return new Date(Date.UTC(year, monthIndex + delta, 1)).toISOString().slice(0, 7);
}
/** `count` consecutive months ending at `month`, oldest first. */
export function monthsEndingAt(month, count) {
    return Array.from({ length: count }, (_, index) => shiftMonth(month, index - count + 1));
}
/** `count` consecutive months starting the month AFTER `month`, soonest first. */
export function monthsAfter(month, count) {
    return Array.from({ length: count }, (_, index) => shiftMonth(month, index + 1));
}
/* -------------------------------------------------------------------------- */
/* What a contract is scheduled to bring in                                    */
/* -------------------------------------------------------------------------- */
/**
 * Everything this contract is scheduled to bring in, bucketed by month.
 *
 * This is the figure that turns "we collected L 340,000 in August" from a
 * number into a judgement. On its own the number cannot tell you whether August
 * was a bad month or simply a month with fewer installments falling due; beside
 * what was scheduled, it can.
 *
 * Built once per contract and read for many months, rather than asking "what is
 * due in November" twelve times and rebuilding the whole schedule each time.
 *
 * Three sale types, three different answers:
 *
 * - A donation is a transfer of land for no money. It expects nothing, ever.
 * - A cash sale is settled at signing, so the whole price falls due in the one
 *   month the contract was signed in.
 * - A financed sale expects the prima in its signing month and then each
 *   installment in the month it falls due. The prima is added separately
 *   because `buildSchedule` covers the FINANCED part only — the down payment is
 *   not installment one.
 */
export function expectedByMonth(terms) {
    const expected = new Map();
    const add = (month, amountCents) => {
        if (amountCents > 0) {
            expected.set(month, (expected.get(month) ?? 0) + amountCents);
        }
    };
    if (terms.saleType === "donation") {
        return expected;
    }
    if (terms.saleType === "cash") {
        add(monthOf(terms.signedOn), terms.salePriceCents);
        return expected;
    }
    add(monthOf(terms.signedOn), terms.downPaymentCents);
    for (const installment of buildSchedule(terms)) {
        add(monthOf(installment.dueOn), installment.amountCents);
    }
    return expected;
}
/* -------------------------------------------------------------------------- */
/* Payment health, in the aggregate                                            */
/* -------------------------------------------------------------------------- */
/**
 * Is this customer actually behind, as opposed to merely approaching a due
 * date?
 *
 * `due_soon` deliberately counts as NOT behind. It covers the week before an
 * installment falls due and the five-day grace after it, which is a reason to
 * make a phone call and not a reason to appear in a list of debtors. Putting it
 * on the wrong side of this line would report a healthy book as a failing one
 * every month, five days after the due day.
 */
export function isBehind(status) {
    return status === "overdue" || status === "at_risk";
}
/**
 * The four payment-health buckets, in the order they escalate.
 *
 * Exported as a list rather than written out at each call site so the summary
 * counters, the chart legend and the response all agree on both the set and the
 * order — the same reason HEALTH_PRESENTATION exists on the frontend.
 */
export const HEALTH_ORDER = [
    "current",
    "due_soon",
    "overdue",
    "at_risk",
];
/* -------------------------------------------------------------------------- */
/* Sell-out rate                                                               */
/* -------------------------------------------------------------------------- */
/**
 * How many months of stock are left at the rate this project has been selling,
 * or `null` when the question has no honest answer.
 *
 * `null` in three cases, all of which have to stay apart from "0 months":
 * nothing has sold in the window, so there is no rate to project; there is
 * nothing left to sell; or the window is empty. A project that sold nothing is
 * not a project that sells out today, and rendering it as a number would say
 * exactly that.
 *
 * Deliberately a trailing average rather than last month's figure. Land sells
 * in bursts — three lots in one week and nothing for two months — so a single
 * month is noise, and a projection built on noise is worse than none.
 */
export function monthsOfStock(lotsAvailable, soldInWindow, windowMonths) {
    if (lotsAvailable <= 0 || soldInWindow <= 0 || windowMonths <= 0) {
        return null;
    }
    return Math.round((lotsAvailable * windowMonths) / soldInWindow);
}
/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */
/**
 * A running total that starts at zero for every key, so callers never have to
 * write `map.get(k) ?? 0` before adding to it.
 *
 * Small, but it appears a dozen times in routes/dashboard.ts — collected by
 * month, by project, by user, by payment type, by method — and each of those
 * written out by hand is another chance to add to a total that is `undefined`
 * and turn the whole figure into NaN, which renders as a blank cell rather than
 * as an error anybody would notice.
 */
export class Tally {
    totals = new Map();
    add(key, amount) {
        this.totals.set(key, (this.totals.get(key) ?? 0) + amount);
    }
    get(key) {
        return this.totals.get(key) ?? 0;
    }
}
//# sourceMappingURL=dashboard.js.map
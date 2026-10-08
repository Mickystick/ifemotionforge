/**
 * The arithmetic of a contract: when money is due, and whether it arrived.
 *
 * Everything here is a pure function of the contract's agreed terms plus the
 * payments actually posted against it. Nothing in this file reads or writes the
 * database, and nothing it produces is ever stored — a saved "payment alert
 * status" is stale by the following morning, which is exactly how a spreadsheet
 * ends up reassuring somebody about a customer who stopped paying in March.
 *
 * The business rules, agreed with the owner:
 *
 * - An installment is not late until FIVE days after its due date.
 * - Two months behind is no longer merely late; it needs attention.
 * - Everything is denominated in lempiras. A customer who pays in dollars has
 *   the bank's actual rate for that day recorded on the payment itself, so the
 *   accounts are built from what was really received rather than from today's
 *   display rate applied backwards.
 */
/** Days after the due date before an installment counts as late. */
export const GRACE_DAYS = 5;
/** Months behind at which a contract stops being merely late. */
export const AT_RISK_MONTHS = 2;
/** How early an upcoming installment starts showing as "por vencer". */
export const DUE_SOON_DAYS = 7;
const DAY_MS = 86_400_000;
/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */
/*
 * Calendar dates are handled as UTC milliseconds throughout. Parsing
 * "2026-03-05" with `new Date()` in a browser or a server set to Tegucigalpa
 * yields the 4th at 18:00 local, and a due date that moves depending on where
 * the code runs is not a due date.
 */
function utcDay(isoDate) {
    return Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
}
function toIsoDate(millis) {
    return new Date(millis).toISOString().slice(0, 10);
}
function daysInMonth(year, monthIndex) {
    // Day 0 of the following month is the last day of this one.
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from, to) {
    return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}
export function shiftDays(isoDate, days) {
    return toIsoDate(utcDay(isoDate) + days * DAY_MS);
}
/**
 * The same day-of-month, `months` later, clamped to months that are too short
 * to have one.
 *
 * A contract with a due day of the 31st still falls due in February, and it
 * falls due on the 28th — or the 29th in a leap year. Letting the date roll
 * forward into March instead, which is what naive month arithmetic does, would
 * silently grant an extra three days every February and put the schedule out of
 * step with the paper contract for the rest of its life.
 */
export function addMonthsOnDay(isoDate, months, day) {
    // Month overflow past December rolls the year over on its own.
    const target = new Date(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1 + months, 1));
    const targetYear = target.getUTCFullYear();
    const targetMonth = target.getUTCMonth();
    return toIsoDate(Date.UTC(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth))));
}
/**
 * When the first installment falls due.
 *
 * Default: one whole month after signing, on the agreed due day. Signing on
 * 15 January with a due day of the 5th means the first installment is due on
 * 5 February, not three weeks after the customer handed over the prima.
 *
 * `firstDueOn` overrides it, because this is genuinely negotiated — "empezamos
 * a pagar en enero" is a normal thing to agree to, and a rule cannot guess it.
 */
export function firstDueDate(terms) {
    if (terms.firstDueOn) {
        return terms.firstDueOn;
    }
    if (terms.dueDay === null) {
        return null;
    }
    return addMonthsOnDay(terms.signedOn, 1, terms.dueDay);
}
/* -------------------------------------------------------------------------- */
/* The schedule                                                                */
/* -------------------------------------------------------------------------- */
/** What is financed after the prima: the part being paid in installments. */
export function financedCents(terms) {
    return Math.max(0, terms.salePriceCents - terms.downPaymentCents);
}
/**
 * Has this reservation lapsed?
 *
 * A reservation is the one contract kind required to carry an `expiresOn`, and
 * the whole point of that date is that the hold ENDS on it — the lot goes back
 * on the market by itself. Nothing sweeps expired reservations to a closed
 * status; like every other status in this app, it is derived on read. A signed
 * `contract` never expires this way, only a `reservation`.
 *
 * `asOf` and `expiresOn` are both YYYY-MM-DD calendar dates, so a plain string
 * comparison orders them correctly.
 */
export function isReservationExpired(kind, expiresOn, asOf) {
    return kind === "reservation" && expiresOn != null && expiresOn < asOf;
}
/**
 * The installments, derived rather than stored.
 *
 * There is no payment-schedule table yet, and there should not be one until
 * contracts can be restructured: a generated schedule cannot drift from the
 * terms it was generated from, whereas a stored one silently can, and then two
 * screens disagree about when a customer is due.
 *
 * The LAST installment absorbs the rounding. An agreed L 3,500 a month over 24
 * months against L 84,300 financed leaves L 300 unaccounted for, and it is the
 * final payment that is short or long — never a fractional monthly nobody could
 * hand over at a window.
 */
export function buildSchedule(terms) {
    if (terms.saleType !== "financed") {
        return [];
    }
    const months = terms.termMonths ?? 0;
    const monthly = terms.monthlyPaymentCents ?? 0;
    const first = firstDueDate(terms);
    if (months < 1 || monthly < 1 || first === null || terms.dueDay === null) {
        return [];
    }
    const financed = financedCents(terms);
    const schedule = [];
    let placed = 0;
    for (let index = 0; index < months; index += 1) {
        const isLast = index === months - 1;
        // Whatever is left on the final one, so the schedule sums to exactly the
        // financed amount rather than to monthly × months.
        const amountCents = isLast ? Math.max(0, financed - placed) : Math.min(monthly, financed - placed);
        if (amountCents <= 0 && !isLast) {
            // The agreed monthly has already covered the whole financed amount, so
            // the remaining installments are not owed. Stop rather than list zeros.
            break;
        }
        placed += amountCents;
        schedule.push({
            number: index + 1,
            dueOn: addMonthsOnDay(first, index, terms.dueDay),
            amountCents,
        });
    }
    return schedule;
}
/**
 * How much the contract says should have been received by `asOf`.
 *
 * The prima counts from the signing date; installments count from their due
 * dates. A cash sale expects the whole price at signing, and a donation expects
 * nothing, ever.
 */
function expectedByCents(terms, schedule, asOf) {
    if (terms.saleType === "donation") {
        return 0;
    }
    if (utcDay(asOf) < utcDay(terms.signedOn)) {
        return 0;
    }
    if (terms.saleType === "cash") {
        return terms.salePriceCents;
    }
    let expected = terms.downPaymentCents;
    for (const installment of schedule) {
        if (utcDay(installment.dueOn) <= utcDay(asOf)) {
            expected += installment.amountCents;
        }
    }
    return Math.min(expected, terms.salePriceCents);
}
/**
 * The installments this contract still owes money on, in due-date order.
 *
 * The FIRST entry carries only what is left of it, so a part-paid installment
 * asks for the difference rather than for the whole amount again. Every entry
 * after it is untouched.
 *
 * The list is what makes "next due" mean the next installment MONEY IS STILL
 * OWED ON rather than the next one on the calendar. A customer who pays three
 * months at once has nothing to do in months two and three, and telling them a
 * payment is due next week is how an app teaches people to ignore it.
 *
 * The prima is deducted before the walk begins because `buildSchedule` covers
 * the FINANCED part only — the down payment is not installment one.
 */
export function outstandingInstallments(terms, paidToDateCents) {
    let uncovered = Math.max(0, paidToDateCents - terms.downPaymentCents);
    const outstanding = [];
    for (const installment of buildSchedule(terms)) {
        // Only installments BEFORE the first uncovered one can be skipped. Once one
        // has been kept, everything after it is owed in full whatever the arithmetic
        // says, because the money ran out at that point.
        if (outstanding.length === 0 && uncovered >= installment.amountCents) {
            uncovered -= installment.amountCents;
            continue;
        }
        outstanding.push(outstanding.length === 0
            ? { ...installment, amountCents: installment.amountCents - uncovered }
            : installment);
    }
    return outstanding;
}
/**
 * Where this contract stands today.
 *
 * Note the two different expectations, which is the part worth reading twice:
 *
 * - Arrears are measured against what was due AFTER the five-day grace, so a
 *   customer who pays on the 8th for a due date of the 5th is never called
 *   late.
 * - Being ahead is measured against the plain schedule, with no grace. Using
 *   the graced figure for both would announce that somebody who paid exactly on
 *   their due date is a month ahead, every month, for the life of the contract.
 */
export function assessContract(terms, paidToDateCents, asOf) {
    const schedule = buildSchedule(terms);
    const balanceCents = Math.max(0, terms.salePriceCents - paidToDateCents);
    const settled = terms.salePriceCents - paidToDateCents <= 0;
    const dueBySchedule = expectedByCents(terms, schedule, asOf);
    const dueAfterGrace = expectedByCents(terms, schedule, shiftDays(asOf, -GRACE_DAYS));
    const arrearsCents = settled ? 0 : Math.max(0, dueAfterGrace - paidToDateCents);
    const aheadCents = Math.max(0, paidToDateCents - dueBySchedule);
    // A cash sale or a donation has no monthly, so arrears cannot be counted in
    // months. Any arrears at all on one of those is a single overdue debt.
    const monthly = terms.monthlyPaymentCents ?? 0;
    const monthsBehind = monthly > 0 ? Math.ceil(arrearsCents / monthly) : arrearsCents > 0 ? 1 : 0;
    const monthsAhead = monthly > 0 ? Math.floor(aheadCents / monthly) : 0;
    const upcoming = outstandingInstallments(terms, paidToDateCents)[0];
    const upcomingInFull = upcoming === undefined
        ? 0
        : (buildSchedule(terms).find((installment) => installment.number === upcoming.number)
            ?.amountCents ?? upcoming.amountCents);
    let status = "current";
    if (monthsBehind >= AT_RISK_MONTHS) {
        status = "at_risk";
    }
    else if (monthsBehind >= 1) {
        status = "overdue";
    }
    else if (!settled &&
        upcoming !== undefined &&
        daysBetween(asOf, upcoming.dueOn) <= DUE_SOON_DAYS) {
        status = "due_soon";
    }
    return {
        status,
        balanceCents,
        arrearsCents,
        monthsBehind,
        monthsAhead,
        nextDueOn: settled ? null : (upcoming?.dueOn ?? null),
        nextDueAmountCents: settled ? 0 : (upcoming?.amountCents ?? 0),
        nextInstallmentCents: settled ? 0 : upcomingInFull,
        nextDueCreditCents: settled || upcoming === undefined ? 0 : upcomingInFull - upcoming.amountCents,
        settled,
    };
}
/**
 * Which installments a payment went towards, given the paid-to-date either side
 * of it.
 *
 * This is the line a receipt needs in order to be worth keeping: "cuota 7 de 24
 * — L 3,500; abono a capital — L 1,500" is an answer, where "recibí L 5,000" is
 * only a number. What the money was applied to is disputed far more often than
 * how much of it there was.
 *
 * The prima is deducted first because the schedule in `buildSchedule` covers
 * the FINANCED part only — the down payment is not installment 1. A payment
 * that lands entirely inside the prima therefore covers no installments and
 * returns an empty list, which is correct: it was a prima, not a cuota.
 */
export function appliedInstallments(terms, paidBeforeCents, paidAfterCents) {
    const schedule = buildSchedule(terms);
    if (schedule.length === 0 || paidAfterCents <= paidBeforeCents) {
        return [];
    }
    // Position within the FINANCED part, so the prima does not shift the numbering.
    const from = Math.max(0, paidBeforeCents - terms.downPaymentCents);
    const to = Math.max(0, paidAfterCents - terms.downPaymentCents);
    const applied = [];
    let cursor = 0;
    for (const installment of schedule) {
        const start = cursor;
        const end = cursor + installment.amountCents;
        cursor = end;
        // How much of THIS payment landed inside this installment's slice.
        const overlap = Math.min(to, end) - Math.max(from, start);
        if (overlap <= 0) {
            if (start >= to) {
                break;
            }
            continue;
        }
        applied.push({
            number: installment.number,
            dueOn: installment.dueOn,
            appliedCents: overlap,
            settled: to >= end,
        });
    }
    return applied;
}
//# sourceMappingURL=contracts.js.map
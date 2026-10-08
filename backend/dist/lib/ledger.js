/**
 * The running balance of a contract, replayed from its transactions.
 *
 * This file exists to kill a specific class of bug — the one that makes a
 * spreadsheet unusable as a book of receipts.
 *
 * In a spreadsheet, "saldo anterior" and "saldo nuevo" are rollups, so they
 * always show TODAY's figures. Print a receipt in March and open it again in
 * May and it has quietly rewritten itself: the customer's paper and the screen
 * no longer agree, and there is no way to tell which is the lie. The usual fix
 * is to freeze the numbers into columns and lock the row — which trades the
 * first bug for a worse one, because a frozen number is stale the moment an old
 * payment is corrected, and nothing on the row admits it.
 *
 * Neither is necessary. A balance is not a fact that has to be stored; it is a
 * fact that has to be DERIVED, at a stated position in an ordered ledger:
 *
 *     saldo anterior = charges − credits posted strictly before this one
 *     saldo nuevo    = saldo anterior − this transaction
 *
 * Derive it and both problems vanish at once. Every receipt shows the numbers
 * that were true at its own position, permanently, with nothing to lock and
 * nothing to forget. And correcting a payment from two months ago — or the
 * prima from last year — re-derives every receipt after it into figures that
 * still add up, because they were never numbers in the first place. They were a
 * query.
 *
 * Nothing here reads or writes the database, so all of it is testable against
 * plain arrays.
 */
import { parseTimestamp } from "./time.js";
/**
 * The total order over one contract's transactions, and the single most
 * load-bearing decision in this file.
 *
 * "Previous balance" is meaningless without an answer to "previous to WHAT?",
 * and `paidOn` alone cannot give one: it is a calendar date, so two payments on
 * the same day tie, and a tie means two screens can disagree about which came
 * first — which is precisely the disagreement that makes a customer stop
 * trusting the receipts.
 *
 * So the key is three parts deep and the last one cannot tie:
 *
 *  1. `paidOn`   — the day the money actually moved. This is what makes a
 *                  payment entered late land in its real place in history
 *                  rather than at the end.
 *  2. `createdAt` — the order they were entered, for two payments on one day.
 *  3. `id`        — arbitrary, but STABLE, so the order never depends on which
 *                  row SQLite happened to return first.
 *
 * `createdAt` is compared as a parsed instant rather than as text. Rows written
 * by the application carry "2026-08-26T15:02:23.451Z" and rows written by a
 * column default carry SQLite's "2026-08-26 15:02:23"; comparing those as
 * strings sorts every space-form row before every T-form row on the same day,
 * because ' ' < 'T'. See src/lib/time.ts.
 */
export function compareLedgerOrder(a, b) {
    if (a.paidOn !== b.paidOn) {
        return a.paidOn < b.paidOn ? -1 : 1;
    }
    const createdDelta = parseTimestamp(a.createdAt) - parseTimestamp(b.createdAt);
    if (createdDelta !== 0) {
        return createdDelta;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** The same transactions, in ledger order. Does not mutate the input. */
export function orderLedger(entries) {
    return [...entries].sort(compareLedgerOrder);
}
/**
 * A reversed payment stops counting, but is never deleted and never edited.
 *
 * Kept as its own named function because it is the rule the whole app agrees
 * on — the same `reversed_at IS NULL` that routes/lots.ts, routes/customers.ts
 * and routes/contracts.ts each apply in SQL.
 */
export function isCounted(credit) {
    return !credit.reversedAt;
}
/**
 * Replay one contract's ledger from the beginning.
 *
 * O(n log n) in the number of transactions, run on demand. A contract has a few
 * dozen payments over its life, so replaying from zero on every read is
 * cheaper than the machinery it would take to cache it correctly — and cached
 * balances that fall out of step with their payments are the exact failure this
 * file exists to prevent.
 */
export function replayContract(input) {
    const credits = orderLedger(input.credits.filter(isCounted));
    const charges = [...(input.charges ?? [])].sort((a, b) => a.incurredOn === b.incurredOn ? (a.id < b.id ? -1 : 1) : a.incurredOn < b.incurredOn ? -1 : 1);
    const lines = [];
    let chargedSoFar = input.salePriceCents;
    let creditedSoFar = 0;
    let nextCharge = 0;
    for (const entry of credits) {
        // Charges that fell due on or before this transaction's date are owed by
        // the time it is made, so they are inside the "saldo anterior" the customer
        // is shown — not added afterwards, which would print a receipt whose own
        // arithmetic does not work.
        let chargesApplied = 0;
        while (nextCharge < charges.length && charges[nextCharge].incurredOn <= entry.paidOn) {
            chargesApplied += charges[nextCharge].amountCents;
            nextCharge += 1;
        }
        chargedSoFar += chargesApplied;
        const balanceBeforeCents = Math.max(0, chargedSoFar - creditedSoFar);
        creditedSoFar += entry.amountCents;
        lines.push({
            entry,
            balanceBeforeCents,
            balanceAfterCents: Math.max(0, chargedSoFar - creditedSoFar),
            paidToDateCents: creditedSoFar,
            chargesAppliedCents: chargesApplied,
        });
    }
    // Anything dated after the last transaction still counts towards the total.
    for (let index = nextCharge; index < charges.length; index += 1) {
        chargedSoFar += charges[index].amountCents;
    }
    return {
        totalChargesCents: chargedSoFar,
        totalCreditedCents: creditedSoFar,
        balanceCents: Math.max(0, chargedSoFar - creditedSoFar),
        lines,
        overpaidCents: Math.max(0, creditedSoFar - chargedSoFar),
    };
}
/**
 * What one receipt should print, computed by replaying each contract it touches
 * and reading off the position this receipt occupies.
 *
 * The receipt itself contributes nothing to these figures beyond WHICH payments
 * it covers. That is what makes a correction to an older payment flow through
 * automatically: this function is asked again, the ledger is one transaction
 * different, and the answer changes to one that still adds up.
 */
export function receiptFigures(input) {
    const onThisReceipt = new Set(input.paymentIds);
    const byContract = new Map();
    for (const credit of input.customerCredits) {
        const list = byContract.get(credit.contractId);
        if (list) {
            list.push(credit);
        }
        else {
            byContract.set(credit.contractId, [credit]);
        }
    }
    const lines = [];
    let previousBalanceCents = 0;
    let newBalanceCents = 0;
    let totalPaidCents = 0;
    for (const [contractId, credits] of byContract) {
        const charges = input.chargesByContract?.get(contractId);
        const ledger = replayContract({
            salePriceCents: input.salePriceByContract.get(contractId) ?? 0,
            credits,
            ...(charges ? { charges } : {}),
        });
        for (const line of ledger.lines) {
            if (!onThisReceipt.has(line.entry.id)) {
                continue;
            }
            lines.push({
                contractId,
                paymentId: line.entry.id,
                amountCents: line.entry.amountCents,
                balanceBeforeCents: line.balanceBeforeCents,
                balanceAfterCents: line.balanceAfterCents,
            });
            previousBalanceCents += line.balanceBeforeCents;
            newBalanceCents += line.balanceAfterCents;
            totalPaidCents += line.entry.amountCents;
        }
    }
    // Stable output regardless of Map iteration order, so two calls with the same
    // data render the same document.
    lines.sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
    const excluded = input.excludeFromCumulative;
    const cumulativeCredits = excluded && excluded.size > 0
        ? input.customerCredits.filter((credit) => !excluded.has(credit.contractId) || onThisReceipt.has(credit.id))
        : input.customerCredits;
    return {
        lines,
        totalPaidCents,
        previousBalanceCents,
        newBalanceCents,
        cumulativePaidCents: cumulativePaidThrough(cumulativeCredits, onThisReceipt),
    };
}
/**
 * Everything the customer had paid, across all their contracts, by the time
 * this receipt was issued.
 *
 * "By the time" is measured against the LAST of this receipt's payments in
 * ledger order, so a receipt covering three lots counts all three of its own
 * lines and nothing that came after it. Anything posted later — including a
 * payment back-dated into this period months from now — correctly moves this
 * figure on every receipt it precedes, which is the behaviour a frozen column
 * cannot give.
 */
function cumulativePaidThrough(customerCredits, onThisReceipt) {
    const ordered = orderLedger(customerCredits.filter(isCounted));
    let lastIndex = -1;
    for (let index = 0; index < ordered.length; index += 1) {
        if (onThisReceipt.has(ordered[index].id)) {
            lastIndex = index;
        }
    }
    let total = 0;
    for (let index = 0; index <= lastIndex; index += 1) {
        total += ordered[index].amountCents;
    }
    return total;
}
//# sourceMappingURL=ledger.js.map
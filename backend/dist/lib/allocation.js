/**
 * Splitting one payment across the lots of one purchase.
 *
 * A customer who bought three lots hands over a single amount and expects a
 * single receipt. The money still has to land on three contracts, because each
 * lot is released, titled or repossessed on its own — see the note on
 * `saleGroupId` in src/db/schema.ts.
 *
 * The split is equal, to the centavo. L 14,500 over two lots is 7,250 + 7,250;
 * L 25,000 over three is 8,333.34 + 8,333.33 + 8,333.33, the one leftover
 * centavo going to the lot that owes the most. Shares used to be rounded to
 * whole hundreds (8,400 + 8,300 + 8,300), a habit from splitting by hand that
 * only made the lots look uneven here.
 *
 * Equal yields in exactly two places, both to keep a payment from posting
 * wrong: a lot never gets more than it still owes, and never less than its own
 * next installment while the total can cover that. Whatever those two rules
 * move is shared equally among the other lots.
 *
 * Nothing here writes anything. The routes call it to propose a split, which a
 * person can then override line by line before the payments are posted — the
 * proposal is a convenience, never a decision.
 */
/**
 * Divide `amountCents` equally, to the centavo, across the lots that still owe
 * something.
 *
 * Each lot's share is one common level, held between two bounds of its own:
 * at least its next installment (`minimumDueCents`) and at most its balance.
 * The level is the highest one the money reaches, so with no bounds in play
 * every lot gets the same, and when one applies the rest stay equal among
 * themselves. Two lots owing 49.02 and 7,200 now, with 14,500 handed over,
 * get 7,250 each; had the second owed 7,300 now, it would get 7,300 and the
 * other 7,200.
 *
 * Centavos that do not divide (L 0.01 of L 25,000 over three lots) go one each
 * to the lots that owe the most, so the same lot does not take them every
 * month. A lot that is paid off drops out. Money beyond what the whole
 * purchase owes is returned as `unallocatedCents`, not absorbed.
 *
 * When the total cannot cover every lot's next installment, the smallest
 * installments are covered first, so as many lots as possible come out
 * current, and the rest are listed in `shortOfMinimumContractIds`.
 */
export function splitEvenly(amountCents, targets) {
    // Largest balance first: the order the odd centavos are handed out in.
    const eligible = [...targets]
        .filter((target) => target.balanceCents > 0)
        .sort((a, b) => b.balanceCents - a.balanceCents || a.code.localeCompare(b.code));
    const minimums = eligible.map((target) => Math.min(Math.max(0, target.minimumDueCents ?? 0), target.balanceCents));
    const balances = eligible.map((target) => target.balanceCents);
    const sum = (values) => values.reduce((total, value) => total + value, 0);
    const result = (shares, unallocatedCents) => ({
        allocations: eligible
            .map((target, index) => ({ contractId: target.contractId, amountCents: shares[index] }))
            .filter((allocation) => allocation.amountCents > 0),
        unallocatedCents,
        shortOfMinimumContractIds: eligible
            .filter((_, index) => shares[index] < minimums[index])
            .map((target) => target.contractId),
    });
    if (amountCents <= 0 || eligible.length === 0) {
        return { allocations: [], unallocatedCents: Math.max(0, amountCents), shortOfMinimumContractIds: [] };
    }
    // Enough to clear every lot: each gets its balance, and the rest goes back.
    if (amountCents >= sum(balances)) {
        return result(balances, amountCents - sum(balances));
    }
    // Not enough for every lot's next installment: smallest installments first.
    if (amountCents < sum(minimums)) {
        const shares = eligible.map(() => 0);
        let remaining = amountCents;
        const bySmallestMinimum = eligible
            .map((_, index) => index)
            .sort((a, b) => minimums[a] - minimums[b] || eligible[a].code.localeCompare(eligible[b].code));
        for (const index of bySmallestMinimum) {
            shares[index] = Math.min(minimums[index], remaining);
            remaining -= shares[index];
        }
        return result(shares, 0);
    }
    // The common level: the highest one at which every lot's share, held
    // between its minimum and its balance, still adds up to no more than the
    // amount. Found by bisection over whole centavos.
    const shareAt = (level) => eligible.map((_, index) => Math.min(Math.max(level, minimums[index]), balances[index]));
    let low = 0;
    let high = Math.max(...balances);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (sum(shareAt(middle)) <= amountCents) {
            low = middle;
        }
        else {
            high = middle - 1;
        }
    }
    const shares = shareAt(low);
    let leftover = amountCents - sum(shares);
    // Fewer centavos are left than there are lots still sitting at the level,
    // so one each, largest balance first.
    for (let index = 0; index < eligible.length && leftover > 0; index += 1) {
        if (shares[index] === low && low >= minimums[index] && low < balances[index]) {
            shares[index] = shares[index] + 1;
            leftover -= 1;
        }
    }
    return result(shares, leftover);
}
//# sourceMappingURL=allocation.js.map
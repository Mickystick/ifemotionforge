import { eq } from "drizzle-orm";
import { contracts, payments } from "../db/schema.js";
import { replayContract } from "./ledger.js";
/**
 * Move a contract between `active` and `paid_off` to match its replayed balance.
 *
 * Call this inside the same transaction as anything that changes what a
 * contract has been paid — a new receipt, a void, a corrected transaction, a
 * reprice. A contract whose balance has reached zero settles; one whose balance
 * reopens (a payment reversed, an amount corrected down, a price raised) goes
 * back to active.
 *
 * `cancelled` and `defaulted` are terminal — a human closed the contract for a
 * reason, and a later payment correction must not silently reopen it. Those are
 * left untouched here.
 *
 * Nothing is written to the Historial. A settle or a reopen is only ever the
 * consequence of a payment change, and that change is already in the history
 * under the person who made it — a second row saying the status followed would
 * be the same fact twice.
 */
export function syncContractLifecycle(db, contractId) {
    const contract = db
        .select({
        status: contracts.status,
        salePriceCents: contracts.salePriceCents,
    })
        .from(contracts)
        .where(eq(contracts.id, contractId))
        .get();
    if (!contract || (contract.status !== "active" && contract.status !== "paid_off")) {
        return "unchanged";
    }
    const credits = db
        .select({
        id: payments.id,
        amountCents: payments.amountCents,
        paidOn: payments.paidOn,
        createdAt: payments.createdAt,
        reversedAt: payments.reversedAt,
    })
        .from(payments)
        .where(eq(payments.contractId, contractId))
        .all();
    const balanceCents = replayContract({
        salePriceCents: contract.salePriceCents,
        credits,
    }).balanceCents;
    const target = balanceCents <= 0 ? "paid_off" : "active";
    if (target === contract.status) {
        return "unchanged";
    }
    db.update(contracts)
        .set({ status: target, updatedAt: new Date().toISOString() })
        .where(eq(contracts.id, contractId))
        .run();
    return target === "paid_off" ? "settled" : "reopened";
}
//# sourceMappingURL=contractLifecycle.js.map
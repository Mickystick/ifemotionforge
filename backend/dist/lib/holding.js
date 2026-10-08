import { sql } from "drizzle-orm";
import { contracts } from "../db/schema.js";
/**
 * SQL fragment: this reservation has passed its expiry date.
 *
 * `asOf` and `expires_on` are both YYYY-MM-DD, so `<` compares them correctly.
 * Shared by the two predicates below so "the hold has lapsed" is written once.
 */
function expiredReservation(asOf) {
    return sql `(
    ${contracts.kind} = 'reservation'
    AND ${contracts.expiresOn} IS NOT NULL
    AND ${contracts.expiresOn} < ${asOf}
  )`;
}
/**
 * SQL predicate: this contract still ties up its lot.
 *
 * `active` and `paid_off` both mean the lot is spoken for — a contract paid in
 * full is not back on the market, the customer owns it. `cancelled` and
 * `defaulted` release it, and so does a reservation past its `expiresOn` — that
 * release is derived here on every read rather than swept by a job, the same
 * way payment health and lot availability already are.
 *
 * Use this wherever the question is "is this lot taken": the lots list, the
 * "can I sell this lot" check, the sold count on the projects screen.
 */
export function holdsLot(asOf) {
    return sql `(
    ${contracts.status} IN ('active', 'paid_off')
    AND NOT ${expiredReservation(asOf)}
  )`;
}
/**
 * SQL predicate: this contract is still being serviced.
 *
 * Narrower than `holdsLot`: a `paid_off` contract holds its lot but owes
 * nothing and takes no more payments. Use this wherever the question is "is
 * there still something to pay or collect here": the customer's live holdings,
 * the split targets for a payment.
 */
export function openContract(asOf) {
    return sql `(
    ${contracts.status} = 'active'
    AND NOT ${expiredReservation(asOf)}
  )`;
}
//# sourceMappingURL=holding.js.map
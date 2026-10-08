import { randomUUID } from "node:crypto";
import { auditEvents } from "../db/schema.js";
/**
 * Append one row to the audit history.
 *
 * Call this inside the same transaction as the change it describes. If the
 * change rolls back, its audit row must roll back with it — an audit log that
 * records things that did not happen is worse than none at all.
 */
export function recordAudit(db, entry) {
    db.insert(auditEvents)
        .values({
        id: randomUUID(),
        actorId: entry.actorId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        reason: entry.reason ?? null,
        beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
        afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
    })
        .run();
}
//# sourceMappingURL=audit.js.map
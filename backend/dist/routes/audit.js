import { desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { auditEvents, contracts, customers, lots, projects, users } from "../db/schema.js";
const auditQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    /**
     * Optional filter, e.g. only lot changes. Every value `recordAudit` can
     * write is listed here — `project`, `role` and `exchange_rate` were missing,
     * so events that are recorded could never be filtered for.
     */
    entityType: z
        .enum(["lot", "project", "customer", "contract", "payment", "user", "role", "exchange_rate"])
        .optional(),
});
/**
 * The name a row carries in its own snapshot, when nothing is left to join to.
 *
 * Deleting a customer leaves the joins below with nothing to find: the row they
 * would have named no longer exists. The delete event stores the whole record
 * in `before` precisely so the history can still say who it was, and this reads
 * it back. Without it, the last thing the log ever says about a person is a
 * UUID.
 *
 * Receipts are not joined, so the rows that are about one — a void, a removed
 * file — carry its code in their snapshot for the same reason.
 */
function snapshotLabel(snapshot) {
    const name = snapshot?.fullName ?? snapshot?.name ?? snapshot?.code ?? snapshot?.receiptCode;
    return typeof name === "string" ? name : null;
}
/**
 * Read the total two ways and they disagree the moment a filter is applied:
 * the page of rows was filtered, the count was not, and the Historial screen
 * then offered pages of events that were not there. One `where` clause, built
 * once, drives both queries.
 */
function auditWhere(entityType) {
    return entityType ? eq(auditEvents.entityType, entityType) : undefined;
}
/**
 * The change history.
 *
 * Read-only by design: there is no endpoint to edit or delete an audit row.
 * A history someone can rewrite is not a history.
 */
export const auditRoutes = async (app) => {
    app.get("/audit", { onRequest: app.requireCapability("audit:view") }, async (request, reply) => {
        const parsed = auditQuery.safeParse(request.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid_query", message: "Parámetros inválidos." });
        }
        const { limit, offset, entityType } = parsed.data;
        const where = auditWhere(entityType);
        // Resolve a human-readable label for whatever the row points at, so the
        // screen shows "A-07" rather than a UUID.
        const actor = users;
        // A second, ALIASED reference to the same table: an audit row about a user
        // account has an actor and a subject, and both are users. Without the alias
        // SQLite sees one table joined to itself under one name and the row names
        // the person who made the change rather than the account that changed.
        const subject = alias(users, "subject_user");
        const rows = app.db
            .select({
            id: auditEvents.id,
            action: auditEvents.action,
            entityType: auditEvents.entityType,
            entityId: auditEvents.entityId,
            reason: auditEvents.reason,
            beforeJson: auditEvents.beforeJson,
            afterJson: auditEvents.afterJson,
            createdAt: auditEvents.createdAt,
            actorName: actor.name,
            actorRole: actor.role,
            lotCode: lots.code,
            customerName: customers.fullName,
            projectName: projects.name,
            contractCode: contracts.code,
            subjectName: subject.name,
        })
            .from(auditEvents)
            .innerJoin(actor, eq(actor.id, auditEvents.actorId))
            // One join per kind of entity a row can point at. Entity ids are UUIDs,
            // so at most one of these ever matches, and the rest come back null.
            .leftJoin(lots, eq(lots.id, auditEvents.entityId))
            .leftJoin(customers, eq(customers.id, auditEvents.entityId))
            .leftJoin(projects, eq(projects.id, auditEvents.entityId))
            // A contract is never deleted, so this always finds it. Without it, an
            // edit, a cancel or a lot correction said WHAT changed and not which
            // contract it was about.
            .leftJoin(contracts, eq(contracts.id, auditEvents.entityId))
            .leftJoin(subject, eq(subject.id, auditEvents.entityId))
            .where(where)
            .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
            .limit(limit)
            .offset(offset)
            .all();
        const total = app.db
            .select({ count: sql `COUNT(*)` })
            .from(auditEvents)
            .where(where)
            .get();
        return reply.send({
            events: rows.map((row) => {
                const before = row.beforeJson
                    ? JSON.parse(row.beforeJson)
                    : null;
                return {
                    id: row.id,
                    action: row.action,
                    entityType: row.entityType,
                    entityId: row.entityId,
                    entityLabel: row.lotCode ??
                        row.customerName ??
                        row.projectName ??
                        row.subjectName ??
                        row.contractCode ??
                        snapshotLabel(before),
                    actorName: row.actorName,
                    actorRole: row.actorRole,
                    reason: row.reason,
                    before,
                    after: row.afterJson ? JSON.parse(row.afterJson) : null,
                    createdAt: row.createdAt,
                };
            }),
            total: total?.count ?? 0,
            limit,
            offset,
        });
    });
};
//# sourceMappingURL=audit.js.map
import { eq } from "drizzle-orm";
import { z } from "zod";
import { roleCapabilities } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { resolveCapabilities } from "../lib/capabilities.js";
import { EDITABLE_CAPABILITIES, LOCKED_CAPABILITIES, isCapability, } from "../lib/permissions.js";
/**
 * Only the associate role is configurable.
 *
 * The owner's capabilities are fixed in code. A supervisor who could revoke
 * their own `permission:manage` would lock the business out of the only account
 * that can grant it back, and no confirmation dialog makes that a good idea.
 */
const EDITABLE_ROLE = "staff";
const updateBody = z.object({
    /** The complete set of granted capabilities — not a delta. */
    capabilities: z.array(z.string()).max(64),
});
export const permissionRoutes = async (app) => {
    app.get("/permissions", { onRequest: app.requireCapability("permission:manage") }, async (request, reply) => {
        const granted = resolveCapabilities(app.db, EDITABLE_ROLE);
        return reply.send({
            role: EDITABLE_ROLE,
            capabilities: EDITABLE_CAPABILITIES.map((capability) => ({
                capability,
                enabled: granted.has(capability),
            })),
            // Sent so the screen can show what is deliberately not on offer,
            // rather than leaving the supervisor wondering where it went.
            locked: [...LOCKED_CAPABILITIES],
        });
    });
    app.put("/permissions", { onRequest: app.requireCapability("permission:manage") }, async (request, reply) => {
        const parsed = updateBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "No se pudo leer la lista de permisos.",
            });
        }
        const requested = parsed.data.capabilities;
        const unknown = requested.filter((capability) => !isCapability(capability));
        if (unknown.length > 0) {
            return reply.code(400).send({
                error: "unknown_capability",
                message: `Permiso desconocido: ${unknown.join(", ")}.`,
            });
        }
        // Refused loudly rather than filtered out silently. A request to grant
        // account control is either a bug or an attempt, and both deserve an
        // answer that says so.
        const locked = requested.filter((capability) => isCapability(capability) && LOCKED_CAPABILITIES.has(capability));
        if (locked.length > 0) {
            return reply.code(400).send({
                error: "locked_capability",
                message: "Gestionar usuarios, editar permisos y declarar un contrato incumplido son " +
                    "exclusivos del supervisor y no se pueden ceder.",
            });
        }
        const actor = request.user;
        const before = [...resolveCapabilities(app.db, EDITABLE_ROLE)].sort();
        const granted = new Set(requested);
        const after = [...granted].sort();
        app.db.transaction((tx) => {
            // The request is the complete set, so the stored rows are replaced
            // wholesale. Toggling one switch off is then a normal write rather than
            // a delete that has to be worked out from a diff.
            tx.delete(roleCapabilities).where(eq(roleCapabilities.role, EDITABLE_ROLE)).run();
            // Every editable switch is written, including the ones turned OFF, so
            // "the supervisor revoked everything" is stored as a decision rather
            // than as an absence that would read back as "never configured".
            tx.insert(roleCapabilities)
                .values(EDITABLE_CAPABILITIES.map((capability) => ({
                role: EDITABLE_ROLE,
                capability,
                enabled: granted.has(capability),
                grantedBy: actor.id,
                grantedAt: new Date().toISOString(),
            })))
                .run();
            // Without this row the history becomes unreadable: an action the
            // associate took last month can look impossible today, simply because
            // the permission was revoked since.
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "role",
                entityId: EDITABLE_ROLE,
                action: "update",
                before: { capabilities: before },
                after: { capabilities: after },
            });
        });
        return reply.send({ role: EDITABLE_ROLE, capabilities: after });
    });
};
//# sourceMappingURL=permissions.js.map
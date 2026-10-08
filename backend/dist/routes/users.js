import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { users } from "../db/schema.js";
import { deleteSessionsForUser } from "../auth/session.js";
import { recordAudit } from "../lib/audit.js";
import { hashPassword } from "../lib/password.js";
import { ROLES } from "../lib/permissions.js";
/**
 * The accounts that can sign in — created, edited and switched off from the
 * app, rather than by whoever has the database file.
 *
 * WHAT each role may do is not decided here. That is per-role and lives in
 * routes/permissions.ts; this screen decides WHO exists and which role they
 * hold. The two are deliberately separate: hiring somebody is a weekly job,
 * while changing what the associate role is trusted with is a rare decision
 * that deserves its own screen and its own audit trail.
 *
 * Every route here needs `user:manage`, which is locked to the supervisor in
 * src/lib/permissions.ts and cannot be granted away. An associate who could
 * create accounts could create an owner account, and the whole permission
 * system would be a suggestion.
 */
/**
 * Short passwords are the reason password rules exist, and length is the only
 * rule that reliably helps. No character-class requirements: they push people
 * towards "Passw0rd!" and towards writing it on the monitor.
 */
const MINIMUM_PASSWORD_LENGTH = 10;
const password = z
    .string()
    .min(MINIMUM_PASSWORD_LENGTH, `La contraseña debe tener al menos ${MINIMUM_PASSWORD_LENGTH} caracteres.`)
    // Matches the ceiling on the login route. scrypt is deliberately slow, so an
    // unbounded password is an invitation to make the server do arbitrary work.
    .max(200);
const createBody = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().min(1).max(320).email(),
    role: z.enum(ROLES),
    password,
});
/** Editing an account never touches its password — that has its own route. */
const updateBody = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().min(1).max(320).email(),
    role: z.enum(ROLES),
});
const passwordBody = z.object({ password });
/** Stored and compared in lower case, exactly as the login route reads it. */
const normalizeEmail = (raw) => raw.trim().toLowerCase();
/**
 * The clash a email address would cause, worded for the user, or `null`.
 *
 * The unique index is what guarantees this; the lookup is what turns the
 * guarantee into a sentence naming the account already using the address —
 * the same shape as `identificationClash` in routes/customers.ts.
 */
function emailClash(db, email, ignoreUserId) {
    const clash = db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.email, email))
        .get();
    if (!clash || clash.id === ignoreUserId) {
        return null;
    }
    return `El correo ${email} ya lo usa la cuenta de ${clash.name}.`;
}
/**
 * How many owners could still sign in if this one stopped being one.
 *
 * The last supervisor cannot be demoted or deactivated, and this is the check
 * that says so. Without it the business locks itself out of the only role that
 * can create accounts, edit permissions or undo either — and the way back is a
 * database file and somebody who knows SQL.
 */
function otherActiveOwners(db, exceptUserId) {
    const row = db
        .select({ count: sql `COUNT(*)` })
        .from(users)
        .where(and(eq(users.role, "owner"), isNull(users.deactivatedAt), ne(users.id, exceptUserId)))
        .get();
    return row?.count ?? 0;
}
export const userRoutes = async (app) => {
    app.get("/users", { onRequest: app.requireCapability("user:manage") }, async (request, reply) => {
        const rows = app.db
            .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
            deactivatedAt: users.deactivatedAt,
            // Kept on the account itself. It used to be read back out of the
            // Historial, one `login` row per sign-in; see `AuditEntry`.
            lastSignInAt: users.lastSignInAt,
            createdAt: users.createdAt,
        })
            .from(users)
            .orderBy(asc(users.name))
            .all();
        return reply.send({
            users: rows.map((row) => ({
                ...row,
                // So the screen can grey out the actions that would lock this person
                // out of their own session. The server refuses them anyway.
                isSelf: row.id === request.user.id,
            })),
        });
    });
    app.post("/users", { onRequest: app.requireCapability("user:manage") }, async (request, reply) => {
        const parsed = createBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Revisa los datos de la cuenta.",
                issues: parsed.error.issues.map((issue) => issue.message),
            });
        }
        const email = normalizeEmail(parsed.data.email);
        const clash = emailClash(app.db, email);
        if (clash) {
            return reply.code(409).send({ error: "duplicate_email", message: clash });
        }
        // Hashed BEFORE the transaction: scrypt is intentionally slow, and holding
        // a SQLite write transaction open across it would block every other write
        // for the duration.
        const passwordHash = await hashPassword(parsed.data.password);
        const actor = request.user;
        const created = app.db.transaction((tx) => {
            const next = tx
                .insert(users)
                .values({
                id: randomUUID(),
                email,
                name: parsed.data.name,
                role: parsed.data.role,
                passwordHash,
                deactivatedAt: null,
                createdAt: new Date().toISOString(),
            })
                .returning()
                .get();
            // The password is not in `after`, and must never be. An audit log that
            // records credentials is a second place to steal them from.
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "user",
                entityId: next.id,
                action: "create",
                after: { name: next.name, email: next.email, role: next.role },
            });
            return next;
        });
        const view = {
            id: created.id,
            name: created.name,
            email: created.email,
            role: created.role,
            deactivatedAt: created.deactivatedAt,
            createdAt: created.createdAt,
        };
        return reply.code(201).send({ user: view });
    });
    app.patch("/users/:id", { onRequest: app.requireCapability("user:manage") }, async (request, reply) => {
        const parsed = updateBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Revisa los datos de la cuenta.",
                issues: parsed.error.issues.map((issue) => issue.message),
            });
        }
        const existing = app.db.select().from(users).where(eq(users.id, request.params.id)).get();
        if (!existing) {
            return reply.code(404).send({ error: "not_found", message: "Cuenta no encontrada." });
        }
        const actor = request.user;
        const roleIsChanging = parsed.data.role !== existing.role;
        /*
         * Nobody changes their own role.
         *
         * A supervisor who demotes themselves loses `user:manage` on their very
         * next request — including the request that would put it back. The name
         * and the email are theirs to edit; the role is the one field that can
         * take the app away from them.
         */
        if (roleIsChanging && existing.id === actor.id) {
            return reply.code(409).send({
                error: "cannot_change_own_role",
                message: "No puedes cambiar tu propio rol. Pide a otro supervisor que lo haga, para que " +
                    "nadie se quede fuera de su propia aplicación.",
            });
        }
        // Demoting the last supervisor leaves nobody able to create accounts or
        // edit permissions — and nobody able to undo it.
        if (roleIsChanging &&
            existing.role === "owner" &&
            existing.deactivatedAt === null &&
            otherActiveOwners(app.db, existing.id) === 0) {
            return reply.code(409).send({
                error: "last_owner",
                message: `${existing.name} es el único supervisor activo. Nombra a otro supervisor antes ` +
                    "de cambiarle el rol.",
            });
        }
        const email = normalizeEmail(parsed.data.email);
        const clash = emailClash(app.db, email, existing.id);
        if (clash) {
            return reply.code(409).send({ error: "duplicate_email", message: clash });
        }
        const updated = app.db.transaction((tx) => {
            const next = tx
                .update(users)
                .set({ name: parsed.data.name, email, role: parsed.data.role })
                .where(eq(users.id, existing.id))
                .returning()
                .get();
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "user",
                entityId: existing.id,
                action: "update",
                before: { name: existing.name, email: existing.email, role: existing.role },
                after: { name: next.name, email: next.email, role: next.role },
            });
            return next;
        });
        const view = {
            id: updated.id,
            name: updated.name,
            email: updated.email,
            role: updated.role,
            deactivatedAt: updated.deactivatedAt,
            createdAt: updated.createdAt,
        };
        return reply.send({ user: view });
    });
    /**
     * Set somebody's password.
     *
     * The supervisor never sees the old one — there is nothing to see, only a
     * scrypt hash — so this REPLACES rather than changes. That is what a forgotten
     * password actually needs.
     *
     * Every session belonging to the account is dropped on the way out. A
     * password reset because it leaked is worth nothing while the session that
     * was opened with the old one still works.
     */
    app.put("/users/:id/password", { onRequest: app.requireCapability("user:manage") }, async (request, reply) => {
        const parsed = passwordBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: parsed.error.issues[0]?.message ?? "Revisa la contraseña.",
            });
        }
        const existing = app.db.select().from(users).where(eq(users.id, request.params.id)).get();
        if (!existing) {
            return reply.code(404).send({ error: "not_found", message: "Cuenta no encontrada." });
        }
        const passwordHash = await hashPassword(parsed.data.password);
        const actor = request.user;
        app.db.transaction((tx) => {
            tx.update(users).set({ passwordHash }).where(eq(users.id, existing.id)).run();
            // WHEN, not what. The history has to show that somebody's password was
            // changed and by whom — that is a real event somebody may need to
            // explain later — without storing a single thing about the password.
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "user",
                entityId: existing.id,
                action: "update",
                after: { passwordResetAt: new Date().toISOString() },
            });
        });
        // Outside the transaction on purpose: signing the account out is a
        // consequence of the reset, not part of it, and a failure here must not
        // roll back a password the supervisor has already handed over.
        const endedSessions = deleteSessionsForUser(app.db, existing.id);
        return reply.send({ ok: true, endedSessions });
    });
    /**
     * Switch an account off.
     *
     * Not a delete, and there is no delete. This user's id is written on every
     * payment they recorded and on every line of the audit history; removing the
     * row would either break those references or erase the answer to "who
     * received this money", which is the reason the columns exist at all. A
     * former employee stops being able to sign in, and everything they did stays
     * exactly as legible as it was.
     */
    app.post("/users/:id/deactivate", { onRequest: app.requireCapability("user:manage") }, async (request, reply) => {
        const existing = app.db.select().from(users).where(eq(users.id, request.params.id)).get();
        if (!existing) {
            return reply.code(404).send({ error: "not_found", message: "Cuenta no encontrada." });
        }
        const actor = request.user;
        if (existing.id === actor.id) {
            return reply.code(409).send({
                error: "cannot_deactivate_self",
                message: "No puedes desactivar tu propia cuenta. Quedarías fuera de la aplicación en tu " +
                    "siguiente clic, sin forma de volver a entrar.",
            });
        }
        if (existing.deactivatedAt !== null) {
            return reply.code(409).send({
                error: "already_deactivated",
                message: `La cuenta de ${existing.name} ya está desactivada.`,
            });
        }
        if (existing.role === "owner" && otherActiveOwners(app.db, existing.id) === 0) {
            return reply.code(409).send({
                error: "last_owner",
                message: `${existing.name} es el único supervisor activo. Nombra a otro supervisor antes ` +
                    "de desactivar esta cuenta.",
            });
        }
        const deactivatedAt = new Date().toISOString();
        app.db.transaction((tx) => {
            tx.update(users).set({ deactivatedAt }).where(eq(users.id, existing.id)).run();
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "user",
                entityId: existing.id,
                // "archive" rather than a new action name: this is the same idea as
                // an archived lot — out of use, still on file, still readable.
                action: "archive",
                before: { name: existing.name, email: existing.email, deactivatedAt: null },
                after: { name: existing.name, email: existing.email, deactivatedAt },
            });
        });
        const endedSessions = deleteSessionsForUser(app.db, existing.id);
        return reply.send({ ok: true, deactivatedAt, endedSessions });
    });
    /** Let a deactivated account sign in again — a rehire, or a correction. */
    app.post("/users/:id/reactivate", { onRequest: app.requireCapability("user:manage") }, async (request, reply) => {
        const existing = app.db.select().from(users).where(eq(users.id, request.params.id)).get();
        if (!existing) {
            return reply.code(404).send({ error: "not_found", message: "Cuenta no encontrada." });
        }
        if (existing.deactivatedAt === null) {
            return reply.code(409).send({
                error: "already_active",
                message: `La cuenta de ${existing.name} ya está activa.`,
            });
        }
        const actor = request.user;
        app.db.transaction((tx) => {
            tx.update(users).set({ deactivatedAt: null }).where(eq(users.id, existing.id)).run();
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "user",
                entityId: existing.id,
                action: "restore",
                before: {
                    name: existing.name,
                    email: existing.email,
                    deactivatedAt: existing.deactivatedAt,
                },
                after: { name: existing.name, email: existing.email, deactivatedAt: null },
            });
        });
        // The old password still works. Reactivating is not the same decision as
        // resetting a credential, and quietly doing both would leave the person
        // unable to sign in with no explanation of why.
        return reply.send({ ok: true });
    });
};
//# sourceMappingURL=users.js.map
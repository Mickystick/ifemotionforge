import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { sessions, users } from "../db/schema.js";
import { isRole } from "../lib/permissions.js";
export const SESSION_COOKIE = "lindero_session";
/**
 * Create a login session.
 *
 * The id is 32 random bytes — far too much to guess — and it is the ONLY thing
 * the browser receives. The user's identity and role are never put in the
 * cookie, so there is nothing in it for an attacker to edit in their favour.
 */
export function createSession(db, userId, sessionDays) {
    const id = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
    db.insert(sessions).values({ id, userId, expiresAt }).run();
    return id;
}
/**
 * Look up who a session belongs to, or `null` if it is unknown, expired, or
 * belongs to an account that has been deactivated.
 *
 * Runs on every authenticated request, which is why role changes take effect
 * immediately rather than at the user's next login — and why deactivating an
 * account ends it on that account's very next click, rather than whenever its
 * session happened to run out. The rows are deleted too, in
 * `deleteSessionsForUser`, but that is housekeeping: this clause is what makes
 * the answer safe even if a session is somehow missed.
 */
export function getSessionUser(db, sessionId) {
    const now = new Date().toISOString();
    const row = db
        .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
    })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now), isNull(users.deactivatedAt)))
        .get();
    if (!row || !isRole(row.role)) {
        return null;
    }
    return { id: row.id, name: row.name, email: row.email, role: row.role };
}
export function destroySession(db, sessionId) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}
/**
 * Sign one account out everywhere.
 *
 * Called when an account is deactivated and when its password is reset: in both
 * cases the person holding the old session is exactly who must stop being
 * trusted, and a password changed because it leaked is worth nothing while the
 * session opened with it still works.
 */
export function deleteSessionsForUser(db, userId) {
    return db.delete(sessions).where(eq(sessions.userId, userId)).run().changes;
}
/** Housekeeping: drop sessions that have already expired. */
export function deleteExpiredSessions(db) {
    const result = db
        .delete(sessions)
        .where(lt(sessions.expiresAt, new Date().toISOString()))
        .run();
    return result.changes;
}
/** Shared id generator, so every table uses the same format. */
export function newId() {
    return randomUUID();
}
//# sourceMappingURL=session.js.map
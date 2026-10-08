import { and, eq } from "drizzle-orm";
import { userPreferences } from "../db/schema.js";
/**
 * Reading and writing one person's settings.
 *
 * Deliberately thin, and deliberately ignorant of what any preference means.
 * The value is JSON the interface wrote and the interface reads back; this file
 * only knows how to store a string under a key for a user, which is what keeps
 * "add a band to the dashboard" from being a database change.
 *
 * Every function here takes the user id as an argument and none of them accepts
 * it from a request body. That is the whole security story for this table: a
 * route resolves the signed-in user from the session and passes THAT, so there
 * is no shape of request that writes somebody else's settings.
 */
/** The order and visibility of the Panel General's bands. */
export const DASHBOARD_LAYOUT = "dashboard-layout";
/**
 * The stored value, or `null` when this user has never chosen.
 *
 * `null` also for a value that will not parse, which can only happen if
 * somebody edited the database by hand. A settings row is not worth a 500: the
 * screen falls back to its default order, which is exactly what a user who has
 * never touched it sees.
 */
export function readPreference(db, userId, key) {
    const row = db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
        .get();
    if (!row) {
        return null;
    }
    try {
        return JSON.parse(row.value);
    }
    catch {
        return null;
    }
}
/** Store a preference, replacing whatever was there. */
export function writePreference(db, userId, key, value) {
    const encoded = JSON.stringify(value);
    const now = new Date().toISOString();
    db.insert(userPreferences)
        .values({ userId, key, value: encoded, updatedAt: now })
        // One row per user per key, enforced by the unique index. Without this an
        // upsert becomes a read-then-write, and two tabs saving at once leave two
        // rows where the reader will find whichever SQLite happens to return.
        .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: { value: encoded, updatedAt: now },
    })
        .run();
}
/**
 * Forget a preference entirely.
 *
 * Not the same as storing today's default: a user who has never chosen follows
 * the default as it CHANGES, and one who has chosen does not. "Restore the
 * original order" has to mean the first of those, or a later release that
 * improves the default order would never reach anybody who had once pressed
 * the reset button.
 */
export function clearPreference(db, userId, key) {
    db.delete(userPreferences)
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
        .run();
}
//# sourceMappingURL=preferences.js.map
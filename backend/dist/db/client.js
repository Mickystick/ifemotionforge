import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
/**
 * Opens the SQLite database and applies the settings that make it safe for a
 * server to use. These four PRAGMAs are not optional extras — without them
 * SQLite behaves in ways that will eventually corrupt or block a web app.
 */
export function createDb(databasePath) {
    if (databasePath !== ":memory:") {
        // better-sqlite3 will not create missing directories itself.
        mkdirSync(dirname(databasePath), { recursive: true });
    }
    const sqlite = new Database(databasePath);
    // Write-Ahead Logging: readers no longer block the writer, and vice versa.
    // Without this, a slow report would lock out someone recording a payment.
    sqlite.pragma("journal_mode = WAL");
    // SQLite ignores foreign keys unless you ask it not to. This is the setting
    // that stops a contract from pointing at a lot that does not exist.
    sqlite.pragma("foreign_keys = ON");
    // If another write is in progress, wait up to 5 seconds instead of failing
    // instantly with SQLITE_BUSY.
    sqlite.pragma("busy_timeout = 5000");
    // Flush to disk at transaction boundaries rather than on every write. Safe
    // under WAL, and considerably faster.
    sqlite.pragma("synchronous = NORMAL");
    const db = drizzle(sqlite, { schema });
    return { db, sqlite };
}
//# sourceMappingURL=client.js.map
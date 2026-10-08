import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
/**
 * Finds the folder of SQL migration files, relative to THIS module rather than
 * the working directory.
 *
 * `migrate(db, { migrationsFolder: "./drizzle" })` resolves that path against
 * `process.cwd()` — fine when the one and only way to run migrations is `npm`
 * scripts invoked from `backend/`, but the server now runs them itself on boot
 * (see server.ts) and a service manager can start it from anywhere.
 *
 * `drizzle-kit` writes the files to `backend/drizzle`. `npm run build` copies
 * them to `backend/dist/drizzle` so a compiled install still has them without
 * the source tree. Both layouts put the folder either one or two levels above
 * this file, so try both:
 *
 *   dist/db/migrations.js  ->  dist/drizzle      (../drizzle, copied by build)
 *   dist/db/migrations.js  ->  backend/drizzle   (../../drizzle, whole tree deployed)
 *   src/db/migrations.ts   ->  backend/drizzle   (../../drizzle, tsx: dev, tests, db:migrate)
 */
function findMigrationsFolder() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "..", "drizzle"), join(here, "..", "..", "drizzle")];
    for (const folder of candidates) {
        // meta/_journal.json is the index drizzle reads first; if it is here, the
        // rest of the folder is too.
        if (existsSync(join(folder, "meta", "_journal.json"))) {
            return folder;
        }
    }
    throw new Error("Could not locate the drizzle migrations folder. Looked in:\n" +
        candidates.map((path) => `  ${path}`).join("\n") +
        "\nA compiled install gets this folder from `npm run build` — check that it ran.");
}
/**
 * Applies every migration this database has not seen yet, with foreign keys
 * disabled for the duration.
 *
 * Safe to call repeatedly and on every boot: drizzle records which migrations
 * have run in a table of its own and skips them next time. The server calls
 * this at startup, so a production deploy has no separate migration step to
 * remember — but `npm run db:migrate` still runs it on its own when that is
 * what you want.
 *
 * The foreign key handling is not a shortcut, it is SQLite's own documented
 * procedure for changing a column — and it has to happen HERE rather than
 * inside the .sql file.
 *
 * SQLite cannot alter a column in place. Dropping NOT NULL means building a new
 * table, copying the rows across, dropping the old one and renaming the new one
 * into its place. `DROP TABLE customers` with foreign keys enforced is a
 * foreign key violation the moment a single contract points at a customer, so
 * SQLite's instructions say to turn enforcement off around the rebuild and
 * check the result afterwards.
 *
 * `PRAGMA foreign_keys` is a NO-OP inside a transaction, and Drizzle's migrator
 * wraps every pending migration in one `BEGIN`. So the `PRAGMA foreign_keys=OFF`
 * that drizzle-kit helpfully writes at the top of a generated rebuild does
 * nothing at all, and the migration fails on any database that holds real data
 * while passing cleanly on the empty one in front of you. It has to be set out
 * here, around the transaction, where it takes effect.
 *
 * `foreign_key_check` afterwards is what keeps that honest. Enforcement being
 * off means a careless migration could leave a contract pointing at a customer
 * who no longer exists, and nothing would say so until something broke months
 * later. This turns that into a failure at deploy time, before the server
 * starts, with the offending rows named.
 */
export function runMigrations(db, sqlite, migrationsFolder = findMigrationsFolder()) {
    sqlite.pragma("foreign_keys = OFF");
    try {
        migrate(db, { migrationsFolder });
        const violations = sqlite.pragma("foreign_key_check");
        if (violations.length > 0) {
            const summary = violations
                .slice(0, 5)
                .map((row) => `${row.table} row ${row.rowid} → ${row.parent}`)
                .join(", ");
            throw new Error(`Las migraciones dejaron ${violations.length} referencia(s) rota(s): ${summary}. ` +
                "La base de datos NO se ha iniciado.");
        }
    }
    finally {
        // Back on even when a migration threw: the connection stays open long
        // enough for the caller to report the error, and nothing should be able to
        // write to it unguarded in the meantime.
        sqlite.pragma("foreign_keys = ON");
    }
}
//# sourceMappingURL=migrations.js.map
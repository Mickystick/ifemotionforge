import { loadConfig } from "../config/env.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrations.js";
/**
 * `npm run db:migrate` — apply pending migrations to the database and exit.
 *
 * Safe to run repeatedly — Drizzle records which migrations have run. The
 * server also runs migrations on boot (see server.ts), so a deploy does not
 * depend on this script. It stays for development, and for the times you want
 * to migrate a database without starting the server. The foreign key handling
 * that a table rebuild needs lives in `runMigrations`, which explains itself.
 */
const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);
runMigrations(db, sqlite);
sqlite.close();
console.log(`Migrations applied to ${config.databasePath}`);
//# sourceMappingURL=migrate.js.map
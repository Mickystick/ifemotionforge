import { rmSync } from "node:fs";
import { loadConfig } from "../config/env.js";
/**
 * Deletes the SQLite file so `db:migrate` + `db:seed` can rebuild it.
 *
 * Development only. It refuses to run with NODE_ENV=production, because on the
 * droplet this would destroy real customer records.
 */
const config = loadConfig();
if (config.nodeEnv === "production") {
    throw new Error("db:reset is disabled in production");
}
for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${config.databasePath}${suffix}`, { force: true });
}
console.log(`Deleted ${config.databasePath} — run db:migrate and db:seed to rebuild.`);
//# sourceMappingURL=reset.js.map
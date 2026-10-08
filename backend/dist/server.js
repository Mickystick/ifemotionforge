import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import { deleteExpiredSessions } from "./auth/session.js";
import { refreshAutomaticRate } from "./lib/exchangeRate.js";
const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);
// Bring the schema up to date before anything touches it — the expired-session
// sweep just below is the first query that would otherwise hit a missing table
// on a fresh install. Safe on every boot: drizzle skips migrations already
// applied. A failure here stops startup, which is what you want — serving
// traffic against a half-built schema is worse than a restart loop a service
// manager will surface.
runMigrations(db, sqlite);
const app = await buildApp(config, db);
// Housekeeping on boot: expired sessions serve no purpose.
const removed = deleteExpiredSessions(db);
if (removed > 0) {
    app.log.info({ removed }, "Deleted expired sessions");
}
/**
 * Keep the displayed exchange rate current.
 *
 * Runs once at boot and then on a timer. It is deliberately fire-and-forget: a
 * provider that is down must never stop the server from starting or serving —
 * the last known rate stays on screen, labelled with its age.
 *
 * A manually set rate is left alone until a supervisor asks for automatic
 * updates again; `refreshAutomaticRate` is where that rule lives.
 */
const refreshRate = () => {
    void refreshAutomaticRate(db).then((result) => {
        if (result.status === "failed") {
            app.log.warn({ error: result.error }, "Exchange rate refresh failed; keeping last reading");
        }
        else if (result.status === "updated") {
            app.log.info({ rate: result.rate }, "Exchange rate updated");
        }
    });
};
if (config.exchangeRateRefreshHours > 0) {
    refreshRate();
    const timer = setInterval(refreshRate, config.exchangeRateRefreshHours * 60 * 60 * 1000);
    // `unref` so a pending timer never holds the process open on shutdown.
    timer.unref();
}
const shutdown = async (signal) => {
    app.log.info({ signal }, "Shutting down");
    // Whatever else might hold the server open, exit well inside systemd's
    // TimeoutStopSec rather than waiting to be killed. `unref` so the timer
    // itself never keeps the process alive.
    const deadline = setTimeout(() => {
        app.log.error("Shutdown took longer than 10 s; exiting anyway");
        process.exit(1);
    }, 10_000);
    deadline.unref();
    await app.close();
    // Closing SQLite cleanly checkpoints the write-ahead log.
    sqlite.close();
    process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
try {
    await app.listen({ host: config.host, port: config.port });
}
catch (error) {
    app.log.error(error);
    process.exit(1);
}
//# sourceMappingURL=server.js.map
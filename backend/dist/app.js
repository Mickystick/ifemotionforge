import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import authPlugin from "./auth/plugin.js";
import { publishChange } from "./lib/changes.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { contractRoutes } from "./routes/contracts.js";
import { customerRoutes } from "./routes/customers.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { exchangeRateRoutes } from "./routes/exchangeRate.js";
import { lotRoutes } from "./routes/lots.js";
import { permissionRoutes } from "./routes/permissions.js";
import { projectRoutes } from "./routes/projects.js";
import { receiptRoutes } from "./routes/receipts.js";
import { transactionRoutes } from "./routes/transactions.js";
import { userRoutes } from "./routes/users.js";
export async function buildApp(config, db) {
    const app = Fastify({
        logger: config.nodeEnv !== "test",
        // Off (false) by default so a direct connection — local dev, or this
        // process reachable with no proxy in front — is never spoofable via a
        // self-supplied X-Forwarded-For. See parseTrustProxy in config/env.ts for
        // what to set behind a real reverse proxy.
        trustProxy: config.trustProxy,
    });
    await app.register(cors, {
        origin: config.frontendOrigins,
        // Required for the session cookie to travel with fetch() requests.
        credentials: true,
    });
    await app.register(cookie, { secret: config.cookieSecret });
    // A generous ceiling for normal use; the login route is far stricter below.
    await app.register(rateLimit, {
        max: 300,
        timeWindow: "1 minute",
    });
    await app.register(authPlugin, { db });
    /*
     * Announce every successful write, from one place.
     *
     * The alternative was a `publishChange` beside each of the twenty-odd
     * handlers that write something, and the bug that design has is the one it
     * cannot show you: a new route, or a moved one, that simply never announces
     * itself. Nothing fails, no test goes red, and one screen somewhere stops
     * keeping up — found weeks later by somebody wondering why they had to
     * refresh. A hook cannot be forgotten, because there is nothing to remember.
     *
     * `onResponse` rather than `onSend`, so the news follows a write that
     * actually completed. The status check is the same rule: a 409 refusing an
     * overpayment, a 400 on a bad date and a 403 all changed nothing, and telling
     * every open tab to re-read after them would be noise that looks like data.
     *
     * Reads are skipped by method. Signing in and out is skipped by path: a
     * session is one person's, nobody else's screen is stale because of it, and
     * a login storm must not turn into a reload storm.
     */
    const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    app.addHook("onResponse", async (request, reply) => {
        if (!WRITE_METHODS.has(request.method) || reply.statusCode >= 400) {
            return;
        }
        // The registered pattern ("/api/receipts/:id/void") rather than the URL, so
        // one customer's id never reaches another customer's browser.
        const route = request.routeOptions?.url ?? request.url;
        if (route.startsWith("/api/auth/")) {
            return;
        }
        const clientId = request.headers["x-client-id"];
        publishChange({
            resource: route.split("/")[2] ?? "unknown",
            origin: typeof clientId === "string" && clientId !== "" ? clientId : null,
            at: new Date().toISOString(),
        });
    });
    /*
     * The last line between a database error and the user's screen.
     *
     * Routes refuse bad input themselves, in Spanish, naming the record at fault.
     * When something slips past one of those checks the failure still has to
     * arrive as a sentence: SQLite answers a violated index with text like
     * "UNIQUE constraint failed: lots.project_id, lots.code", and Fastify's
     * default handler would forward that verbatim into the dialog. It is not a
     * message, it is a schema dump — useless to the person at the screen and a
     * small gift to anyone probing the API.
     *
     * Deliberate refusals (4xx) keep their own wording; only unplanned failures
     * are replaced, and those are logged in full so nothing is actually lost.
     */
    app.setErrorHandler((error, request, reply) => {
        const status = error.statusCode ?? 500;
        if (status < 500) {
            return reply.code(status).send({
                error: error.code ?? "request_error",
                message: error.message,
            });
        }
        request.log.error({ err: error }, "Unhandled error");
        return reply.code(500).send({
            error: "server_error",
            message: "No se pudo completar la operación. Vuelve a intentarlo o avisa a soporte.",
        });
    });
    await app.register(async (api) => {
        await api.register(healthRoutes);
        // /auth/login gets its own tight limit — see routes/auth.ts, which
        // applies it to that one route only. /auth/me and /auth/logout stay on
        // the app-wide default above: /auth/me runs on every page load, and
        // sharing login's budget with it would let a few reloads lock out a
        // login that hasn't even been attempted yet.
        await api.register(authRoutes, {
            sessionDays: config.sessionDays,
            isProduction: config.nodeEnv === "production",
            loginAttemptsPerMinute: config.loginAttemptsPerMinute,
            timeZone: config.timeZone,
        });
        await api.register(lotRoutes);
        await api.register(projectRoutes);
        await api.register(customerRoutes);
        await api.register(contractRoutes, {
            timeZone: config.timeZone,
            uploadsPath: config.uploadsPath,
        });
        await api.register(receiptRoutes, { uploadsPath: config.uploadsPath });
        await api.register(transactionRoutes);
        await api.register(permissionRoutes);
        await api.register(userRoutes);
        await api.register(exchangeRateRoutes);
        await api.register(dashboardRoutes, { timeZone: config.timeZone });
        await api.register(auditRoutes);
        await api.register(eventRoutes);
    }, { prefix: "/api" });
    return app;
}
//# sourceMappingURL=app.js.map
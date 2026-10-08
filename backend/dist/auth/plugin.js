import fp from "fastify-plugin";
import { roleCan } from "../lib/capabilities.js";
import { SESSION_COOKIE, getSessionUser } from "./session.js";
const authPlugin = async (app, options) => {
    app.decorate("db", options.db);
    app.decorateRequest("user", null);
    // Resolve the session on every request, before any route handler runs. The
    // user is read from the database, never from the cookie's contents.
    app.addHook("onRequest", async (request) => {
        const sessionId = request.cookies[SESSION_COOKIE];
        request.user = sessionId ? getSessionUser(options.db, sessionId) : null;
    });
    app.decorate("requireUser", async (request, reply) => {
        if (!request.user) {
            await reply.code(401).send({ error: "unauthenticated", message: "Inicia sesión." });
        }
    });
    app.decorate("requireCapability", (capability) => {
        return async (request, reply) => {
            if (!request.user) {
                await reply.code(401).send({ error: "unauthenticated", message: "Inicia sesión." });
                return;
            }
            // Asked of the database, not of a hard-coded table: the supervisor can
            // change what the associate role may do, and a revoked capability has to
            // stop working on the associate's very next request.
            if (!roleCan(options.db, request.user.role, capability)) {
                request.log.warn({ userId: request.user.id, role: request.user.role, capability }, "Capability denied");
                await reply.code(403).send({
                    error: "forbidden",
                    message: "Tu usuario no tiene permiso para esta acción.",
                });
            }
        };
    });
};
// `fastify-plugin` stops Fastify from scoping these decorations to a child
// context, so `app.db` and the guards are visible to every route.
export default fp(authPlugin, { name: "lindero-auth" });
//# sourceMappingURL=plugin.js.map
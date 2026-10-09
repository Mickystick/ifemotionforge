import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Db } from "../db/client.js";
import { roleCan } from "../lib/capabilities.js";
import type { Capability } from "../lib/permissions.js";
import type { SessionUser } from "./session.js";
import { SESSION_COOKIE, getSessionUser } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, or `null` for an anonymous request. */
    user: SessionUser | null;
  }

  interface FastifyInstance {
    db: Db;
    /** Route guard: 401 unless someone is signed in. */
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Route guard factory: 401 if anonymous, 403 without the capability. */
    requireCapability: (
      capability: Capability,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface AuthPluginOptions {
  db: Db;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  app.decorate("db", options.db);
  app.decorateRequest("user", null);

  // Resolve the session on every request, before any route handler runs. The
  // user is read from the database, never from the cookie's contents.
  app.addHook("onRequest", async (request) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    request.user = sessionId ? getSessionUser(options.db, sessionId) : null;
  });

  app.decorate("requireUser", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.code(401).send({ error: "unauthenticated", message: "Please sign in." });
    }
  });

  app.decorate("requireCapability", (capability: Capability) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        await reply.code(401).send({ error: "unauthenticated", message: "Please sign in." });
        return;
      }

      // Asked of the database, not of a hard-coded table: the supervisor can
      // change what the associate role may do, and a revoked capability has to
      // stop working on the associate's very next request.
      if (!roleCan(options.db, request.user.role, capability)) {
        request.log.warn(
          { userId: request.user.id, role: request.user.role, capability },
          "Capability denied",
        );
        await reply.code(403).send({
          error: "forbidden",
          message: "Your account does not have permission to perform this action.",
        });
      }
    };
  });
};

// `fastify-plugin` stops Fastify from scoping these decorations to a child
// context, so `app.db` and the guards are visible to every route.
export default fp(authPlugin, { name: "lindero-auth" });

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { lots, projects } from "../db/schema.js";
import { AREA_UNITS } from "../lib/area.js";
import { recordAudit } from "../lib/audit.js";

/** Today as a YYYY-MM-DD calendar date. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A project row with the counts the Proyectos screen shows.
 *
 * Every number here is COUNTED at read time from lots and contracts. None of it
 * is stored on the project: a cached "24 lotes" is a number that goes wrong the
 * first time somebody archives a lot, and a project summary that disagrees with
 * the Lotes tab is worse than no summary.
 */
const projectsListQuery = (db: import("../db/client.js").Db, asOf: string) => {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      areaUnit: projects.areaUnit,
      archivedAt: projects.archivedAt,
      lotCount: sql<number>`
        (SELECT COUNT(*) FROM lots
         WHERE lots.project_id = projects.id AND lots.archived_at IS NULL)
      `,
      // Inventory value is the sum of BASE prices, not of agreed sale prices:
      // it answers "what is this project worth on the shelf", which is a
      // different question from what customers have actually committed to pay.
      inventoryCents: sql<number>`
        (SELECT COALESCE(SUM(lots.base_price_cents), 0) FROM lots
         WHERE lots.project_id = projects.id AND lots.archived_at IS NULL)
      `,
      areaM2: sql<number>`
        (SELECT COALESCE(SUM(lots.area_m2), 0) FROM lots
         WHERE lots.project_id = projects.id AND lots.archived_at IS NULL)
      `,
      // A lot is taken when an active contract points at it. The four counts
      // below mirror exactly how the Lotes tab derives its statuses — see
      // frontend features/lots/lotStatus.ts — so the two screens cannot
      // disagree about what is sold. A reservation past its expiry date has
      // lapsed: it counts as none of them, and the lot falls back into
      // `availableCount`.
      reservedCount: sql<number>`
        (SELECT COUNT(*) FROM lots
         JOIN contracts ON contracts.lot_id = lots.id
           AND contracts.status = 'active' AND contracts.kind = 'reservation'
           AND (contracts.expires_on IS NULL OR contracts.expires_on >= ${asOf})
         WHERE lots.project_id = projects.id AND lots.archived_at IS NULL)
      `,
      // Sold on credit and still being paid: the land has NOT changed hands.
      // Kept out of `soldCount` because a company that has financed forty lots
      // has not sold forty lots — it is owed forty balances and still owns the
      // land behind them.
      //
      // "Not contado and not a donation" rather than "= financed" on purpose:
      // it is the same fall-through lotStatus.ts makes, so a sale type neither
      // side recognises lands in the same bucket on both instead of dropping
      // out of the counts and inflating `availableCount` below.
      financedCount: sql<number>`
        (SELECT COUNT(*) FROM lots
         JOIN contracts ON contracts.lot_id = lots.id
           AND contracts.status = 'active' AND contracts.kind = 'contract'
           AND contracts.sale_type NOT IN ('cash', 'donation')
         WHERE lots.project_id = projects.id AND lots.archived_at IS NULL)
      `,
      // Gone: paid at contado, or paid off in full. Either way there is nothing
      // left to collect and the lot is no longer ours.
      soldCount: sql<number>`
        (SELECT COUNT(*) FROM lots
         JOIN contracts ON contracts.lot_id = lots.id
           AND contracts.status IN ('active', 'paid_off') AND contracts.kind = 'contract'
           AND contracts.sale_type <> 'donation'
           AND (contracts.sale_type = 'cash' OR contracts.status = 'paid_off')
         WHERE lots.project_id = projects.id AND lots.archived_at IS NULL)
      `,
      // Also gone, but not sold. Counted apart so a donated lot never inflates
      // what the project appears to have earned.
      donatedCount: sql<number>`
        (SELECT COUNT(*) FROM lots
         JOIN contracts ON contracts.lot_id = lots.id
           AND contracts.status IN ('active', 'paid_off') AND contracts.kind = 'contract'
           AND contracts.sale_type = 'donation'
         WHERE lots.project_id = projects.id AND lots.archived_at IS NULL)
      `,
    })
    .from(projects)
    .orderBy(projects.name);
};

const projectBody = z.object({
  name: z.string().trim().min(1).max(160),
  areaUnit: z.enum(AREA_UNITS),
});

const archiveBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get("/projects", { onRequest: app.requireUser }, async (request, reply) => {
    const rows = projectsListQuery(app.db, today()).all();

    return reply.send({
      projects: rows.map((row) => ({
        id: row.id,
        name: row.name,
        areaUnit: row.areaUnit,
        archivedAt: row.archivedAt,
        lotCount: row.lotCount,
        reservedCount: row.reservedCount,
        financedCount: row.financedCount,
        soldCount: row.soldCount,
        donatedCount: row.donatedCount,
        // Everything else is derived from these four, so the client is not
        // asked to keep a fifth number in agreement with them. The four are
        // mutually exclusive by construction, so what is left really is free.
        availableCount:
          row.lotCount -
          row.reservedCount -
          row.financedCount -
          row.soldCount -
          row.donatedCount,
        inventoryValue: row.inventoryCents,
        areaM2: row.areaM2,
      })),
    });
  });

  app.post(
    "/projects",
    { onRequest: app.requireCapability("project:create") },
    async (request, reply) => {
      const parsed = projectBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Check the project name and unit.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      // Project names are unique across the whole database, archived ones
      // included — reusing a name would make the audit history ambiguous.
      const clash = app.db
        .select({ id: projects.id, archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.name, parsed.data.name))
        .get();

      if (clash) {
        return reply.code(409).send({
          error: "duplicate_name",
          message:
            clash.archivedAt === null
              ? `A project named ${parsed.data.name} already exists.`
              : `An archived project named ${parsed.data.name} already exists. You can restore it.`,
        });
      }

      const now = new Date().toISOString();

      // Not in the Historial: a new project is its own record. See `AuditEntry`.
      const created = app.db
        .insert(projects)
        .values({
          id: randomUUID(),
          name: parsed.data.name,
          areaUnit: parsed.data.areaUnit,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      return reply.code(201).send({
        project: { id: created.id, name: created.name, areaUnit: created.areaUnit },
      });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/projects/:id",
    { onRequest: app.requireCapability("project:edit") },
    async (request, reply) => {
      const parsed = projectBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Check the project name and unit.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const existing = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Project not found." });
      }

      const clash = app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.name, parsed.data.name))
        .get();

      if (clash && clash.id !== existing.id) {
        return reply.code(409).send({
          error: "duplicate_name",
          message: `A project named ${parsed.data.name} already exists.`,
        });
      }

      const actor = request.user!;

      // Changing the unit does NOT touch a single stored area. Areas are held
      // in square metres, so switching a project from metres to manzanas
      // changes how the same land is written down, never how much of it
      // there is.
      const updated = app.db.transaction((tx) => {
        const next = tx
          .update(projects)
          .set({
            name: parsed.data.name,
            areaUnit: parsed.data.areaUnit,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(projects.id, existing.id))
          .returning()
          .get();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "project",
          entityId: existing.id,
          action: "update",
          before: { name: existing.name, areaUnit: existing.areaUnit },
          after: { name: next.name, areaUnit: next.areaUnit },
        });

        return next;
      });

      return reply.send({
        project: { id: updated.id, name: updated.name, areaUnit: updated.areaUnit },
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/projects/:id/archive",
    { onRequest: app.requireCapability("project:archive") },
    async (request, reply) => {
      const parsed = archiveBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Please explain the reason in at least 10 characters.",
        });
      }

      const existing = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.params.id))
        .get();

      if (!existing || existing.archivedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Project not found." });
      }

      // Archiving a project with live inventory would hide lots that are still
      // for sale, and contracts still being paid, from every screen at once.
      // The lots have to be dealt with first, deliberately, one by one.
      const activeLots = app.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(lots)
        .where(and(eq(lots.projectId, existing.id), isNull(lots.archivedAt)))
        .get();

      if (activeLots && activeLots.count > 0) {
        return reply.code(409).send({
          error: "project_has_lots",
          message:
            `Cannot archive ${existing.name}: it still has ${activeLots.count} ` +
            `active lot${activeLots.count === 1 ? "" : "s"}. ` +
            "Archive the lots first.",
        });
      }

      const actor = request.user!;
      const archivedAt = new Date().toISOString();

      app.db.transaction((tx) => {
        tx.update(projects)
          .set({ archivedAt, archiveReason: parsed.data.reason, updatedAt: archivedAt })
          .where(eq(projects.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "project",
          entityId: existing.id,
          action: "archive",
          reason: parsed.data.reason,
          before: { archivedAt: null },
          after: { archivedAt },
        });
      });

      return reply.send({ ok: true, archivedAt });
    },
  );

  // Archiving a project is reversible precisely because nothing was destroyed.
  app.post<{ Params: { id: string } }>(
    "/projects/:id/restore",
    { onRequest: app.requireCapability("project:archive") },
    async (request, reply) => {
      const existing = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.params.id))
        .get();

      if (!existing || existing.archivedAt === null) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "Archived project not found." });
      }

      const actor = request.user!;

      app.db.transaction((tx) => {
        tx.update(projects)
          .set({
            archivedAt: null,
            archiveReason: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(projects.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "project",
          entityId: existing.id,
          action: "restore",
          before: { archivedAt: existing.archivedAt },
          after: { archivedAt: null },
        });
      });

      return reply.send({ ok: true });
    },
  );
};

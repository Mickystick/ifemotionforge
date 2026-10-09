import { randomUUID } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { contracts, customers, lots, payments, projects } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { openContract } from "../lib/holding.js";
import { normalizePhone } from "../lib/phone.js";

/** Today as a YYYY-MM-DD calendar date. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Every customer's ACTIVE contracts, in one query.
 *
 * The Clientes table shows what each person currently holds, and that has to be
 * read from the contracts rather than kept as a column on the customer: a
 * "2 contratos" written on the customer row is wrong the moment a contract is
 * cancelled, and nobody would ever find out.
 *
 * Cancelled, defaulted and paid-off contracts are left out — they are the
 * customer's history, not what they are still paying on. So is a reservation
 * past its expiry date: the hold has lapsed and the lot is free again. See
 * `openContract`.
 */
const activeContractsQuery = (db: import("../db/client.js").Db, asOf: string) =>
  db
    .select({
      customerId: contracts.customerId,
      contractId: contracts.id,
      contractCode: contracts.code,
      kind: contracts.kind,
      salePriceCents: contracts.salePriceCents,
      lotCode: lots.code,
      projectName: projects.name,
      // Summed from the payments table, exactly as the lots list does it. There
      // is no stored balance anywhere in Lindero.
      paidToDateCents: sql<number>`
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
        ), 0)
      `,
    })
    .from(contracts)
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .where(openContract(asOf))
    .orderBy(asc(contracts.code));

const customerBody = z.object({
  fullName: z.string().trim().min(1).max(160),
  /**
   * Número de identidad. Optional, and unique among those who gave one.
   *
   * Blank is a real answer here, not a validation failure: an identidad is
   * confidential and is often simply not available when the customer is first
   * written down. `identificationOrNull` below turns every shape of "nothing"
   * into NULL before it reaches the database.
   */
  identification: z.string().trim().max(40).nullish(),
  /**
   * As typed, or blank when the customer has never given one. Normalised to
   * E.164 below rather than by the schema, so the refusal can explain what a
   * usable number looks like instead of failing as an anonymous validation
   * issue — and so blank can be told apart from unusable.
   */
  phone: z.string().trim().max(40).nullish(),
  /** Optional throughout: plenty of customers here have no email address. */
  email: z.string().trim().max(160).email().nullish(),
  address: z.string().trim().max(300).nullish(),
  customerSince: z.number().int().min(1900).max(2200),
  notes: z.string().trim().max(2000).nullish(),
});

/**
 * Deleting a customer asks for a motive, like archiving a lot does.
 *
 * The row itself is about to stop existing, so the audit entry is the ONLY
 * thing that will still be able to say this person was ever on file. A line
 * saying who removed them and why is the whole record.
 */
const deleteBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

/**
 * An identidad as the column stores it: the trimmed number, or NULL.
 *
 * One function so that "", "   ", null and undefined cannot end up meaning four
 * different things in the database. NULL rather than "" specifically, because
 * `customers_identification_unique` treats NULLs as distinct and empty strings
 * as equal — store "" and the SECOND customer without an identidad is refused
 * as a duplicate of the first, which is the exact case this is here to allow.
 */
function identificationOrNull(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";

  return trimmed === "" ? null : trimmed;
}

/**
 * A phone number as the column stores it: normalised E.164, or NULL when the
 * customer has never given one — as opposed to given one that will not parse.
 *
 * Blank is not sent through `normalizePhone`: an empty string would come back
 * `null` from that function too, and folding "never asked" together with
 * "typed something unusable" would turn every blank submission into the
 * `invalid_phone` refusal below, which is the one case here that is NOT an
 * error.
 */
function phoneOrNull(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";

  return trimmed === "" ? null : normalizePhone(trimmed);
}

/**
 * The clash an identity number would cause, worded for the user, or `null` when
 * it is free — as it always is for a customer who has not given one.
 *
 * Same reasoning as `lotCodeClash` in routes/lots.ts: the unique index is what
 * guarantees this, and the lookup is what turns the guarantee into a sentence
 * naming the person already on file. It matters more here than anywhere — a
 * customer entered twice splits their contracts across two records, and the
 * balance on each one is then quietly wrong.
 *
 * A missing identidad cannot clash with anything, and must not: two customers
 * who have both declined to give one are two customers, not a duplicate. That
 * is the one duplicate this check has to let through, and the reason the
 * comparison never runs on NULL.
 */
function identificationClash(
  db: import("../db/client.js").Db,
  identification: string | null,
  ignoreCustomerId?: string,
): string | null {
  if (identification === null) {
    return null;
  }

  const clash = db
    .select({ id: customers.id, fullName: customers.fullName })
    .from(customers)
    .where(eq(customers.identification, identification))
    .get();

  if (!clash || clash.id === ignoreCustomerId) {
    return null;
  }

  return `ID ${identification} is already registered to ${clash.fullName}.`;
}

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/customers", { onRequest: app.requireUser }, async (request, reply) => {
    const rows = app.db.select().from(customers).orderBy(asc(customers.fullName)).all();

    // One query for the contracts, grouped in memory, rather than one query per
    // customer. The list is small, but the shape of the mistake is not.
    const byCustomer = new Map<string, Array<Record<string, unknown>>>();

    for (const row of activeContractsQuery(app.db, today()).all()) {
      const list = byCustomer.get(row.customerId) ?? [];

      list.push({
        contractId: row.contractId,
        contractCode: row.contractCode,
        kind: row.kind,
        lotCode: row.lotCode,
        projectName: row.projectName,
        salePrice: row.salePriceCents,
        paidToDate: row.paidToDateCents,
      });

      byCustomer.set(row.customerId, list);
    }

    return reply.send({
      customers: rows.map((row) => ({
        id: row.id,
        fullName: row.fullName,
        identification: row.identification,
        phone: row.phone,
        email: row.email,
        address: row.address,
        customerSince: row.customerSince,
        notes: row.notes,
        contracts: byCustomer.get(row.id) ?? [],
      })),
    });
  });

  app.post(
    "/customers",
    { onRequest: app.requireCapability("customer:create") },
    async (request, reply) => {
      const parsed = customerBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Check the customer details.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const typedPhone = parsed.data.phone?.trim() ?? "";
      const phone = phoneOrNull(typedPhone);

      if (typedPhone !== "" && phone === null) {
        return reply.code(400).send({
          error: "invalid_phone",
          message:
            "This phone number does not look valid. Enter the 8-digit Honduran number " +
            "(9982-4471) or the full number with its country code (+1 305 555 0123), " +
            "or leave it blank if the customer does not have a number on file.",
        });
      }

      const identification = identificationOrNull(parsed.data.identification);
      const clash = identificationClash(app.db, identification);

      if (clash) {
        return reply.code(409).send({ error: "duplicate_identification", message: clash });
      }

      const now = new Date().toISOString();

      // Not in the Historial: a new customer is its own record, and an edit's
      // `before` says what it used to be. See `AuditEntry`.
      const created = app.db
        .insert(customers)
        .values({
          id: randomUUID(),
          fullName: parsed.data.fullName,
          identification,
          phone,
          email: parsed.data.email ?? null,
          address: parsed.data.address ?? null,
          customerSince: parsed.data.customerSince,
          notes: parsed.data.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      return reply.code(201).send({
        customer: { id: created.id, fullName: created.fullName, phone: created.phone },
      });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/customers/:id",
    { onRequest: app.requireCapability("customer:edit") },
    async (request, reply) => {
      const parsed = customerBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Check the customer details.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const existing = app.db
        .select()
        .from(customers)
        .where(eq(customers.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Customer not found." });
      }

      const typedPhone = parsed.data.phone?.trim() ?? "";
      const phone = phoneOrNull(typedPhone);

      if (typedPhone !== "" && phone === null) {
        return reply.code(400).send({
          error: "invalid_phone",
          message:
            "This phone number does not look valid. Enter the 8-digit Honduran number " +
            "(9982-4471) or the full number with its country code (+1 305 555 0123), " +
            "or leave it blank if the customer does not have a number on file.",
        });
      }

      const identification = identificationOrNull(parsed.data.identification);
      const clash = identificationClash(app.db, identification, existing.id);

      if (clash) {
        return reply.code(409).send({ error: "duplicate_identification", message: clash });
      }

      const actor = request.user!;

      const updated = app.db.transaction((tx) => {
        const next = tx
          .update(customers)
          .set({
            fullName: parsed.data.fullName,
            identification,
            phone,
            email: parsed.data.email ?? null,
            address: parsed.data.address ?? null,
            customerSince: parsed.data.customerSince,
            notes: parsed.data.notes ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(customers.id, existing.id))
          .returning()
          .get();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "customer",
          entityId: existing.id,
          action: "update",
          before: {
            fullName: existing.fullName,
            identification: existing.identification,
            phone: existing.phone,
            email: existing.email,
            address: existing.address,
            notes: existing.notes,
          },
          after: {
            fullName: next.fullName,
            identification: next.identification,
            phone: next.phone,
            email: next.email,
            address: next.address,
            notes: next.notes,
          },
        });

        return next;
      });

      return reply.send({
        customer: { id: updated.id, fullName: updated.fullName, phone: updated.phone },
      });
    },
  );

  /**
   * Delete a customer outright.
   *
   * This is the one place in Lindero where a row really is removed instead of
   * archived, and it is only safe because of the guard below: a customer who has
   * never appeared on a contract has no history to tear. Nothing points at them,
   * so nothing breaks when they go.
   *
   * The moment a contract exists the answer is no, and the two cases are kept
   * apart on purpose:
   *
   * - An ACTIVE contract means this person is holding a lot right now. Deleting
   *   them would leave that lot held by nobody, and the Lotes screen would show
   *   a contract with an empty name.
   * - A finished contract — cancelled, paid off, defaulted — is history. The
   *   payments under it are real money that was really received, and a receipt
   *   nobody can trace back to a person is not a record of anything.
   *
   * Neither is a case for a delete button. When a customer with history has to
   * go away, what is actually wanted is a contract cancellation, which is its
   * own deliberate action with its own trail.
   */
  app.delete<{ Params: { id: string } }>(
    "/customers/:id",
    { onRequest: app.requireCapability("customer:delete") },
    async (request, reply) => {
      const parsed = deleteBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Please explain the reason in at least 10 characters.",
        });
      }

      const existing = app.db
        .select()
        .from(customers)
        .where(eq(customers.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Customer not found." });
      }

      // Every contract this person has ever been on, not just the live ones.
      // The active count decides the wording; the total decides the answer.
      const held = app.db
        .select({ code: contracts.code, status: contracts.status })
        .from(contracts)
        .where(eq(contracts.customerId, existing.id))
        .orderBy(asc(contracts.code))
        .all();

      const active = held.filter((contract) => contract.status === "active");

      if (active.length > 0) {
        return reply.code(409).send({
          error: "customer_has_active_contracts",
          message:
            `Cannot delete ${existing.fullName}: they still have ` +
            `${active.length} active contract${active.length === 1 ? "" : "s"} ` +
            `(${active.map((contract) => contract.code).join(", ")}). ` +
            "Cancel the contract first.",
          contractCodes: active.map((contract) => contract.code),
        });
      }

      if (held.length > 0) {
        return reply.code(409).send({
          error: "customer_has_history",
          message:
            `Cannot delete ${existing.fullName}: they have ` +
            `${held.length} contract${held.length === 1 ? "" : "s"} in their history ` +
            `(${held.map((contract) => contract.code).join(", ")}). ` +
            "Deleting this customer would leave those payments without an owner.",
          contractCodes: held.map((contract) => contract.code),
        });
      }

      const actor = request.user!;

      app.db.transaction((tx) => {
        tx.delete(customers).where(eq(customers.id, existing.id)).run();

        // Written with the full record in `before`, because after this
        // transaction there is nowhere else left to read it from. The audit
        // screen falls back to this name for exactly that reason — see the
        // label resolution in routes/audit.ts.
        recordAudit(tx, {
          actorId: actor.id,
          entityType: "customer",
          entityId: existing.id,
          action: "delete",
          reason: parsed.data.reason,
          before: {
            fullName: existing.fullName,
            identification: existing.identification,
            phone: existing.phone,
            email: existing.email,
            address: existing.address,
            customerSince: existing.customerSince,
            notes: existing.notes,
          },
        });
      });

      return reply.send({ ok: true, deleted: { id: existing.id, fullName: existing.fullName } });
    },
  );
};

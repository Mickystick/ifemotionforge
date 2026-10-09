import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { contracts, customers, lots, payments, projects, receipts, users } from "../db/schema.js";
import { splitEvenly } from "../lib/allocation.js";
import type { AllocationTarget } from "../lib/allocation.js";
import { attachmentsForPayment, attachmentsForReceipts } from "../lib/storedFiles.js";
import { recordAudit } from "../lib/audit.js";
import { assessContract } from "../lib/contracts.js";
import type { ContractTerms, SaleType } from "../lib/contracts.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import { roleCan } from "../lib/capabilities.js";
import { openContract } from "../lib/holding.js";
import { replayContract } from "../lib/ledger.js";

/** Today as a YYYY-MM-DD calendar date. */
const today = () => new Date().toISOString().slice(0, 10);

const PAYMENT_METHODS = ["cash", "transfer", "card"] as const;
const PAYMENT_TYPES = ["down_payment", "installment", "full_payment", "adjustment"] as const;

/**
 * Every posted transaction, with the context needed to make sense of it.
 *
 * One endpoint behind BOTH views of the Recibos screen — the flat list by date
 * and the grouped list by customer. Grouping is a question about presentation,
 * so it is answered in the browser from a single ordered list rather than by a
 * second endpoint that could disagree with the first about what exists.
 *
 * Payments with no receipt are included. They are real money, they count in
 * every balance, and leaving them out of the transactions screen would mean
 * this list disagreed with the contract it belongs to.
 */
const transactionsQuery = (db: Db) => {
  // The contract an adenda closed to write this row's contract — the same table
  // twice in one query, so it needs a name of its own.
  const predecessor = alias(contracts, "predecessor");

  return db
    .select({
      id: payments.id,
      amount: payments.amountCents,
      originalAmount: payments.originalAmountCents,
      originalCurrency: payments.originalCurrency,
      exchangeRate: payments.exchangeRate,
      paidOn: payments.paidOn,
      method: payments.method,
      type: payments.type,
      reference: payments.reference,
      notes: payments.notes,
      reversedAt: payments.reversedAt,
      reversalReason: payments.reversalReason,
      createdAt: payments.createdAt,
      contractId: contracts.id,
      contractCode: contracts.code,
      contractStatus: contracts.status,
      replacesContractCode: predecessor.code,
      lotCode: lots.code,
      projectName: projects.name,
      customerId: customers.id,
      customerName: customers.fullName,
      customerIdentification: customers.identification,
      receiptId: receipts.id,
      receiptCode: receipts.code,
      // The receipt's internal note, so a row can say "there is a message here"
      // without the list having to open every receipt to find out.
      receiptNote: receipts.note,
      receiptVoidedAt: receipts.voidedAt,
      recordedByName: users.name,
    })
    .from(payments)
    .innerJoin(contracts, eq(contracts.id, payments.contractId))
    .leftJoin(predecessor, eq(predecessor.id, contracts.replacesContractId))
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .innerJoin(customers, eq(customers.id, contracts.customerId))
    .innerJoin(users, eq(users.id, payments.recordedBy))
    .leftJoin(receipts, eq(receipts.id, payments.receiptId));
};

/**
 * What a transaction edit may change.
 *
 * Note what is NOT here: the contract. Moving money from one lot to another is
 * not an edit, it is a reversal and a new payment — the two contracts have
 * separate balances, separate receipts and, quite possibly, separate customers,
 * and one UPDATE that silently rewrites both ledgers is not something anybody
 * could explain afterwards.
 */
const editBody = z.object({
  amountCents: z.number().int().positive(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format."),
  method: z.enum(PAYMENT_METHODS),
  type: z.enum(PAYMENT_TYPES),
  reference: z.string().trim().max(120).nullish(),
  /**
   * The payment's OWN note — only meaningful for money recorded before there
   * were receipts, which has no receipt to hold a note. Absent leaves it as it
   * is; see `receiptNote` for where a note goes everywhere else.
   */
  notes: z.string().trim().max(300).nullish(),
  /**
   * The note on the receipt this payment is a line of: the team's note, shared
   * by every line of it and shown in the Nota del equipo box.
   *
   * Three states, and the difference is the point. ABSENT leaves it alone, so a
   * correction that never touched the note cannot erase one. Blank or `null`
   * clears it. Text sets it. It is written here, in the same transaction as the
   * correction, only so the two cannot half-happen — changing it needs
   * `payment:record` as well, because this route must not be a way round the
   * permission `PATCH /receipts/:id/note` is gated on.
   */
  receiptNote: z.string().trim().max(500).nullish(),
  /**
   * Required, and at least a sentence.
   *
   * This is the one place in the app where a posted financial fact is rewritten
   * in place rather than reversed, so the audit entry is the only record that
   * the old figure ever existed. "Ajuste" tells a reader nothing; the rule the
   * app already applies to cancelling a contract applies here for the same
   * reason.
   */
  reason: z.string().trim().min(10).max(500),
  /** Deliberate acknowledgement that the new amount exceeds what is owed. */
  allowOverpayment: z.boolean().default(false),
  /**
   * The OTHER lines of the same receipt this correction also applies to.
   *
   * A receipt covering three lots is three payment rows, and a wrong date or a
   * wrong method on one of them is almost always wrong on all three — they were
   * typed once, from one piece of paper. This is what lets the fix be made once
   * as well.
   *
   * What travels is deliberately not everything. `paidOn`, `method`, `type` and
   * `reference` describe the ACT of paying, which the lines share by
   * construction, so copying them across is restating one fact.
   * `amountCents` and `notes` describe one lot's share, and copying an amount
   * onto three rows would turn an L 40,000 receipt into L 120,000 — which is
   * what somebody "applying a date change to all lots" would be doing without
   * meaning to. Moving an AMOUNT between lots is a different operation with a
   * different rule (the parts must still sum to the receipt), and it lives at
   * POST /receipts/:id/redistribute.
   */
  applyToPaymentIds: z.array(z.string().min(1)).max(50).default([]),
});

export const transactionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/transactions", { onRequest: app.requireUser }, async () => {
    const rows = transactionsQuery(app.db)
      .orderBy(desc(payments.paidOn), desc(payments.createdAt))
      .all();

    /*
     * The comprobantes, so a row can show one without being opened.
     *
     * The whole point of the thumbnail on a transaction row is that checking
     * "is this the right slip?" costs a glance rather than a click, a fetch and
     * a wait — so the list has to arrive already knowing what is attached. One
     * extra query for the entire screen, not one per row.
     *
     * Only the metadata travels. The bytes are fetched per file, lazily, by the
     * browser, from /api/attachments/:id/file — a hundred rows must not mean a
     * hundred photographs on the wire before anything is drawn.
     */
    const byReceipt = attachmentsForReceipts(
      app.db,
      [...new Set(rows.map((row) => row.receiptId).filter((id) => id !== null))],
    );

    return {
      transactions: rows.map((row) => ({
        ...row,
        attachments:
          row.receiptId === null
            ? []
            : attachmentsForPayment(byReceipt.get(row.receiptId), row.id),
      })),
    };
  });

  /**
   * How one amount would divide across everything a customer is paying on.
   *
   * The customer hands over a single figure for three lots; this proposes where
   * it lands. The rule itself is in src/lib/allocation.ts: equal shares to the
   * centavo, never more than a lot owes nor less than its next installment,
   * with any odd centavo going to the lot that owes the most.
   *
   * A PROPOSAL. Nothing is written, and the screen lets every line be
   * overridden before the receipt is issued.
   *
   * Distinct from the sale-group split already in routes/contracts.ts: that one
   * divides across the lots of ONE purchase. This divides across everything the
   * person currently owes on, which is what somebody paying at a window
   * actually means when they hand over a lump sum.
   */
  app.get<{ Params: { id: string }; Querystring: { amountCents?: string } }>(
    "/customers/:id/split",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const amountCents = Number(request.query.amountCents);

      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return reply.code(400).send({
          error: "invalid_amount",
          message: "Enter the amount to distribute, in cents.",
        });
      }

      const customer = app.db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, request.params.id))
        .get();

      if (!customer) {
        return reply
          .code(404)
          .send({ error: "customer_not_found", message: "That customer does not exist." });
      }

      const asOf = today();

      const open = app.db
        .select({
          id: contracts.id,
          code: contracts.code,
          saleType: contracts.saleType,
          salePriceCents: contracts.salePriceCents,
          downPaymentCents: contracts.downPaymentCents,
          termMonths: contracts.termMonths,
          monthlyPaymentCents: contracts.monthlyPaymentCents,
          dueDay: contracts.dueDay,
          signedOn: contracts.signedOn,
          firstDueOn: contracts.firstDueOn,
          createdAt: contracts.createdAt,
          lotCode: lots.code,
          projectName: projects.name,
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
        // Contracts still being serviced — a paid-off or lapsed one has
        // nothing left to pay, so it is not a split target.
        .where(and(eq(contracts.customerId, request.params.id), openContract(asOf)))
        .all();

      const targets: AllocationTarget[] = open.map((contract) => {
        const terms: ContractTerms = {
          saleType: contract.saleType as SaleType,
          salePriceCents: contract.salePriceCents,
          downPaymentCents: contract.downPaymentCents,
          termMonths: contract.termMonths,
          monthlyPaymentCents: contract.monthlyPaymentCents,
          dueDay: contract.dueDay,
          signedOn: contract.signedOn ?? contract.createdAt.slice(0, 10),
          firstDueOn: contract.firstDueOn,
        };

        return {
          contractId: contract.id,
          code: contract.code,
          balanceCents: Math.max(0, contract.salePriceCents - contract.paidToDateCents),
          // The next installment this lot still needs, so a plain even split
          // cannot round it below what it owes RIGHT NOW while another lot
          // that merely owes more overall takes the surplus.
          minimumDueCents: assessContract(terms, contract.paidToDateCents, asOf).nextDueAmountCents,
        };
      });

      const result = splitEvenly(amountCents, targets);
      const byContract = new Map(
        result.allocations.map((allocation) => [allocation.contractId, allocation.amountCents]),
      );
      const shortOfMinimum = new Set(result.shortOfMinimumContractIds);

      return {
        lines: open
          .map((contract) => {
            const amount = byContract.get(contract.id) ?? 0;
            const balanceBefore = Math.max(0, contract.salePriceCents - contract.paidToDateCents);

            return {
              contractId: contract.id,
              contractCode: contract.code,
              lotCode: contract.lotCode,
              projectName: contract.projectName,
              amountCents: amount,
              balanceBefore,
              balanceAfter: Math.max(0, balanceBefore - amount),
              // The total handed over could not cover this lot's own next
              // installment even after favoring the smallest ones first — the
              // screen warns rather than silently posting a short payment.
              belowMinimum: shortOfMinimum.has(contract.id),
            };
          })
          // Contracts receiving nothing are still listed, so the screen can show
          // a paid-off lot sitting at zero rather than silently omitting it and
          // leaving somebody to wonder where their third lot went.
          .sort((a, b) => a.lotCode.localeCompare(b.lotCode, "es")),
        unallocatedCents: result.unallocatedCents,
      };
    },
  );

  /**
   * Correct a posted transaction.
   *
   * This is the one place in Lindero where a financial row is rewritten rather
   * than reversed, and it exists because the owner asked for exactly this: find
   * out two months later that a payment was really L 10,000, change it, and
   * have every figure after it re-adjust. Because balances are replayed rather
   * than stored, they do — see src/lib/ledger.ts.
   *
   * What protects it is that nothing is LOST: the before and after are both
   * written to the audit history along with a required reason, so the previous
   * figure is still answerable for. That is the trade being made deliberately —
   * an editable amount with a full paper trail, rather than an immutable row
   * that forces a reversal-plus-repost for a simple typo.
   *
   * A reversed payment cannot be edited. It is already out of the accounts, and
   * editing the amount of money that is not counted is meaningless.
   */
  app.patch<{ Params: { id: string } }>(
    "/transactions/:id",
    /*
     * `payment:edit`, NOT `payment:reverse`.
     *
     * The two used to share a permission, and the label on that permission —
     * "Reversar pagos: corrige un pago escribiendo una reversa" — described only
     * half of what it handed over. A reversal writes a second, visible entry and
     * leaves the original standing; this route rewrites a posted figure in
     * place. The old amount survives only in the audit history, which is a
     * different and larger amount of trust.
     *
     * The app already draws this exact line between `contract:edit` and
     * `contract:reprice`: moving a due date and moving a balance are not the
     * same permission. Same reasoning, same split.
     */
    { onRequest: app.requireCapability("payment:edit") },
    async (request, reply) => {
      const parsed = editBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_transaction",
          message: parsed.error.issues[0]?.message ?? "Check the transaction details.",
        });
      }

      const body = parsed.data;

      const existing = app.db
        .select()
        .from(payments)
        .where(eq(payments.id, request.params.id))
        .get();

      if (!existing) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "That transaction does not exist." });
      }

      if (existing.reversedAt) {
        return reply.code(409).send({
          error: "already_reversed",
          message: "That transaction has been reversed and is no longer included in balances.",
        });
      }

      /*
       * The sibling lines this correction also covers.
       *
       * Every one has to be a live row of the SAME receipt. Without that check
       * a caller could name any payment id in the database and rewrite its date
       * and method through a route that looks like it only touches one row —
       * and the reason attached to it would be about somebody else's payment.
       */
      const siblingIds = [...new Set(body.applyToPaymentIds)].filter((id) => id !== existing.id);
      let siblings: Array<typeof existing> = [];

      if (siblingIds.length > 0) {
        if (existing.receiptId === null) {
          return reply.code(400).send({
            error: "no_receipt",
            message: "That transaction is not part of a receipt, so it has no other line items.",
          });
        }

        siblings = app.db
          .select()
          .from(payments)
          .where(inArray(payments.id, siblingIds))
          .all();

        if (siblings.length !== siblingIds.length) {
          return reply
            .code(404)
            .send({ error: "not_found", message: "One of the line items no longer exists." });
        }

        const stray = siblings.find((row) => row.receiptId !== existing.receiptId);

        if (stray) {
          return reply.code(400).send({
            error: "different_receipt",
            message: "Only line items from the same receipt can be corrected together.",
          });
        }

        const reversed = siblings.find((row) => row.reversedAt !== null);

        if (reversed) {
          return reply.code(409).send({
            error: "already_reversed",
            message: "One of the line items has been reversed and is no longer included in balances.",
          });
        }
      }

      const contract = app.db
        .select({
          id: contracts.id,
          code: contracts.code,
          salePriceCents: contracts.salePriceCents,
        })
        .from(contracts)
        .where(eq(contracts.id, existing.contractId))
        .get();

      if (!contract) {
        return reply
          .code(404)
          .send({ error: "contract_not_found", message: "The contract no longer exists." });
      }

      if (!body.allowOverpayment) {
        // The balance WITHOUT this payment, so the check asks "would the new
        // amount overpay", not "does it differ from the old one".
        const others = app.db
          .select({
            id: payments.id,
            amountCents: payments.amountCents,
            paidOn: payments.paidOn,
            createdAt: payments.createdAt,
            reversedAt: payments.reversedAt,
          })
          .from(payments)
          .where(sql`${payments.contractId} = ${contract.id} AND ${payments.id} <> ${existing.id}`)
          .all();

        const room = replayContract({
          salePriceCents: contract.salePriceCents,
          credits: others,
        }).balanceCents;

        if (body.amountCents > room) {
          return reply.code(409).send({
            error: "overpayment",
            message:
              `Without this transaction, contract ${contract.code} would have L ` +
              `${(room / 100).toLocaleString("en-HN")} remaining. ` +
              "Confirm the overpayment if the customer actually paid extra.",
            balanceCents: room,
          });
        }
      }

      /*
       * The team note this correction also writes, if it changes it.
       *
       * The note belongs to the RECEIPT, not to this line: a receipt covering
       * three lots is one piece of paper and one message, and the other two
       * lines have to read the same words this one does. Writing it to the
       * receipt row is what makes that true without copying it anywhere.
       */
      let noteChange: { receiptId: string; after: string | null } | null = null;

      if (body.receiptNote !== undefined) {
        if (existing.receiptId === null) {
          return reply.code(400).send({
            error: "no_receipt",
            message: "That transaction is not part of a receipt, so it has no team note.",
          });
        }

        const receipt = app.db
          .select({ id: receipts.id, note: receipts.note })
          .from(receipts)
          .where(eq(receipts.id, existing.receiptId))
          .get();

        const nextNote = body.receiptNote === null || body.receiptNote === "" ? null : body.receiptNote;

        // Only a note that actually differs needs the permission, so a
        // correction that sends the note back unchanged — which a form that
        // always includes the field will — is not refused for it.
        if (receipt && nextNote !== (receipt.note ?? null)) {
          if (!roleCan(app.db, request.user!.role, "payment:record")) {
            return reply.code(403).send({
              error: "forbidden",
              message: "Your account can correct transactions but cannot change the receipt note.",
            });
          }

          noteChange = { receiptId: receipt.id, after: nextNote };
        }
      }

      const before = {
        amountCents: existing.amountCents,
        paidOn: existing.paidOn,
        method: existing.method,
        type: existing.type,
        reference: existing.reference,
        notes: existing.notes,
      };

      const after = {
        amountCents: body.amountCents,
        paidOn: body.paidOn,
        method: body.method,
        type: body.type,
        reference: body.reference ?? null,
        // Absent is "leave it", not "clear it": the form no longer sends the
        // payment's own note for a line that has a receipt, and a correction
        // that never mentioned it must not wipe one typed before that changed.
        notes: body.notes === undefined ? existing.notes : (body.notes ?? null),
      };

      app.db.transaction((tx) => {
        tx.update(payments)
          .set({
            ...after,
            // The original currency figure travels with the amount. A payment
            // recorded in lempiras keeps them equal; one taken in dollars keeps
            // the rate it was settled at, so re-deriving the dollar figure from
            // the stored rate is the only answer that stays true to what the
            // customer actually handed over.
            originalAmountCents:
              existing.originalCurrency === "HNL"
                ? body.amountCents
                : Math.round(body.amountCents / Number(existing.exchangeRate)),
          })
          .where(eq(payments.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: request.user!.id,
          entityType: "payment",
          entityId: existing.id,
          action: "update",
          reason: body.reason,
          before,
          after,
        });

        // Not in the Historial, the same as `PATCH /receipts/:id/note`: the note
        // is a message, whichever door it came through.
        if (noteChange) {
          tx.update(receipts)
            .set({ note: noteChange.after })
            .where(eq(receipts.id, noteChange.receiptId))
            .run();
        }

        /*
         * The same act of paying, restated on the other lines of the receipt.
         *
         * Only the four fields that describe the act — never the amount, which
         * is this lot's share and nobody else's. See `applyToPaymentIds`.
         */
        for (const sibling of siblings) {
          tx.update(payments)
            .set({
              paidOn: after.paidOn,
              method: after.method,
              type: after.type,
              reference: after.reference,
            })
            .where(eq(payments.id, sibling.id))
            .run();

          // The reason is written once by the person and repeated here, so each
          // line's own history answers "why did this change" without having to
          // be traced back to a sibling row.
          recordAudit(tx, {
            actorId: request.user!.id,
            entityType: "payment",
            entityId: sibling.id,
            action: "update",
            reason: body.reason,
            before: {
              paidOn: sibling.paidOn,
              method: sibling.method,
              type: sibling.type,
              reference: sibling.reference,
            },
            after: {
              paidOn: after.paidOn,
              method: after.method,
              type: after.type,
              reference: after.reference,
            },
          });
        }

        // A corrected amount can close a contract (down to zero) or reopen a
        // paid-off one (corrected below the price again).
        //
        // The siblings keep their amounts, so their balances cannot have moved
        // — but their `paidOn` can have, and the lifecycle is derived by
        // replaying the ledger in date order. Cheaper to sync them than to
        // reason about which date changes could matter.
        for (const contractId of new Set([
          existing.contractId,
          ...siblings.map((sibling) => sibling.contractId),
        ])) {
          syncContractLifecycle(tx, contractId);
        }
      });

      const updated = transactionsQuery(app.db).where(eq(payments.id, existing.id)).get();

      return { transaction: updated };
    },
  );
};

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { contractAmendments, contractDocuments, contracts, customers, lots, payments, projects, receipts, users, } from "../db/schema.js";
import { MAX_DOCUMENTS_PER_CONTRACT, MAX_DOCUMENT_BYTES, isAllowedContentType, removeStoredFile, safeDisplayName, sendStoredFile, storageKeyFor, } from "../lib/storedFiles.js";
import { splitEvenly } from "../lib/allocation.js";
import { recordAudit } from "../lib/audit.js";
import { assessContract, buildSchedule, financedCents, firstDueDate, isReservationExpired, } from "../lib/contracts.js";
import { roleCan } from "../lib/capabilities.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import { holdsLot, openContract } from "../lib/holding.js";
import { businessToday } from "../lib/time.js";
/**
 * The contracts list, with every derived figure computed on read.
 *
 * The row carries the agreed TERMS. What is financed, what has been paid, what
 * is still owed and whether the customer is behind are all worked out here and
 * in src/lib/contracts.ts, every time. None of them is a column, so none of
 * them can be stale — which is the whole reason this app exists rather than a
 * spreadsheet with a `balance` field somebody has to remember to update.
 */
const contractsListQuery = (db) => db
    .select({
    id: contracts.id,
    code: contracts.code,
    saleGroupId: contracts.saleGroupId,
    kind: contracts.kind,
    saleType: contracts.saleType,
    status: contracts.status,
    salePriceCents: contracts.salePriceCents,
    downPaymentCents: contracts.downPaymentCents,
    termMonths: contracts.termMonths,
    monthlyPaymentCents: contracts.monthlyPaymentCents,
    dueDay: contracts.dueDay,
    signedOn: contracts.signedOn,
    firstDueOn: contracts.firstDueOn,
    expiresOn: contracts.expiresOn,
    closedAt: contracts.closedAt,
    closedReason: contracts.closedReason,
    closedSettlement: contracts.closedSettlement,
    notes: contracts.notes,
    createdAt: contracts.createdAt,
    lotId: lots.id,
    lotCode: lots.code,
    lotAreaM2: lots.areaM2,
    projectName: projects.name,
    customerId: customers.id,
    customerName: customers.fullName,
    customerPhone: customers.phone,
    customerEmail: customers.email,
    paidToDateCents: sql `
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
        ), 0)
      `,
    // Asked separately from paid-to-date on purpose. The prima that was
    // AGREED is a term of the contract; whether it ever arrived is a fact
    // about the payments, and a screen showing only one of the two cannot
    // tell you about a customer who signed and then never came back.
    downPaymentPaidCents: sql `
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
            AND ${payments.type} = 'down_payment'
        ), 0)
      `,
})
    .from(contracts)
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .innerJoin(customers, eq(customers.id, contracts.customerId));
/**
 * How many documents each contract carries, for the whole list at once.
 *
 * A GROUP BY rather than a count per row: the Contratos screen shows every
 * contract in the business, and asking the database once per row is the N+1
 * that turns one screen into four hundred queries. Contracts with no paperwork
 * are simply absent from the map, and the caller reads that as zero.
 */
function documentCountsFor(db) {
    const rows = db
        .select({
        contractId: contractDocuments.contractId,
        value: sql `COUNT(*)`,
    })
        .from(contractDocuments)
        .groupBy(contractDocuments.contractId)
        .all();
    return new Map(rows.map((row) => [row.contractId, row.value]));
}
/** One document as the API reports it. `storageKey` never leaves the server. */
function presentDocument(row) {
    return {
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        byteSize: row.byteSize,
        createdAt: row.createdAt,
        /*
         * Who put it there.
         *
         * Not shown for a comprobante, and shown here, because the question asked
         * of a legal document six months later is "who filed this, and when" — the
         * same question the audit log answers about everything else that matters.
         */
        uploadedBy: row.uploadedByName,
    };
}
const NO_LINKS = { bySuccessor: new Map(), byPredecessor: new Map() };
/**
 * Every adenda link in the business, both ways round, in one query.
 *
 * The panel of either contract has to be able to say what is on the other
 * side — "reemplaza a CT-2026-011", "reemplazado por CT-2026-011-A1" — and the
 * list is the only thing the screen loads. One join over the successors, which
 * are the only rows carrying the link, answers both directions.
 */
function amendmentLinksFor(db) {
    const predecessor = alias(contracts, "predecessor");
    const rows = db
        .select({
        successorId: contracts.id,
        successorCode: contracts.code,
        predecessorId: predecessor.id,
        predecessorCode: predecessor.code,
        amendmentId: contractAmendments.id,
        effectiveOn: contractAmendments.effectiveOn,
        reason: contractAmendments.reason,
        authorizedBy: contractAmendments.authorizedBy,
        recordedAt: contractAmendments.createdAt,
        recordedBy: users.name,
    })
        .from(contracts)
        .innerJoin(predecessor, eq(predecessor.id, contracts.replacesContractId))
        .innerJoin(contractAmendments, eq(contractAmendments.id, contracts.amendmentId))
        .innerJoin(users, eq(users.id, contractAmendments.recordedBy))
        .all();
    const links = { bySuccessor: new Map(), byPredecessor: new Map() };
    for (const row of rows) {
        const amendment = {
            id: row.amendmentId,
            effectiveOn: row.effectiveOn,
            reason: row.reason,
            authorizedBy: row.authorizedBy,
            recordedBy: row.recordedBy,
            recordedAt: row.recordedAt,
        };
        links.bySuccessor.set(row.successorId, {
            contractId: row.predecessorId,
            code: row.predecessorCode,
            amendment,
        });
        links.byPredecessor.set(row.predecessorId, {
            contractId: row.successorId,
            code: row.successorCode,
            amendment,
        });
    }
    return links;
}
/** Every document on one contract, oldest first, with who uploaded each. */
function documentsFor(db, contractId) {
    return db
        .select({
        id: contractDocuments.id,
        fileName: contractDocuments.fileName,
        contentType: contractDocuments.contentType,
        byteSize: contractDocuments.byteSize,
        createdAt: contractDocuments.createdAt,
        uploadedByName: users.name,
    })
        .from(contractDocuments)
        .innerJoin(users, eq(users.id, contractDocuments.uploadedBy))
        .where(eq(contractDocuments.contractId, contractId))
        // Oldest first: the signed contract is normally the first thing filed, and
        // the adenda that follow read in the order they happened.
        .orderBy(asc(contractDocuments.createdAt), asc(contractDocuments.id))
        .all();
}
/**
 * A contract as the API reports it: what was signed, plus what follows from it.
 *
 * `signedOn` falls back to the day the row was created. Contracts written
 * before the signing date existed as a column were backfilled that way by
 * migration 0004, and this keeps the fallback in one place rather than letting
 * a null reach the arithmetic.
 *
 * `documentCount` is a COUNT and not the documents themselves. The list is
 * every contract in the business and each one can carry a dozen scans; sending
 * their metadata down on a screen that only needs to mark which contracts have
 * their paperwork on file would be a page of JSON nobody reads. The panel asks
 * for the actual list when a contract is opened.
 */
function present(row, asOf, documentCount = 0, links = NO_LINKS) {
    const terms = {
        saleType: row.saleType,
        salePriceCents: row.salePriceCents,
        downPaymentCents: row.downPaymentCents,
        termMonths: row.termMonths,
        monthlyPaymentCents: row.monthlyPaymentCents,
        dueDay: row.dueDay,
        signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
        firstDueOn: row.firstDueOn,
    };
    const health = assessContract(terms, row.paidToDateCents, asOf);
    return {
        id: row.id,
        code: row.code,
        saleGroupId: row.saleGroupId,
        kind: row.kind,
        saleType: row.saleType,
        status: row.status,
        /**
         * A reservation whose `expiresOn` has passed. The row still reads
         * `status = 'active'` — nothing rewrites it — but the hold has lapsed: the
         * lot is available again and the Contratos screen shows this one as
         * "Vencida". Derived here, like every other status in the app.
         */
        expired: isReservationExpired(row.kind, row.expiresOn, asOf),
        lot: {
            id: row.lotId,
            code: row.lotCode,
            projectName: row.projectName,
            areaM2: row.lotAreaM2,
        },
        customer: {
            id: row.customerId,
            fullName: row.customerName,
            phone: row.customerPhone,
            /*
             * Carried so the list can offer to write to this person without a second
             * request per row. Optional in the same way it is on the customer: an
             * address nobody gave is `null`, and the button that needs one is
             * disabled rather than hidden — a missing address is a fact about the
             * record worth seeing, not a feature to make disappear.
             */
            email: row.customerEmail,
        },
        terms: {
            salePrice: row.salePriceCents,
            downPayment: row.downPaymentCents,
            /** Derived: the part being paid in installments. Never a stored column. */
            financed: financedCents(terms),
            termMonths: row.termMonths,
            monthlyPayment: row.monthlyPaymentCents,
            dueDay: row.dueDay,
            signedOn: terms.signedOn,
            /** When the first installment actually falls due — derived if not agreed. */
            firstDueOn: firstDueDate(terms),
            /**
             * The stored column, `null` when the first due date simply follows from
             * the signing date.
             *
             * Sent alongside the computed one because the edit form cannot tell them
             * apart otherwise, and the difference matters: writing a derived date
             * back into the column would PIN it, so a later correction to `signedOn`
             * would silently stop moving the schedule with it.
             */
            firstDueOnAgreed: row.firstDueOn,
            expiresOn: row.expiresOn,
        },
        /** Every figure below is computed on this request. */
        downPaymentPaid: row.downPaymentPaidCents,
        paidToDate: row.paidToDateCents,
        balance: health.balanceCents,
        health: {
            status: health.status,
            arrears: health.arrearsCents,
            monthsBehind: health.monthsBehind,
            monthsAhead: health.monthsAhead,
            nextDueOn: health.nextDueOn,
            nextDueAmount: health.nextDueAmountCents,
            nextInstallment: health.nextInstallmentCents,
            nextDueCredit: health.nextDueCreditCents,
            settled: health.settled,
        },
        installmentCount: buildSchedule(terms).length,
        /**
         * How many files of signed paperwork this contract has.
         *
         * Zero is the answer for every contract written before this existed, which
         * is why the screen marks the ones that HAVE their document rather than
         * flagging the ones that do not: a red mark against the entire back
         * catalogue on day one is noise, and noise is what gets ignored.
         */
        documentCount,
        closedAt: row.closedAt,
        closedReason: row.closedReason,
        /** "none" | "held" | "refunded" — what became of money paid, on cancellation. */
        closedSettlement: row.closedSettlement,
        notes: row.notes,
        /**
         * The adenda on either side of this contract, if any: what it replaced,
         * and what replaced it. A contract amended twice has both.
         */
        replaces: links.bySuccessor.get(row.id) ?? null,
        replacedBy: links.byPredecessor.get(row.id) ?? null,
    };
}
/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */
const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD.")
    // Rejects "2026-02-31", which matches the pattern and is not a day.
    .refine((value) => value === new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), {
    message: "Esa fecha no existe en el calendario.",
});
const contractBody = z.object({
    customerId: z.string().uuid(),
    lotId: z.string().uuid(),
    kind: z.enum(["reservation", "contract"]),
    saleType: z.enum(["financed", "cash", "donation"]),
    /** Whole centavos. The client converts from lempiras before sending. */
    salePriceCents: z.number().int().nonnegative(),
    downPaymentCents: z.number().int().nonnegative(),
    termMonths: z.number().int().min(1).max(600).nullish(),
    monthlyPaymentCents: z.number().int().positive().nullish(),
    dueDay: z.number().int().min(1).max(31).nullish(),
    signedOn: isoDate,
    firstDueOn: isoDate.nullish(),
    expiresOn: isoDate.nullish(),
    notes: z.string().trim().max(2000).nullish(),
    /**
     * Join the sale group of an existing contract — the second and third lot of
     * one purchase. The group is created on the fly if that contract does not
     * have one yet.
     */
    joinGroupOfContractId: z.string().uuid().nullish(),
});
/** Editing terms keeps the same lot and customer: a different lot is a different sale. */
const updateBody = contractBody
    .omit({ customerId: true, lotId: true, joinGroupOfContractId: true })
    .extend({
    /**
     * Why the terms are being changed. Required for EVERY edit — the handler
     * rejects a missing one with its own `reason_required` code, which is why
     * this stays `.optional()` here rather than being enforced by the schema.
     */
    reason: z.string().trim().min(10).max(500).optional(),
});
const reassignLotBody = z.object({
    lotId: z.string().uuid(),
    reason: z.string().trim().min(10).max(500),
});
const cancelBody = z.object({
    reason: z.string().trim().min(10).max(500),
    /**
     * What happens to money the customer has already paid:
     *
     * - "none"     — it stays as income; nothing is reversed.
     * - "held"     — it stays counted for now, flagged for a decision later.
     * - "refunded" — the payments are reversed here and now, so they stop
     *                counting anywhere, and any receipt they fully covered is
     *                voided. Needs the `payment:reverse` capability.
     *
     * Required when anything has been paid — the handler rejects a missing one
     * with `settlement_required` rather than the schema, so it can say why.
     */
    settlement: z.enum(["none", "held", "refunded"]).optional(),
});
/**
 * An adenda, as the "Adenda" dialog sends it.
 *
 * The schedule — forma de pago, plazo, día de pago, primera cuota — is one for
 * the whole agreement, because that is how it is negotiated: "the rest in three
 * months, on the 15th". What differs per lot is only the money, since the new
 * total is divided between lots that may not be the same size.
 */
const amendmentBody = z.object({
    /** The day the new terms were agreed. The new contracts are signed on it. */
    effectiveOn: isoDate,
    /** A donation is not something an adenda turns a sale into. */
    saleType: z.enum(["financed", "cash"]),
    termMonths: z.number().int().min(1).max(600).nullish(),
    dueDay: z.number().int().min(1).max(31).nullish(),
    firstDueOn: isoDate.nullish(),
    lines: z
        .array(z.object({
        /** The running contract this line replaces. */
        contractId: z.string().uuid(),
        salePriceCents: z.number().int().nonnegative(),
        downPaymentCents: z.number().int().nonnegative(),
        monthlyPaymentCents: z.number().int().positive().nullish(),
    }))
        .min(1)
        .max(50),
    authorizedBy: z.string().trim().max(120).nullish(),
    reason: z.string().trim().min(10).max(500),
});
/** Thrown inside the adenda transaction when a contract closed under it. */
class AmendmentConflict extends Error {
}
/**
 * The number an adenda gives the contract it writes: CT-2026-011 becomes
 * CT-2026-011-A1, and a second adenda on the same lot CT-2026-011-A2.
 *
 * Derived from the replaced contract's number rather than drawn from the yearly
 * sequence, so the lineage reads straight off the list — "011-A1" is 011 after
 * its first adenda — without opening anything. The yearly sequence does not
 * notice: `nextContractCode` casts whatever follows "CT-2026-" to an integer,
 * and SQLite reads "011-A1" as 11.
 */
function amendedCode(db, previousCode) {
    const root = previousCode.replace(/-A\d+$/, "");
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = new RegExp(`^${escaped}-A(\\d+)$`);
    const taken = db
        .select({ code: contracts.code })
        .from(contracts)
        .where(sql `${contracts.code} LIKE ${`${root}-A%`}`)
        .all();
    const highest = taken.reduce((max, row) => {
        const match = suffix.exec(row.code);
        return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `${root}-A${highest + 1}`;
}
/**
 * The terms that do not add up, worded for the person at the screen, or `null`
 * when the contract is coherent.
 *
 * Kept apart from the Zod schema because these are relationships BETWEEN
 * fields — a term of 24 months means nothing on a cash sale, and a donation
 * with a price is not a donation. Zod validates each field; this validates the
 * agreement.
 */
function termsProblem(body) {
    const hasSchedule = body.termMonths != null || body.monthlyPaymentCents != null || body.dueDay != null;
    if (body.saleType === "financed") {
        if (body.termMonths == null || body.monthlyPaymentCents == null || body.dueDay == null) {
            return "Un contrato a crédito necesita plazo en meses, cuota mensual y día de pago.";
        }
    }
    else if (hasSchedule) {
        return body.saleType === "cash"
            ? "Una venta de contado se salda al firmar: no lleva plazo, cuota ni día de pago."
            : "Una donación no lleva plazo, cuota ni día de pago.";
    }
    if (body.saleType === "donation" && (body.salePriceCents > 0 || body.downPaymentCents > 0)) {
        // Recorded at zero rather than left out of the table: the lot's history has
        // to say what became of it, and "no aparece" is not an answer.
        return "Una donación se registra con precio y prima en cero.";
    }
    if (body.saleType === "cash" && body.downPaymentCents > 0) {
        // A prima is the part of the price that is NOT financed. A cash sale
        // finances nothing — the whole price is expected at signing, which is what
        // `expectedByCents` already assumes — so a prima on one is a number that
        // changes no arithmetic and still gets counted as a prima pendiente on the
        // Panel General until somebody notices.
        return "Una venta de contado se salda al firmar: no lleva prima.";
    }
    if (body.downPaymentCents > body.salePriceCents) {
        return "La prima no puede ser mayor que el precio de venta.";
    }
    if (body.saleType === "financed" && body.downPaymentCents === body.salePriceCents) {
        return "Si la prima cubre todo el precio, la venta es de contado, no a crédito.";
    }
    if (body.kind === "reservation" && !body.expiresOn) {
        // A hold with no end date keeps a lot off the market forever and nobody
        // ever notices. That is the difference between a reservation and a sale.
        return "Una reserva necesita una fecha de vencimiento.";
    }
    if (body.firstDueOn && body.firstDueOn < body.signedOn) {
        return "La primera cuota no puede vencer antes de firmar el contrato.";
    }
    if (body.expiresOn && body.expiresOn < body.signedOn) {
        return "El vencimiento de la reserva no puede ser anterior a la firma.";
    }
    return null;
}
/**
 * The next contract number for a year, e.g. "CT-2026-014".
 *
 * Server-assigned and sequential. The unique index on `code` is what actually
 * guarantees no two contracts share a number; this makes the common case land
 * on the next free one instead of colliding.
 *
 * The suffix is compared as an INTEGER, not as text. A text sort puts
 * "CT-2026-999" above "CT-2026-1000" — nine is a bigger character than one — so
 * ordering by the string hands out 1000 a second time the moment the
 * thousandth contract of a year exists, and every create after that collides
 * on the unique index for the rest of the year. `substr(code, N)` takes
 * everything after the `CT-YYYY-` prefix; `CAST(... AS INTEGER)` then makes 1000
 * genuinely larger than 999.
 *
 * Takes any handle with `select` so it can run INSIDE the insert transaction,
 * where the write lock keeps two racing creates from reading the same maximum.
 */
function nextContractCode(db, year) {
    const prefix = `CT-${year}-`;
    const row = db
        .select({
        max: sql `MAX(CAST(substr(${contracts.code}, ${prefix.length + 1}) AS INTEGER))`,
    })
        .from(contracts)
        .where(sql `${contracts.code} LIKE ${`${prefix}%`}`)
        .get();
    return `${prefix}${String((row?.max ?? 0) + 1).padStart(3, "0")}`;
}
/** True for the SQLite error a violated UNIQUE index throws. */
function isUniqueViolation(error) {
    if (typeof error === "object" && error !== null && "code" in error) {
        return error.code === "SQLITE_CONSTRAINT_UNIQUE";
    }
    return String(error).includes("UNIQUE");
}
/**
 * Run a write, and run it once more if it lost a race for a unique value.
 *
 * `nextContractCode` reads MAX(number) + 1 under the write lock, but two
 * transactions can still both read the same maximum before either commits — the
 * loser then hits the unique index on `code`. One retry recomputes against the
 * row the winner just wrote and lands on the next free number.
 */
function withUniqueRetry(run) {
    try {
        return run();
    }
    catch (error) {
        if (isUniqueViolation(error)) {
            return run();
        }
        throw error;
    }
}
export const contractRoutes = async (app, options) => {
    /** Today in the office's calendar, not the server's and not UTC's. */
    const today = () => businessToday(options.timeZone);
    app.get("/contracts", { onRequest: app.requireUser }, async (_request, reply) => {
        const asOf = today();
        const rows = contractsListQuery(app.db).orderBy(desc(contracts.code)).all();
        // One grouped count for the whole screen rather than one query per row.
        const documentCounts = documentCountsFor(app.db);
        const links = amendmentLinksFor(app.db);
        return reply.send({
            contracts: rows.map((row) => present(row, asOf, documentCounts.get(row.id) ?? 0, links)),
        });
    });
    /**
     * How one payment would be split across a purchase, without posting anything.
     *
     * The Contratos screen offers this on a customer holding several lots, so the
     * amounts can be seen and adjusted before any money is recorded. The rule
     * itself lives in src/lib/allocation.ts.
     */
    app.get("/contracts/groups/:groupId/split", { onRequest: app.requireUser }, async (request, reply) => {
        const amountCents = Number(request.query.amountCents);
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
            return reply.code(400).send({
                error: "invalid_amount",
                message: "Indica el monto a repartir, en centavos.",
            });
        }
        const asOf = today();
        const members = contractsListQuery(app.db)
            .where(and(eq(contracts.saleGroupId, request.params.groupId), openContract(asOf)))
            .all()
            .map((row) => present(row, asOf));
        if (members.length === 0) {
            return reply.code(404).send({
                error: "not_found",
                message: "Esa compra no tiene contratos vigentes.",
            });
        }
        const split = splitEvenly(amountCents, members.map((member) => ({
            contractId: member.id,
            code: member.code,
            balanceCents: member.balance,
            // The next installment this lot still needs, so a plain even split
            // cannot round it below what it owes RIGHT NOW while another lot
            // that merely owes more overall takes the surplus.
            minimumDueCents: member.health.nextDueAmount,
        })));
        const shortOfMinimum = new Set(split.shortOfMinimumContractIds);
        return reply.send({
            amountCents,
            unallocatedCents: split.unallocatedCents,
            lines: split.allocations.map((allocation) => {
                const member = members.find((candidate) => candidate.id === allocation.contractId);
                return {
                    contractId: member.id,
                    contractCode: member.code,
                    lotCode: member.lot.code,
                    amountCents: allocation.amountCents,
                    balanceBefore: member.balance,
                    balanceAfter: member.balance - allocation.amountCents,
                    // The total handed over could not cover this lot's own next
                    // installment even after favoring the smallest ones first — the
                    // screen warns rather than silently posting a short payment.
                    belowMinimum: shortOfMinimum.has(member.id),
                };
            }),
        });
    });
    app.post("/contracts", { onRequest: app.requireCapability("contract:create") }, async (request, reply) => {
        const parsed = contractBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Revisa los datos del contrato.",
                issues: parsed.error.issues.map((issue) => issue.message),
            });
        }
        const problem = termsProblem(parsed.data);
        if (problem) {
            return reply.code(400).send({ error: "invalid_terms", message: problem });
        }
        const lot = app.db.select().from(lots).where(eq(lots.id, parsed.data.lotId)).get();
        if (!lot || lot.archivedAt !== null) {
            return reply.code(400).send({
                error: "unknown_lot",
                message: "Ese lote no existe o está archivado.",
            });
        }
        const customer = app.db
            .select()
            .from(customers)
            .where(eq(customers.id, parsed.data.customerId))
            .get();
        if (!customer) {
            return reply
                .code(400)
                .send({ error: "unknown_customer", message: "Ese cliente no existe." });
        }
        // A lot can only be held once. This is what stops the same lot being sold
        // to two people, which no amount of care in the interface can prevent on
        // its own once two staff are entering contracts at the same time. A
        // reservation that has passed its expiry date is not a holder — the lot
        // is free again — so a lapsed hold no longer blocks the sale it was meant
        // to make room for. A paid-off contract still holds: the lot is sold.
        const holder = app.db
            .select({ code: contracts.code })
            .from(contracts)
            .where(and(eq(contracts.lotId, lot.id), holdsLot(today())))
            .get();
        if (holder) {
            return reply.code(409).send({
                error: "lot_taken",
                message: `El lote ${lot.code} ya tiene el contrato ${holder.code} vigente.`,
            });
        }
        // Joining a purchase that already exists: the second lot of the same
        // deal. Both contracts must belong to the same person, or one customer's
        // payment would be split onto another's lot.
        let saleGroupId = null;
        let groupSeed = null;
        if (parsed.data.joinGroupOfContractId) {
            const sibling = app.db
                .select({
                id: contracts.id,
                saleGroupId: contracts.saleGroupId,
                customerId: contracts.customerId,
                status: contracts.status,
            })
                .from(contracts)
                .where(eq(contracts.id, parsed.data.joinGroupOfContractId))
                .get();
            if (!sibling || sibling.status !== "active") {
                return reply.code(400).send({
                    error: "unknown_group",
                    message: "El contrato al que quieres unir esta compra no existe o no está vigente.",
                });
            }
            if (sibling.customerId !== customer.id) {
                return reply.code(400).send({
                    error: "group_customer_mismatch",
                    message: "Una compra agrupa lotes de un solo cliente.",
                });
            }
            saleGroupId = sibling.saleGroupId ?? randomUUID();
            groupSeed = { id: sibling.id, saleGroupId: sibling.saleGroupId };
        }
        const now = new Date().toISOString();
        const year = parsed.data.signedOn.slice(0, 4);
        // The number is allocated INSIDE the transaction that inserts, under the
        // write lock, and the whole thing retries once if it still races another
        // create onto the same number — see `withUniqueRetry`.
        const created = withUniqueRetry(() => app.db.transaction((tx) => {
            // The first lot of a purchase was written before anybody knew a
            // second one was coming, so it has no group id. Stamping it here is
            // what turns two separate contracts into one purchase.
            if (groupSeed && groupSeed.saleGroupId === null && saleGroupId !== null) {
                tx.update(contracts)
                    .set({ saleGroupId, updatedAt: now })
                    .where(eq(contracts.id, groupSeed.id))
                    .run();
            }
            const next = tx
                .insert(contracts)
                .values({
                id: randomUUID(),
                code: nextContractCode(tx, year),
                lotId: lot.id,
                customerId: customer.id,
                saleGroupId,
                kind: parsed.data.kind,
                saleType: parsed.data.saleType,
                status: "active",
                salePriceCents: parsed.data.salePriceCents,
                downPaymentCents: parsed.data.downPaymentCents,
                termMonths: parsed.data.termMonths ?? null,
                monthlyPaymentCents: parsed.data.monthlyPaymentCents ?? null,
                dueDay: parsed.data.dueDay ?? null,
                signedOn: parsed.data.signedOn,
                firstDueOn: parsed.data.firstDueOn ?? null,
                expiresOn: parsed.data.expiresOn ?? null,
                notes: parsed.data.notes ?? null,
                createdAt: now,
                updatedAt: now,
            })
                .returning()
                .get();
            // Not in the Historial: the contract is its own record, and an edit's
            // `before` carries the terms it had. See `AuditEntry`.
            return next;
        }));
        return reply.code(201).send({
            contract: { id: created.id, code: created.code, saleGroupId: created.saleGroupId },
        });
    });
    app.patch("/contracts/:id", { onRequest: app.requireCapability("contract:edit") }, async (request, reply) => {
        const parsed = updateBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Revisa los datos del contrato.",
                issues: parsed.error.issues.map((issue) => issue.message),
            });
        }
        const problem = termsProblem(parsed.data);
        if (problem) {
            return reply.code(400).send({ error: "invalid_terms", message: problem });
        }
        const actor = request.user;
        const existing = app.db
            .select()
            .from(contracts)
            .where(eq(contracts.id, request.params.id))
            .get();
        if (!existing) {
            return reply.code(404).send({ error: "not_found", message: "Contrato no encontrado." });
        }
        if (existing.status !== "active" && existing.status !== "paid_off") {
            // A closed contract is history. Editing it would rewrite what the
            // parties are recorded as having agreed. A `paid_off` contract, on the
            // other hand, can still be corrected — a reprice upward reopens it (see
            // the lifecycle sync below). Written as the two statuses that stay
            // OPEN, so a closed status added later (`replaced` was one) is refused
            // without anybody having to remember this line.
            return reply.code(409).send({
                error: "not_active",
                message: "Este contrato está cerrado y ya no admite cambios.",
            });
        }
        const paidToDateCents = app.db
            .select({ total: sql `COALESCE(SUM(${payments.amountCents}), 0)` })
            .from(payments)
            .where(and(eq(payments.contractId, existing.id), sql `${payments.reversedAt} IS NULL`))
            .get()?.total ?? 0;
        // EVERY edit to signed terms demands a written motive, not only a
        // reprice. These are the figures both parties shook hands on, so a due
        // day that quietly moved from the 15th to the 5th is exactly the kind of
        // change somebody has to be able to ask about six months later — and the
        // person who moved it will not remember. `reason` stays optional in the
        // schema so this can answer with its own error code and its own wording
        // instead of a generic body rejection.
        if (!parsed.data.reason) {
            return reply.code(400).send({
                error: "reason_required",
                message: `Explica por qué se modifican los términos del contrato ${existing.code} ` +
                    "(mínimo 10 caracteres).",
            });
        }
        // Repricing is the one edit here that moves money, so on top of the
        // motive it carries a capability of its own and is filed under its own
        // audit action. Deliberately NOT `price:change`, which is about a lot's
        // list price: changing what a lot is advertised at and changing what a
        // customer already owes are different powers, and an owner may well want
        // to hand over the first without the second.
        const isRepricing = parsed.data.salePriceCents !== existing.salePriceCents;
        if (isRepricing && !roleCan(app.db, actor.role, "contract:reprice")) {
            return reply.code(403).send({
                error: "forbidden",
                message: "Tu usuario puede editar contratos, pero no cambiar el precio de venta.",
            });
        }
        if (parsed.data.salePriceCents < paidToDateCents) {
            // Otherwise the contract would owe a negative amount, and the customer
            // would be owed a refund nothing in the app can express yet.
            return reply.code(400).send({
                error: "price_below_paid",
                message: "El precio no puede quedar por debajo de lo ya pagado en este contrato.",
            });
        }
        const now = new Date().toISOString();
        const updated = app.db.transaction((tx) => {
            const next = tx
                .update(contracts)
                .set({
                kind: parsed.data.kind,
                saleType: parsed.data.saleType,
                salePriceCents: parsed.data.salePriceCents,
                downPaymentCents: parsed.data.downPaymentCents,
                termMonths: parsed.data.termMonths ?? null,
                monthlyPaymentCents: parsed.data.monthlyPaymentCents ?? null,
                dueDay: parsed.data.dueDay ?? null,
                signedOn: parsed.data.signedOn,
                firstDueOn: parsed.data.firstDueOn ?? null,
                expiresOn: parsed.data.expiresOn ?? null,
                notes: parsed.data.notes ?? null,
                updatedAt: now,
            })
                .where(eq(contracts.id, existing.id))
                .returning()
                .get();
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "contract",
                entityId: existing.id,
                action: isRepricing ? "reprice" : "update",
                reason: parsed.data.reason ?? null,
                before: {
                    kind: existing.kind,
                    saleType: existing.saleType,
                    salePriceCents: existing.salePriceCents,
                    downPaymentCents: existing.downPaymentCents,
                    termMonths: existing.termMonths,
                    monthlyPaymentCents: existing.monthlyPaymentCents,
                    dueDay: existing.dueDay,
                    signedOn: existing.signedOn,
                },
                after: {
                    kind: next.kind,
                    saleType: next.saleType,
                    salePriceCents: next.salePriceCents,
                    downPaymentCents: next.downPaymentCents,
                    termMonths: next.termMonths,
                    monthlyPaymentCents: next.monthlyPaymentCents,
                    dueDay: next.dueDay,
                    signedOn: next.signedOn,
                },
            });
            // A new price can push the balance to zero (settling the contract) or,
            // on a paid-off contract repriced upward, reopen it.
            syncContractLifecycle(tx, existing.id);
            return next;
        });
        return reply.send({ contract: { id: updated.id, code: updated.code } });
    });
    /**
     * Correct the lot on a signed contract — a data-entry mistake, not a new sale.
     *
     * Deliberately its own route rather than a field on `updateBody`: everywhere
     * else in this app "a different lot is a different sale" (see the JSDoc above
     * `updateBody`), and that stays true for an honest mistake too — a lot swap is
     * still a distinct, heavily-audited act, not a quiet field edit. What it
     * spares the office is undoing every payment already recorded against the
     * wrong lot: `payments.contractId` never carried a lot id (see schema.ts), so
     * moving `contracts.lotId` here is enough — every balance, receipt and lot
     * status is derived from that column on read and simply follows the contract
     * to its new lot.
     */
    app.post("/contracts/:id/reassign-lot", { onRequest: app.requireCapability("contract:reassign_lot") }, async (request, reply) => {
        const parsed = reassignLotBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Elige el lote correcto y explica el motivo (mínimo 10 caracteres).",
            });
        }
        const actor = request.user;
        const existing = app.db
            .select()
            .from(contracts)
            .where(eq(contracts.id, request.params.id))
            .get();
        if (!existing) {
            return reply.code(404).send({ error: "not_found", message: "Contrato no encontrado." });
        }
        if (existing.status !== "active" && existing.status !== "paid_off") {
            // A closed contract is history, same rule as the terms edit above.
            return reply.code(409).send({
                error: "not_active",
                message: "Este contrato está cerrado y ya no admite cambios.",
            });
        }
        if (parsed.data.lotId === existing.lotId) {
            return reply.code(400).send({
                error: "same_lot",
                message: "Ese ya es el lote de este contrato.",
            });
        }
        const lot = app.db.select().from(lots).where(eq(lots.id, parsed.data.lotId)).get();
        if (!lot || lot.archivedAt !== null) {
            return reply.code(400).send({
                error: "unknown_lot",
                message: "Ese lote no existe o está archivado.",
            });
        }
        // The same uniqueness rule a new contract obeys: a lot can only be held
        // once. Without re-checking it here, correcting one contract's mistake
        // could silently create a second one — two contracts pointing at the lot
        // this one is moving to.
        const holder = app.db
            .select({ code: contracts.code })
            .from(contracts)
            .where(and(eq(contracts.lotId, lot.id), holdsLot(today())))
            .get();
        if (holder) {
            return reply.code(409).send({
                error: "lot_taken",
                message: `El lote ${lot.code} ya tiene el contrato ${holder.code} vigente.`,
            });
        }
        const previousLot = app.db
            .select({ code: lots.code })
            .from(lots)
            .where(eq(lots.id, existing.lotId))
            .get();
        const now = new Date().toISOString();
        const updated = app.db.transaction((tx) => {
            const next = tx
                .update(contracts)
                .set({ lotId: lot.id, updatedAt: now })
                .where(eq(contracts.id, existing.id))
                .returning()
                .get();
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "contract",
                entityId: existing.id,
                action: "reassign_lot",
                reason: parsed.data.reason,
                // The codes ride along with the ids because the Historial shows
                // whatever changed as-is, and "B-12 → B-21" is the line somebody
                // will be looking for months from now, not two UUIDs.
                before: { lotId: existing.lotId, lotCode: previousLot?.code ?? null },
                after: { lotId: next.lotId, lotCode: lot.code },
            });
            return next;
        });
        return reply.send({ contract: { id: updated.id, code: updated.code } });
    });
    /**
     * An adenda: new terms agreed for contracts that are already running.
     *
     * Each contract is closed as `replaced` and a successor is written on the
     * same lot with the new terms, starting from nothing paid. What was paid
     * before stays exactly where it is — on the old contract, as income — so the
     * customer's old receipts keep every figure they were printed with. See
     * `contractAmendments` in src/db/schema.ts for why this is not an edit.
     *
     * One adenda usually covers several lots: a customer who bought three
     * renegotiates the three together. The successors form a purchase of their
     * own, so one payment can again be split across them. How the new total is
     * divided between the lots is worked out by the interface, where it can be
     * seen before it is saved; this route holds each lot's share to the same
     * rules a new contract is held to.
     */
    app.post("/contracts/amendments", { onRequest: app.requireCapability("contract:amend") }, async (request, reply) => {
        const parsed = amendmentBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Revisa los datos de la adenda. El motivo necesita al menos 10 caracteres.",
                issues: parsed.error.issues.map((issue) => issue.message),
            });
        }
        const body = parsed.data;
        const actor = request.user;
        const contractIds = body.lines.map((line) => line.contractId);
        if (new Set(contractIds).size !== contractIds.length) {
            return reply.code(400).send({
                error: "duplicate_contract",
                message: "Un mismo contrato aparece dos veces en la adenda.",
            });
        }
        // Recorded on the day it was agreed, never ahead of it. A future date
        // would close the running contracts today and start the new ones later,
        // leaving the lots between two agreements in the meantime.
        if (body.effectiveOn > today()) {
            return reply.code(400).send({
                error: "future_date",
                message: "La fecha de la adenda no puede ser futura: es el día en que se acordó.",
            });
        }
        const rows = app.db
            .select({ contract: contracts, lotCode: lots.code })
            .from(contracts)
            .innerJoin(lots, eq(lots.id, contracts.lotId))
            .where(inArray(contracts.id, contractIds))
            .all();
        const byId = new Map(rows.map((row) => [row.contract.id, row]));
        let customerId = null;
        for (const line of body.lines) {
            const row = byId.get(line.contractId);
            if (!row) {
                return reply
                    .code(404)
                    .send({ error: "not_found", message: "Uno de los contratos de la adenda no existe." });
            }
            const { contract, lotCode } = row;
            // The new contracts are one purchase, and a purchase is one person's.
            if (customerId !== null && contract.customerId !== customerId) {
                return reply.code(400).send({
                    error: "customer_mismatch",
                    message: "Una adenda cubre contratos de un solo cliente.",
                });
            }
            customerId = contract.customerId;
            if (contract.status !== "active") {
                return reply.code(409).send({
                    error: "not_active",
                    message: `${contract.code} no está vigente: solo un contrato vigente admite una adenda.`,
                });
            }
            // A reservation is a hold, not a signed sale; turning one into a sale
            // is what «Editar términos» is for.
            if (contract.kind !== "contract") {
                return reply.code(400).send({
                    error: "not_a_contract",
                    message: `${contract.code} es una reserva. Conviértela en contrato con «Editar términos» ` +
                        "antes de hacerle una adenda.",
                });
            }
            const signedOn = contract.signedOn ?? contract.createdAt.slice(0, 10);
            if (body.effectiveOn < signedOn) {
                return reply.code(400).send({
                    error: "before_signing",
                    message: `La adenda no puede ser anterior a la firma de ${contract.code} (${signedOn}).`,
                });
            }
            // The same agreement rules a brand-new contract answers to, per lot.
            const problem = termsProblem({
                kind: "contract",
                saleType: body.saleType,
                salePriceCents: line.salePriceCents,
                downPaymentCents: line.downPaymentCents,
                termMonths: body.termMonths ?? null,
                monthlyPaymentCents: line.monthlyPaymentCents ?? null,
                dueDay: body.dueDay ?? null,
                signedOn: body.effectiveOn,
                firstDueOn: body.firstDueOn ?? null,
                expiresOn: null,
            });
            if (problem) {
                return reply
                    .code(400)
                    .send({ error: "invalid_terms", message: `Lote ${lotCode}: ${problem}` });
            }
        }
        /*
         * A payment on an old contract dated AFTER the adenda is money that
         * arrived under the new agreement but was filed under the old one. The
         * adenda would strand it there — kept as income on a closed contract,
         * never reaching the new balance — so it has to be sorted out first, while
         * it can still be moved.
         */
        const lateItem = app.db
            .select({
            contractId: payments.contractId,
            paidOn: payments.paidOn,
            amountCents: payments.amountCents,
        })
            .from(payments)
            .where(and(inArray(payments.contractId, contractIds), sql `${payments.reversedAt} IS NULL`, sql `${payments.paidOn} > ${body.effectiveOn}`))
            .orderBy(asc(payments.paidOn))
            .get();
        if (lateItem) {
            const code = byId.get(lateItem.contractId).contract.code;
            return reply.code(409).send({
                error: "payment_after_amendment",
                message: `${code} tiene un pago del ${lateItem.paidOn} ` +
                    `(L ${(lateItem.amountCents / 100).toLocaleString("es-HN")}), posterior a la fecha ` +
                    "de la adenda. Si ese dinero es del nuevo acuerdo, anula ese pago y regístralo en " +
                    "el contrato nuevo después de la adenda; si era del contrato anterior, pon la " +
                    "adenda en esa fecha o después.",
            });
        }
        const now = new Date().toISOString();
        const amendmentId = randomUUID();
        // A purchase of its own once there is more than one lot, so a single
        // payment can be split across the successors the way it was across the
        // contracts they replace.
        const saleGroupId = body.lines.length > 1 ? randomUUID() : null;
        let created;
        try {
            created = withUniqueRetry(() => app.db.transaction((tx) => {
                tx.insert(contractAmendments)
                    .values({
                    id: amendmentId,
                    effectiveOn: body.effectiveOn,
                    reason: body.reason,
                    authorizedBy: body.authorizedBy?.trim() ? body.authorizedBy.trim() : null,
                    recordedBy: actor.id,
                    createdAt: now,
                })
                    .run();
                return body.lines.map((line) => {
                    const { contract: previous } = byId.get(line.contractId);
                    const paidToDateCents = tx
                        .select({ total: sql `COALESCE(SUM(${payments.amountCents}), 0)` })
                        .from(payments)
                        .where(and(eq(payments.contractId, previous.id), sql `${payments.reversedAt} IS NULL`))
                        .get()?.total ?? 0;
                    // Kept as income — the deal being recorded. Null when nothing was
                    // paid, as on any close: there was no money to decide about.
                    const settlement = paidToDateCents > 0 ? "none" : null;
                    // Conditional on still being active, and checked: the checks
                    // above ran outside this transaction, and a contract closed in
                    // between must not be closed twice or given two successors.
                    const closed = tx
                        .update(contracts)
                        .set({
                        status: "replaced",
                        closedAt: now,
                        closedReason: body.reason,
                        closedSettlement: settlement,
                        updatedAt: now,
                    })
                        .where(and(eq(contracts.id, previous.id), eq(contracts.status, "active")))
                        .run();
                    if (closed.changes !== 1) {
                        throw new AmendmentConflict(previous.code);
                    }
                    const next = tx
                        .insert(contracts)
                        .values({
                        id: randomUUID(),
                        code: amendedCode(tx, previous.code),
                        lotId: previous.lotId,
                        customerId: previous.customerId,
                        saleGroupId,
                        kind: "contract",
                        saleType: body.saleType,
                        status: "active",
                        salePriceCents: line.salePriceCents,
                        downPaymentCents: line.downPaymentCents,
                        termMonths: body.termMonths ?? null,
                        monthlyPaymentCents: line.monthlyPaymentCents ?? null,
                        dueDay: body.dueDay ?? null,
                        signedOn: body.effectiveOn,
                        firstDueOn: body.firstDueOn ?? null,
                        expiresOn: null,
                        notes: null,
                        replacesContractId: previous.id,
                        amendmentId,
                        createdAt: now,
                        updatedAt: now,
                    })
                        .returning()
                        .get();
                    recordAudit(tx, {
                        actorId: actor.id,
                        entityType: "contract",
                        entityId: previous.id,
                        action: "replace",
                        reason: body.reason,
                        before: { status: previous.status, paidToDateCents },
                        after: {
                            status: "replaced",
                            replacedBy: next.code,
                            settlement,
                            paidToDateCents,
                        },
                    });
                    // The successor gets no row of its own: creating a contract is not
                    // filed, and the new terms are on the contract itself, linked back
                    // by `replaces_contract_id` and explained by the amendment. The
                    // row above is the part that took something away.
                    // Nothing is paid on it yet, but a price of zero is settled from
                    // the start — the same rule every other write follows.
                    syncContractLifecycle(tx, next.id);
                    return { id: next.id, code: next.code, replacesContractId: previous.id };
                });
            }));
        }
        catch (error) {
            if (error instanceof AmendmentConflict) {
                return reply.code(409).send({
                    error: "not_active",
                    message: `${error.message} cambió mientras se registraba la adenda. Ábrela de nuevo.`,
                });
            }
            throw error;
        }
        return reply.code(201).send({ amendment: { id: amendmentId }, contracts: created });
    });
    /**
     * Close a contract — either a cancellation (a sale unwound) or a default (the
     * customer declared unable to keep paying). The two share everything: the lot
     * comes back on its own because availability is derived, nothing is deleted,
     * and the same question is asked about money already paid — refund it, hold
     * it, or keep it as income.
     *
     * They differ only in the status written, the capability required, the audit
     * action, and the wording. `close` is that shared body; the two routes below
     * are thin.
     */
    const close = async (request, reply, kind) => {
        const parsed = cancelBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Explica el motivo con al menos 10 caracteres.",
            });
        }
        const actor = request.user;
        const existing = app.db
            .select()
            .from(contracts)
            .where(eq(contracts.id, request.params.id))
            .get();
        if (!existing) {
            return reply.code(404).send({ error: "not_found", message: "Contrato no encontrado." });
        }
        // `active` or `paid_off` — both are contracts that still hold a lot and can
        // be closed. An already-cancelled or defaulted one is done.
        if (existing.status !== "active" && existing.status !== "paid_off") {
            return reply.code(409).send({
                error: "not_active",
                message: "Ese contrato ya está cerrado.",
            });
        }
        // Every non-reversed payment on this contract, with the receipt it sits on.
        // What the customer has already paid, and what a "refund" would touch.
        const contractPayments = app.db
            .select({
            id: payments.id,
            amountCents: payments.amountCents,
            receiptId: payments.receiptId,
        })
            .from(payments)
            .where(and(eq(payments.contractId, existing.id), sql `${payments.reversedAt} IS NULL`))
            .all();
        const paidToDateCents = contractPayments.reduce((sum, p) => sum + p.amountCents, 0);
        // The settlement question only exists once money has changed hands. With
        // nothing paid there is nothing to decide, and `closed_settlement` stays null.
        let settlement = null;
        if (paidToDateCents > 0) {
            if (!parsed.data.settlement) {
                return reply.code(400).send({
                    error: "settlement_required",
                    message: `${existing.code} tiene L ${(paidToDateCents / 100).toLocaleString("es-HN")} ` +
                        "pagados. Indica qué pasa con ese dinero: reembolso, retención temporal o " +
                        "que quede como ingreso.",
                });
            }
            settlement = parsed.data.settlement;
            // Reversing money is a bigger power than closing a contract, so the refund
            // option carries its own capability.
            if (settlement === "refunded" && !roleCan(app.db, actor.role, "payment:reverse")) {
                return reply.code(403).send({
                    error: "forbidden",
                    message: `Tu usuario puede ${kind.verb} contratos, pero no revertir pagos. ` +
                        "Elige otra opción o pide a un supervisor que registre el reembolso.",
                });
            }
        }
        const closedAt = new Date().toISOString();
        const reversedPaymentIds = [];
        const voidedReceiptIds = [];
        app.db.transaction((tx) => {
            tx.update(contracts)
                .set({
                status: kind.newStatus,
                closedAt,
                closedReason: parsed.data.reason,
                closedSettlement: settlement,
                updatedAt: closedAt,
            })
                .where(eq(contracts.id, existing.id))
                .run();
            if (settlement === "refunded" && contractPayments.length > 0) {
                const note = `Contrato ${existing.code} ${kind.newStatus === "defaulted" ? "incumplido" : "cancelado"} con reembolso`;
                // The payments keep their amount, date and rate — they just stop
                // counting, exactly as a receipt void does. Every balance in the app
                // already filters on `reversed_at IS NULL`.
                tx.update(payments)
                    .set({ reversedAt: closedAt, reversedBy: actor.id, reversalReason: note })
                    .where(and(eq(payments.contractId, existing.id), sql `${payments.reversedAt} IS NULL`))
                    .run();
                for (const p of contractPayments) {
                    reversedPaymentIds.push(p.id);
                }
                // A receipt whose payments were all for this contract now carries
                // nothing — void it too, so it reads as a void rather than as a receipt
                // whose numbers quietly shrank. A receipt shared with another lot (a
                // sale group) keeps standing; only its closed line is gone.
                const receiptIds = [
                    ...new Set(contractPayments.map((p) => p.receiptId).filter((x) => !!x)),
                ];
                for (const receiptId of receiptIds) {
                    const stillActive = tx
                        .select({ n: sql `COUNT(*)` })
                        .from(payments)
                        .where(and(eq(payments.receiptId, receiptId), sql `${payments.reversedAt} IS NULL`))
                        .get();
                    if ((stillActive?.n ?? 0) === 0) {
                        tx.update(receipts)
                            .set({ voidedAt: closedAt, voidReason: note, voidedBy: actor.id })
                            .where(and(eq(receipts.id, receiptId), sql `${receipts.voidedAt} IS NULL`))
                            .run();
                        voidedReceiptIds.push(receiptId);
                    }
                }
            }
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "contract",
                entityId: existing.id,
                action: kind.action,
                reason: parsed.data.reason,
                before: { status: existing.status, closedAt: null, paidToDateCents },
                after: {
                    status: kind.newStatus,
                    closedAt,
                    settlement,
                    ...(settlement === "refunded"
                        ? { reversedPaymentIds, voidedReceiptIds, refundedCents: paidToDateCents }
                        : {}),
                },
            });
        });
        return reply.send({
            ok: true,
            closedAt,
            paidToDateCents,
            settlement,
            refundedCents: settlement === "refunded" ? paidToDateCents : 0,
        });
    };
    app.post("/contracts/:id/cancel", { onRequest: app.requireCapability("contract:cancel") }, (request, reply) => close(request, reply, { newStatus: "cancelled", action: "cancel", verb: "cancelar" }));
    /**
     * Declare a contract uncollectable — the customer defaulted.
     *
     * Distinct from a cancellation on purpose: a cancellation is a sale unwound
     * by agreement, a default is the business writing off what it is owed. Owner
     * only, and locked there (see LOCKED_CAPABILITIES) — it is a decision about
     * money being given up on, not one to delegate. Everything else — the lot
     * coming back, the settlement question, the refund path — is shared with
     * cancellation.
     */
    app.post("/contracts/:id/default", { onRequest: app.requireCapability("contract:default") }, (request, reply) => close(request, reply, { newStatus: "defaulted", action: "default", verb: "declarar incumplidos" }));
    /* ---------------------------------------------------------------------- */
    /* The signed paperwork                                                    */
    /* ---------------------------------------------------------------------- */
    /*
     * Multipart, registered inside this plugin and with a ceiling of its own.
     *
     * `receiptRoutes` registers it too, separately, and that is the point of
     * doing it here rather than app-wide: only the routes that are meant to take
     * a file can take one, and each gets the limit that suits what it receives.
     * 12 MB is right for a phone photograph of a deposit slip and wrong for a
     * fifteen-page scanned contract, which is the document this whole section
     * exists for.
     *
     * The limits are the real guard: Fastify refuses a body past `fileSize` while
     * it is still streaming, so a hostile 4 GB upload is rejected before it can
     * fill the disk rather than after.
     */
    await app.register(multipart, {
        limits: {
            fileSize: MAX_DOCUMENT_BYTES,
            files: 1,
            fields: 2,
        },
    });
    /** Every document on one contract. Behind the session like the contract itself. */
    app.get("/contracts/:id/documents", { onRequest: app.requireUser }, async (request, reply) => {
        const contract = app.db
            .select({ id: contracts.id })
            .from(contracts)
            .where(eq(contracts.id, request.params.id))
            .get();
        if (!contract) {
            return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
        }
        return { documents: documentsFor(app.db, contract.id).map(presentDocument) };
    });
    /**
     * File the signed contract against the contract record.
     *
     * `contract:create`, the same capability that writes the contract in the
     * first place: scanning the signed copy and filing it is the last step of
     * making one, not a separate privilege. Deleting it is NOT — see below.
     *
     * The bytes are written to disk under a generated name and the row records
     * where they went; nothing the uploader chose ever reaches the filesystem.
     * See src/lib/storedFiles.ts.
     */
    app.post("/contracts/:id/documents", { onRequest: app.requireCapability("contract:create") }, async (request, reply) => {
        const contract = app.db
            .select({ id: contracts.id })
            .from(contracts)
            .where(eq(contracts.id, request.params.id))
            .get();
        if (!contract) {
            return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
        }
        const existing = app.db
            .select({ value: sql `COUNT(*)` })
            .from(contractDocuments)
            .where(eq(contractDocuments.contractId, contract.id))
            .get();
        if ((existing?.value ?? 0) >= MAX_DOCUMENTS_PER_CONTRACT) {
            return reply.code(409).send({
                error: "too_many_documents",
                message: `Un contrato admite hasta ${MAX_DOCUMENTS_PER_CONTRACT} documentos.`,
            });
        }
        let part;
        try {
            part = await request.file();
        }
        catch {
            // Thrown by @fastify/multipart when the body is not multipart at all.
            return reply
                .code(400)
                .send({ error: "invalid_upload", message: "No se recibió ningún archivo." });
        }
        if (!part) {
            return reply
                .code(400)
                .send({ error: "invalid_upload", message: "No se recibió ningún archivo." });
        }
        if (!isAllowedContentType(part.mimetype)) {
            return reply.code(415).send({
                error: "unsupported_type",
                message: "Solo se aceptan PDF o imágenes (JPG, PNG, WEBP, HEIC) del contrato escaneado.",
            });
        }
        const buffer = await part.toBuffer();
        // `toBuffer` resolves even when the stream was truncated at the limit, so
        // the flag has to be asked about explicitly. Without this a 40 MB scan
        // would be stored silently as its first 30 MB — a contract missing its
        // last pages, that looks like a successful upload.
        if (part.file.truncated) {
            return reply.code(413).send({
                error: "file_too_large",
                message: `El archivo supera el máximo de ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB.`,
            });
        }
        if (buffer.byteLength === 0) {
            return reply.code(400).send({ error: "empty_file", message: "El archivo está vacío." });
        }
        const storageKey = storageKeyFor(part.mimetype);
        const documentId = randomUUID();
        const fileName = safeDisplayName(part.filename ?? "contrato");
        await mkdir(options.uploadsPath, { recursive: true });
        await writeFile(join(options.uploadsPath, storageKey), buffer);
        let createdAt = "";
        // Attaching is not in the Historial — adding a file takes nothing away.
        // Removing one is; see DELETE /contract-documents/:id.
        try {
            createdAt =
                app.db
                    .insert(contractDocuments)
                    .values({
                    id: documentId,
                    contractId: contract.id,
                    storageKey,
                    fileName,
                    contentType: part.mimetype,
                    byteSize: buffer.byteLength,
                    uploadedBy: request.user.id,
                })
                    .returning({ createdAt: contractDocuments.createdAt })
                    .get()?.createdAt ?? "";
        }
        catch (error) {
            // The row is what makes the file findable. If it could not be written,
            // the bytes on disk are unreachable rubbish, so they go too rather than
            // accumulating as orphans nobody will ever notice.
            await removeStoredFile(options.uploadsPath, storageKey);
            throw error;
        }
        return reply.code(201).send({
            document: {
                id: documentId,
                fileName,
                contentType: part.mimetype,
                byteSize: buffer.byteLength,
                createdAt,
                uploadedBy: request.user.name,
            },
        });
    });
    /**
     * Serve one document, for viewing rather than for saving.
     *
     * Behind the session guard like everything else: a signed contract carries
     * both parties' names, their identidades and what was agreed, and is nobody
     * else's business. The id is a UUID rather than a guessable number for the
     * same reason the receipt lookup code is random.
     *
     * The headers — inline, sandboxed into an opaque origin — are the shared
     * implementation in src/lib/storedFiles.ts, the same one that serves a
     * comprobante. Written once because every line of it is a security decision.
     */
    app.get("/contract-documents/:id/file", { onRequest: app.requireUser }, async (request, reply) => {
        const row = app.db
            .select()
            .from(contractDocuments)
            .where(eq(contractDocuments.id, request.params.id))
            .get();
        if (!row) {
            return reply.code(404).send({ error: "not_found", message: "Ese archivo no existe." });
        }
        return sendStoredFile(reply, row, options.uploadsPath);
    });
    /**
     * Remove a document.
     *
     * `contract:edit`, NOT the `contract:create` that uploading takes, and the
     * gap between those two is deliberate. An associate who writes contracts
     * should be able to file the signed copy — that is the job. Destroying the
     * signed copy is a different act: this is the legal instrument for a lot, and
     * unlike a wrongly-attached photograph of a deposit slip, there is no second
     * copy of it in a chat somewhere. It is not something to be able to do by
     * mistake on the way to doing something else.
     *
     * The row and the file both go, and the audit entry naming the file is what
     * remains. Nothing else in this app deletes a record outright; the reason
     * this one may is that the alternative — a contract permanently showing a
     * document that turned out to belong to another lot — is worse.
     */
    app.delete("/contract-documents/:id", { onRequest: app.requireCapability("contract:edit") }, async (request, reply) => {
        const row = app.db
            .select()
            .from(contractDocuments)
            .where(eq(contractDocuments.id, request.params.id))
            .get();
        if (!row) {
            return reply.code(404).send({ error: "not_found", message: "Ese archivo no existe." });
        }
        app.db.transaction((tx) => {
            tx.delete(contractDocuments).where(eq(contractDocuments.id, row.id)).run();
            recordAudit(tx, {
                actorId: request.user.id,
                entityType: "contract",
                entityId: row.contractId,
                action: "update",
                before: { removedDocument: row.fileName },
            });
        });
        await removeStoredFile(options.uploadsPath, row.storageKey);
        return { ok: true };
    });
};
//# sourceMappingURL=contracts.js.map
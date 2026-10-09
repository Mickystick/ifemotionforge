import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { auditEvents, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

interface ContractJson {
  id: string;
  code: string;
  status: string;
  saleGroupId: string | null;
  lot: { id: string; code: string };
  terms: { salePrice: number; downPayment: number; signedOn: string; firstDueOn: string | null };
  paidToDate: number;
  balance: number;
  closedSettlement: string | null;
  replaces: { contractId: string; code: string; amendment: { reason: string } } | null;
  replacedBy: { contractId: string; code: string; amendment: { authorizedBy: string | null } } | null;
}

/**
 * The case this feature was built for: three lots bought together at
 * L 450,000 each over five years, L 174,000 paid, then renegotiated to
 * L 800,000 for the three — with what was already paid kept by the business,
 * not credited to the new price.
 */
describe("an adenda on a purchase of three lots", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  // A customer of their own, so "total pagado acumulado" is only ever this
  // purchase — the seeded customer also holds a reservation with money on it.
  const customerId = randomUUID();
  db.run(
    `INSERT INTO customers (id, full_name, identification, phone, customer_since)
     VALUES ('${customerId}', 'Comprador de Tres Lotes', '0801-1985-00003', '+50499990003', 2026)`,
  );

  const lot = (code: string, areaM2: number) => {
    const id = randomUUID();
    db.insert(lots)
      .values({ id, projectId: ids.projectId, code, areaM2, basePriceCents: lempiras(450_000) })
      .run();
    return id;
  };

  const post = (url: string, payload: unknown, cookie = ownerCookie) =>
    app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });

  const listContracts = async (): Promise<ContractJson[]> =>
    (await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie: ownerCookie } }))
      .json().contracts;

  const receipt = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/receipts/${id}`, headers: { cookie: ownerCookie } }))
      .json().receipt;

  const sale = (lotId: string, joinGroupOfContractId?: string) => ({
    customerId,
    lotId,
    kind: "contract",
    saleType: "financed",
    salePriceCents: lempiras(450_000),
    downPaymentCents: lempiras(30_000),
    termMonths: 60,
    monthlyPaymentCents: lempiras(7_000),
    dueDay: 15,
    signedOn: "2026-05-09",
    joinGroupOfContractId,
  });

  const first = (await post("/api/contracts", sale(lot("B-04", 320)))).json().contract;
  const second = (await post("/api/contracts", sale(lot("B-05", 339.5), first.id))).json().contract;
  const third = (await post("/api/contracts", sale(lot("B-06", 338.58), second.id))).json().contract;
  const old = [first, second, third] as Array<{ id: string; code: string }>;

  /** One receipt spreading `each` over the three old contracts. */
  const payOld = async (paidOn: string, each: number, type: string) =>
    (
      await post("/api/receipts", {
        customerId,
        paidOn,
        method: "transfer",
        lines: old.map((contract) => ({ contractId: contract.id, amountCents: lempiras(each), type })),
      })
    ).json().receipt.id as string;

  // L 174,000 under the old terms: the prima and four monthly cuotas.
  const oldReceipts = [
    await payOld("2026-05-09", 30_000, "down_payment"),
    await payOld("2026-06-15", 7_000, "installment"),
    await payOld("2026-07-15", 7_000, "installment"),
    await payOld("2026-08-15", 7_000, "installment"),
    await payOld("2026-09-15", 7_000, "installment"),
  ];
  const printedBefore = await Promise.all(oldReceipts.map(receipt));

  /** L 800,000 for the three, the rest (L 650,000) in three cuotas from 15 October. */
  const newTerms = {
    effectiveOn: "2026-09-20",
    saleType: "financed",
    termMonths: 3,
    dueDay: 15,
    firstDueOn: "2026-10-15",
    lines: [
      { contractId: first.id, salePriceCents: lempiras(266_667), downPaymentCents: lempiras(50_000), monthlyPaymentCents: lempiras(72_223) },
      { contractId: second.id, salePriceCents: lempiras(266_667), downPaymentCents: lempiras(50_000), monthlyPaymentCents: lempiras(72_223) },
      { contractId: third.id, salePriceCents: lempiras(266_666), downPaymentCents: lempiras(50_000), monthlyPaymentCents: lempiras(72_222) },
    ],
    authorizedBy: "Gerencia",
    reason: "Pagará los 3 lotes antes de fin de año: nuevo precio total de L 800,000.",
  };

  it("is not something an associate may do by default", async () => {
    const response = await post("/api/contracts/amendments", newTerms, staffCookie);
    assert.equal(response.statusCode, 403);
  });

  it("demands a written motive", async () => {
    const response = await post("/api/contracts/amendments", { ...newTerms, reason: "cambio" });
    assert.equal(response.statusCode, 400);
  });

  it("refuses a date that has not happened yet", async () => {
    const response = await post("/api/contracts/amendments", { ...newTerms, effectiveOn: "2099-01-01" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "future_date");
  });

  it("refuses a date before the contracts were signed", async () => {
    const response = await post("/api/contracts/amendments", { ...newTerms, effectiveOn: "2026-05-01" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "before_signing");
  });

  it("holds each lot to the rules of a new contract", async () => {
    const response = await post("/api/contracts/amendments", {
      ...newTerms,
      lines: newTerms.lines.map((line) => ({ ...line, downPaymentCents: lempiras(300_000) })),
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /^Lot B-04: The down payment cannot exceed/);
  });

  it("refuses when an old contract already holds money dated after the adenda", async () => {
    // L 174,000 was paid up to 15 September, so an adenda on the 10th would
    // strand the September cuota on a contract that no longer counts.
    const response = await post("/api/contracts/amendments", { ...newTerms, effectiveOn: "2026-09-10" });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "payment_after_amendment");
    assert.match(response.json().message, /2026-09-15/);
  });

  // Recorded inside a test rather than at the top, so every refusal above is
  // checked against contracts that are still running.
  let created: Awaited<ReturnType<typeof post>>;

  it("writes a successor for each lot, numbered after the contract it replaces", async () => {
    created = await post("/api/contracts/amendments", newTerms);

    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(
      created.json().contracts.map((contract: { code: string }) => contract.code),
      old.map((contract) => `${contract.code}-A1`),
    );
  });

  it("closes the old contracts with every payment still on them, kept as income", async () => {
    const contracts = await listContracts();

    for (const previous of old) {
      const row = contracts.find((contract) => contract.id === previous.id)!;

      assert.equal(row.status, "replaced");
      assert.equal(row.closedSettlement, "none");
      assert.equal(row.paidToDate, lempiras(58_000));
      assert.equal(row.terms.salePrice, lempiras(450_000));
      assert.equal(row.replacedBy?.code, `${previous.code}-A1`);
      assert.equal(row.replacedBy?.amendment.authorizedBy, "Gerencia");
    }
  });

  it("starts the new contracts from the new price with nothing paid", async () => {
    const contracts = await listContracts();
    const successors = old.map(
      (previous) => contracts.find((contract) => contract.replaces?.contractId === previous.id)!,
    );

    for (const [index, successor] of successors.entries()) {
      assert.equal(successor.status, "active");
      assert.equal(successor.lot.code, ["B-04", "B-05", "B-06"][index]);
      assert.equal(successor.terms.signedOn, "2026-09-20");
      assert.equal(successor.terms.firstDueOn, "2026-10-15");
      assert.equal(successor.paidToDate, 0);
      assert.equal(successor.balance, successor.terms.salePrice);
      assert.equal(successor.replaces?.amendment.reason, newTerms.reason);
    }

    const total = successors.reduce((sum, contract) => sum + contract.terms.salePrice, 0);
    assert.equal(total, lempiras(800_000));

    // A purchase of their own — one payment can be split across them again —
    // and not the old one, which now holds only closed contracts.
    const groups = new Set(successors.map((contract) => contract.saleGroupId));
    assert.equal(groups.size, 1);
    assert.ok(successors[0]!.saleGroupId);
    assert.notEqual(successors[0]!.saleGroupId, first.saleGroupId);
  });

  it("hands each lot to its successor", async () => {
    const lotsList = (
      await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } })
    ).json().lots as Array<{ code: string; holding: { contractCode: string } | null }>;

    for (const code of ["B-04", "B-05", "B-06"]) {
      assert.match(lotsList.find((row) => row.code === code)!.holding!.contractCode, /-A1$/);
    }
  });

  it("leaves every receipt printed before the adenda exactly as it was", async () => {
    const printedAfter = await Promise.all(oldReceipts.map(receipt));

    for (const [index, before] of printedBefore.entries()) {
      const now = printedAfter[index];

      assert.equal(now.previousBalance, before.previousBalance);
      assert.equal(now.newBalance, before.newBalance);
      assert.equal(now.cumulativePaid, before.cumulativePaid);
      assert.deepEqual(
        now.lines.map((line: { contractTotal: number }) => line.contractTotal),
        before.lines.map((line: { contractTotal: number }) => line.contractTotal),
      );
    }

    // The last one still reads the way it was handed over in September.
    assert.equal(printedAfter[4].newBalance, lempiras(1_176_000));
    assert.equal(printedAfter[4].cumulativePaid, lempiras(174_000));
  });

  it("refuses money on a replaced contract", async () => {
    const response = await post("/api/receipts", {
      customerId,
      paidOn: "2026-09-22",
      method: "transfer",
      lines: [{ contractId: first.id, amountCents: lempiras(7_000), type: "installment" }],
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "contract_closed");
  });

  it("refuses to edit a replaced contract", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/contracts/${first.id}`,
      headers: { cookie: ownerCookie },
      payload: { ...sale(randomUUID()), reason: "Intento de editar un contrato reemplazado." },
    });
    assert.equal(response.statusCode, 409);
  });

  it("refuses a second adenda on a contract already replaced", async () => {
    const response = await post("/api/contracts/amendments", newTerms);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "not_active");
  });

  it("prints receipts for the new agreement without the money paid under the old one", async () => {
    const successors = created.json().contracts as Array<{ id: string }>;

    // The L 130,000 and L 20,000 he sent for the new deal, as its prima.
    const pay = async (paidOn: string, amounts: number[]) =>
      (
        await post("/api/receipts", {
          customerId,
          paidOn,
          method: "transfer",
          lines: successors.map((contract, index) => ({
            contractId: contract.id,
            amountCents: amounts[index],
            type: "down_payment",
          })),
        })
      ).json().receipt.id as string;

    const big = await receipt(await pay("2026-09-22", [4_333_333, 4_333_333, 4_333_334]));
    assert.equal(big.previousBalance, lempiras(800_000));
    assert.equal(big.newBalance, lempiras(670_000));
    assert.equal(big.cumulativePaid, lempiras(130_000));
    assert.equal(
      big.lines.reduce((sum: number, line: { contractTotal: number }) => sum + line.contractTotal, 0),
      lempiras(800_000),
    );

    const small = await receipt(await pay("2026-09-28", [666_667, 666_667, 666_666]));
    assert.equal(small.previousBalance, lempiras(670_000));
    assert.equal(small.newBalance, lempiras(650_000));
    assert.equal(small.cumulativePaid, lempiras(150_000));

    // Still true of the old receipts, after new money arrived beside them.
    assert.equal((await receipt(oldReceipts[4]!)).cumulativePaid, lempiras(174_000));
  });

  it("splits a payment across the new purchase", async () => {
    const [successor] = (await listContracts()).filter((contract) => contract.replaces);
    const response = await app.inject({
      method: "GET",
      url: `/api/contracts/groups/${successor!.saleGroupId}/split?amountCents=${lempiras(216_667)}`,
      headers: { cookie: ownerCookie },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().lines.length, 3);
  });

  it("tells the transactions list which contract each payment's contract replaced", async () => {
    const rows = (
      await app.inject({ method: "GET", url: "/api/transactions", headers: { cookie: ownerCookie } })
    ).json().transactions as Array<{
      customerId: string;
      contractId: string;
      contractCode: string;
      contractStatus: string;
      replacesContractCode: string | null;
    }>;
    const mine = rows.filter((row) => row.customerId === customerId);

    const before = mine.filter((row) => old.some((contract) => contract.id === row.contractId));
    const after = mine.filter((row) => !old.some((contract) => contract.id === row.contractId));

    assert.ok(before.length > 0 && after.length > 0);

    // Money paid before the adenda sits on a contract that replaced nothing.
    for (const row of before) {
      assert.equal(row.contractStatus, "replaced");
      assert.equal(row.replacesContractCode, null);
    }

    // Money paid after sits on a successor, and names the contract it took over from.
    for (const row of after) {
      const predecessor = old.find((contract) => `${contract.code}-A1` === row.contractCode);
      assert.ok(predecessor, `${row.contractCode} is not a successor of an old contract`);
      assert.equal(row.replacesContractCode, predecessor.code);
    }
  });

  it("files the adenda in the history under the motive that was given", async () => {
    const rows = db.select().from(auditEvents).where(eq(auditEvents.action, "replace")).all();

    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.reason, newTerms.reason);
      assert.match(row.afterJson ?? "", /"replacedBy":"CT-2026-\d{3}-A1"/);
    }
  });

  it("files nothing for the successors themselves", () => {
    // Creating a contract is not filed, and an adenda is no exception: the new
    // terms are on the successor, linked back to what it replaced. The row that
    // took something away is the one in the history.
    const creations = db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "contract"), eq(auditEvents.action, "create")))
      .all();

    assert.deepEqual(creations, []);
  });

  it("numbers a second adenda A2, and leaves the yearly sequence alone", async () => {
    const successor = (created.json().contracts as Array<{ id: string; code: string }>)[0]!;

    const again = await post("/api/contracts/amendments", {
      effectiveOn: "2026-09-28",
      saleType: "cash",
      lines: [{ contractId: successor.id, salePriceCents: lempiras(260_000), downPaymentCents: 0 }],
      reason: "Se acordó liquidar este lote de contado por L 260,000.",
    });
    assert.equal(again.statusCode, 201);
    assert.equal(again.json().contracts[0].code, `${old[0]!.code}-A2`);

    // A single lot is not a purchase of several.
    const a2 = (await listContracts()).find(
      (contract) => contract.id === again.json().contracts[0].id,
    )!;
    assert.equal(a2.saleGroupId, null);
    assert.equal(a2.replaces?.code, successor.code);

    // The A1 contract now sits between two adendas and says both.
    const a1 = (await listContracts()).find((contract) => contract.id === successor.id)!;
    assert.equal(a1.replaces?.code, old[0]!.code);
    assert.equal(a1.replacedBy?.code, `${old[0]!.code}-A2`);

    // The A1 contract had L 50,000 paid on it, which stays there as income.
    assert.equal(a1.paidToDate, lempiras(50_000));
    assert.equal(a1.closedSettlement, "none");

    const next = await post("/api/contracts", sale(lot("B-07", 300)));
    assert.equal(next.statusCode, 201);
    assert.equal(next.json().contract.code, "CT-2026-004");
  });
});

describe("an adenda across customers", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  it("refuses contracts that belong to two different people", async () => {
    const otherCustomer = randomUUID();
    db.run(
      `INSERT INTO customers (id, full_name, identification, phone, customer_since)
       VALUES ('${otherCustomer}', 'Otra Persona', '0801-1999-12345', '+50499990001', 2026)`,
    );

    const lotId = randomUUID();
    db.insert(lots)
      .values({ id: lotId, projectId: ids.projectId, code: "Z-01", areaM2: 300, basePriceCents: 0 })
      .run();

    const theirs = (
      await app.inject({
        method: "POST",
        url: "/api/contracts",
        headers: { cookie: ownerCookie },
        payload: {
          customerId: otherCustomer,
          lotId,
          kind: "contract",
          saleType: "cash",
          salePriceCents: lempiras(100_000),
          downPaymentCents: 0,
          signedOn: "2026-03-10",
        },
      })
    ).json().contract;

    const mine = (
      await app.inject({
        method: "POST",
        url: "/api/contracts",
        headers: { cookie: ownerCookie },
        payload: {
          customerId: ids.customerId,
          lotId: ids.freeLotId,
          kind: "contract",
          saleType: "cash",
          salePriceCents: lempiras(100_000),
          downPaymentCents: 0,
          signedOn: "2026-03-10",
        },
      })
    ).json().contract;

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts/amendments",
      headers: { cookie: ownerCookie },
      payload: {
        effectiveOn: "2026-09-01",
        saleType: "cash",
        lines: [
          { contractId: mine.id, salePriceCents: lempiras(90_000), downPaymentCents: 0 },
          { contractId: theirs.id, salePriceCents: lempiras(90_000), downPaymentCents: 0 },
        ],
        reason: "Intento de juntar dos clientes en una misma adenda.",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "customer_mismatch");
  });

  it("refuses a reservation, which is converted rather than amended", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/contracts/amendments",
      headers: { cookie: ownerCookie },
      payload: {
        effectiveOn: "2026-09-01",
        saleType: "cash",
        lines: [{ contractId: ids.contractId, salePriceCents: lempiras(150_000), downPaymentCents: 0 }],
        reason: "Intento de hacer una adenda sobre una reserva.",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "not_a_contract");
  });
});

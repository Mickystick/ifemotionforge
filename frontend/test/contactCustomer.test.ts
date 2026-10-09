import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Cents, MoneyView } from "../src/lib/money";
import type { Contract } from "../src/types";
import {
  canContact,
  contactUrl,
  defaultMessage,
  defaultSubject,
} from "../src/features/contracts/contactCustomer";

/**
 * The message a customer actually receives, and the link that carries it.
 *
 * Worth testing on its own because it is the one thing on the Contratos screen
 * that leaves the building. A wrong figure in a table is read by the person who
 * can tell it is wrong; a wrong figure in a WhatsApp message has already been
 * sent to the customer, and the reference in it — lot and contract — is what
 * they will quote back down the phone.
 */

const money: MoneyView = { currency: "HNL", usdRate: 24.6 };

const cents = (amount: number) => Math.round(amount * 100) as Cents;

function buildContract(overrides: Partial<Contract> = {}): Contract {
  const base = {
    id: "c-1",
    code: "CT-2026-014",
    saleGroupId: null,
    kind: "contract",
    saleType: "financed",
    status: "active",
    lot: { id: "l-1", code: "A-07", projectName: "Villa Nueva", areaM2: 250 },
    customer: {
      id: "cu-1",
      fullName: "María Fernanda Rodríguez Paz",
      phone: "+50499824471",
      email: "maria@example.hn",
    },
    terms: {
      salePrice: cents(120_000),
      downPayment: cents(20_000),
      financed: cents(100_000),
      termMonths: 20,
      monthlyPayment: cents(5_000),
      dueDay: 10,
      signedOn: "2026-01-10",
      firstDueOn: "2026-02-10",
      firstDueOnAgreed: null,
      expiresOn: null,
    },
    downPaymentPaid: cents(20_000),
    paidToDate: cents(45_000),
    balance: cents(75_000),
    health: {
      status: "current",
      arrears: cents(0),
      monthsBehind: 0,
      monthsAhead: 0,
      nextDueOn: "2026-09-10",
      nextDueAmount: cents(5_000),
      nextInstallment: cents(5_000),
      nextDueCredit: cents(0),
      settled: false,
    },
    installmentCount: 20,
    closedAt: null,
    closedReason: null,
    notes: null,
  } as unknown as Contract;

  return { ...base, ...overrides } as Contract;
}

describe("the message written to a customer", () => {
  it("names the lot and the contract, which is what they can be asked about", () => {
    const message = defaultMessage(buildContract(), money);

    assert.ok(message.includes("A-07"), message);
    assert.ok(message.includes("CT-2026-014"), message);
    assert.ok(message.includes("Villa Nueva"), message);
  });

  it("greets by first name rather than by the whole legal name", () => {
    const message = defaultMessage(buildContract(), money);

    assert.ok(message.startsWith("Good morning, María."), message);
    assert.ok(!message.includes("Rodríguez Paz"), message);
  });

  it("states the overdue amount only when something really is overdue", () => {
    const settled = defaultMessage(
      buildContract({
        health: {
          status: "current",
          arrears: cents(0),
          monthsBehind: 0,
          monthsAhead: 0,
          nextDueOn: null,
          nextDueAmount: cents(0),
          nextInstallment: cents(0),
          nextDueCredit: cents(0),
          settled: true,
        },
      }),
      money,
    );

    // A customer who owes nothing must not be told they owe something, and must
    // not be told about a cuota that does not exist either.
    assert.ok(!settled.includes("overdue"), settled);
    assert.ok(!settled.includes("installment"), settled);
    assert.ok(settled.includes("A-07"), settled);

    const behind = defaultMessage(
      buildContract({
        health: {
          status: "overdue",
          arrears: cents(10_000),
          monthsBehind: 2,
          monthsAhead: 0,
          nextDueOn: "2026-09-10",
          nextDueAmount: cents(5_000),
          nextInstallment: cents(5_000),
          nextDueCredit: cents(0),
          settled: false,
        },
      }),
      money,
    );

    assert.ok(behind.includes("overdue"), behind);
    assert.ok(behind.includes("10,000"), behind);
  });

  it("states the regular cuota, with an advance named beside it", () => {
    const message = defaultMessage(
      buildContract({
        health: {
          status: "current",
          arrears: cents(0),
          monthsBehind: 0,
          monthsAhead: 0,
          nextDueOn: "2026-09-30",
          nextDueAmount: cents(7_249.51),
          nextInstallment: cents(7_250),
          nextDueCredit: cents(0.49),
          settled: false,
        },
      }),
      money,
    );

    // "7,249.51" would read as a different cuota; the customer's cuota is 7,250.
    assert.ok(message.includes("7,250"), message);
    assert.ok(!message.includes("7,249.51"), message);
    assert.ok(message.includes("has already been paid toward that installment") && message.includes("0.49"), message);
  });
});

describe("the link that carries it", () => {
  it("sends WhatsApp to the number on the customer's own record", () => {
    const contract = buildContract();
    const url = contactUrl(contract, "whatsapp", "hola", "asunto");

    // Bare digits, no plus: what wa.me accepts. And it is THIS customer's
    // number, which is the whole reason a chat link beats a share sheet.
    assert.ok(url.startsWith("https://wa.me/50499824471?text="), url);
    assert.equal(url.includes("+"), false);
  });

  it("puts the text in the body for SMS and the subject in the subject for mail", () => {
    const contract = buildContract();

    const sms = contactUrl(contract, "sms", "hola qué tal", "asunto");
    assert.ok(sms.startsWith("sms:+50499824471?&body="), sms);
    assert.ok(sms.includes("hola%20qu%C3%A9%20tal"), sms);

    const mail = contactUrl(contract, "email", "cuerpo", defaultSubject(contract));
    assert.ok(mail.startsWith("mailto:maria%40example.hn?subject="), mail);
    assert.ok(mail.includes("A-07"), mail);
    assert.ok(mail.includes("body=cuerpo"), mail);
  });

  it("reports a channel unusable when there is no address for it", () => {
    const noEmail = buildContract({
      customer: {
        id: "cu-2",
        fullName: "Juan Pérez",
        phone: "+50488887777",
        email: null,
      },
    } as Partial<Contract>);

    assert.equal(canContact(noEmail, "email"), false);
    assert.equal(canContact(noEmail, "whatsapp"), true);
    assert.equal(canContact(noEmail, "sms"), true);

    // An address of nothing but spaces is no address at all.
    const blank = buildContract({
      customer: { id: "cu-3", fullName: "Ana", phone: "+50488887777", email: "   " },
    } as Partial<Contract>);

    assert.equal(canContact(blank, "email"), false);
  });

  it("reports WhatsApp and SMS unusable for a customer with no phone on file", () => {
    // The rare case this exists for: a lot paid outright in one visit, with
    // nobody ever needing to write the number down.
    const noPhone = buildContract({
      customer: { id: "cu-4", fullName: "Pagó Todo de Contado", phone: null, email: "x@x.hn" },
    } as Partial<Contract>);

    assert.equal(canContact(noPhone, "whatsapp"), false);
    assert.equal(canContact(noPhone, "sms"), false);
    assert.equal(canContact(noPhone, "email"), true);
  });
});

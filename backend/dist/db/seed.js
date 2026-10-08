import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/env.js";
import { hashPassword } from "../lib/password.js";
import { createDb } from "./client.js";
import { contracts, customers, lots, payments, projects, users } from "./schema.js";
/**
 * Fills an empty database with the data the prototype showed, so the app has
 * something real to display before anyone types a record in.
 *
 * Refuses to run if users already exist, so it can never overwrite live data.
 * Also refuses outright in production — this is fictional demo data, complete
 * with a published password, and no real deployment should ever get it. See
 * db:bootstrap for how a real deployment creates its first account instead.
 */
const config = loadConfig();
if (config.nodeEnv === "production") {
    throw new Error("db:seed is disabled in production — use db:bootstrap to create the first account");
}
const { db, sqlite } = createDb(config.databasePath);
const existing = db.select({ id: users.id }).from(users).all();
if (existing.length > 0) {
    console.log("Database already has users — seed skipped.");
    sqlite.close();
    process.exit(0);
}
const lempiras = (amount) => Math.round(amount * 100);
const ownerId = randomUUID();
const staffId = randomUUID();
/*
 * `areaUnit` is how each project's areas are WRITTEN, not how they are stored —
 * every area below is square metres, always. Monte Real is seeded in varas
 * cuadradas so the unit handling is visible from the first run.
 */
const projectRows = [
    { id: randomUUID(), name: "Proyecto Santiago Etapa 1", areaUnit: "m2" },
    { id: randomUUID(), name: "Proyecto Santiago Etapa 2", areaUnit: "m2" },
    { id: randomUUID(), name: "Valle Verde", areaUnit: "m2" },
    { id: randomUUID(), name: "Monte Real", areaUnit: "vara2" },
];
const projectId = (name) => {
    const found = projectRows.find((project) => project.name === name);
    if (!found) {
        throw new Error(`Unknown project: ${name}`);
    }
    return found.id;
};
/*
 * Phones are seeded in E.164, the shape they are stored in — see
 * src/lib/phone.ts. The interface still shows and accepts "9944-7781".
 */
const customerRows = [
    { id: randomUUID(), fullName: "José Rodríguez", identification: "0801-1985-04412", phone: "+50499447781", email: "jrodriguez@correo.hn", address: "Col. Las Colinas, Tegucigalpa", customerSince: 2024, notes: "Prefiere que le escriban por WhatsApp en las tardes." },
    { id: randomUUID(), fullName: "Roberto Cruz", identification: "0501-1979-00238", phone: "+50498713320", email: null, address: "Barrio El Centro, San Pedro Sula", customerSince: 2025, notes: null },
    { id: randomUUID(), fullName: "Carlos Mendoza", identification: "0801-1990-11207", phone: "+50499824471", email: "cmendoza@correo.hn", address: "Res. El Trapiche, Tegucigalpa", customerSince: 2024, notes: "Paga por transferencia los primeros días del mes." },
    { id: randomUUID(), fullName: "Ana Lucía Paz", identification: "0703-1988-00951", phone: "+50499152093", email: "alpaz@correo.hn", address: "Col. Satélite, La Ceiba", customerSince: 2023, notes: null },
    { id: randomUUID(), fullName: "Elena Castillo", identification: "0801-1975-08830", phone: "+50499036612", email: null, address: "Col. Kennedy, Tegucigalpa", customerSince: 2022, notes: "Contrato pagado por completo en 2025." },
    { id: randomUUID(), fullName: "María Fernández", identification: "0601-1992-02274", phone: "+50499581104", email: "mfernandez@correo.hn", address: "Col. Modelo, Comayagua", customerSince: 2025, notes: "Contactar al esposo, Luis, al 9958-1105 si no contesta." },
    // Nobody has put her on a contract yet: a real cartera is mostly people who
    // asked once. She is also the only seeded record the delete button will
    // actually let go of, and the only one the "Sin contrato activo" filter finds.
    { id: randomUUID(), fullName: "Sofía Núñez", identification: "0801-1996-03318", phone: "+50497720145", email: null, address: "Col. Miraflores, Tegucigalpa", customerSince: 2026, notes: "Preguntó por lotes de esquina en Valle Verde; no ha vuelto." },
];
const customerId = (fullName) => {
    const found = customerRows.find((customer) => customer.fullName === fullName);
    if (!found) {
        throw new Error(`Unknown customer: ${fullName}`);
    }
    return found.id;
};
const lotSpecs = [
    {
        code: "A-07", project: "Proyecto Santiago Etapa 1", areaM2: 320, basePrice: 185_000,
        holder: "José Rodríguez",
        sale: {
            code: "CT-2026-014", kind: "contract", saleType: "financed",
            price: 185_000, down: 25_000, months: 24, monthly: 6_700, dueDay: 5,
            signedOn: "2026-01-15",
            paid: [
                ["2026-01-15", 25_000, "down_payment"],
                ["2026-02-05", 6_700, "installment"],
                ["2026-03-05", 6_700, "installment"],
                ["2026-04-04", 6_700, "installment"],
                ["2026-05-06", 6_700, "installment"],
                ["2026-06-05", 6_700, "installment"],
                ["2026-07-03", 6_700, "installment"],
            ],
            notes: "Paga puntual por transferencia.",
        },
    },
    { code: "A-12", project: "Proyecto Santiago Etapa 1", areaM2: 298, basePrice: 172_000, holder: null, sale: null },
    {
        code: "B-03", project: "Proyecto Santiago Etapa 2", areaM2: 310, basePrice: 178_500,
        holder: "Roberto Cruz",
        sale: {
            // A hold, not a sale: it has an end date, and when it passes the lot has
            // to go back on the market rather than sitting quietly off it forever.
            code: "CT-2026-021", kind: "reservation", saleType: "financed",
            price: 178_500, down: 20_000, months: 18, monthly: 8_800, dueDay: 10,
            signedOn: "2026-07-01", expiresOn: "2026-10-01",
            paid: [["2026-07-01", 20_000, "down_payment"]],
            notes: "Reserva mientras vende su carro. Confirmar antes del vencimiento.",
        },
    },
    {
        code: "B-14", project: "Proyecto Santiago Etapa 2", areaM2: 340, basePrice: 196_000,
        holder: "Carlos Mendoza",
        sale: {
            // Two months behind: the contract the Contratos screen exists to surface.
            code: "CT-2025-088", kind: "contract", saleType: "financed",
            price: 196_000, down: 30_000, months: 36, monthly: 4_600, dueDay: 15,
            signedOn: "2025-06-15",
            paid: [
                ["2025-06-15", 30_000, "down_payment"],
                ...Array.from({ length: 11 }, (_, index) => {
                    const month = index + 7;
                    const year = month > 12 ? 2026 : 2025;
                    const label = String(month > 12 ? month - 12 : month).padStart(2, "0");
                    return [`${year}-${label}-15`, 4_600, "installment"];
                }),
            ],
            notes: "Dejó de pagar en julio. Llamar al hijo si no contesta.",
        },
    },
    {
        code: "C-02", project: "Valle Verde", areaM2: 285, basePrice: 164_000,
        holder: "Ana Lucía Paz",
        sale: {
            code: "CT-2025-052", kind: "contract", saleType: "financed", group: "paz",
            price: 164_000, down: 20_000, months: 24, monthly: 6_000, dueDay: 5,
            signedOn: "2025-09-05",
            paid: [
                ["2025-09-05", 20_000, "down_payment"],
                ...Array.from({ length: 11 }, (_, index) => {
                    const month = index + 10;
                    const year = month > 12 ? 2026 : 2025;
                    const label = String(month > 12 ? month - 12 : month).padStart(2, "0");
                    // The uneven thirds of one L 18,000 receipt: 6,000 / 6,000 / 6,000
                    // here, and the odd hundreds land on her other two lots.
                    return [`${year}-${label}-05`, 6_000, "installment"];
                }),
            ],
            notes: "Compró tres lotes juntos; paga los tres con un solo recibo.",
        },
    },
    {
        code: "C-08", project: "Valle Verde", areaM2: 305, basePrice: 176_000,
        holder: "Ana Lucía Paz",
        sale: {
            code: "CT-2025-053", kind: "contract", saleType: "financed", group: "paz",
            price: 176_000, down: 20_000, months: 24, monthly: 6_500, dueDay: 5,
            signedOn: "2025-09-05",
            paid: [
                ["2025-09-05", 20_000, "down_payment"],
                ...Array.from({ length: 11 }, (_, index) => {
                    const month = index + 10;
                    const year = month > 12 ? 2026 : 2025;
                    const label = String(month > 12 ? month - 12 : month).padStart(2, "0");
                    return [`${year}-${label}-05`, 6_500, "installment"];
                }),
            ],
        },
    },
    {
        code: "C-15", project: "Valle Verde", areaM2: 290, basePrice: 168_000,
        holder: "Ana Lucía Paz",
        sale: {
            code: "CT-2025-054", kind: "contract", saleType: "financed", group: "paz",
            price: 168_000, down: 20_000, months: 24, monthly: 6_200, dueDay: 5,
            signedOn: "2025-09-05",
            paid: [
                ["2025-09-05", 20_000, "down_payment"],
                ...Array.from({ length: 11 }, (_, index) => {
                    const month = index + 10;
                    const year = month > 12 ? 2026 : 2025;
                    const label = String(month > 12 ? month - 12 : month).padStart(2, "0");
                    return [`${year}-${label}-05`, 6_200, "installment"];
                }),
            ],
        },
    },
    {
        code: "D-04", project: "Monte Real", areaM2: 330, basePrice: 210_000,
        holder: "Elena Castillo",
        sale: {
            // Paid off. Its lifecycle says so; its payment health is a separate
            // question, and the answer to that one is "nothing is owed".
            code: "CT-2024-007", kind: "contract", saleType: "financed",
            price: 210_000, down: 50_000, months: 12, monthly: 13_400, dueDay: 1,
            signedOn: "2024-11-01",
            paid: [
                ["2024-11-01", 50_000, "down_payment"],
                ...Array.from({ length: 11 }, (_, index) => {
                    const month = index + 12;
                    const year = month > 12 ? 2025 : 2024;
                    const label = String(month > 12 ? month - 12 : month).padStart(2, "0");
                    return [`${year}-${label}-01`, 13_400, "installment"];
                }),
                ["2025-11-01", 12_600, "installment"],
            ],
        },
    },
    {
        code: "D-11", project: "Monte Real", areaM2: 312, basePrice: 198_500,
        holder: "María Fernández",
        sale: {
            // A cash sale: settled at signing, so it carries no plazo, cuota or día.
            code: "CT-2026-003", kind: "contract", saleType: "cash",
            price: 198_500, down: 0, months: null, monthly: null, dueDay: null,
            signedOn: "2026-02-20",
            paid: [["2026-02-20", 198_500, "full_payment"]],
            notes: "Pagó de contado al firmar.",
        },
    },
];
const ownerPassword = await hashPassword("lindero123");
const staffPassword = await hashPassword("asociado123");
db.transaction((tx) => {
    tx.insert(users)
        .values([
        { id: ownerId, email: "gerencia@lindero.hn", name: "Gerencia", role: "owner", passwordHash: ownerPassword },
        { id: staffId, email: "asociado@lindero.hn", name: "Asociado", role: "staff", passwordHash: staffPassword },
    ])
        .run();
    tx.insert(projects).values(projectRows).run();
    tx.insert(customers).values(customerRows).run();
    // One id per named purchase, so the lots Ana Lucía bought together really do
    // share a sale group rather than only looking as though they do.
    const saleGroupIds = new Map();
    for (const spec of lotSpecs) {
        const lotId = randomUUID();
        tx.insert(lots)
            .values({
            id: lotId,
            projectId: projectId(spec.project),
            code: spec.code,
            areaM2: spec.areaM2,
            basePriceCents: lempiras(spec.basePrice),
        })
            .run();
        if (!spec.holder || !spec.sale) {
            continue;
        }
        const sale = spec.sale;
        const contractId = randomUUID();
        if (sale.group && !saleGroupIds.has(sale.group)) {
            saleGroupIds.set(sale.group, randomUUID());
        }
        tx.insert(contracts)
            .values({
            id: contractId,
            code: sale.code,
            lotId,
            customerId: customerId(spec.holder),
            saleGroupId: sale.group ? saleGroupIds.get(sale.group) : null,
            kind: sale.kind,
            saleType: sale.saleType,
            status: "active",
            salePriceCents: lempiras(sale.price),
            downPaymentCents: lempiras(sale.down),
            termMonths: sale.months,
            monthlyPaymentCents: sale.monthly === null ? null : lempiras(sale.monthly),
            dueDay: sale.dueDay,
            signedOn: sale.signedOn,
            expiresOn: sale.expiresOn ?? null,
            notes: sale.notes ?? null,
        })
            .run();
        // Each installment as its own row, dated when it was actually received.
        // Paid-to-date, the balance and the payment health are all summed and
        // computed from these — none of them is stored anywhere.
        for (const [paidOn, amount, type] of sale.paid) {
            tx.insert(payments)
                .values({
                id: randomUUID(),
                contractId,
                amountCents: lempiras(amount),
                originalAmountCents: lempiras(amount),
                originalCurrency: "HNL",
                exchangeRate: "1",
                paidOn,
                method: type === "down_payment" ? "cash" : "transfer",
                type,
                recordedBy: ownerId,
            })
                .run();
        }
    }
});
sqlite.close();
console.log(`Seeded ${config.databasePath}`);
console.log("  Supervisor  gerencia@lindero.hn / lindero123");
console.log("  Asociado    asociado@lindero.hn / asociado123");
//# sourceMappingURL=seed.js.map
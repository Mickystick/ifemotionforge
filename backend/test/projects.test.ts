import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { contracts, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

interface ProjectRow {
  id: string;
  name: string;
  areaUnit: string;
  archivedAt: string | null;
  lotCount: number;
  availableCount: number;
  reservedCount: number;
  financedCount: number;
  soldCount: number;
  donatedCount: number;
  inventoryValue: number;
  areaM2: number;
}

describe("projects", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const list = async (cookie = ownerCookie): Promise<ProjectRow[]> =>
    (await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } })).json()
      .projects;

  it("counts lots and statuses instead of storing them", async () => {
    const [project] = await list();

    // The seed has two lots: A-01 held by an active reservation, A-02 free.
    assert.equal(project.lotCount, 2);
    assert.equal(project.reservedCount, 1);
    assert.equal(project.soldCount, 0);
    assert.equal(project.availableCount, 1);
    assert.equal(project.inventoryValue, 18_500_000 + 16_000_000);
    assert.equal(project.areaM2, 580);
  });

  it("defaults an existing project to square metres", async () => {
    const [project] = await list();
    assert.equal(project.areaUnit, "m2");
  });

  it("lets any signed-in user read the list", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: staffCookie },
    });
    assert.equal(response.statusCode, 200);
  });

  it("refuses to create a project for staff", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: staffCookie },
      payload: { name: "Altos del Río", areaUnit: "manzana" },
    });
    assert.equal(response.statusCode, 403);
  });

  it("creates a project with its own unit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
      payload: { name: "Altos del Río", areaUnit: "manzana" },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().project.areaUnit, "manzana");

    const created = (await list()).find((project) => project.name === "Altos del Río");
    assert.equal(created?.lotCount, 0);
  });

  it("refuses a duplicate name and an unknown unit", async () => {
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
      payload: { name: "Altos del Río", areaUnit: "m2" },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, "duplicate_name");

    const badUnit = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
      payload: { name: "Otro", areaUnit: "acres" },
    });
    assert.equal(badUnit.statusCode, 400);
  });

  it("changes the unit without touching a single stored area", async () => {
    const before = (await list()).find((project) => project.id === ids.projectId);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/projects/${ids.projectId}`,
      headers: { cookie: ownerCookie },
      payload: { name: "Proyecto Prueba", areaUnit: "vara2" },
    });
    assert.equal(response.statusCode, 200);

    const afterEdit = (await list()).find((project) => project.id === ids.projectId);
    assert.equal(afterEdit?.areaUnit, "vara2");
    // The land did not change size because the paperwork changed units.
    assert.equal(afterEdit?.areaM2, before?.areaM2);
  });

  it("refuses to archive a project that still has active lots", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${ids.projectId}/archive`,
      headers: { cookie: ownerCookie },
      payload: { reason: "Ya terminamos de vender este proyecto." },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "project_has_lots");
    assert.match(response.json().message, /2 active lots/);
  });

  it("archives an empty project, hides it from the lot form, and restores it", async () => {
    const empty = (await list()).find((project) => project.name === "Altos del Río")!;

    const archived = await app.inject({
      method: "POST",
      url: `/api/projects/${empty.id}/archive`,
      headers: { cookie: ownerCookie },
      payload: { reason: "Proyecto cancelado antes de lotificar." },
    });
    assert.equal(archived.statusCode, 200);

    // Still listed on the Proyectos screen, but no longer offered for new lots.
    const stillListed = (await list()).find((project) => project.id === empty.id);
    assert.ok(stillListed?.archivedAt);

    const lotsPayload = (
      await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: ownerCookie } })
    ).json();
    assert.equal(
      lotsPayload.projects.some((project: { id: string }) => project.id === empty.id),
      false,
    );

    // And a lot cannot be filed under it either.
    const refused = await app.inject({
      method: "POST",
      url: "/api/lots",
      headers: { cookie: ownerCookie },
      payload: {
        code: "X-01",
        projectName: "Altos del Río",
        areaM2: 100,
        basePriceCents: 100_000,
      },
    });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, "unknown_project");

    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${empty.id}/restore`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal((await list()).find((project) => project.id === empty.id)?.archivedAt, null);
  });

  it("files every change to a project in the history, and not its creation", async () => {
    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: ownerCookie } })
    ).json().events;

    const actions = events
      .filter((event: { entityType: string }) => event.entityType === "project")
      .map((event: { action: string }) => event.action);

    for (const action of ["update", "archive", "restore"]) {
      assert.ok(actions.includes(action), `expected a project ${action} in the history`);
    }

    // Creating one is not a change to anything on file.
    assert.equal(actions.includes("create"), false);
  });
});

/**
 * The counters on a project card, one contract shape at a time.
 *
 * Its own app because it adds lots: the counts the suite above asserts are the
 * seed's, and a project that quietly grew to six lots would fail them.
 *
 * The point of the split is that "vendido" has to mean the land is gone. A lot
 * being paid off monthly is still ours, so it is counted apart — otherwise a
 * company financing forty lots reads as having sold forty lots it still owns.
 */
describe("project counts, by what the contract actually is", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  // One lot per shape, on top of the seed's reserved A-01 and free A-02.
  const shapes = [
    { code: "B-01", saleType: "financed", status: "active" },
    { code: "B-02", saleType: "financed", status: "paid_off" },
    { code: "B-03", saleType: "cash", status: "active" },
    { code: "B-04", saleType: "donation", status: "active" },
  ] as const;

  for (const [index, shape] of shapes.entries()) {
    const lotId = randomUUID();

    db.insert(lots)
      .values({
        id: lotId,
        projectId: ids.projectId,
        code: shape.code,
        areaM2: 100,
        basePriceCents: 1_000_000,
      })
      .run();

    db.insert(contracts)
      .values({
        id: randomUUID(),
        code: `CT-SHAPE-${index}`,
        lotId,
        customerId: ids.customerId,
        kind: "contract",
        saleType: shape.saleType,
        status: shape.status,
        // A donation transfers land for nothing, so its price really is zero.
        salePriceCents: shape.saleType === "donation" ? 0 : 1_000_000,
      })
      .run();
  }

  const project = async (): Promise<ProjectRow> =>
    (
      await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: ownerCookie } })
    ).json().projects[0];

  it("counts a live crédito as financed, never as sold", async () => {
    assert.equal((await project()).financedCount, 1);
  });

  it("counts a paid-off crédito and a contado sale as sold", async () => {
    // Both mean the same thing on the ground: nothing left to collect, and the
    // lot is no longer ours. A crédito that finished IS a completed sale.
    assert.equal((await project()).soldCount, 2);
  });

  it("counts a donation on its own, so a giveaway never reads as revenue", async () => {
    assert.equal((await project()).donatedCount, 1);
  });

  it("leaves exactly the untouched lot available", async () => {
    const row = await project();

    // The four buckets are mutually exclusive, so what is left really is free:
    // six lots, minus the reserved A-01 and the four above, leaves A-02.
    assert.equal(row.lotCount, 6);
    assert.equal(row.reservedCount, 1);
    assert.equal(row.availableCount, 1);
    assert.equal(
      row.availableCount,
      row.lotCount - row.reservedCount - row.financedCount - row.soldCount - row.donatedCount,
    );
  });
});

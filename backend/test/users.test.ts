import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/**
 * Managing the accounts themselves — who exists, what role they hold, and
 * whether they can still sign in.
 *
 * Distinct from permissions-editing.test.ts, which covers what the associate
 * ROLE may do. This is about the people.
 */
describe("user accounts", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const createUser = (cookie: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/users", headers: { cookie }, payload });

  const listUsers = (cookie: string) =>
    app.inject({ method: "GET", url: "/api/users", headers: { cookie } });

  it("is closed to the associate entirely", async () => {
    assert.equal((await listUsers(staffCookie)).statusCode, 403);

    const created = await createUser(staffCookie, {
      name: "Cuenta Propia",
      email: "propia@test.hn",
      role: "owner",
      password: "una-contrasena-larga",
    });

    // The whole reason `user:manage` is locked: an associate who could create
    // accounts could create a supervisor and grant themselves everything.
    assert.equal(created.statusCode, 403);
  });

  it("creates an account the new hire can actually sign in with", async () => {
    const created = await createUser(ownerCookie, {
      name: "Nueva Asociada",
      email: "  Nueva@Test.HN  ",
      role: "staff",
      password: "contrasena-de-prueba",
    });

    assert.equal(created.statusCode, 201);
    // Trimmed and lower-cased, because that is how the login route reads it.
    assert.equal(created.json().user.email, "nueva@test.hn");
    // Never, under any circumstance, in a response.
    assert.equal(created.json().user.passwordHash, undefined);

    const cookie = await login(app, "nueva@test.hn", "contrasena-de-prueba");
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.name, "Nueva Asociada");
    // And the new account follows the associate role's permissions, without
    // anybody configuring anything for this person.
    assert.ok(me.json().user.capabilities.includes("payment:record"));
    assert.ok(!me.json().user.capabilities.includes("payment:reverse"));
  });

  it("refuses an email that already belongs to someone, naming them", async () => {
    const response = await createUser(ownerCookie, {
      name: "Duplicada",
      email: "OWNER@test.hn",
      role: "staff",
      password: "otra-contrasena-larga",
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "duplicate_email");
    assert.match(response.json().message, /Owner/);
  });

  it("refuses a password short enough to guess", async () => {
    const response = await createUser(ownerCookie, {
      name: "Contraseña Corta",
      email: "corta@test.hn",
      role: "staff",
      password: "corta",
    });

    assert.equal(response.statusCode, 400);
    assert.match(JSON.stringify(response.json().issues), /at least 10 characters/);
  });

  it("lists the accounts with their last sign-in, and never a hash", async () => {
    const response = await listUsers(ownerCookie);
    assert.equal(response.statusCode, 200);

    const owner = response.json().users.find((row: { id: string }) => row.id === ids.ownerId);

    assert.equal(owner.role, "owner");
    assert.equal(owner.isSelf, true);
    assert.equal(owner.deactivatedAt, null);
    // Stamped on the account at sign-in, not read back out of the Historial.
    assert.ok(owner.lastSignInAt);
    assert.equal(JSON.stringify(response.json()).includes("scrypt$"), false);
  });

  it("ends the session the moment an account is deactivated", async () => {
    const created = await createUser(ownerCookie, {
      name: "Se Va",
      email: "seva@test.hn",
      role: "staff",
      password: "contrasena-de-salida",
    });
    const leaverId = created.json().user.id;
    const leaverCookie = await login(app, "seva@test.hn", "contrasena-de-salida");

    // Working before.
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/lots", headers: { cookie: leaverCookie } }))
        .statusCode,
      200,
    );

    const deactivated = await app.inject({
      method: "POST",
      url: `/api/users/${leaverId}/deactivate`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(deactivated.statusCode, 200);

    // Not at the next expiry — on the next click.
    const afterwards = await app.inject({
      method: "GET",
      url: "/api/lots",
      headers: { cookie: leaverCookie },
    });
    assert.equal(afterwards.statusCode, 401);

    // And signing back in is refused with an explanation, not a wrong-password
    // message that would send a real ex-employee round in circles.
    const retry = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "seva@test.hn", password: "contrasena-de-salida" },
    });
    assert.equal(retry.statusCode, 403);
    assert.equal(retry.json().error, "account_deactivated");

    // A wrong password on a deactivated account still says only "wrong
    // password": the existence of the account is not confirmed to a guesser.
    const guess = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "seva@test.hn", password: "no-es-la-contrasena" },
    });
    assert.equal(guess.statusCode, 401);
    assert.equal(guess.json().error, "invalid_credentials");

    // The row is still there, so the payments and audit rows pointing at it
    // still resolve to a person.
    const reactivated = await app.inject({
      method: "POST",
      url: `/api/users/${leaverId}/reactivate`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(reactivated.statusCode, 200);

    // The old password still works: reactivating is not resetting.
    await login(app, "seva@test.hn", "contrasena-de-salida");
  });

  it("will not let a supervisor lock themselves out", async () => {
    const self = await app.inject({
      method: "POST",
      url: `/api/users/${ids.ownerId}/deactivate`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(self.statusCode, 409);
    assert.equal(self.json().error, "cannot_deactivate_self");

    const demoteSelf = await app.inject({
      method: "PATCH",
      url: `/api/users/${ids.ownerId}`,
      headers: { cookie: ownerCookie },
      payload: { name: "Owner", email: "owner@test.hn", role: "staff" },
    });
    assert.equal(demoteSelf.statusCode, 409);
    assert.equal(demoteSelf.json().error, "cannot_change_own_role");

    // Renaming yourself is fine — the role is the only field that can take the
    // application away from you.
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/users/${ids.ownerId}`,
      headers: { cookie: ownerCookie },
      payload: { name: "Owner Renombrado", email: "owner@test.hn", role: "owner" },
    });
    assert.equal(rename.statusCode, 200);
    assert.equal(rename.json().user.name, "Owner Renombrado");
  });

  it("keeps at least one supervisor able to sign in", async () => {
    // A second supervisor, so the first one can be demoted at all.
    const second = await createUser(ownerCookie, {
      name: "Segundo Supervisor",
      email: "segundo@test.hn",
      role: "owner",
      password: "contrasena-supervisor",
    });
    const secondId = second.json().user.id;
    const secondCookie = await login(app, "segundo@test.hn", "contrasena-supervisor");

    // Now there are two, so demoting one is allowed.
    const demoted = await app.inject({
      method: "PATCH",
      url: `/api/users/${ids.ownerId}`,
      headers: { cookie: secondCookie },
      payload: { name: "Owner Renombrado", email: "owner@test.hn", role: "staff" },
    });
    assert.equal(demoted.statusCode, 200);

    // And with only one left, the app refuses to remove the last way back in.
    const lastDemotion = await app.inject({
      method: "PATCH",
      url: `/api/users/${secondId}`,
      headers: { cookie: ownerCookie },
      payload: { name: "Segundo Supervisor", email: "segundo@test.hn", role: "staff" },
    });
    // The demoted owner cannot do it at all any more...
    assert.equal(lastDemotion.statusCode, 403);

    const lastDeactivation = await app.inject({
      method: "POST",
      url: `/api/users/${secondId}/deactivate`,
      headers: { cookie: secondCookie },
    });
    // ...and the last supervisor cannot remove themselves either way.
    assert.equal(lastDeactivation.statusCode, 409);
    assert.equal(lastDeactivation.json().error, "cannot_deactivate_self");

    // Put the fixture back for any test that runs after this one.
    await app.inject({
      method: "PATCH",
      url: `/api/users/${ids.ownerId}`,
      headers: { cookie: secondCookie },
      payload: { name: "Owner Renombrado", email: "owner@test.hn", role: "owner" },
    });
  });

  it("resets a password and signs that account out everywhere", async () => {
    const created = await createUser(ownerCookie, {
      name: "Olvidadiza",
      email: "olvido@test.hn",
      role: "staff",
      password: "la-vieja-contrasena",
    });
    const userId = created.json().user.id;
    const oldCookie = await login(app, "olvido@test.hn", "la-vieja-contrasena");

    const reset = await app.inject({
      method: "PUT",
      url: `/api/users/${userId}/password`,
      headers: { cookie: ownerCookie },
      payload: { password: "la-nueva-contrasena" },
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().endedSessions, 1);

    // A password changed because it leaked is worth nothing while the session
    // opened with the old one still works.
    const stale = await app.inject({
      method: "GET",
      url: "/api/lots",
      headers: { cookie: oldCookie },
    });
    assert.equal(stale.statusCode, 401);

    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "olvido@test.hn", password: "la-vieja-contrasena" },
    });
    assert.equal(oldPassword.statusCode, 401);

    await login(app, "olvido@test.hn", "la-nueva-contrasena");
  });

  it("writes every account change to the history, and never the password", async () => {
    const audit = await app.inject({
      method: "GET",
      url: "/api/audit?limit=200",
      headers: { cookie: ownerCookie },
    });

    const events = audit
      .json()
      .events.filter((event: { entityType: string }) => event.entityType === "user");

    const actions = new Set(events.map((event: { action: string }) => event.action));
    assert.ok(actions.has("create"));
    assert.ok(actions.has("update"));
    assert.ok(actions.has("archive"));
    assert.ok(actions.has("restore"));

    // Named, not a UUID: an account row now resolves to the person it is about
    // rather than only to the supervisor who changed it.
    const creation = events.find(
      (event: { action: string; after: { email?: string } | null }) =>
        event.action === "create" && event.after?.email === "olvido@test.hn",
    );
    assert.equal(creation.entityLabel, "Olvidadiza");
    assert.equal(creation.actorName, "Owner Renombrado");

    // Not the password, not the hash, not a fragment of either.
    const body = JSON.stringify(events);
    assert.equal(body.includes("la-nueva-contrasena"), false);
    assert.equal(body.includes("la-vieja-contrasena"), false);
    assert.equal(body.includes("scrypt$"), false);
    // What it DOES record is that a reset happened, and when.
    assert.ok(body.includes("passwordResetAt"));
  });

  it("leaves the payments a departed associate recorded exactly where they were", async () => {
    const before = db.$client
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE recorded_by = ?")
      .get(ids.ownerId) as { n: number };

    assert.ok(before.n > 0);

    // Nothing here is a delete, so there is no path by which those rows lose
    // the person who recorded them.
    const deleteAttempt = await app.inject({
      method: "DELETE",
      url: `/api/users/${ids.staffId}`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(deleteAttempt.statusCode, 404);

    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  });
});

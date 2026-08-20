/**
 * Promoting a second person to `Owner` through the product's own surfaces, end to end: the real
 * users table and its trigger, the boot Role sync, the HTTP grant route the "Give more access"
 * form posts to, and `LiveRouteAuthorizer` in enforcing mode.
 *
 * The API half of #408 was closed by giving the durable `owner` Role real grants. The grantee was
 * still shut out of People & access because the session payload described them by the `users.role`
 * column, which a Role grant never touches — so the UI kept hiding every admin surface from them.
 */

import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PgGroupRepo, PgPrincipalRepo, PgRoleRepo } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { PgTokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { PgUserInviteRepo } from "../auth/invites";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, PgUserRepo } from "../auth/users";
import { transactionPort } from "../db";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import { syncDeploymentRoles } from "../identity/roles";
import { makeMigratedPglite } from "../test/pglite";
import { LiveRouteAuthorizer } from "./route-gate";
import { AuthzAdminService } from "./service";

const PASSWORD = "correct-horse-battery";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

describe("promoting a second person to Owner through the product", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let memberId: string;

  async function login(email: string): Promise<Session> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const sid = res.cookies.find((cookie) => cookie.name === "tf_sid")?.value;
    const csrf = res.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value;
    if (!sid || !csrf) throw new Error("login issued no session cookie");
    return { sid, csrf };
  }

  function session(as: Session) {
    return app.inject({ method: "GET", url: "/api/v1/auth/session", cookies: { tf_sid: as.sid } });
  }

  /** The request the "Give more access" form makes. */
  function giveOwner(as: Session, principalId: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/authz/roles/owner/assignments",
      cookies: { tf_sid: as.sid, [CSRF_COOKIE]: as.csrf },
      headers: { [CSRF_HEADER]: as.csrf },
      payload: { principalId },
    });
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const transactions = transactionPort(db);
    await syncDeploymentRoles(new PgRoleRepo(transactions));

    const users = new PgUserRepo(db);
    await createUser(users, "admin@example.com", PASSWORD, "admin");
    // Both invitees hold the default "Everyday access"; only one is then given Owner.
    const member = await createUser(users, "member@example.com", PASSWORD, "member");
    await createUser(users, "bystander@example.com", PASSWORD, "member");
    memberId = member._id;

    const resolver = buildApiAuthorityLayerResolver(db);
    app = await buildApp({
      sessionStore: new MemorySessionStore(),
      userRepo: users,
      userAdminRepo: users,
      tokenRepo: new PgTokenRepo(db),
      userInviteRepo: new PgUserInviteRepo(db),
      routeAuthorizer: new LiveRouteAuthorizer(resolver),
      authorizationGate: { mode: "enforcing" },
      authzAdmin: new AuthzAdminService({
        roles: new PgRoleRepo(transactions),
        groups: new PgGroupRepo(transactions),
        principals: new PgPrincipalRepo(transactions),
        resolver,
        businessId: DEPLOYMENT_BUSINESS_ID,
      }),
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("lets the grantee read People & access once Owner is given", async () => {
    expect((await giveOwner(await login("admin@example.com"), memberId)).statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      cookies: { tf_sid: (await login("member@example.com")).sid },
    });

    expect(res.statusCode).toBe(200);
  });

  it("tells the grantee's own session that they are an admin of the business", async () => {
    await giveOwner(await login("admin@example.com"), memberId);

    const res = await session(await login("member@example.com"));

    expect(res.json().user).toMatchObject({ role: "member", isAdmin: true });
  });

  it("says the same at login, so the answer does not wait for a reload", async () => {
    await giveOwner(await login("admin@example.com"), memberId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "member@example.com", password: PASSWORD },
    });

    expect(res.json().user.isAdmin).toBe(true);
  });

  it("leaves everyday access refused, and its session says so", async () => {
    await giveOwner(await login("admin@example.com"), memberId);
    const bystander = await login("bystander@example.com");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      cookies: { tf_sid: bystander.sid },
    });

    expect(list.statusCode).toBe(403);
    expect((await session(bystander)).json().user.isAdmin).toBe(false);
  });

  it("keeps the account role untouched, so Owner is the only thing that changed", async () => {
    await giveOwner(await login("admin@example.com"), memberId);

    const held = await db.query<{ role_id: string }>(
      "SELECT role_id FROM role_assignments WHERE business_id = $1 AND principal_id = $2 ORDER BY role_id",
      [DEPLOYMENT_BUSINESS_ID, memberId]
    );

    expect(held.rows.map((row) => row.role_id)).toEqual(["member", "owner"]);
  });
});

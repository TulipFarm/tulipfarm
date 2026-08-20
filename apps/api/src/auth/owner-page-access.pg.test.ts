/**
 * The literal #408 repro, through product surfaces only: an admin invites someone, they accept,
 * the admin gives them the `Owner` access level from "Give more access", and they sign in fresh
 * and load People & access.
 *
 * The page's loader fans out over the whole authz read surface and fails as a unit, so an Owner
 * refused by any one of those routes sees the same "You are not an admin of this business." as
 * before the grant. Asserting only `/api/v1/users` cannot see that.
 */

import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PgGroupRepo, PgPrincipalRepo, PgRoleRepo } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { LiveRouteAuthorizer, makeAuthorizationCheck } from "../authz/route-gate";
import { AuthzAdminService } from "../authz/service";
import { transactionPort } from "../db";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import { ADMIN_ONLY_SURFACES, syncDeploymentRoles } from "../identity/roles";
import { makeMigratedPglite } from "../test/pglite";
import { PgTokenRepo } from "./api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "./csrf";
import { PgUserInviteRepo } from "./invites";
import { MemorySessionStore } from "./session-store";
import { createUser, PgUserRepo } from "./users";

const PASSWORD = "correct-horse-battery";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

/** Every request `_app.business.access._index` issues before it renders anything. */
function pageReads(principalId: string): string[] {
  return [
    "/api/v1/users",
    "/api/v1/authz/roles",
    "/api/v1/authz/groups",
    "/api/v1/authz/roles/owner/assignees",
    "/api/v1/authz/roles/member/assignees",
    `/api/v1/authz/principals/${principalId}/grants`,
  ];
}

/** Every admin-only action a route declares by name. `*` is a catalog entry, not a request. */
const ADMIN_ONLY_ACTIONS = ADMIN_ONLY_SURFACES.flatMap((surface) =>
  surface.actions
    .filter((action) => action !== "*")
    .map((action) => ({ action, resourceType: surface.type, fallback: "admin" }) as const)
);

describe("promoting an invited member to Owner, exactly as the product does it", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let decide: ReturnType<typeof makeAuthorizationCheck>;
  let inviteeId: string;
  let bystanderId: string;

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

  function get(as: Session, url: string) {
    return app.inject({ method: "GET", url, cookies: { tf_sid: as.sid } });
  }

  /** "Invite someone" on People & access, then the invitee redeeming the link. */
  async function inviteAndAccept(as: Session, email: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      cookies: { tf_sid: as.sid, [CSRF_COOKIE]: as.csrf },
      headers: { [CSRF_HEADER]: as.csrf },
      payload: { email },
    });
    expect(created.statusCode).toBe(201);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token: created.json().invite.token, password: PASSWORD },
    });
    expect(accepted.statusCode).toBe(200);
    return created.json().user.id;
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

    const resolver = buildApiAuthorityLayerResolver(db);
    decide = makeAuthorizationCheck(new LiveRouteAuthorizer(resolver), { mode: "enforcing" });
    app = await buildApp({
      sessionStore: new MemorySessionStore(),
      userRepo: users,
      userAdminRepo: users,
      passwordWriteRepo: users,
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

    const admin = await login("admin@example.com");
    inviteeId = await inviteAndAccept(admin, "invitee@example.com");
    bystanderId = await inviteAndAccept(admin, "bystander@example.com");
    expect((await giveOwner(admin, inviteeId)).statusCode).toBe(200);
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("serves every read the page's loader fans out over", async () => {
    const owner = await login("invitee@example.com");

    const results = await Promise.all(
      pageReads(bystanderId).map(async (url) => `${url} -> ${(await get(owner, url)).statusCode}`)
    );

    expect(results).toEqual(pageReads(bystanderId).map((url) => `${url} -> 200`));
  });

  it("tells the grantee's own session that they are an admin of the business", async () => {
    const res = await get(await login("invitee@example.com"), "/api/v1/auth/session");

    expect(res.json().user).toMatchObject({ role: "member", isAdmin: true });
  });

  it("admits the grantee on the session they already held when it was given", async () => {
    const before = await login("bystander@example.com");
    expect((await get(before, "/api/v1/auth/session")).json().user.isAdmin).toBe(false);

    expect((await giveOwner(await login("admin@example.com"), bystanderId)).statusCode).toBe(200);

    const after = await get(before, "/api/v1/auth/session");
    expect(after.json().user).toMatchObject({ isAdmin: true });
    expect((await get(before, `/api/v1/authz/principals/${inviteeId}/grants`)).statusCode).toBe(
      200
    );
  });

  it("lets an Owner pass the access on, which is the level's own definition", async () => {
    const res = await giveOwner(await login("invitee@example.com"), bystanderId);

    expect(res.statusCode).toBe(200);
  });

  it("confers every admin-only action, which is what the level's own copy promises", async () => {
    const owner = {
      id: inviteeId,
      kind: "user",
      businessId: DEPLOYMENT_BUSINESS_ID,
      credential: "session",
      authMethods: ["password"],
      authenticatedAt: new Date(),
      role: "member",
    } as const;

    const refused: string[] = [];
    for (const request of ADMIN_ONLY_ACTIONS) {
      if (!(await decide(owner, request)))
        refused.push(`${request.resourceType}:${request.action}`);
    }

    expect(refused).toEqual([]);
  });

  it("leaves everyday access refused across the same reads", async () => {
    const bystander = await login("bystander@example.com");

    const results = await Promise.all(
      pageReads(inviteeId).map(async (url) => `${url} -> ${(await get(bystander, url)).statusCode}`)
    );

    expect(results).toEqual(pageReads(inviteeId).map((url) => `${url} -> 403`));
  });
});

import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PgPrincipalRepo, PgRoleRepo } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../db";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import type { RequestPrincipal } from "../identity/principal";
import { MEMBER_ALLOWED_SURFACES, syncDeploymentRoles } from "../identity/roles";
import { makeMigratedPglite } from "../test/pglite";
import { LiveRouteAuthorizer, makeAuthorizationCheck } from "./route-gate";

/**
 * The gate's two halves are tested apart: route suites build the app with no authorizer and so
 * only ever exercise the static `fallback`, while the engine's own suites use hand-built Role
 * rows. Neither covers the composition production actually runs — migration-seeded rows, the boot
 * sync, and `LiveRouteAuthorizer` under the default `enforcing` mode — which is the only place a
 * member can be refused a route declared member-visible.
 */

const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN_ID = "33333333-3333-3333-3333-333333333333";

/**
 * `role` is set truthfully, but it is the *fallback* input and enforcing mode discards the
 * fallback. Every assertion below therefore rests on the durable grants the engine reads, which
 * is the point: it is the half no route suite covers.
 */
function principal(id: string, role: "admin" | "member"): RequestPrincipal {
  return {
    id,
    kind: "user",
    businessId: DEPLOYMENT_BUSINESS_ID,
    credential: "session",
    authMethods: ["password"],
    authenticatedAt: new Date(),
    role,
  };
}

const INTEGRATION_READ = {
  action: "integration.read",
  resourceType: "integration",
  fallback: "authenticated",
} as const;

const INTEGRATION_CONNECT = {
  action: "integration.connect",
  resourceType: "integration",
  fallback: "admin",
} as const;

const SECRET_WRITE = {
  action: "secret.write",
  resourceType: "secret",
  fallback: "admin",
} as const;

/** What People & access requires of its caller. */
const USER_MANAGE = {
  action: "user.manage",
  resourceType: "user",
  fallback: "admin",
} as const;
async function memberGrantCount(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM role_grants WHERE business_id = $1 AND role_id = 'member'",
    [DEPLOYMENT_BUSINESS_ID]
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("deployment roles under the live route gate", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const transactions = transactionPort(db);
    const principals = new PgPrincipalRepo(transactions);
    const roles = new PgRoleRepo(transactions);

    for (const id of [MEMBER_ID, ADMIN_ID]) {
      await principals.put({
        businessId: DEPLOYMENT_BUSINESS_ID,
        id,
        kind: "user",
        status: "active",
      });
    }
    await roles.assign({
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: MEMBER_ID,
      roleId: "member",
    });
    await roles.assign({
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: ADMIN_ID,
      roleId: "admin",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  function check() {
    const authorizer = new LiveRouteAuthorizer(buildApiAuthorityLayerResolver(db));
    return makeAuthorizationCheck(authorizer, { mode: "enforcing" });
  }

  const member = principal(MEMBER_ID, "member");
  const admin = principal(ADMIN_ID, "admin");

  it("seeds member with no grants in the migration alone", async () => {
    expect(await memberGrantCount(db)).toBe(0);
  });

  it("refuses a member every declared surface until the boot sync runs", async () => {
    const decide = check();

    expect(await decide(member, INTEGRATION_READ)).toBe(false);
  });

  it("grants the member allow-list once the boot sync has run", async () => {
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(db)));
    expect(await memberGrantCount(db)).toBeGreaterThan(0);

    const decide = check();

    expect(await decide(member, INTEGRATION_READ)).toBe(true);
    expect(await decide(admin, INTEGRATION_READ)).toBe(true);
  });

  it("still refuses a member the admin-only half of the same resource type", async () => {
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(db)));
    const decide = check();

    expect(await decide(member, INTEGRATION_CONNECT)).toBe(false);
    expect(await decide(admin, INTEGRATION_CONNECT)).toBe(true);
  });

  it("authorizes every action the member allow-list declares", async () => {
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(db)));
    const decide = check();

    const explicit = MEMBER_ALLOWED_SURFACES.flatMap((surface) =>
      surface.actions
        .filter((action) => action !== "*")
        .map((action) => ({ action, resourceType: surface.type }))
    );

    const denied: string[] = [];
    for (const grant of explicit) {
      const request = { ...grant, fallback: "authenticated" } as const;
      if (!(await decide(member, request))) denied.push(`${grant.resourceType}:${grant.action}`);
    }

    expect(denied).toEqual([]);
  });

  /**
   * The `Owner` level is the only promotion the product offers, and its own copy calls it "can do
   * anything, including managing access" — so it has to survive the boot sync as authority, not as
   * the placeholder grants the migration seeded against resource types no route declares (#408).
   */
  it("grants a member promoted to Owner the admin-only surfaces", async () => {
    await new PgRoleRepo(transactionPort(db)).assign({
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: MEMBER_ID,
      roleId: "owner",
    });
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(db)));
    const decide = check();

    expect(await decide(member, USER_MANAGE)).toBe(true);
    expect(await decide(member, SECRET_WRITE)).toBe(true);
  });

  it("keeps admin-only surfaces refused to everyday access", async () => {
    await syncDeploymentRoles(new PgRoleRepo(transactionPort(db)));
    const decide = check();

    expect(await decide(member, USER_MANAGE)).toBe(false);
    expect(await decide(admin, USER_MANAGE)).toBe(true);
  });
});

import type { PGlite } from "@electric-sql/pglite";
import { decideEffectivePermission } from "@tulipfarm/authz";
import {
  AUTHORIZATION_STORAGE_STATEMENTS,
  PgGroupRepo,
  PgPrincipalRepo,
  PgRoleRepo,
} from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../db";
import { makePglite } from "../test/pglite";
import { LiveAuthorityLayerResolver } from "./authority-layers";
import type { RequestPrincipal } from "./principal";

const BUSINESS_ID = "business-1";
const NOW = new Date("2026-08-12T12:00:00Z");

function requestPrincipal(overrides: Partial<RequestPrincipal> = {}): RequestPrincipal {
  return {
    id: "user-1",
    kind: "user",
    businessId: BUSINESS_ID,
    credential: "session",
    authMethods: ["password"],
    authenticatedAt: NOW,
    userId: "user-1",
    ...overrides,
  };
}

describe("LiveAuthorityLayerResolver", () => {
  let db: PGlite;
  let principals: PgPrincipalRepo;
  let roles: PgRoleRepo;
  let groups: PgGroupRepo;
  let resolver: LiveAuthorityLayerResolver;

  beforeEach(async () => {
    db = await makePglite();
    for (const statement of AUTHORIZATION_STORAGE_STATEMENTS) {
      await db.exec(statement);
    }
    const transactions = transactionPort(db);
    principals = new PgPrincipalRepo(transactions);
    roles = new PgRoleRepo(transactions);
    groups = new PgGroupRepo(transactions);
    resolver = new LiveAuthorityLayerResolver({ principals, roles, groups, now: () => NOW });
  });

  afterEach(async () => {
    await db.close();
  });

  it("resolves the caller layer from live role assignments and preserves domain", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "engineering-member",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [
        { action: "record.update", resourceType: "*", effect: "allow" },
        { action: "record.update", resourceType: "*", domain: "*", effect: "allow" },
        {
          action: "record.read",
          resourceType: "*",
          domain: "engineering",
          effect: "allow",
        },
      ],
    });
    await roles.assign({
      businessId: BUSINESS_ID,
      principalId: "user-1",
      roleId: "engineering-member",
    });

    const layer = await resolver.resolveCallerLayer(requestPrincipal());

    expect(layer).toEqual({
      name: "user",
      grants: [
        { action: "record.update", resourceType: "*", effect: "allow" },
        { action: "record.update", resourceType: "*", domain: "*", effect: "allow" },
        {
          action: "record.read",
          resourceType: "*",
          domain: "engineering",
          effect: "allow",
        },
      ],
    });
    expect(
      decideEffectivePermission([layer], { action: "record.update", resourceType: "ticket" }, NOW)
        .allowed
    ).toBe(true);
    expect(
      decideEffectivePermission(
        [layer],
        { action: "record.update", resourceType: "ticket", domain: "hr" },
        NOW
      ).allowed
    ).toBe(true);
    expect(
      decideEffectivePermission(
        [layer],
        { action: "record.read", resourceType: "ticket", domain: "engineering" },
        NOW
      ).allowed
    ).toBe(true);
    expect(
      decideEffectivePermission(
        [layer],
        { action: "record.read", resourceType: "ticket", domain: "hr" },
        NOW
      ).allowed
    ).toBe(false);
  });

  it("resolves the invoked Agent as its own live principal layer", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "hr-agent",
      kind: "agent",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "hr-agent-role",
      assignableTo: ["agent"],
      parentRoleIds: [],
      grants: [{ action: "record.update", resourceType: "*", domain: "hr", effect: "allow" }],
    });
    await roles.assign({
      businessId: BUSINESS_ID,
      principalId: "hr-agent",
      roleId: "hr-agent-role",
    });

    await expect(resolver.resolveAgentLayer(BUSINESS_ID, "hr-agent")).resolves.toEqual({
      name: "agent",
      grants: [{ action: "record.update", resourceType: "*", domain: "hr", effect: "allow" }],
    });
  });

  it("returns caller and Agent layers that narrow by intersection when consumed", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    await principals.put({
      businessId: BUSINESS_ID,
      id: "hr-agent",
      kind: "agent",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "engineering-user-role",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [
        {
          action: "record.update",
          resourceType: "*",
          domain: "engineering",
          effect: "allow",
        },
      ],
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "hr-agent-role",
      assignableTo: ["agent"],
      parentRoleIds: [],
      grants: [{ action: "record.update", resourceType: "*", domain: "hr", effect: "allow" }],
    });
    await roles.assign({
      businessId: BUSINESS_ID,
      principalId: "user-1",
      roleId: "engineering-user-role",
    });
    await roles.assign({
      businessId: BUSINESS_ID,
      principalId: "hr-agent",
      roleId: "hr-agent-role",
    });

    const layers = await resolver.resolveCallerAndAgentLayers(requestPrincipal(), "hr-agent");

    expect(
      decideEffectivePermission(
        layers,
        { action: "record.update", resourceType: "ticket", domain: "engineering" },
        NOW
      )
    ).toEqual({ allowed: false, reason: "no_matching_allow", deniedLayer: "agent" });
    expect(
      decideEffectivePermission(
        layers,
        { action: "record.update", resourceType: "ticket", domain: "hr" },
        NOW
      )
    ).toEqual({ allowed: false, reason: "no_matching_allow", deniedLayer: "user" });
  });

  it("resolves disabled or kind-mismatched principals to an empty layer", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "disabled",
    });
    await principals.put({
      businessId: BUSINESS_ID,
      id: "service-1",
      kind: "service",
      status: "active",
    });

    await expect(resolver.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
    await expect(
      resolver.resolveCallerLayer(
        requestPrincipal({ id: "service-1", kind: "user", userId: "service-1" })
      )
    ).resolves.toEqual({ name: "user", grants: [] });
  });

  async function seedUserAndGroupRole(
    roleGrants: {
      action: string;
      resourceType: string;
      domain?: string;
      effect: "allow" | "deny";
    }[],
    options: {
      assignableTo?: readonly ("user" | "agent")[];
      groupExpiresAt?: Date;
      membershipExpiresAt?: Date;
      groupRoleExpiresAt?: Date;
    } = {}
  ): Promise<void> {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "engineering",
      assignableTo: options.assignableTo ?? ["user"],
      parentRoleIds: [],
      grants: roleGrants,
    });
    await groups.putGroup({
      businessId: BUSINESS_ID,
      id: "engineers",
      ...(options.groupExpiresAt ? { expiresAt: options.groupExpiresAt } : {}),
    });
    await groups.addMember({
      businessId: BUSINESS_ID,
      groupId: "engineers",
      principalId: "user-1",
      ...(options.membershipExpiresAt ? { expiresAt: options.membershipExpiresAt } : {}),
    });
    await groups.assignRole({
      businessId: BUSINESS_ID,
      groupId: "engineers",
      roleId: "engineering",
      ...(options.groupRoleExpiresAt ? { expiresAt: options.groupRoleExpiresAt } : {}),
    });
  }

  it("expands a group-held Role into a member's layer even without a direct assignment", async () => {
    await seedUserAndGroupRole([
      { action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" },
    ]);

    const layer = await resolver.resolveCallerLayer(requestPrincipal());

    expect(layer).toEqual({
      name: "user",
      grants: [
        { action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" },
      ],
    });
  });

  it("unions direct assignments with group-held Roles and resolves a shared Role once", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "direct",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "record.update", resourceType: "*", domain: "hr", effect: "allow" }],
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "shared",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "*", domain: "hr", effect: "allow" }],
    });
    await roles.assign({ businessId: BUSINESS_ID, principalId: "user-1", roleId: "direct" });
    await roles.assign({ businessId: BUSINESS_ID, principalId: "user-1", roleId: "shared" });
    await groups.putGroup({ businessId: BUSINESS_ID, id: "engineers" });
    await groups.addMember({
      businessId: BUSINESS_ID,
      groupId: "engineers",
      principalId: "user-1",
    });
    await groups.assignRole({ businessId: BUSINESS_ID, groupId: "engineers", roleId: "shared" });

    const layer = await resolver.resolveCallerLayer(requestPrincipal());

    // `shared` is reached both directly and via the group; its single grant must appear once.
    expect(layer.grants).toEqual([
      { action: "record.update", resourceType: "*", domain: "hr", effect: "allow" },
      { action: "record.read", resourceType: "*", domain: "hr", effect: "allow" },
    ]);
  });

  it("contributes nothing when the group has expired", async () => {
    await seedUserAndGroupRole(
      [{ action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" }],
      { groupExpiresAt: new Date(NOW.getTime() - 1_000) }
    );

    await expect(resolver.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
  });

  it("contributes nothing when the membership has expired", async () => {
    await seedUserAndGroupRole(
      [{ action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" }],
      { membershipExpiresAt: new Date(NOW.getTime() - 1_000) }
    );

    await expect(resolver.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
  });

  it("contributes nothing when the group-held Role assignment has expired", async () => {
    await seedUserAndGroupRole(
      [{ action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" }],
      { groupRoleExpiresAt: new Date(NOW.getTime() - 1_000) }
    );

    await expect(resolver.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
  });

  it("fails closed to an empty layer when a group holds a Role the principal kind cannot be assigned", async () => {
    // The Role is agent-only; a user reaching it via a group would be an escalation past what a
    // direct assignment could grant, so the whole layer collapses.
    await seedUserAndGroupRole(
      [{ action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" }],
      { assignableTo: ["agent"] }
    );

    await expect(resolver.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
  });

  it("contributes nothing after a group-held Role is deleted (holding cascades away)", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "placeholder",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "*", domain: "eng", effect: "allow" }],
    });
    await groups.putGroup({ businessId: BUSINESS_ID, id: "engineers" });
    await groups.addMember({
      businessId: BUSINESS_ID,
      groupId: "engineers",
      principalId: "user-1",
    });
    await groups.assignRole({
      businessId: BUSINESS_ID,
      groupId: "engineers",
      roleId: "placeholder",
    });
    // Deleting the Role cascades its group holding away; the member's layer must go empty, never
    // resolve a dangling reference.
    await roles.deleteRole(BUSINESS_ID, "placeholder");

    await expect(resolver.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
  });

  it("ignores group-held Roles when no group repo is wired (fail closed)", async () => {
    const noGroups = new LiveAuthorityLayerResolver({ principals, roles, now: () => NOW });
    await seedUserAndGroupRole([
      { action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" },
    ]);

    await expect(noGroups.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
  });
});

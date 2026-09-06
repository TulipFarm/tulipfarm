import type { PGlite } from "@electric-sql/pglite";
import { decideEffectivePermission } from "@tulipfarm/authz";
import {
  AUTHORIZATION_STORAGE_STATEMENTS,
  PgGroupRepo,
  PgPrincipalRepo,
  PgRoleRepo,
  PgTeamRepo,
  TEAM_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../db";
import { makePglite } from "../test/pglite";
import { ApiAuthorityLayerResolver } from "./authority-layers";
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

describe("ApiAuthorityLayerResolver", () => {
  let db: PGlite;
  let principals: PgPrincipalRepo;
  let roles: PgRoleRepo;
  let groups: PgGroupRepo;
  let teams: PgTeamRepo;
  let resolver: ApiAuthorityLayerResolver;

  beforeEach(async () => {
    db = await makePglite();
    for (const statement of AUTHORIZATION_STORAGE_STATEMENTS) {
      await db.exec(statement);
    }
    for (const statement of TEAM_STORAGE_STATEMENTS) {
      await db.exec(statement);
    }
    const transactions = transactionPort(db);
    principals = new PgPrincipalRepo(transactions);
    roles = new PgRoleRepo(transactions);
    groups = new PgGroupRepo(transactions);
    teams = new PgTeamRepo(transactions);
    resolver = new ApiAuthorityLayerResolver({ principals, roles, groups, now: () => NOW });
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

  it("retains direct Principal assignment expiry as explanation evidence", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "temporary",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "ticket", effect: "allow" }],
    });
    await roles.assign({
      businessId: BUSINESS_ID,
      principalId: "user-1",
      roleId: "temporary",
      expiresAt: NOW,
    });

    const diagnosed = await resolver.diagnosePrincipalLayer("user", requestPrincipal());
    expect(diagnosed.layer.grants).toEqual([]);
    expect(diagnosed.evidence).toContainEqual({
      kind: "expiry",
      effect: "informational",
      sourcePrincipalId: "user-1",
      roleId: "temporary",
      expiresAt: NOW,
    });
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
    const noGroups = new ApiAuthorityLayerResolver({ principals, roles, now: () => NOW });
    await seedUserAndGroupRole([
      { action: "record.read", resourceType: "*", domain: "engineering", effect: "allow" },
    ]);

    await expect(noGroups.resolveCallerLayer(requestPrincipal())).resolves.toEqual({
      name: "user",
      grants: [],
    });
  });

  async function createTeam(
    id: string,
    slug: string,
    parentTeamId: string,
    displayName = slug
  ): Promise<void> {
    await teams.putTeam({
      id,
      businessId: BUSINESS_ID,
      slug,
      displayName,
      parentTeamId,
      status: "active",
      protected: false,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  async function addTeamMember(
    teamId: string,
    principalId: string,
    principalKind: "user" | "agent" = "user",
    expiresAt?: Date
  ): Promise<void> {
    await teams.putMembership({
      teamId,
      principalId,
      principalKind,
      level: "member",
      ...(expiresAt ? { expiresAt } : {}),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  async function resolvedRecordReadGrants() {
    return (await resolver.resolveCallerLayer(requestPrincipal())).grants.filter(
      (grant) => grant.action === "record.read" && grant.resourceType === "ticket"
    );
  }

  function enableTeamAuthority() {
    resolver = new ApiAuthorityLayerResolver({ principals, roles, groups, teams, now: () => NOW });
  }

  it("resolves parent authority downward, never child authority upward, with source evidence", async () => {
    enableTeamAuthority();
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    const everyone = await teams.ensureEveryone(BUSINESS_ID);
    const parentId = "00000000-0000-4000-8000-000000000101";
    const childId = "00000000-0000-4000-8000-000000000102";
    await createTeam(parentId, "engineering", everyone.id);
    await createTeam(childId, "platform", parentId);
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "team-reader",
      assignableTo: ["team"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "ticket", effect: "allow" }],
    });
    await teams.assignRole({ teamId: parentId, roleId: "team-reader", assignedAt: NOW });
    await addTeamMember(childId, "user-1");

    const diagnosed = await resolver.diagnosePrincipalLayer("user", requestPrincipal());
    expect(diagnosed.layer.grants).toContainEqual(
      expect.objectContaining({ action: "record.read", effect: "allow" })
    );
    expect(diagnosed.evidence).toContainEqual(
      expect.objectContaining({
        kind: "inherited_membership",
        sourceTeamId: parentId,
        pathTeamIds: [childId, parentId],
      })
    );

    await teams.removeMembership(childId, "user-1");
    await addTeamMember(parentId, "user-1");
    await teams.revokeRole(parentId, "team-reader");
    await teams.assignRole({ teamId: childId, roleId: "team-reader", assignedAt: NOW });
    await expect(resolvedRecordReadGrants()).resolves.toEqual([]);
  });

  it("combines multiple Teams and lets a Team deny beat every allow", async () => {
    enableTeamAuthority();
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    const everyone = await teams.ensureEveryone(BUSINESS_ID);
    const engineeringId = "00000000-0000-4000-8000-000000000111";
    const securityId = "00000000-0000-4000-8000-000000000112";
    await createTeam(engineeringId, "engineering", everyone.id);
    await createTeam(securityId, "security", everyone.id);
    await addTeamMember(engineeringId, "user-1");
    await addTeamMember(securityId, "user-1");
    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000211",
      teamId: engineeringId,
      action: "record.read",
      resourceType: "ticket",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000212",
      teamId: securityId,
      action: "record.read",
      resourceType: "ticket",
      effect: "deny",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const layer = await resolver.resolveCallerLayer(requestPrincipal());
    expect(
      decideEffectivePermission([layer], { action: "record.read", resourceType: "ticket" }, NOW)
    ).toEqual({ allowed: false, reason: "explicit_deny", deniedLayer: "user" });
  });

  it("applies expiry, move, archive, and revocation on the next resolution", async () => {
    enableTeamAuthority();
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    const everyone = await teams.ensureEveryone(BUSINESS_ID);
    const sourceId = "00000000-0000-4000-8000-000000000121";
    const otherId = "00000000-0000-4000-8000-000000000122";
    const childId = "00000000-0000-4000-8000-000000000123";
    await createTeam(sourceId, "source", everyone.id);
    await createTeam(otherId, "other", everyone.id);
    await createTeam(childId, "child", sourceId);
    await addTeamMember(childId, "user-1");
    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000221",
      teamId: sourceId,
      action: "record.read",
      resourceType: "ticket",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(resolvedRecordReadGrants()).resolves.toHaveLength(1);

    const child = await teams.getTeam(BUSINESS_ID, childId);
    if (!child) throw new Error("missing child");
    await teams.putTeam({
      ...child,
      parentTeamId: otherId,
      revision: 2,
      updatedAt: new Date(NOW.getTime() + 1),
    });
    await expect(resolvedRecordReadGrants()).resolves.toEqual([]);

    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000222",
      teamId: childId,
      action: "record.read",
      resourceType: "ticket",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(resolvedRecordReadGrants()).resolves.toHaveLength(1);
    await teams.deleteGrant(childId, "00000000-0000-4000-8000-000000000222");
    await expect(resolvedRecordReadGrants()).resolves.toEqual([]);

    const movedChild = await teams.getTeam(BUSINESS_ID, childId);
    if (!movedChild) throw new Error("missing moved child");
    await teams.putTeam({
      ...movedChild,
      status: "archived",
      archivedAt: NOW,
      revision: movedChild.revision + 1,
      updatedAt: new Date(NOW.getTime() + 2),
    });
    await expect(resolvedRecordReadGrants()).resolves.toEqual([]);

    const expiringId = "00000000-0000-4000-8000-000000000124";
    await createTeam(expiringId, "expiring", everyone.id);
    await addTeamMember(expiringId, "user-1", "user", NOW);
    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000223",
      teamId: expiringId,
      action: "record.read",
      resourceType: "ticket",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const expired = await resolver.diagnosePrincipalLayer("user", requestPrincipal());
    expect(
      expired.layer.grants.filter(
        (grant) => grant.action === "record.read" && grant.resourceType === "ticket"
      )
    ).toEqual([]);
    expect(expired.evidence).toContainEqual(
      expect.objectContaining({ kind: "expiry", sourceTeamId: expiringId })
    );
  });

  it("requires Team-targeted Roles and intersects Agent Team authority with the caller", async () => {
    enableTeamAuthority();
    await principals.put({
      businessId: BUSINESS_ID,
      id: "user-1",
      kind: "user",
      status: "active",
    });
    await principals.put({
      businessId: BUSINESS_ID,
      id: "agent-1",
      kind: "agent",
      status: "active",
    });
    const everyone = await teams.ensureEveryone(BUSINESS_ID);
    const callersId = "00000000-0000-4000-8000-000000000131";
    const agentsId = "00000000-0000-4000-8000-000000000132";
    await createTeam(callersId, "callers", everyone.id);
    await createTeam(agentsId, "agents", everyone.id);
    await addTeamMember(callersId, "user-1");
    await addTeamMember(agentsId, "agent-1", "agent");
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "wrong-target",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "ticket", effect: "allow" }],
    });
    await expect(
      teams.assignRole({ teamId: callersId, roleId: "wrong-target", assignedAt: NOW })
    ).rejects.toThrow(/not assignable to Teams/i);
    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000231",
      teamId: callersId,
      action: "*",
      resourceType: "*",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000232",
      teamId: agentsId,
      action: "record.read",
      resourceType: "ticket",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const layers = await resolver.resolveCallerAndAgentLayers(requestPrincipal(), "agent-1");
    expect(
      decideEffectivePermission(layers, { action: "record.read", resourceType: "ticket" }, NOW)
        .allowed
    ).toBe(true);
    expect(
      decideEffectivePermission(layers, { action: "record.write", resourceType: "ticket" }, NOW)
    ).toEqual({ allowed: false, reason: "no_matching_allow", deniedLayer: "agent" });
  });
});

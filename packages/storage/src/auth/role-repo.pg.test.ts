import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { PgGroupRepo } from "./group-repo";
import { PgPrincipalRepo } from "./principal-repo";
import { AUTHORIZATION_STORAGE_STATEMENTS, PgRoleRepo, type RoleRecord } from "./role-repo";

const NOW = new Date("2026-08-12T12:00:00Z");

function roleRecord(overrides: Partial<RoleRecord> = {}): RoleRecord {
  return {
    id: "role-1",
    businessId: "business-1",
    assignableTo: ["user"],
    parentRoleIds: ["parent-role"],
    grants: [
      {
        action: "record.read",
        resourceType: "invoice",
        domain: "finance",
        recordSelector: "invoice-1",
        fieldSelector: ["total"],
        dataClass: "confidential",
        destination: "web",
        conditions: { department: "finance" },
        effect: "allow",
        expiresAt: new Date("2026-08-13T12:00:00Z"),
      },
    ],
    ...overrides,
  };
}

describe("PgRoleRepo", () => {
  let database: PGlite;
  let roles: PgRoleRepo;
  let groups: PgGroupRepo;
  let principals: PgPrincipalRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of AUTHORIZATION_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    roles = new PgRoleRepo(transactions);
    groups = new PgGroupRepo(transactions);
    principals = new PgPrincipalRepo(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("TRUNCATE TABLE principals, roles, principal_groups CASCADE");
    await principals.put({
      businessId: "business-1",
      id: "principal-1",
      kind: "user",
      status: "active",
    });
  });

  it("round-trips a role with grants, domain, parents, conditions, and expiry", async () => {
    const record = roleRecord();
    await roles.putRole(record);

    await expect(roles.getRole("business-1", "role-1")).resolves.toEqual(record);
    await expect(roles.listRoles("business-1")).resolves.toEqual([record]);
  });

  it("replaces parent and grant rows when a role is updated", async () => {
    await roles.putRole(roleRecord());
    await roles.putRole(
      roleRecord({
        parentRoleIds: [],
        grants: [{ action: "record.write", resourceType: "invoice", effect: "deny" }],
      })
    );

    await expect(roles.getRole("business-1", "role-1")).resolves.toMatchObject({
      parentRoleIds: [],
      grants: [{ action: "record.write", resourceType: "invoice", effect: "deny" }],
    });
  });

  it("lists only unexpired direct role assignments", async () => {
    await roles.putRole(roleRecord());
    await roles.putRole(roleRecord({ id: "role-2", parentRoleIds: [], grants: [] }));
    await roles.assign({ businessId: "business-1", principalId: "principal-1", roleId: "role-1" });
    await roles.assign({
      businessId: "business-1",
      principalId: "principal-1",
      roleId: "role-2",
      expiresAt: new Date(NOW.getTime() - 1_000),
    });

    await expect(roles.listAssignments("business-1", "principal-1", NOW)).resolves.toEqual([
      { businessId: "business-1", principalId: "principal-1", roleId: "role-1" },
    ]);
  });

  it("persists group membership as principal-to-group assignment", async () => {
    await groups.putGroup({ businessId: "business-1", id: "owners" });
    await groups.addMember({
      businessId: "business-1",
      principalId: "principal-1",
      groupId: "owners",
    });

    await expect(groups.getGroup("business-1", "owners")).resolves.toEqual({
      businessId: "business-1",
      id: "owners",
    });
    await expect(groups.listMemberships("business-1", "principal-1", NOW)).resolves.toEqual([
      { businessId: "business-1", principalId: "principal-1", groupId: "owners" },
    ]);
  });

  it("deletes a role and cascades its assignments", async () => {
    await roles.putRole(roleRecord());
    await roles.assign({ businessId: "business-1", principalId: "principal-1", roleId: "role-1" });

    await roles.deleteRole("business-1", "role-1");

    await expect(roles.getRole("business-1", "role-1")).resolves.toBeUndefined();
    await expect(roles.listAssignments("business-1", "principal-1", NOW)).resolves.toEqual([]);
  });

  it("revokes a single assignment", async () => {
    await roles.putRole(roleRecord());
    await roles.putRole(roleRecord({ id: "role-2", parentRoleIds: [], grants: [] }));
    await roles.assign({ businessId: "business-1", principalId: "principal-1", roleId: "role-1" });
    await roles.assign({ businessId: "business-1", principalId: "principal-1", roleId: "role-2" });

    await roles.revokeAssignment("business-1", "principal-1", "role-1");

    await expect(roles.listAssignments("business-1", "principal-1", NOW)).resolves.toEqual([
      { businessId: "business-1", principalId: "principal-1", roleId: "role-2" },
    ]);
  });

  it("lists assignees of a role, unexpired only", async () => {
    await principals.put({
      businessId: "business-1",
      id: "principal-2",
      kind: "user",
      status: "active",
    });
    await principals.put({
      businessId: "business-1",
      id: "principal-3",
      kind: "user",
      status: "active",
    });
    await roles.putRole(roleRecord());
    await roles.assign({ businessId: "business-1", principalId: "principal-1", roleId: "role-1" });
    await roles.assign({ businessId: "business-1", principalId: "principal-2", roleId: "role-1" });
    await roles.assign({
      businessId: "business-1",
      principalId: "principal-3",
      roleId: "role-1",
      expiresAt: new Date(NOW.getTime() - 1_000),
    });

    const assignees = await roles.listAssignees("business-1", "role-1", NOW);
    expect(assignees.map((a) => a.principalId).sort()).toEqual(["principal-1", "principal-2"]);
  });

  it("lists groups, members, and removes a member", async () => {
    await principals.put({
      businessId: "business-1",
      id: "principal-2",
      kind: "user",
      status: "active",
    });
    await groups.putGroup({ businessId: "business-1", id: "owners" });
    await groups.putGroup({ businessId: "business-1", id: "engineering" });
    await groups.addMember({
      businessId: "business-1",
      principalId: "principal-1",
      groupId: "owners",
    });
    await groups.addMember({
      businessId: "business-1",
      principalId: "principal-2",
      groupId: "owners",
    });

    expect((await groups.listGroups("business-1")).map((g) => g.id)).toEqual([
      "engineering",
      "owners",
    ]);
    expect(
      (await groups.listMembers("business-1", "owners", NOW)).map((m) => m.principalId)
    ).toEqual(["principal-1", "principal-2"]);

    await groups.removeMember("business-1", "owners", "principal-1");
    expect(
      (await groups.listMembers("business-1", "owners", NOW)).map((m) => m.principalId)
    ).toEqual(["principal-2"]);
  });

  it("holds, lists, and revokes roles for a group; never lists an expired holding", async () => {
    await groups.putGroup({ businessId: "business-1", id: "owners" });
    await roles.putRole(roleRecord());
    await roles.putRole(roleRecord({ id: "role-2", parentRoleIds: [], grants: [] }));
    await roles.putRole(roleRecord({ id: "role-3", parentRoleIds: [], grants: [] }));
    await groups.assignRole({ businessId: "business-1", groupId: "owners", roleId: "role-1" });
    await groups.assignRole({ businessId: "business-1", groupId: "owners", roleId: "role-2" });
    await groups.assignRole({
      businessId: "business-1",
      groupId: "owners",
      roleId: "role-3",
      expiresAt: new Date(NOW.getTime() - 1_000),
    });

    expect(
      (await groups.listGroupRoles("business-1", "owners", NOW)).map((r) => r.roleId).sort()
    ).toEqual(["role-1", "role-2"]);

    await groups.revokeRole("business-1", "owners", "role-1");
    expect((await groups.listGroupRoles("business-1", "owners", NOW)).map((r) => r.roleId)).toEqual(
      ["role-2"]
    );
  });

  it("cascades group-role holdings when the role or group is deleted", async () => {
    await groups.putGroup({ businessId: "business-1", id: "owners" });
    await roles.putRole(roleRecord());
    await groups.assignRole({ businessId: "business-1", groupId: "owners", roleId: "role-1" });

    await roles.deleteRole("business-1", "role-1");
    await expect(groups.listGroupRoles("business-1", "owners", NOW)).resolves.toEqual([]);
  });

  it("deleteGroup removes the group and cascades its members and held roles", async () => {
    await groups.putGroup({ businessId: "business-1", id: "owners" });
    await roles.putRole(roleRecord());
    await groups.addMember({
      businessId: "business-1",
      principalId: "principal-1",
      groupId: "owners",
    });
    await groups.assignRole({ businessId: "business-1", groupId: "owners", roleId: "role-1" });

    await groups.deleteGroup("business-1", "owners");

    expect(await groups.getGroup("business-1", "owners")).toBeUndefined();
    expect(await groups.listMembers("business-1", "owners", NOW)).toEqual([]);
    expect(await groups.listMemberships("business-1", "principal-1", NOW)).toEqual([]);
    expect(await groups.listGroupRoles("business-1", "owners", NOW)).toEqual([]);
    // The principal and role outlive the group they were connected through.
    expect(await roles.getRole("business-1", "role-1")).not.toBeUndefined();
    expect(await principals.get("business-1", "principal-1")).not.toBeUndefined();
  });

  it("refuses a group-role holding for a role that does not exist", async () => {
    await groups.putGroup({ businessId: "business-1", id: "owners" });
    await expect(
      groups.assignRole({ businessId: "business-1", groupId: "owners", roleId: "missing" })
    ).rejects.toThrow();
  });

  it("rejects assignments for principals that do not exist", async () => {
    await roles.putRole(roleRecord());

    await expect(
      roles.assign({
        businessId: "business-1",
        principalId: "missing",
        roleId: "role-1",
      })
    ).rejects.toThrow();
  });
});

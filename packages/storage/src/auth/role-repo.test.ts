import { describe, expect, it } from "vitest";
import {
  type GroupMembershipRecord,
  type GroupRecord,
  type GroupRoleAssignmentRecord,
  InMemoryGroupRepo,
  InMemoryRoleRepo,
  type RoleAssignmentRecord,
  type RoleRecord,
} from "./role-repo";

const NOW = new Date("2026-07-23T12:00:00Z");

function roleRecord(overrides: Partial<RoleRecord> = {}): RoleRecord {
  return {
    id: "role-1",
    businessId: "business-1",
    assignableTo: ["user"],
    parentRoleIds: [],
    grants: [{ action: "record.read", resourceType: "invoice", effect: "allow" }],
    ...overrides,
  };
}

function assignment(overrides: Partial<RoleAssignmentRecord> = {}): RoleAssignmentRecord {
  return {
    principalId: "principal-1",
    roleId: "role-1",
    businessId: "business-1",
    ...overrides,
  };
}

describe("InMemoryRoleRepo", () => {
  it("round-trips a role record and returns undefined for an unknown id", async () => {
    const repo = new InMemoryRoleRepo();
    const record = roleRecord();
    await repo.putRole(record);
    expect(await repo.getRole("business-1", "role-1")).toEqual(record);
    expect(await repo.listRoles("business-1")).toEqual([record]);
    expect(await repo.getRole("business-1", "missing")).toBeUndefined();
  });

  it("lists a principal's assignments", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.assign(assignment());
    await repo.assign(assignment({ roleId: "role-2" }));
    await repo.assign(assignment({ principalId: "principal-2", roleId: "role-3" }));
    const listed = await repo.listAssignments("business-1", "principal-1", NOW);
    expect(listed.map((a) => a.roleId).sort()).toEqual(["role-1", "role-2"]);
  });

  it("never lists an expired assignment", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.assign(assignment({ expiresAt: new Date(NOW.getTime() - 1_000) }));
    expect(await repo.listAssignments("business-1", "principal-1", NOW)).toEqual([]);
  });

  it("isolates roles and assignments by business", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.putRole(roleRecord({ businessId: "business-1", assignableTo: ["user"] }));
    await repo.putRole(roleRecord({ businessId: "business-2", assignableTo: ["agent"] }));
    await repo.assign(assignment({ businessId: "business-2" }));

    await expect(repo.getRole("business-1", "role-1")).resolves.toMatchObject({
      assignableTo: ["user"],
    });
    await expect(repo.getRole("business-2", "role-1")).resolves.toMatchObject({
      assignableTo: ["agent"],
    });
    expect(await repo.listAssignments("business-1", "principal-1", NOW)).toEqual([]);
  });

  it("upserts a duplicate assignment rather than duplicating the row", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.assign(assignment());
    await repo.assign(assignment({ expiresAt: new Date(NOW.getTime() + 10_000) }));
    const listed = await repo.listAssignments("business-1", "principal-1", NOW);
    expect(listed).toHaveLength(1);
    expect(listed[0].expiresAt).toEqual(new Date(NOW.getTime() + 10_000));
  });

  it("revokes an assignment and deletes a role's assignments on deleteRole", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.putRole(roleRecord());
    await repo.assign(assignment());
    await repo.assign(assignment({ roleId: "role-2" }));

    await repo.revokeAssignment("business-1", "principal-1", "role-1");
    expect(
      (await repo.listAssignments("business-1", "principal-1", NOW)).map((a) => a.roleId)
    ).toEqual(["role-2"]);

    await repo.deleteRole("business-1", "role-2");
    expect(await repo.getRole("business-1", "role-2")).toBeUndefined();
    expect(await repo.listAssignments("business-1", "principal-1", NOW)).toEqual([]);
  });

  it("lists assignees of a role, unexpired only", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.assign(assignment({ principalId: "principal-1" }));
    await repo.assign(assignment({ principalId: "principal-2" }));
    await repo.assign(
      assignment({ principalId: "principal-3", expiresAt: new Date(NOW.getTime() - 1_000) })
    );

    const assignees = await repo.listAssignees("business-1", "role-1", NOW);
    expect(assignees.map((a) => a.principalId).sort()).toEqual(["principal-1", "principal-2"]);
  });
});

function membership(overrides: Partial<GroupMembershipRecord> = {}): GroupMembershipRecord {
  return {
    principalId: "principal-1",
    groupId: "owners",
    businessId: "business-1",
    ...overrides,
  };
}

function groupRole(overrides: Partial<GroupRoleAssignmentRecord> = {}): GroupRoleAssignmentRecord {
  return {
    groupId: "owners",
    roleId: "role-1",
    businessId: "business-1",
    ...overrides,
  };
}

describe("InMemoryGroupRepo", () => {
  it("round-trips a group and lists groups by business", async () => {
    const repo = new InMemoryGroupRepo();
    const record: GroupRecord = { businessId: "business-1", id: "owners" };
    await repo.putGroup(record);
    await repo.putGroup({ businessId: "business-2", id: "elsewhere" });

    expect(await repo.getGroup("business-1", "owners")).toEqual(record);
    expect(await repo.listGroups("business-1")).toEqual([record]);
  });

  it("adds, lists, and removes members; upserts a duplicate", async () => {
    const repo = new InMemoryGroupRepo();
    await repo.addMember(membership());
    await repo.addMember(membership({ expiresAt: new Date(NOW.getTime() + 10_000) }));
    await repo.addMember(membership({ principalId: "principal-2" }));

    expect(await repo.listMembers("business-1", "owners", NOW)).toHaveLength(2);
    expect(await repo.listMemberships("business-1", "principal-1", NOW)).toHaveLength(1);

    await repo.removeMember("business-1", "owners", "principal-1");
    expect((await repo.listMembers("business-1", "owners", NOW)).map((m) => m.principalId)).toEqual(
      ["principal-2"]
    );
  });

  it("never lists an expired membership", async () => {
    const repo = new InMemoryGroupRepo();
    await repo.addMember(membership({ expiresAt: new Date(NOW.getTime() - 1_000) }));
    expect(await repo.listMemberships("business-1", "principal-1", NOW)).toEqual([]);
    expect(await repo.listMembers("business-1", "owners", NOW)).toEqual([]);
  });

  it("holds, lists, and revokes roles for a group; never lists an expired holding", async () => {
    const repo = new InMemoryGroupRepo();
    await repo.assignRole(groupRole());
    await repo.assignRole(groupRole({ roleId: "role-2" }));
    await repo.assignRole(
      groupRole({ roleId: "role-3", expiresAt: new Date(NOW.getTime() - 1_000) })
    );

    expect(
      (await repo.listGroupRoles("business-1", "owners", NOW)).map((r) => r.roleId).sort()
    ).toEqual(["role-1", "role-2"]);

    await repo.revokeRole("business-1", "owners", "role-1");
    expect((await repo.listGroupRoles("business-1", "owners", NOW)).map((r) => r.roleId)).toEqual([
      "role-2",
    ]);
  });

  it("upserts a duplicate group-role holding rather than duplicating it", async () => {
    const repo = new InMemoryGroupRepo();
    await repo.assignRole(groupRole());
    await repo.assignRole(groupRole({ expiresAt: new Date(NOW.getTime() + 10_000) }));
    const held = await repo.listGroupRoles("business-1", "owners", NOW);
    expect(held).toHaveLength(1);
    expect(held[0].expiresAt).toEqual(new Date(NOW.getTime() + 10_000));
  });

  it("deleteGroup removes the group and cascades its members and held roles", async () => {
    const repo = new InMemoryGroupRepo();
    await repo.putGroup({ businessId: "business-1", id: "owners" });
    await repo.addMember(membership());
    await repo.assignRole(groupRole());

    await repo.deleteGroup("business-1", "owners");

    expect(await repo.getGroup("business-1", "owners")).toBeUndefined();
    expect(await repo.listMembers("business-1", "owners", NOW)).toEqual([]);
    expect(await repo.listMemberships("business-1", "principal-1", NOW)).toEqual([]);
    expect(await repo.listGroupRoles("business-1", "owners", NOW)).toEqual([]);
  });

  it("deleteGroup is a no-op for an unknown group and isolates by business", async () => {
    const repo = new InMemoryGroupRepo();
    await repo.putGroup({ businessId: "business-1", id: "owners" });
    await repo.putGroup({ businessId: "business-2", id: "owners" });

    await repo.deleteGroup("business-1", "missing");
    await repo.deleteGroup("business-1", "owners");

    expect(await repo.getGroup("business-1", "owners")).toBeUndefined();
    expect(await repo.getGroup("business-2", "owners")).toEqual({
      businessId: "business-2",
      id: "owners",
    });
  });
});

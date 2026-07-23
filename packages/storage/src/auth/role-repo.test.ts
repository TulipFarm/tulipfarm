import { describe, expect, it } from "vitest";
import { InMemoryRoleRepo, type RoleAssignmentRecord, type RoleRecord } from "./role-repo";

function roleRecord(overrides: Partial<RoleRecord> = {}): RoleRecord {
  return {
    id: "role-1",
    businessId: "business-1",
    assignableTo: "user",
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
    expect(await repo.getRole("role-1")).toEqual(record);
    expect(await repo.getRole("missing")).toBeUndefined();
  });

  it("lists a principal's assignments", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.assign(assignment());
    await repo.assign(assignment({ roleId: "role-2" }));
    await repo.assign(assignment({ principalId: "principal-2", roleId: "role-3" }));
    const listed = await repo.listAssignments("principal-1");
    expect(listed.map((a) => a.roleId).sort()).toEqual(["role-1", "role-2"]);
  });

  it("never lists an expired assignment", async () => {
    const repo = new InMemoryRoleRepo();
    await repo.assign(assignment({ expiresAt: new Date(Date.now() - 1_000) }));
    expect(await repo.listAssignments("principal-1")).toEqual([]);
  });
});

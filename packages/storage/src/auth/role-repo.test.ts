import { describe, expect, it } from "vitest";
import { InMemoryRoleRepo, type RoleAssignmentRecord, type RoleRecord } from "./role-repo";

const NOW = new Date("2026-07-23T12:00:00Z");

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
    expect(await repo.getRole("business-1", "role-1")).toEqual(record);
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
    await repo.putRole(roleRecord({ businessId: "business-1", assignableTo: "user" }));
    await repo.putRole(roleRecord({ businessId: "business-2", assignableTo: "agent" }));
    await repo.assign(assignment({ businessId: "business-2" }));

    await expect(repo.getRole("business-1", "role-1")).resolves.toMatchObject({
      assignableTo: "user",
    });
    await expect(repo.getRole("business-2", "role-1")).resolves.toMatchObject({
      assignableTo: "agent",
    });
    expect(await repo.listAssignments("business-1", "principal-1", NOW)).toEqual([]);
  });
});

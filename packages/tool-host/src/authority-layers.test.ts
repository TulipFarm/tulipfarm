import {
  InMemoryGroupRepo,
  InMemoryPrincipalRepo,
  InMemoryRoleRepo,
  InMemoryTeamRepo,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { collectHeldRoleIds } from "./authority-layers";

const BUSINESS_ID = "business-1";
const PRINCIPAL_ID = "person-1";
const NOW = new Date("2026-09-05T12:00:00Z");

describe("collectHeldRoleIds", () => {
  it("revokes a migrated legacy group Role when its Team membership is removed", async () => {
    const principals = new InMemoryPrincipalRepo();
    const roles = new InMemoryRoleRepo();
    const groups = new InMemoryGroupRepo();
    const teams = new InMemoryTeamRepo();

    await principals.put({
      businessId: BUSINESS_ID,
      id: PRINCIPAL_ID,
      kind: "user",
      status: "active",
    });
    await roles.putRole({
      businessId: BUSINESS_ID,
      id: "reader",
      assignableTo: ["team"],
      parentRoleIds: [],
      grants: [],
    });
    await groups.putGroup({ businessId: BUSINESS_ID, id: "legacy-readers" });
    await groups.addMember({
      businessId: BUSINESS_ID,
      groupId: "legacy-readers",
      principalId: PRINCIPAL_ID,
    });
    await groups.assignRole({
      businessId: BUSINESS_ID,
      groupId: "legacy-readers",
      roleId: "reader",
    });

    const everyone = await teams.ensureEveryone(BUSINESS_ID);
    const migratedTeamId = "00000000-0000-4000-8000-000000000001";
    await teams.putTeam({
      id: migratedTeamId,
      businessId: BUSINESS_ID,
      slug: "legacy-readers",
      displayName: "Legacy Readers",
      parentTeamId: everyone.id,
      status: "active",
      protected: false,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await teams.putMembership({
      teamId: migratedTeamId,
      principalId: PRINCIPAL_ID,
      principalKind: "user",
      level: "member",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await teams.assignRole({ teamId: migratedTeamId, roleId: "reader", assignedAt: NOW });

    const repos = { principals, roles, groups, teams };
    await expect(collectHeldRoleIds(repos, BUSINESS_ID, PRINCIPAL_ID, NOW)).resolves.toEqual([
      "reader",
    ]);

    await teams.removeMembership(migratedTeamId, PRINCIPAL_ID);

    await expect(collectHeldRoleIds(repos, BUSINESS_ID, PRINCIPAL_ID, NOW)).resolves.toEqual([]);
  });
});

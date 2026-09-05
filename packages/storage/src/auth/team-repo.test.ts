import { describe, expect, it } from "vitest";
import {
  EVERYONE_TEAM_SLUG,
  InMemoryTeamRepo,
  type TeamMembershipRecord,
  type TeamRecord,
} from "./team-repo";

const BUSINESS_ID = "business-1";
const NOW = new Date("2026-09-05T12:00:00Z");

function team(
  id: string,
  slug: string,
  displayName: string,
  parentTeamId: string,
  overrides: Partial<TeamRecord> = {}
): TeamRecord {
  return {
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
    ...overrides,
  };
}

function membership(overrides: Partial<TeamMembershipRecord> = {}): TeamMembershipRecord {
  return {
    teamId: "00000000-0000-4000-8000-000000000001",
    principalId: "person-1",
    principalKind: "user",
    level: "member",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("InMemoryTeamRepo", () => {
  it("creates one protected Everyone root per business", async () => {
    const repo = new InMemoryTeamRepo();
    const first = await repo.ensureEveryone(BUSINESS_ID);
    const second = await repo.ensureEveryone(BUSINESS_ID);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      slug: EVERYONE_TEAM_SLUG,
      displayName: "Everyone",
      protected: true,
      status: "active",
    });
    expect(first.parentTeamId).toBeUndefined();
  });

  it("enforces sibling names, cycles, and a maximum depth of ten", async () => {
    const repo = new InMemoryTeamRepo();
    const root = await repo.ensureEveryone(BUSINESS_ID);
    let parentId = root.id;

    for (let depth = 2; depth <= 10; depth += 1) {
      const id = `00000000-0000-4000-8000-${String(depth).padStart(12, "0")}`;
      await repo.putTeam(team(id, `level-${depth}`, `Level ${depth}`, parentId));
      parentId = id;
    }

    await expect(
      repo.putTeam(team("00000000-0000-4000-8000-000000000011", "level-11", "Level 11", parentId))
    ).rejects.toThrow("10 levels");

    const firstChild = "00000000-0000-4000-8000-000000000002";
    await expect(
      repo.putTeam(
        team(firstChild, "level-2", "Level 2", parentId, {
          revision: 2,
          updatedAt: new Date(NOW.getTime() + 1_000),
        })
      )
    ).rejects.toThrow("cycle");
    await expect(
      repo.putTeam(
        team("00000000-0000-4000-8000-000000000099", "duplicate-name", "LEVEL 2", root.id)
      )
    ).rejects.toThrow("display name");
  });

  it("reserves deleted slugs and retains archive state", async () => {
    const repo = new InMemoryTeamRepo();
    const root = await repo.ensureEveryone(BUSINESS_ID);
    const original = team("00000000-0000-4000-8000-000000000020", "finance", "Finance", root.id);
    await repo.putTeam(original);
    await repo.putTeam({
      ...original,
      status: "archived",
      revision: 2,
      updatedAt: new Date(NOW.getTime() + 1_000),
      archivedAt: new Date(NOW.getTime() + 1_000),
    });

    expect(await repo.getTeam(BUSINESS_ID, original.id)).toMatchObject({
      status: "archived",
      revision: 2,
    });

    await repo.deleteTeam(BUSINESS_ID, original.id);
    await expect(
      repo.putTeam(team("00000000-0000-4000-8000-000000000021", "finance", "New Finance", root.id))
    ).rejects.toThrow("reserved");
  });

  it("matches lifecycle reference guards without scanning records", async () => {
    let hasAssetReference = true;
    let hasPendingApproval = false;
    const repo = new InMemoryTeamRepo({
      hasAssetReference: () => hasAssetReference,
      hasPendingApproval: () => hasPendingApproval,
    });
    const root = await repo.ensureEveryone(BUSINESS_ID);
    const record = team("00000000-0000-4000-8000-000000000022", "lifecycle", "Lifecycle", root.id);
    await repo.putTeam(record);

    await expect(
      repo.transitionLifecycle({
        businessId: BUSINESS_ID,
        teamId: record.id,
        action: "archive",
        expectedRevision: record.revision,
        now: NOW,
      })
    ).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/asset ownership/i) });

    hasAssetReference = false;
    hasPendingApproval = true;
    await expect(
      repo.transitionLifecycle({
        businessId: BUSINESS_ID,
        teamId: record.id,
        action: "archive",
        expectedRevision: record.revision,
        now: NOW,
      })
    ).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/Approvals/i) });

    hasPendingApproval = false;
    await expect(
      repo.transitionLifecycle({
        businessId: BUSINESS_ID,
        teamId: record.id,
        action: "archive",
        expectedRevision: record.revision,
        now: NOW,
      })
    ).resolves.toMatchObject({ ok: true, team: { status: "archived" } });
  });

  it("persists membership expiry, Role assignments, grants, and delegation", async () => {
    const repo = new InMemoryTeamRepo();
    const root = await repo.ensureEveryone(BUSINESS_ID);
    const record = team(
      "00000000-0000-4000-8000-000000000001",
      "engineering",
      "Engineering",
      root.id
    );
    await repo.putTeam(record);
    await repo.putLegacyGroupMapping(BUSINESS_ID, "engineering-group", record.id);
    await repo.putMembership(membership());
    await repo.putMembership(
      membership({
        principalId: "agent-1",
        principalKind: "agent",
        expiresAt: new Date(NOW.getTime() - 1),
      })
    );
    await expect(
      repo.putMembership(
        membership({ principalId: "agent-2", principalKind: "agent", level: "admin" })
      )
    ).rejects.toThrow("Only people");

    await repo.assignRole({ teamId: record.id, roleId: "reader", assignedAt: NOW });
    await repo.putGrant({
      id: "00000000-0000-4000-8000-000000000030",
      teamId: record.id,
      action: "record.read",
      resourceType: "ticket",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repo.putDelegationPolicy({
      teamId: record.id,
      allowedRoleIds: ["reader"],
      allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
      revision: 1,
      updatedAt: NOW,
    });

    expect(await repo.listMemberships(record.id, NOW)).toHaveLength(1);
    expect(await repo.resolveLegacyGroupId(BUSINESS_ID, "engineering-group")).toBe(record.id);
    expect(await repo.listRoleAssignments(record.id, NOW)).toHaveLength(1);
    expect(await repo.listGrants(record.id, NOW)).toHaveLength(1);
    expect(await repo.getDelegationPolicy(record.id)).toMatchObject({
      allowedRoleIds: ["reader"],
      revision: 1,
    });

    await repo.putTeam({
      ...record,
      status: "archived",
      archivedAt: NOW,
      revision: 2,
      updatedAt: NOW,
    });
    expect(await repo.listMemberships(record.id, NOW)).toEqual([]);
    expect(await repo.listRoleAssignments(record.id, NOW)).toEqual([]);
    expect(await repo.listGrants(record.id, NOW)).toEqual([]);
    expect(await repo.listAllMemberships(record.id)).toHaveLength(2);

    await repo.removeMembership(record.id, "person-1");
    await repo.revokeRole(record.id, "reader");
    await repo.deleteGrant(record.id, "00000000-0000-4000-8000-000000000030");
    expect(await repo.listMemberships(record.id, NOW)).toEqual([]);
    expect(await repo.listRoleAssignments(record.id, NOW)).toEqual([]);
    expect(await repo.listGrants(record.id, NOW)).toEqual([]);
  });

  it("applies membership and leave-request revisions with compare-and-swap semantics", async () => {
    const repo = new InMemoryTeamRepo();
    const root = await repo.ensureEveryone(BUSINESS_ID);
    const record = team("00000000-0000-4000-8000-000000000040", "support", "Support", root.id);
    await repo.putTeam(record);
    const original = membership({ teamId: record.id });
    await repo.putMembership(original);
    await repo.putMembership({ ...original, level: "admin", revision: 2 });
    await expect(repo.putMembership({ ...original, revision: 2 })).rejects.toThrow(
      "revision conflict"
    );
    await expect(repo.removeMembership(record.id, original.principalId, 1)).rejects.toThrow(
      "revision conflict"
    );

    const request = {
      id: "00000000-0000-4000-8000-000000000041",
      teamId: record.id,
      principalId: original.principalId,
      status: "pending" as const,
      revision: 1,
      requestedAt: NOW,
    };
    await repo.putLeaveRequest(request);
    await repo.putLeaveRequest({
      ...request,
      status: "rejected",
      revision: 2,
      decidedAt: NOW,
      decidedByPrincipalId: "person-2",
    });
    await expect(
      repo.putLeaveRequest({
        ...request,
        status: "approved",
        revision: 2,
        decidedAt: NOW,
        decidedByPrincipalId: "person-2",
      })
    ).rejects.toThrow("revision conflict");
  });

  it("applies delegation-policy revisions with compare-and-swap semantics", async () => {
    const repo = new InMemoryTeamRepo();
    const root = await repo.ensureEveryone(BUSINESS_ID);
    const record = team(
      "00000000-0000-4000-8000-000000000050",
      "operations",
      "Operations",
      root.id
    );
    await repo.putTeam(record);
    await repo.putDelegationPolicy({
      teamId: record.id,
      allowedRoleIds: ["reader"],
      allowedGrantScopes: [],
      revision: 1,
      updatedAt: NOW,
    });

    const writerUpdate = {
      teamId: record.id,
      allowedRoleIds: ["writer"],
      allowedGrantScopes: [],
      revision: 2,
      updatedAt: new Date(NOW.getTime() + 1),
    };
    const readerUpdate = {
      ...writerUpdate,
      allowedRoleIds: ["reader"],
      updatedAt: new Date(NOW.getTime() + 2),
    };
    const results = await Promise.allSettled([
      repo.putDelegationPolicy(writerUpdate),
      repo.putDelegationPolicy(readerUpdate),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const persisted = await repo.getDelegationPolicy(record.id);
    expect(persisted?.revision).toBe(2);
    expect([["writer"], ["reader"]]).toContainEqual(persisted?.allowedRoleIds);
  });

  it("promotes one existing direct human member during concurrent admin recovery", async () => {
    const repo = new InMemoryTeamRepo();
    const root = await repo.ensureEveryone(BUSINESS_ID);
    const record = team("00000000-0000-4000-8000-000000000060", "recovery", "Recovery", root.id);
    await repo.putTeam(record);
    for (const principalId of ["person-1", "person-2"]) {
      await repo.putMembership(membership({ teamId: record.id, principalId }));
    }

    const results = await Promise.allSettled(
      ["person-1", "person-2"].map((principalId) =>
        repo.recoverAdmin({
          businessId: BUSINESS_ID,
          teamId: record.id,
          principalId,
          teamRevision: record.revision,
          now: NOW,
        })
      )
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects a move confirmation when the recomputed impact changed", async () => {
    const repo = new InMemoryTeamRepo();
    const root = await repo.ensureEveryone(BUSINESS_ID);
    const firstParent = team(
      "00000000-0000-4000-8000-000000000070",
      "first-parent",
      "First parent",
      root.id
    );
    const secondParent = team(
      "00000000-0000-4000-8000-000000000071",
      "second-parent",
      "Second parent",
      root.id
    );
    const moved = team("00000000-0000-4000-8000-000000000072", "moved", "Moved", firstParent.id);
    await repo.putTeam(firstParent);
    await repo.putTeam(secondParent);
    await repo.putTeam(moved);
    const bindingEvidenceDigest = await repo.getMoveBindingEvidenceDigest(BUSINESS_ID);
    await repo.createMovePreview({
      tokenDigest: "a".repeat(64),
      businessId: BUSINESS_ID,
      teamId: moved.id,
      proposedParentTeamId: secondParent.id,
      teamRevision: moved.revision,
      parentRevision: secondParent.revision,
      authorityRevision: await repo.getAuthorityRevision(BUSINESS_ID),
      bindingEvidenceDigest,
      impactDigest: "b".repeat(64),
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    await expect(
      repo.confirmMove({
        tokenDigest: "a".repeat(64),
        businessId: BUSINESS_ID,
        teamId: moved.id,
        proposedParentTeamId: secondParent.id,
        bindingEvidenceDigest,
        impactDigest: "c".repeat(64),
        now: NOW,
      })
    ).rejects.toThrow("stale");
  });
});

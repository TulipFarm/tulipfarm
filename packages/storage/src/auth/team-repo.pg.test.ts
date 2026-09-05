import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_OWNERSHIP_APPROVAL_STORAGE_STATEMENTS,
  PgApprovalGrantRepo,
} from "../approvals/approval-repo";
import {
  ASSET_OWNERSHIP_STORAGE_STATEMENTS,
  PgAssetOwnershipRepo,
} from "../asset-ownership/asset-ownership-repo";
import { transactionPort } from "../pg/test-support";
import { PgPrincipalRepo } from "./principal-repo";
import { AUTHORIZATION_STORAGE_STATEMENTS, PgRoleRepo } from "./role-repo";
import {
  PgTeamRepo,
  TEAM_STORAGE_STATEMENTS,
  type TeamMembershipRecord,
  type TeamRecord,
} from "./team-repo";

const BUSINESS_ID = "business-1";
const NOW = new Date("2026-09-05T12:00:00Z");

function teamRecord(
  id: string,
  slug: string,
  displayName: string,
  parentTeamId: string
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
  };
}

describe("PgTeamRepo", () => {
  let database: PGlite;
  let teams: PgTeamRepo;
  let principals: PgPrincipalRepo;
  let roles: PgRoleRepo;
  let ownership: PgAssetOwnershipRepo;
  let approvals: PgApprovalGrantRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...AUTHORIZATION_STORAGE_STATEMENTS,
      ...TEAM_STORAGE_STATEMENTS,
      ...ASSET_OWNERSHIP_APPROVAL_STORAGE_STATEMENTS,
      ...ASSET_OWNERSHIP_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    const transactions = transactionPort(database);
    teams = new PgTeamRepo(transactions);
    principals = new PgPrincipalRepo(transactions);
    roles = new PgRoleRepo(transactions);
    ownership = new PgAssetOwnershipRepo(transactions);
    approvals = new PgApprovalGrantRepo(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec(
      "TRUNCATE asset_ownership, team_slug_reservations, principals, roles, teams CASCADE"
    );
  });

  it("round-trips Team state and rejects hierarchy, sibling, and slug violations", async () => {
    const root = await teams.ensureEveryone(BUSINESS_ID);
    const finance = teamRecord(
      "00000000-0000-4000-8000-000000000001",
      "finance",
      "Finance",
      root.id
    );
    const labeledFinance = { ...finance, labels: ["finance", "operations"] };
    await teams.putTeam(labeledFinance);
    await expect(teams.getTeamBySlug(BUSINESS_ID, "finance")).resolves.toEqual(labeledFinance);

    await expect(
      teams.putTeam(
        teamRecord("00000000-0000-4000-8000-000000000002", "finance-two", "FINANCE", root.id)
      )
    ).rejects.toThrow();

    await teams.putTeam({
      ...finance,
      status: "archived",
      revision: 2,
      archivedAt: new Date(NOW.getTime() + 1_000),
      updatedAt: new Date(NOW.getTime() + 1_000),
    });

    await teams.deleteTeam(BUSINESS_ID, finance.id);
    await expect(
      teams.putTeam(
        teamRecord("00000000-0000-4000-8000-000000000003", "finance", "New Finance", root.id)
      )
    ).rejects.toThrow();
  });

  it("archives only when targeted asset references and active Approvals are absent", async () => {
    const root = await teams.ensureEveryone(BUSINESS_ID);
    const target = teamRecord(
      "00000000-0000-4000-8000-000000000090",
      "lifecycle-target",
      "Lifecycle target",
      root.id
    );
    await teams.putTeam(target);
    await ownership.create({
      businessId: BUSINESS_ID,
      assetType: "agent",
      assetId: "lifecycle-agent",
      owners: [{ kind: "team", teamId: root.id }],
      shares: [{ teamId: target.id, access: "view" }],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(
      teams.transitionLifecycle({
        businessId: BUSINESS_ID,
        teamId: target.id,
        action: "archive",
        expectedRevision: target.revision,
        now: NOW,
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_empty",
      message: expect.stringMatching(/asset ownership and shares/i),
    });

    await ownership.put(
      {
        businessId: BUSINESS_ID,
        assetType: "agent",
        assetId: "lifecycle-agent",
        owners: [{ kind: "team", teamId: root.id }],
        shares: [],
        revision: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      1
    );
    const approvalId = "00000000-0000-4000-8000-000000000091";
    await approvals.create({
      approvalId,
      businessId: BUSINESS_ID,
      binding: {
        intentDigest: "intent",
        evidenceDigest: "evidence",
        guardrailRevision: "guardrail",
      },
      risk: "low",
      allowedApproverRoles: [`team:${target.id}:admin`],
      requiredApproverRoles: [`team:${target.id}:admin`],
      proposerPrincipalId: "person-1",
      preview: "Add owner",
      riskSummary: "Ownership changes",
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: NOW,
    });
    await ownership.createOperation({
      id: "00000000-0000-4000-8000-000000000092",
      approvalId,
      businessId: BUSINESS_ID,
      assetType: "agent",
      assetId: "lifecycle-agent",
      action: "add_owner",
      teamId: target.id,
      expectedOwnershipRevision: 2,
      status: "pending",
      revision: 1,
      createdAt: NOW,
    });

    await expect(
      teams.transitionLifecycle({
        businessId: BUSINESS_ID,
        teamId: target.id,
        action: "archive",
        expectedRevision: target.revision,
        now: NOW,
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_empty",
      message: expect.stringMatching(/pending ownership Approvals/i),
    });

    await approvals.revoke(BUSINESS_ID, approvalId, NOW);
    await expect(
      teams.transitionLifecycle({
        businessId: BUSINESS_ID,
        teamId: target.id,
        action: "archive",
        expectedRevision: target.revision,
        now: NOW,
      })
    ).resolves.toMatchObject({ ok: true, team: { status: "archived", revision: 2 } });
  });

  it("enforces depth ten and rejects cycles", async () => {
    const root = await teams.ensureEveryone(BUSINESS_ID);
    let parentId = root.id;
    for (let depth = 2; depth <= 10; depth += 1) {
      const id = `00000000-0000-4000-8000-${String(depth).padStart(12, "0")}`;
      await teams.putTeam(teamRecord(id, `level-${depth}`, `Level ${depth}`, parentId));
      parentId = id;
    }
    await expect(
      teams.putTeam(
        teamRecord("00000000-0000-4000-8000-000000000011", "level-11", "Level 11", parentId)
      )
    ).rejects.toThrow();

    const firstChild = await teams.getTeamBySlug(BUSINESS_ID, "level-2");
    if (!firstChild) throw new Error("missing first child");
    await expect(
      teams.putTeam({
        ...firstChild,
        parentTeamId: parentId,
        revision: 2,
        updatedAt: new Date(NOW.getTime() + 1_000),
      })
    ).rejects.toThrow();
  });

  it("persists mixed membership, expiry, Team authority, and delegation policy", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "person-1",
      kind: "user",
      status: "active",
    });
    await principals.put({
      businessId: BUSINESS_ID,
      id: "agent-1",
      kind: "agent",
      status: "active",
    });
    const root = await teams.ensureEveryone(BUSINESS_ID);
    const engineering = teamRecord(
      "00000000-0000-4000-8000-000000000020",
      "engineering",
      "Engineering",
      root.id
    );
    await teams.putTeam(engineering);
    await teams.putLegacyGroupMapping(BUSINESS_ID, "engineering-group", engineering.id);

    const person: TeamMembershipRecord = {
      teamId: engineering.id,
      principalId: "person-1",
      principalKind: "user",
      level: "admin",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await teams.putMembership(person);
    await expect(
      teams.putMembership({
        ...person,
        principalId: "agent-1",
        principalKind: "agent",
        level: "admin",
      })
    ).rejects.toThrow();
    await teams.putMembership({
      ...person,
      principalId: "agent-1",
      principalKind: "agent",
      level: "member",
      expiresAt: new Date(NOW.getTime() - 1),
    });

    await roles.putRole({
      id: "reader",
      businessId: BUSINESS_ID,
      assignableTo: ["team"],
      parentRoleIds: [],
      grants: [],
    });
    await roles.putRole({
      id: "person-only",
      businessId: BUSINESS_ID,
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [],
    });
    await teams.assignRole({ teamId: engineering.id, roleId: "reader", assignedAt: NOW });
    await expect(
      teams.assignRole({ teamId: engineering.id, roleId: "person-only", assignedAt: NOW })
    ).rejects.toThrow();
    await teams.putGrant({
      id: "00000000-0000-4000-8000-000000000021",
      teamId: engineering.id,
      action: "record.read",
      resourceType: "ticket",
      effect: "allow",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await teams.putDelegationPolicy({
      teamId: engineering.id,
      allowedRoleIds: ["reader"],
      allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
      revision: 1,
      updatedAt: NOW,
    });

    expect(await teams.listMemberships(engineering.id, NOW)).toEqual([person]);
    expect(await teams.resolveLegacyGroupId(BUSINESS_ID, "engineering-group")).toBe(engineering.id);
    expect(await teams.listRoleAssignments(engineering.id, NOW)).toHaveLength(1);
    expect(await teams.listGrants(engineering.id, NOW)).toHaveLength(1);
    expect(await teams.getDelegationPolicy(engineering.id)).toMatchObject({
      allowedRoleIds: ["reader"],
      revision: 1,
    });

    await teams.putTeam({
      ...engineering,
      status: "archived",
      archivedAt: NOW,
      revision: 2,
      updatedAt: NOW,
    });
    expect(await teams.listMemberships(engineering.id, NOW)).toEqual([]);
    expect(await teams.listRoleAssignments(engineering.id, NOW)).toEqual([]);
    expect(await teams.listGrants(engineering.id, NOW)).toEqual([]);
    expect(await teams.listAllMemberships(engineering.id)).toHaveLength(2);

    await teams.removeMembership(engineering.id, "person-1");
    await teams.revokeRole(engineering.id, "reader");
    await teams.deleteGrant(engineering.id, "00000000-0000-4000-8000-000000000021");
    expect(await teams.listMemberships(engineering.id, NOW)).toEqual([]);
    expect(await teams.listRoleAssignments(engineering.id, NOW)).toEqual([]);
    expect(await teams.listGrants(engineering.id, NOW)).toEqual([]);
  });

  it("automatically adds active people, but not Agents, to Everyone", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "person-1",
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

    expect((await teams.listMemberships(everyone.id, NOW)).map((item) => item.principalId)).toEqual(
      ["person-1"]
    );

    await principals.put({
      businessId: BUSINESS_ID,
      id: "person-1",
      kind: "user",
      status: "disabled",
    });
    expect(await teams.listMemberships(everyone.id, NOW)).toEqual([]);
  });

  it("enforces membership and leave-request revisions", async () => {
    await principals.put({
      businessId: BUSINESS_ID,
      id: "person-1",
      kind: "user",
      status: "active",
    });
    const root = await teams.ensureEveryone(BUSINESS_ID);
    const support = teamRecord(
      "00000000-0000-4000-8000-000000000040",
      "support",
      "Support",
      root.id
    );
    await teams.putTeam(support);
    const original: TeamMembershipRecord = {
      teamId: support.id,
      principalId: "person-1",
      principalKind: "user",
      level: "member",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await teams.putMembership(original);
    await teams.putMembership({ ...original, level: "admin", revision: 2 });
    await expect(teams.putMembership({ ...original, revision: 2 })).rejects.toThrow(
      "revision conflict"
    );
    await expect(teams.removeMembership(support.id, original.principalId, 1)).rejects.toThrow(
      "revision conflict"
    );
    await expect(teams.removeMembership(support.id, original.principalId, 2)).rejects.toThrow(
      "final Team admin"
    );

    const request = {
      id: "00000000-0000-4000-8000-000000000041",
      teamId: support.id,
      principalId: original.principalId,
      status: "pending" as const,
      revision: 1,
      requestedAt: NOW,
    };
    await teams.putLeaveRequest(request);
    await teams.putLeaveRequest({
      ...request,
      status: "approved",
      revision: 2,
      decidedAt: NOW,
      decidedByPrincipalId: "person-2",
    });
    await expect(
      teams.putLeaveRequest({
        ...request,
        status: "rejected",
        revision: 2,
        decidedAt: NOW,
        decidedByPrincipalId: "person-2",
      })
    ).rejects.toThrow("revision conflict");
  });

  it("enforces delegation-policy revisions", async () => {
    const root = await teams.ensureEveryone(BUSINESS_ID);
    const operations = teamRecord(
      "00000000-0000-4000-8000-000000000050",
      "operations",
      "Operations",
      root.id
    );
    await teams.putTeam(operations);
    await teams.putDelegationPolicy({
      teamId: operations.id,
      allowedRoleIds: ["reader"],
      allowedGrantScopes: [],
      revision: 1,
      updatedAt: NOW,
    });

    const writerUpdate = {
      teamId: operations.id,
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
      teams.putDelegationPolicy(writerUpdate),
      teams.putDelegationPolicy(readerUpdate),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const persisted = await teams.getDelegationPolicy(operations.id);
    expect(persisted?.revision).toBe(2);
    expect([["writer"], ["reader"]]).toContainEqual(persisted?.allowedRoleIds);
  });

  it("atomically promotes only one existing active direct human member", async () => {
    for (const id of ["person-1", "person-2", "outsider"]) {
      await principals.put({
        businessId: BUSINESS_ID,
        id,
        kind: "user",
        status: "active",
      });
    }
    const root = await teams.ensureEveryone(BUSINESS_ID);
    const recovery = teamRecord(
      "00000000-0000-4000-8000-000000000060",
      "recovery",
      "Recovery",
      root.id
    );
    await teams.putTeam(recovery);
    for (const principalId of ["person-1", "person-2"]) {
      await teams.putMembership({
        teamId: recovery.id,
        principalId,
        principalKind: "user",
        level: "member",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    await expect(
      teams.recoverAdmin({
        businessId: BUSINESS_ID,
        teamId: recovery.id,
        principalId: "outsider",
        teamRevision: recovery.revision,
        now: NOW,
      })
    ).rejects.toThrow(/direct human membership/i);

    const results = await Promise.allSettled(
      ["person-1", "person-2"].map((principalId) =>
        teams.recoverAdmin({
          businessId: BUSINESS_ID,
          teamId: recovery.id,
          principalId,
          teamRevision: recovery.revision,
          now: NOW,
        })
      )
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects a move when asset evidence changes before the atomic confirmation", async () => {
    const root = await teams.ensureEveryone(BUSINESS_ID);
    const firstParent = teamRecord(
      "00000000-0000-4000-8000-000000000070",
      "first-parent",
      "First parent",
      root.id
    );
    const secondParent = teamRecord(
      "00000000-0000-4000-8000-000000000071",
      "second-parent",
      "Second parent",
      root.id
    );
    const moved = teamRecord(
      "00000000-0000-4000-8000-000000000072",
      "moved",
      "Moved",
      firstParent.id
    );
    await teams.putTeam(firstParent);
    await teams.putTeam(secondParent);
    await teams.putTeam(moved);
    const asset = {
      businessId: BUSINESS_ID,
      assetType: "file" as const,
      assetId: "move-file",
      owners: [{ kind: "team" as const, teamId: firstParent.id }],
      shares: [{ teamId: moved.id, access: "view" as const }],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await ownership.create(asset);
    const bindingEvidenceDigest = await teams.getMoveBindingEvidenceDigest(BUSINESS_ID);
    await teams.createMovePreview({
      tokenDigest: "a".repeat(64),
      businessId: BUSINESS_ID,
      teamId: moved.id,
      proposedParentTeamId: secondParent.id,
      teamRevision: moved.revision,
      parentRevision: secondParent.revision,
      authorityRevision: await teams.getAuthorityRevision(BUSINESS_ID),
      bindingEvidenceDigest,
      impactDigest: "b".repeat(64),
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await ownership.put(
      {
        ...asset,
        shares: [{ teamId: moved.id, access: "edit" }],
        revision: 2,
        updatedAt: new Date(NOW.getTime() + 1),
      },
      1
    );

    await expect(
      teams.confirmMove({
        tokenDigest: "a".repeat(64),
        businessId: BUSINESS_ID,
        teamId: moved.id,
        proposedParentTeamId: secondParent.id,
        bindingEvidenceDigest,
        impactDigest: "b".repeat(64),
        now: NOW,
      })
    ).rejects.toThrow("stale");
  });
});

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSET_OWNERSHIP_APPROVAL_STORAGE_STATEMENTS,
  PgApprovalGrantRepo,
} from "../approvals/approval-repo";
import { AUTHORIZATION_STORAGE_STATEMENTS } from "../auth/role-repo";
import { TEAM_STORAGE_STATEMENTS } from "../auth/team-repo";
import { transactionPort } from "../pg/test-support";
import { ASSET_OWNERSHIP_STORAGE_STATEMENTS, PgAssetOwnershipRepo } from "./asset-ownership-repo";

const TEAM_ONE = "123e4567-e89b-42d3-a456-426614174101";
const TEAM_TWO = "123e4567-e89b-42d3-a456-426614174102";
const TEAM_THREE = "123e4567-e89b-42d3-a456-426614174103";
const NOW = new Date("2026-09-05T12:00:00.000Z");

describe("PgAssetOwnershipRepo", () => {
  let database: PGlite;
  let repo: PgAssetOwnershipRepo;
  let approvals: PgApprovalGrantRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of AUTHORIZATION_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    for (const statement of TEAM_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    for (const statement of ASSET_OWNERSHIP_APPROVAL_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    for (const statement of ASSET_OWNERSHIP_STORAGE_STATEMENTS) await database.exec(statement);
    await database.query(
      `INSERT INTO principals (business_id, id, kind, status)
       VALUES
         ('business-1', 'admin-one', 'user', 'active'),
         ('business-1', 'admin-two', 'user', 'active'),
         ('business-1', 'admin-three', 'user', 'active')`
    );
    await database.query(
      `INSERT INTO teams
         (id, business_id, slug, display_name, parent_team_id, status, protected)
       VALUES
         ($1, 'business-1', 'one', 'One',
          (SELECT id FROM teams WHERE business_id = 'business-1' AND slug = 'everyone'),
          'active', false),
         ($2, 'business-1', 'two', 'Two',
          (SELECT id FROM teams WHERE business_id = 'business-1' AND slug = 'everyone'),
          'active', false),
         ($3, 'business-1', 'three', 'Three',
          (SELECT id FROM teams WHERE business_id = 'business-1' AND slug = 'everyone'),
          'active', false)`,
      [TEAM_ONE, TEAM_TWO, TEAM_THREE]
    );
    await database.query(
      `INSERT INTO team_memberships (team_id, principal_id, principal_kind, level)
       VALUES
         ($1, 'admin-one', 'user', 'admin'),
         ($2, 'admin-two', 'user', 'admin'),
         ($3, 'admin-three', 'user', 'admin')`,
      [TEAM_ONE, TEAM_TWO, TEAM_THREE]
    );
    const transactions = transactionPort(database);
    repo = new PgAssetOwnershipRepo(transactions);
    approvals = new PgApprovalGrantRepo(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  it("round-trips joint Team owners, shares, and Approval operations", async () => {
    await repo.create({
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      owners: [
        { kind: "team", teamId: TEAM_ONE },
        { kind: "team", teamId: TEAM_TWO },
      ],
      shares: [
        {
          teamId: TEAM_THREE,
          access: "use",
        },
      ],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(repo.get("business-1", "agent", "agent-1")).resolves.toMatchObject({
      owners: [
        { kind: "team", teamId: TEAM_ONE },
        { kind: "team", teamId: TEAM_TWO },
      ],
      shares: [{ teamId: TEAM_THREE, access: "use" }],
    });

    await repo.createOperation({
      id: "223e4567-e89b-42d3-a456-426614174000",
      approvalId: "323e4567-e89b-42d3-a456-426614174000",
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      action: "delete",
      expectedOwnershipRevision: 1,
      status: "pending",
      revision: 1,
      createdAt: NOW,
    });
    await expect(
      repo.getOperation("business-1", "223e4567-e89b-42d3-a456-426614174000")
    ).resolves.toMatchObject({ action: "delete", status: "pending", revision: 1 });
  });

  it("rejects references to an archived Team inside the asset transaction", async () => {
    const archivedTeamId = "123e4567-e89b-42d3-a456-426614174199";
    await database.query(
      `INSERT INTO teams
         (id, business_id, slug, display_name, parent_team_id, status, protected, archived_at)
       VALUES (
         $1, 'business-1', 'archived-target', 'Archived target',
         (SELECT id FROM teams WHERE business_id = 'business-1' AND slug = 'everyone'),
         'archived', false, $2
       )`,
      [archivedTeamId, NOW]
    );

    await expect(
      repo.create({
        businessId: "business-1",
        assetType: "agent",
        assetId: "archived-team-reference",
        owners: [{ kind: "team", teamId: TEAM_ONE }],
        shares: [{ teamId: archivedTeamId, access: "view" }],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })
    ).rejects.toThrow(/active Teams/i);
    await expect(
      repo.createOperation({
        id: "223e4567-e89b-42d3-a456-426614174199",
        approvalId: "323e4567-e89b-42d3-a456-426614174199",
        businessId: "business-1",
        assetType: "agent",
        assetId: "agent-1",
        action: "add_owner",
        teamId: archivedTeamId,
        expectedOwnershipRevision: 1,
        status: "pending",
        revision: 1,
        createdAt: NOW,
      })
    ).rejects.toThrow(/active Teams/i);
  });

  it("rolls back the Approval when an ownership operation names an archived Team", async () => {
    const archivedTeamId = "123e4567-e89b-42d3-a456-426614174198";
    const approvalId = "323e4567-e89b-42d3-a456-426614174198";
    await database.query(
      `INSERT INTO teams
         (id, business_id, slug, display_name, parent_team_id, status, protected, archived_at)
       VALUES (
         $1, 'business-1', 'archived-operation-target', 'Archived operation target',
         (SELECT id FROM teams WHERE business_id = 'business-1' AND slug = 'everyone'),
         'archived', false, $2
       )`,
      [archivedTeamId, NOW]
    );

    await expect(
      repo.createOperationWithApproval(
        {
          id: "223e4567-e89b-42d3-a456-426614174198",
          approvalId,
          businessId: "business-1",
          assetType: "agent",
          assetId: "agent-1",
          action: "add_owner",
          teamId: archivedTeamId,
          expectedOwnershipRevision: 1,
          status: "pending",
          revision: 1,
          createdAt: NOW,
        },
        {
          approvalId,
          businessId: "business-1",
          binding: {
            intentDigest: "intent-atomic-create",
            evidenceDigest: "evidence-atomic-create",
            guardrailRevision: "asset-ownership-v1",
          },
          risk: "high",
          allowedApproverRoles: [`team:${TEAM_ONE}:admin`],
          requiredApproverRoles: [`team:${TEAM_ONE}:admin`],
          proposerPrincipalId: "proposer",
          preview: "add owner",
          riskSummary: "changes ownership",
          expiresAt: new Date(NOW.getTime() + 60_000),
          createdAt: NOW,
        }
      )
    ).rejects.toThrow(/active Teams/i);
    await expect(approvals.get("business-1", approvalId)).resolves.toBeUndefined();
  });

  it("pages Team-linked ownership rows with source filters applied in storage", async () => {
    for (const [assetId, owners, shares] of [
      ["catalog-a", [{ kind: "team" as const, teamId: TEAM_ONE }], []],
      [
        "catalog-b",
        [{ kind: "team" as const, teamId: TEAM_TWO }],
        [{ teamId: TEAM_ONE, access: "view" as const }],
      ],
      ["catalog-c", [{ kind: "team" as const, teamId: TEAM_THREE }], []],
    ] as const) {
      await repo.create({
        businessId: "business-1",
        assetType: "skill",
        assetId,
        owners,
        shares,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    const first = await repo.listByTeamsPage("business-1", [TEAM_ONE], {
      assetType: "skill",
      limit: 1,
    });
    expect(first.records.map((record) => record.assetId)).toEqual(["catalog-a"]);
    expect(first.hasMore).toBe(true);

    const second = await repo.listByTeamsPage("business-1", [TEAM_ONE], {
      assetType: "skill",
      limit: 2,
      after: { assetType: "skill", assetId: "catalog-a" },
    });
    expect(second.records.map((record) => record.assetId)).toEqual(["catalog-b"]);
    expect(second.hasMore).toBe(false);

    const owned = await repo.listByTeamsPage("business-1", [TEAM_ONE], {
      assetType: "skill",
      ownerTeamId: TEAM_ONE,
      limit: 10,
    });
    expect(owned.records.map((record) => record.assetId)).toEqual(["catalog-a"]);
  });

  it("pages pending operations with asset filters applied in storage", async () => {
    for (const [assetType, assetId] of [
      ["agent", "paged-a"],
      ["agent", "paged-b"],
      ["skill", "paged-skill"],
      ["agent", "paged-history"],
    ] as const) {
      await repo.create({
        businessId: "business-1",
        assetType,
        assetId,
        owners: [{ kind: "team", teamId: TEAM_ONE }],
        shares: [],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    for (const [id, assetType, assetId, status, offset] of [
      ["223e4567-e89b-42d3-a456-426614174020", "agent", "paged-a", "pending", 0],
      ["223e4567-e89b-42d3-a456-426614174021", "agent", "paged-b", "pending", 1],
      ["223e4567-e89b-42d3-a456-426614174022", "skill", "paged-skill", "pending", 2],
      ["223e4567-e89b-42d3-a456-426614174023", "agent", "paged-history", "completed", 3],
    ] as const) {
      await repo.createOperation({
        id,
        approvalId: id.replace("223e", "323e"),
        businessId: "business-1",
        assetType,
        assetId,
        action: "archive",
        expectedOwnershipRevision: 1,
        status,
        revision: 1,
        createdAt: new Date(NOW.getTime() + 10_000 + offset),
        ...(status === "completed"
          ? { completedAt: new Date(NOW.getTime() + 20_000 + offset) }
          : {}),
      });
    }

    const first = await repo.listOperationsPage("business-1", {
      status: "pending",
      assetType: "agent",
      limit: 1,
    });
    expect(first.records.map((record) => record.assetId)).toEqual(["agent-1"]);
    expect(first.hasMore).toBe(true);

    const afterSeed = await repo.listOperationsPage("business-1", {
      status: "pending",
      assetType: "agent",
      after: {
        createdAt: first.records[0]?.createdAt as Date,
        id: first.records[0]?.id as string,
      },
      limit: 1,
    });
    expect(afterSeed.records.map((record) => record.assetId)).toEqual(["paged-a"]);
    expect(afterSeed.hasMore).toBe(true);

    const filtered = await repo.listOperationsPage("business-1", {
      status: "pending",
      assetType: "skill",
      assetId: "paged-skill",
      limit: 10,
    });
    expect(filtered.records.map((record) => record.assetId)).toEqual(["paged-skill"]);
    expect(filtered.hasMore).toBe(false);
  });

  it("leaves the Approval reusable when a concurrent ownership update defeats the CAS", async () => {
    const assetId = "agent-atomic-stale";
    const operationId = "223e4567-e89b-42d3-a456-426614174010";
    const approvalId = "323e4567-e89b-42d3-a456-426614174010";
    const binding = {
      intentDigest: "intent-stale",
      evidenceDigest: "evidence-stale",
      guardrailRevision: "asset-ownership-v1",
    };
    const original = {
      businessId: "business-1",
      assetType: "agent" as const,
      assetId,
      owners: [
        { kind: "team" as const, teamId: TEAM_ONE },
        { kind: "team" as const, teamId: TEAM_TWO },
      ],
      shares: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repo.create(original);
    await repo.createOperation({
      id: operationId,
      approvalId,
      businessId: "business-1",
      assetType: "agent",
      assetId,
      action: "add_owner",
      teamId: TEAM_THREE,
      expectedOwnershipRevision: 1,
      status: "pending",
      revision: 1,
      createdAt: NOW,
    });
    await createUnanimousApproval(approvalId, binding);
    await repo.put(
      {
        ...original,
        shares: [{ teamId: TEAM_THREE, access: "view" }],
        revision: 2,
        updatedAt: new Date(NOW.getTime() + 1),
      },
      1
    );

    await expect(
      repo.completeApprovedOperation({
        businessId: "business-1",
        operationId,
        binding,
        at: NOW,
        updatedOwnership: {
          ...original,
          owners: [...original.owners, { kind: "team", teamId: TEAM_THREE }],
          revision: 2,
          updatedAt: new Date(NOW.getTime() + 2),
        },
      })
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await approvals.get("business-1", approvalId))?.consumedAt).toBeUndefined();
    await expect(repo.getOperation("business-1", operationId)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("commits Approval consumption, ownership CAS, and operation completion together", async () => {
    const assetId = "agent-atomic-success";
    const operationId = "223e4567-e89b-42d3-a456-426614174012";
    const approvalId = "323e4567-e89b-42d3-a456-426614174012";
    const binding = {
      intentDigest: "intent-success",
      evidenceDigest: "evidence-success",
      guardrailRevision: "asset-ownership-v1",
    };
    const original = {
      businessId: "business-1",
      assetType: "agent" as const,
      assetId,
      owners: [
        { kind: "team" as const, teamId: TEAM_ONE },
        { kind: "team" as const, teamId: TEAM_TWO },
      ],
      shares: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repo.create(original);
    await repo.createOperation({
      id: operationId,
      approvalId,
      businessId: "business-1",
      assetType: "agent",
      assetId,
      action: "add_owner",
      teamId: TEAM_THREE,
      expectedOwnershipRevision: 1,
      status: "pending",
      revision: 1,
      createdAt: NOW,
    });
    await createUnanimousApproval(approvalId, binding);
    const updated = {
      ...original,
      owners: [...original.owners, { kind: "team" as const, teamId: TEAM_THREE }],
      revision: 2,
      updatedAt: new Date(NOW.getTime() + 1),
    };

    await expect(
      repo.completeApprovedOperation({
        businessId: "business-1",
        operationId,
        binding,
        at: NOW,
        updatedOwnership: updated,
      })
    ).resolves.toMatchObject({
      ownership: { revision: 2, owners: updated.owners },
      operation: { status: "completed", revision: 2 },
    });
    await expect(approvals.get("business-1", approvalId)).resolves.toMatchObject({
      consumedAt: NOW,
    });
  });

  it("rolls back Approval consumption and ownership when a later write fails", async () => {
    const assetId = "agent-atomic-rollback";
    const operationId = "223e4567-e89b-42d3-a456-426614174011";
    const approvalId = "323e4567-e89b-42d3-a456-426614174011";
    const binding = {
      intentDigest: "intent-rollback",
      evidenceDigest: "evidence-rollback",
      guardrailRevision: "asset-ownership-v1",
    };
    const original = {
      businessId: "business-1",
      assetType: "agent" as const,
      assetId,
      owners: [
        { kind: "team" as const, teamId: TEAM_ONE },
        { kind: "team" as const, teamId: TEAM_TWO },
      ],
      shares: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repo.create(original);
    await repo.createOperation({
      id: operationId,
      approvalId,
      businessId: "business-1",
      assetType: "agent",
      assetId,
      action: "add_owner",
      teamId: TEAM_THREE,
      expectedOwnershipRevision: 1,
      status: "pending",
      revision: 1,
      createdAt: NOW,
    });
    await createUnanimousApproval(approvalId, binding);

    await expect(
      repo.completeApprovedOperation({
        businessId: "business-1",
        operationId,
        binding,
        at: NOW,
        updatedOwnership: {
          ...original,
          owners: [...original.owners, original.owners[0]],
          revision: 2,
          updatedAt: new Date(NOW.getTime() + 1),
        },
      })
    ).rejects.toBeDefined();
    expect((await approvals.get("business-1", approvalId))?.consumedAt).toBeUndefined();
    await expect(repo.get("business-1", "agent", assetId)).resolves.toMatchObject({
      owners: original.owners,
      revision: 1,
    });
    await expect(repo.getOperation("business-1", operationId)).resolves.toMatchObject({
      status: "pending",
    });
  });

  async function createUnanimousApproval(
    approvalId: string,
    binding: {
      readonly intentDigest: string;
      readonly evidenceDigest: string;
      readonly guardrailRevision: string;
    }
  ): Promise<void> {
    const roles = [`team:${TEAM_ONE}:admin`, `team:${TEAM_TWO}:admin`];
    await approvals.create({
      approvalId,
      businessId: "business-1",
      binding,
      risk: "high",
      allowedApproverRoles: roles,
      requiredApproverRoles: roles,
      proposerPrincipalId: "proposer",
      preview: "change ownership",
      riskSummary: "destructive",
      expiresAt: new Date("2026-09-05T13:00:00.000Z"),
      createdAt: NOW,
    });
    for (const [principalId, role] of [
      ["admin-one", roles[0]],
      ["admin-two", roles[1]],
    ] as const) {
      await approvals.appendDecision("business-1", approvalId, {
        approverPrincipalId: principalId,
        approverRoles: [role],
        satisfiedApproverRole: role,
        outcome: "approved",
        decidedAt: NOW,
      });
    }
  }
});

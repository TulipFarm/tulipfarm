import type { TeamAssetOwner } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { InMemoryApprovalRepo } from "../approvals/approval-repo";
import {
  type AssetOwnershipOperationRecord,
  type AssetOwnershipRecord,
  InMemoryAssetOwnershipRepo,
} from "./asset-ownership-repo";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function ownership(overrides: Partial<AssetOwnershipRecord> = {}): AssetOwnershipRecord {
  return {
    businessId: "business-1",
    assetType: "agent",
    assetId: "agent-1",
    owners: [{ kind: "team", teamId: "00000000-0000-4000-8000-000000000001" }],
    shares: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function operation(
  overrides: Partial<AssetOwnershipOperationRecord> = {}
): AssetOwnershipOperationRecord {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    approvalId: "00000000-0000-4000-8000-000000000011",
    businessId: "business-1",
    assetType: "agent",
    assetId: "agent-1",
    action: "archive",
    expectedOwnershipRevision: 1,
    status: "pending",
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

describe("InMemoryAssetOwnershipRepo", () => {
  it("keeps ownership business-scoped and immutable to returned-object mutation", async () => {
    const repo = new InMemoryAssetOwnershipRepo();
    await repo.create(ownership());
    const stored = await repo.get("business-1", "agent", "agent-1");
    expect(stored).toEqual(ownership());
    expect(await repo.get("business-2", "agent", "agent-1")).toBeUndefined();
    if (!stored) throw new Error("expected stored ownership");
    expect(() => {
      (stored.owners as TeamAssetOwner[]).push({
        kind: "team",
        teamId: "00000000-0000-4000-8000-000000000002",
      });
    }).toThrow();
  });

  it("applies ownership updates with compare-and-swap", async () => {
    const repo = new InMemoryAssetOwnershipRepo();
    const original = ownership();
    await repo.create(original);
    const updated = {
      ...original,
      owners: [
        ...original.owners,
        { kind: "team" as const, teamId: "00000000-0000-4000-8000-000000000002" },
      ],
      revision: 2,
    };
    await repo.put(updated, 1);
    await expect(repo.put({ ...updated, revision: 3 }, 1)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });

  it("rejects ownership, shares, and operations that name an inactive Team", async () => {
    const repo = new InMemoryAssetOwnershipRepo([], [], undefined, {
      getTeam: async (_businessId, teamId) => ({
        status: teamId === "00000000-0000-4000-8000-000000000001" ? "active" : "archived",
      }),
    });
    await repo.create(ownership());
    await expect(
      repo.put(
        ownership({
          shares: [{ teamId: "00000000-0000-4000-8000-000000000002", access: "view" }],
          revision: 2,
        }),
        1
      )
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repo.createOperation(operation({ teamId: "00000000-0000-4000-8000-000000000002" }))
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("restores Approval consumption when a Team becomes inactive during completion", async () => {
    const approvalId = operation().approvalId;
    const binding = {
      intentDigest: "intent",
      evidenceDigest: "evidence",
      guardrailRevision: "asset-ownership-v1",
    };
    const approvals = new InMemoryApprovalRepo([
      {
        approvalId,
        businessId: "business-1",
        binding,
        risk: "low",
        allowedApproverRoles: ["company:admin"],
        requiredApproverRoles: [],
        proposerPrincipalId: "proposer",
        preview: "add owner",
        riskSummary: "changes ownership",
        expiresAt: new Date(NOW.getTime() + 60_000),
        createdAt: NOW,
        decisions: [
          {
            approverPrincipalId: "approver",
            approverRoles: ["company:admin"],
            outcome: "approved",
            decidedAt: NOW,
          },
        ],
      },
    ]);
    let targetArchived = false;
    const repo = new InMemoryAssetOwnershipRepo(
      [ownership()],
      [operation({ action: "add_owner", teamId: "00000000-0000-4000-8000-000000000002" })],
      {
        create: (grant) => approvals.create(grant),
        restore: (record) => approvals.restore(record),
        consume: async (businessId, id, approvalBinding, at) => {
          const consumed = await approvals.consume(businessId, id, approvalBinding, at);
          targetArchived = true;
          return consumed;
        },
      },
      {
        getTeam: async (_businessId, teamId) => ({
          status:
            teamId === "00000000-0000-4000-8000-000000000002" && targetArchived
              ? "archived"
              : "active",
        }),
      }
    );

    await expect(
      repo.completeApprovedOperation({
        businessId: "business-1",
        operationId: operation().id,
        binding,
        at: NOW,
        updatedOwnership: ownership({
          owners: [
            ...ownership().owners,
            { kind: "team", teamId: "00000000-0000-4000-8000-000000000002" },
          ],
          revision: 2,
        }),
      })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(approvals.get("business-1", approvalId)).resolves.toMatchObject({
      consumedAt: undefined,
    });
    await expect(repo.getOperation("business-1", operation().id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("does not overwrite a concurrent ownership update during approved completion", async () => {
    const approvalId = operation().approvalId;
    const binding = {
      intentDigest: "intent-concurrent",
      evidenceDigest: "evidence-concurrent",
      guardrailRevision: "asset-ownership-v1",
    };
    const approvals = new InMemoryApprovalRepo([
      {
        approvalId,
        businessId: "business-1",
        binding,
        risk: "low",
        allowedApproverRoles: ["company:admin"],
        requiredApproverRoles: [],
        proposerPrincipalId: "proposer",
        preview: "add owner",
        riskSummary: "changes ownership",
        expiresAt: new Date(NOW.getTime() + 60_000),
        createdAt: NOW,
        decisions: [
          {
            approverPrincipalId: "approver",
            approverRoles: ["company:admin"],
            outcome: "approved",
            decidedAt: NOW,
          },
        ],
      },
    ]);
    let releaseConsume = () => {};
    let consumeStarted = () => {};
    const consumeStartedPromise = new Promise<void>((resolve) => {
      consumeStarted = resolve;
    });
    const consumeReleasePromise = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    const repo = new InMemoryAssetOwnershipRepo(
      [ownership()],
      [operation({ action: "add_owner", teamId: "00000000-0000-4000-8000-000000000002" })],
      {
        create: (grant) => approvals.create(grant),
        restore: (record) => approvals.restore(record),
        consume: async (businessId, id, approvalBinding, at) => {
          consumeStarted();
          await consumeReleasePromise;
          return approvals.consume(businessId, id, approvalBinding, at);
        },
      },
      {
        getTeam: async () => ({ status: "active" }),
      }
    );
    const completion = repo.completeApprovedOperation({
      businessId: "business-1",
      operationId: operation().id,
      binding,
      at: NOW,
      updatedOwnership: ownership({
        owners: [
          ...ownership().owners,
          { kind: "team", teamId: "00000000-0000-4000-8000-000000000002" },
        ],
        revision: 2,
      }),
    });
    await consumeStartedPromise;
    const concurrentUpdate = repo.put(
      ownership({
        shares: [{ teamId: "00000000-0000-4000-8000-000000000003", access: "view" }],
        revision: 2,
      }),
      1
    );
    releaseConsume();

    await expect(completion).resolves.toMatchObject({
      ownership: { revision: 2 },
      operation: { status: "completed" },
    });
    await expect(concurrentUpdate).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(repo.get("business-1", "agent", "agent-1")).resolves.toMatchObject({
      owners: [
        { kind: "team", teamId: "00000000-0000-4000-8000-000000000001" },
        { kind: "team", teamId: "00000000-0000-4000-8000-000000000002" },
      ],
      shares: [],
      revision: 2,
    });
  });

  it("rejects emergency completion that adds an inactive Team", async () => {
    const repo = new InMemoryAssetOwnershipRepo(
      [ownership()],
      [operation({ action: "add_owner", teamId: "00000000-0000-4000-8000-000000000002" })],
      undefined,
      {
        getTeam: async (_businessId, teamId) => ({
          status: teamId === "00000000-0000-4000-8000-000000000002" ? "archived" : "active",
        }),
      }
    );

    await expect(
      repo.completeEmergencyOperation({
        businessId: "business-1",
        operationId: operation().id,
        at: NOW,
        updatedOwnership: ownership({
          owners: [
            ...ownership().owners,
            { kind: "team", teamId: "00000000-0000-4000-8000-000000000002" },
          ],
          revision: 2,
        }),
      })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(repo.getOperation("business-1", operation().id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("rehydrates ownership and pending operations after restart", async () => {
    const restarted = new InMemoryAssetOwnershipRepo([ownership()], [operation()]);
    await expect(restarted.get("business-1", "agent", "agent-1")).resolves.toEqual(ownership());
    await expect(restarted.getOperation("business-1", operation().id)).resolves.toEqual(
      operation()
    );
  });

  it("pages pending operations with asset filters", async () => {
    const repo = new InMemoryAssetOwnershipRepo(
      [],
      [
        operation({ id: "00000000-0000-4000-8000-000000000010", assetId: "agent-a" }),
        operation({
          id: "00000000-0000-4000-8000-000000000011",
          approvalId: "00000000-0000-4000-8000-000000000021",
          assetId: "agent-b",
          createdAt: new Date(NOW.getTime() + 1),
        }),
        operation({
          id: "00000000-0000-4000-8000-000000000012",
          approvalId: "00000000-0000-4000-8000-000000000022",
          assetType: "skill",
          assetId: "skill-a",
          createdAt: new Date(NOW.getTime() + 2),
        }),
        operation({
          id: "00000000-0000-4000-8000-000000000013",
          approvalId: "00000000-0000-4000-8000-000000000023",
          assetId: "agent-history",
          status: "completed",
          createdAt: new Date(NOW.getTime() + 3),
        }),
      ]
    );

    const first = await repo.listOperationsPage("business-1", {
      status: "pending",
      assetType: "agent",
      limit: 1,
    });
    expect(first.records.map((record) => record.assetId)).toEqual(["agent-a"]);
    expect(first.hasMore).toBe(true);

    const second = await repo.listOperationsPage("business-1", {
      status: "pending",
      assetType: "agent",
      limit: 1,
      after: {
        createdAt: first.records[0]?.createdAt as Date,
        id: first.records[0]?.id as string,
      },
    });
    expect(second.records.map((record) => record.assetId)).toEqual(["agent-b"]);
    expect(second.hasMore).toBe(false);
  });

  it("pages relevant Team ownership without reading unrelated assets", async () => {
    const teamId = "00000000-0000-4000-8000-000000000001";
    const repo = new InMemoryAssetOwnershipRepo([
      ownership({ assetId: "agent-a" }),
      ownership({ assetId: "agent-b" }),
      ownership({
        assetId: "agent-shared",
        owners: [{ kind: "team", teamId: "00000000-0000-4000-8000-000000000009" }],
        shares: [{ teamId, access: "view" }],
      }),
      ownership({
        assetId: "agent-unrelated",
        owners: [{ kind: "team", teamId: "00000000-0000-4000-8000-000000000009" }],
      }),
    ]);

    const first = await repo.listByTeamsPage("business-1", [teamId], { limit: 2 });
    expect(first.records.map((record) => record.assetId)).toEqual(["agent-a", "agent-b"]);
    expect(first.hasMore).toBe(true);

    const second = await repo.listByTeamsPage("business-1", [teamId], {
      limit: 2,
      after: { assetType: "agent", assetId: "agent-b" },
    });
    expect(second.records.map((record) => record.assetId)).toEqual(["agent-shared"]);
    expect(second.hasMore).toBe(false);
  });
});

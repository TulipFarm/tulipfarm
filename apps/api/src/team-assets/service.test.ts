import { AssetOwnershipService, type OwnershipApprovalRecord } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  InMemoryApprovalRepo,
  InMemoryAssetOwnershipRepo,
  type TeamMembershipRecord,
  type TeamRepo,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { TeamAssetService } from "./service";

const TEAM_ID = "123e4567-e89b-42d3-a456-426614174000";

function service(
  memberships: TeamMembershipRecord[] = [],
  fileKnowledge?: {
    sync: (fileId: string, widening: boolean) => Promise<void>;
  }
) {
  const approvals = new InMemoryApprovalRepo([], async (_businessId, principalId) =>
    memberships
      .filter(
        (membership) =>
          membership.principalId === principalId &&
          membership.principalKind === "user" &&
          membership.level === "admin"
      )
      .map((membership) => `team:${membership.teamId}:admin`)
  );
  const ownershipRepo = new InMemoryAssetOwnershipRepo([], [], approvals);
  const putMembership = vi.fn();
  const teams = {
    ensureEveryone: vi.fn(async () => ({ id: TEAM_ID })),
    getTeam: vi.fn(async (_businessId: string, id: string) => ({
      id,
      status: "active",
    })),
    listPrincipalMemberships: vi.fn(async (_businessId, principalId) =>
      memberships.filter((membership) => membership.principalId === principalId)
    ),
    putMembership,
  } as unknown as TeamRepo;
  const ownership = new AssetOwnershipService({
    ownership: ownershipRepo,
    approvals: approvals as unknown as {
      create(record: OwnershipApprovalRecord): Promise<OwnershipApprovalRecord>;
      get(businessId: string, approvalId: string): Promise<OwnershipApprovalRecord | undefined>;
      appendDecision(
        businessId: string,
        approvalId: string,
        decision: OwnershipApprovalRecord["decisions"][number]
      ): Promise<OwnershipApprovalRecord>;
      consume(
        businessId: string,
        approvalId: string,
        binding: OwnershipApprovalRecord["binding"],
        at: Date
      ): Promise<OwnershipApprovalRecord>;
    },
    memberships: {
      async resolveMembers(_businessId: string, teamId: string) {
        return memberships
          .filter((membership) => membership.teamId === teamId)
          .map((membership) => ({
            membership: "direct" as const,
            sourceTeamId: membership.teamId,
            pathTeamIds: [membership.teamId],
            principalId: membership.principalId,
            principalKind: membership.principalKind,
            level: membership.level,
            expiresAt: membership.expiresAt,
            removable: true,
            revision: membership.revision,
          }));
      },
    },
    facts: { async emit() {} },
  });
  return {
    service: new TeamAssetService({
      ownership,
      ownershipRepo,
      approvals,
      teams,
      ...(fileKnowledge === undefined ? {} : { fileKnowledge }),
    }),
    ownershipRepo,
    approvals,
    putMembership,
    ownership,
  };
}

describe("TeamAssetService", () => {
  describe("reading access to an asset that was never placed under Team ownership", () => {
    const principal = { id: "user-1", kind: "user" };

    it("returns no implicit access", async () => {
      const { service: assets } = service();

      await expect(assets.access("skill", "document-generation", principal)).resolves.toMatchObject(
        { levels: [], canManageOwnership: false }
      );
    });

    it("still withholds ownership management, since there is no ownership to manage", async () => {
      const { service: assets } = service();
      const access = await assets.access("skill", "presentation-generation", principal);

      expect(access.canManageOwnership).toBe(false);
      expect(access.evidence).toEqual([]);
    });

    it("denies edits", async () => {
      const { service: assets } = service();

      await expect(assets.require("skill", "unowned", principal, "edit")).rejects.toMatchObject({
        reason: "forbidden",
      });
    });

    it("still refuses to project ownership that does not exist", async () => {
      const { service: assets } = service();

      await expect(assets.projection("skill", "unowned", principal)).rejects.toThrow();
    });

    it("defers to the record once one exists", async () => {
      const { service: assets } = service();
      await assets.ensure("skill", "shared", { owners: [{ teamId: TEAM_ID }] });

      // The principal is in no Team, so the record now denies what absence would have allowed.
      const access = await assets.access("skill", "shared", principal);
      expect(access.levels).not.toContain("edit");
      await expect(assets.require("skill", "shared", principal, "edit")).rejects.toThrow();
    });
  });

  describe("a File's Knowledge Page after a Team share change", () => {
    const OTHER_TEAM = "223e4567-e89b-42d3-a456-426614174000";
    const sharer: TeamMembershipRecord = {
      teamId: TEAM_ID,
      principalId: "user-1",
      principalKind: "user",
      level: "admin",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("reconciles the Page, narrowing, when a Team share is revoked", async () => {
      // The Page's readership is written from the File's owners and shares. Without this, removing
      // a Team revokes the File but leaves that Team retrieving its text through Knowledge.
      const calls: { fileId: string; widening: boolean }[] = [];
      const { service: assets, ownership } = service([sharer], {
        sync: async (fileId, widening) => {
          calls.push({ fileId, widening });
        },
      });
      const owned = await ownership.create({
        businessId: DEPLOYMENT_BUSINESS_ID,
        assetType: "file",
        assetId: "file-1",
        owners: [{ kind: "team", teamId: TEAM_ID }],
        shares: [],
      });
      const shared = await assets.updateShares(
        "file",
        "file-1",
        [{ teamId: OTHER_TEAM, access: "view" }],
        owned.revision,
        { id: "user-1", kind: "user" }
      );
      await assets.updateShares("file", "file-1", [], shared.revision, {
        id: "user-1",
        kind: "user",
      });

      expect(calls).toEqual([
        { fileId: "file-1", widening: true },
        { fileId: "file-1", widening: false },
      ]);
    });

    it("reconciles the Page when an override completes an owner change nobody approved", async () => {
      // An override completes the same owner change an approval would have, so it moves who may
      // read the File the same way. Skipped, the removed Team keeps retrieving the text.
      const calls: { fileId: string; widening: boolean }[] = [];
      const { service: assets, ownership } = service([sharer], {
        sync: async (fileId, widening) => {
          calls.push({ fileId, widening });
        },
      });
      const owned = await ownership.create({
        businessId: DEPLOYMENT_BUSINESS_ID,
        assetType: "file",
        assetId: "file-override",
        owners: [
          { kind: "team", teamId: TEAM_ID },
          { kind: "team", teamId: OTHER_TEAM },
        ],
        shares: [],
      });
      const operation = await assets.propose(
        {
          assetType: "file",
          assetId: "file-override",
          action: "remove_owner",
          teamId: OTHER_TEAM,
          expectedRevision: owned.revision,
          expiresAt: new Date(Date.now() + 60_000),
        },
        { id: "user-1", kind: "user" }
      );

      await assets.emergencyOverride(
        "file",
        "file-override",
        operation.id,
        "The owning Team is unavailable",
        { id: "company-admin", kind: "user", companyAdmin: true }
      );

      expect(calls).toEqual([{ fileId: "file-override", widening: false }]);
    });

    it("reconciles the Page when the whole ownership projection is dropped", async () => {
      // Dropping it drops every Team that read the File through it — the narrowest change there is.
      const calls: { fileId: string; widening: boolean }[] = [];
      const { service: assets, ownership } = service([sharer], {
        sync: async (fileId, widening) => {
          calls.push({ fileId, widening });
        },
      });
      await ownership.create({
        businessId: DEPLOYMENT_BUSINESS_ID,
        assetType: "file",
        assetId: "file-dropped",
        owners: [{ kind: "team", teamId: TEAM_ID }],
        shares: [],
      });

      await assets.remove("file", "file-dropped");

      expect(calls).toEqual([{ fileId: "file-dropped", widening: false }]);
    });

    it("leaves a Skill's shares alone, since only a File has a Page", async () => {
      const calls: string[] = [];
      const { service: assets } = service([sharer], {
        sync: async (fileId) => {
          calls.push(fileId);
        },
      });
      const owned = await assets.ensure("skill", "skill-1", { owners: [{ teamId: TEAM_ID }] });
      await assets.updateShares(
        "skill",
        "skill-1",
        [{ teamId: OTHER_TEAM, access: "view" }],
        owned.revision,
        { id: "user-1", kind: "user" }
      );

      expect(calls).toEqual([]);
    });
  });

  it.each(["agent", "skill", "routine"] as const)(
    "persists joint Team ownership for a %s",
    async (assetType) => {
      const { service: assets, ownershipRepo } = service();
      await assets.ensure(assetType, `${assetType}-1`, {
        owners: [{ teamId: TEAM_ID }, { teamId: "123e4567-e89b-42d3-a456-426614174001" }],
      });

      await expect(
        ownershipRepo.get(DEPLOYMENT_BUSINESS_ID, assetType, `${assetType}-1`)
      ).resolves.toMatchObject({
        owners: [
          { kind: "team", teamId: TEAM_ID },
          { kind: "team", teamId: "123e4567-e89b-42d3-a456-426614174001" },
        ],
      });
    }
  );

  it("does not turn Agent ownership into Agent Team membership", async () => {
    const { service: assets, putMembership } = service();
    await assets.ensure("agent", "support-agent", { owners: [{ teamId: TEAM_ID }] });

    expect(putMembership).not.toHaveBeenCalled();
  });

  it("allows Approval action only for an admin of the exact required Team", async () => {
    const now = new Date();
    const exactAdmin: TeamMembershipRecord = {
      teamId: TEAM_ID,
      principalId: "admin-1",
      principalKind: "user",
      level: "admin",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { service: assets } = service([exactAdmin]);
    const ownership = await assets.ensure("agent", "agent-1", { owners: [{ teamId: TEAM_ID }] });
    await assets.propose(
      {
        assetType: "agent",
        assetId: "agent-1",
        action: "delete",
        expectedRevision: ownership.revision,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      { id: "admin-1", kind: "user" }
    );

    const { items } = await assets.listApprovalsPage(
      { id: "admin-1", kind: "user" },
      {
        teamId: TEAM_ID,
        limit: 25,
      }
    );
    const [approval] = items;
    expect(approval).toMatchObject({ representedTeamId: TEAM_ID, canDecide: true });
    await expect(
      assets.listApprovalsPage({ id: "outsider", kind: "user" }, { teamId: TEAM_ID, limit: 25 })
    ).rejects.toMatchObject({ reason: "forbidden" });
    await expect(
      assets.listApprovalsPage({ id: "outsider", kind: "user" }, { limit: 25 })
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("requires an owning Team admin or company admin to complete an operation", async () => {
    const now = new Date();
    const exactAdmin: TeamMembershipRecord = {
      teamId: TEAM_ID,
      principalId: "admin-1",
      principalKind: "user",
      level: "admin",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { service: assets } = service([exactAdmin]);
    const ownership = await assets.ensure("agent", "agent-1", { owners: [{ teamId: TEAM_ID }] });
    const operation = await assets.propose(
      {
        assetType: "agent",
        assetId: "agent-1",
        action: "add_owner",
        teamId: "123e4567-e89b-42d3-a456-426614174001",
        expectedRevision: ownership.revision,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      { id: "admin-1", kind: "user" }
    );

    await expect(
      assets.complete("agent", "agent-1", operation.id, {
        id: "outsider",
        kind: "user",
      })
    ).rejects.toMatchObject({ reason: "forbidden" });
  });

  it("completes an add-owner operation after the final live Team Approval", async () => {
    const now = new Date();
    const coOwnerId = "123e4567-e89b-42d3-a456-426614174001";
    const memberships: TeamMembershipRecord[] = [
      {
        teamId: TEAM_ID,
        principalId: "proposer",
        principalKind: "user",
        level: "admin",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        teamId: TEAM_ID,
        principalId: "owner-approver",
        principalKind: "user",
        level: "admin",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        teamId: coOwnerId,
        principalId: "new-owner-approver",
        principalKind: "user",
        level: "admin",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const { service: assets, ownershipRepo } = service(memberships);
    const ownership = await assets.ensure("agent", "agent-auto-complete", {
      owners: [{ teamId: TEAM_ID }],
    });
    const operation = await assets.propose(
      {
        assetType: "agent",
        assetId: "agent-auto-complete",
        action: "add_owner",
        teamId: coOwnerId,
        expectedRevision: ownership.revision,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      { id: "proposer", kind: "user" }
    );

    const pending = await assets.decide(operation.id, TEAM_ID, "approved", {
      id: "owner-approver",
      kind: "user",
    });
    expect(pending.completion).toEqual({ status: "pending", readyToComplete: false });

    const completed = await assets.decide(operation.id, coOwnerId, "approved", {
      id: "new-owner-approver",
      kind: "user",
    });
    expect(completed.completion).toEqual({ status: "completed", readyToComplete: false });
    await expect(
      ownershipRepo.get(DEPLOYMENT_BUSINESS_ID, "agent", "agent-auto-complete")
    ).resolves.toMatchObject({
      revision: 2,
      owners: [
        { kind: "team", teamId: TEAM_ID },
        { kind: "team", teamId: coOwnerId },
      ],
    });
  });

  it("reports a lifecycle operation as ready for its asset mutation", async () => {
    const now = new Date();
    const memberships: TeamMembershipRecord[] = ["proposer", "approver"].map((principalId) => ({
      teamId: TEAM_ID,
      principalId,
      principalKind: "user" as const,
      level: "admin" as const,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const { service: assets } = service(memberships);
    const ownership = await assets.ensure("agent", "agent-ready", {
      owners: [{ teamId: TEAM_ID }],
    });
    const operation = await assets.propose(
      {
        assetType: "agent",
        assetId: "agent-ready",
        action: "archive",
        expectedRevision: ownership.revision,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      { id: "proposer", kind: "user" }
    );

    const decision = await assets.decide(operation.id, TEAM_ID, "approved", {
      id: "approver",
      kind: "user",
    });
    expect(decision.completion).toEqual({ status: "ready", readyToComplete: true });
    await expect(
      assets.listApprovalsPage({ id: "approver", kind: "user" }, { assetType: "agent", limit: 25 })
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          operationId: operation.id,
          readyToComplete: true,
        }),
      ],
      nextCursor: null,
    });
  });

  it("pages filtered open Approvals without reading the historical ledger", async () => {
    const now = new Date();
    const exactAdmin: TeamMembershipRecord = {
      teamId: TEAM_ID,
      principalId: "admin-1",
      principalKind: "user",
      level: "admin",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { service: assets, ownershipRepo, approvals } = service([exactAdmin]);
    for (const assetId of ["agent-a", "agent-b", "skill-history"]) {
      const assetType = assetId.startsWith("skill") ? "skill" : "agent";
      const ownership = await assets.ensure(assetType, assetId, { owners: [{ teamId: TEAM_ID }] });
      const operation = await assets.propose(
        {
          assetType,
          assetId,
          action: "archive",
          expectedRevision: ownership.revision,
          expiresAt: new Date(now.getTime() + 60_000),
        },
        { id: "admin-1", kind: "user" }
      );
      if (assetId === "skill-history") {
        await ownershipRepo.completeEmergencyOperation({
          businessId: DEPLOYMENT_BUSINESS_ID,
          operationId: operation.id,
          at: now,
        });
      }
    }
    const historicalList = vi.spyOn(approvals, "list");
    const operationList = vi.spyOn(ownershipRepo, "listOperations");
    const openReads = vi.spyOn(approvals, "getOpenMany");

    const first = await assets.listApprovalsPage(
      { id: "admin-1", kind: "user" },
      { assetType: "agent", limit: 1 }
    );
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await assets.listApprovalsPage(
      { id: "admin-1", kind: "user" },
      { assetType: "agent", limit: 1, cursor: first.nextCursor as string }
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.operationId).not.toBe(first.items[0]?.operationId);
    expect(second.nextCursor).toBeNull();
    expect(openReads).toHaveBeenCalledWith(
      DEPLOYMENT_BUSINESS_ID,
      expect.any(Array),
      expect.objectContaining({ requiredTeamIds: [TEAM_ID] })
    );
    expect(historicalList).not.toHaveBeenCalled();
    expect(operationList).not.toHaveBeenCalled();
  });

  it("completes a remove-owner operation after every current owner approves", async () => {
    const now = new Date();
    const peerTeamId = "123e4567-e89b-42d3-a456-426614174001";
    const memberships: TeamMembershipRecord[] = [
      ["proposer", TEAM_ID],
      ["owner-approver", TEAM_ID],
      ["peer-approver", peerTeamId],
    ].map(([principalId, teamId]) => ({
      teamId,
      principalId,
      principalKind: "user" as const,
      level: "admin" as const,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const { service: assets } = service(memberships);
    const ownership = await assets.ensure("agent", "agent-remove-owner", {
      owners: [{ teamId: TEAM_ID }, { teamId: peerTeamId }],
    });
    const operation = await assets.propose(
      {
        assetType: "agent",
        assetId: "agent-remove-owner",
        action: "remove_owner",
        teamId: peerTeamId,
        expectedRevision: ownership.revision,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      { id: "proposer", kind: "user" }
    );

    await assets.decide(operation.id, TEAM_ID, "approved", {
      id: "owner-approver",
      kind: "user",
    });
    const completed = await assets.decide(operation.id, peerTeamId, "approved", {
      id: "peer-approver",
      kind: "user",
    });

    expect(completed).toMatchObject({
      completion: { status: "completed", readyToComplete: false },
      ownership: {
        revision: 2,
        owners: [{ kind: "team", teamId: TEAM_ID }],
      },
    });
  });

  it("binds a lifecycle emergency override for the later asset mutation", async () => {
    const now = new Date();
    const memberships: TeamMembershipRecord[] = [
      {
        teamId: TEAM_ID,
        principalId: "proposer",
        principalKind: "user",
        level: "admin",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const { service: assets, approvals, ownershipRepo } = service(memberships);
    const ownership = await assets.ensure("agent", "agent-emergency-archive", {
      owners: [{ teamId: TEAM_ID }],
    });
    const operation = await assets.propose(
      {
        assetType: "agent",
        assetId: "agent-emergency-archive",
        action: "archive",
        expectedRevision: ownership.revision,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      { id: "proposer", kind: "user" }
    );

    await assets.emergencyOverride(
      "agent",
      "agent-emergency-archive",
      operation.id,
      "The owning Team is unavailable",
      { id: "company-admin", kind: "user", companyAdmin: true }
    );

    await expect(
      assets.consumeLifecycleApproval("agent", "agent-emergency-archive", "archive", operation.id)
    ).resolves.toBeUndefined();
    await expect(
      ownershipRepo.getOperation(DEPLOYMENT_BUSINESS_ID, operation.id)
    ).resolves.toMatchObject({ status: "completed" });
    expect((await approvals.get(DEPLOYMENT_BUSINESS_ID, operation.id))?.consumedAt).toBeUndefined();
  });
});

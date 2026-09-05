import { AssetOwnershipAccessService, AssetOwnershipService } from "@tulipfarm/authz";
import { InMemoryApprovalRepo, InMemoryAssetOwnershipRepo } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { KnowledgeOwnershipProjector, knowledgeAssetId } from "./ownership";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const TEAM_A = "team-a";
const TEAM_B = "team-b";

describe("KnowledgeOwnershipProjector", () => {
  it("consumes a pending unanimous Approval as part of the exact Knowledge deletion", async () => {
    const liveRoles = new Map([
      ["admin-a", [`team:${TEAM_A}:admin`]],
      ["admin-b", [`team:${TEAM_B}:admin`]],
    ]);
    const approvals = new InMemoryApprovalRepo(
      [],
      async (_businessId, principalId) => liveRoles.get(principalId) ?? []
    );
    const ownership = new InMemoryAssetOwnershipRepo([], [], approvals);
    const memberships = {
      async resolveMembers(_businessId: string, teamId: string) {
        return [
          {
            membership: "direct" as const,
            sourceTeamId: teamId,
            pathTeamIds: [teamId],
            principalId: teamId === TEAM_A ? "admin-a" : "admin-b",
            principalKind: "user" as const,
            level: "admin" as const,
            removable: true,
            revision: 1,
          },
        ];
      },
    };
    const domain = new AssetOwnershipService({
      ownership,
      approvals,
      memberships,
      facts: { async emit() {} },
      now: () => NOW,
      newId: () => "operation-1",
    });
    const record = await domain.create({
      businessId: "business-1",
      assetType: "knowledge",
      assetId: knowledgeAssetId("page", "page-1"),
      owners: [
        { kind: "team", teamId: TEAM_A },
        { kind: "team", teamId: TEAM_B },
      ],
      shares: [],
    });
    const operation = await domain.propose({
      businessId: record.businessId,
      assetType: record.assetType,
      assetId: record.assetId,
      action: "delete",
      expectedRevision: record.revision,
      proposerPrincipalId: "proposer",
      actor: {
        principalId: "admin-a",
        principalKind: "user",
        companyAdmin: false,
        administeredTeamIds: [TEAM_A],
      },
      expiresAt: new Date("2026-09-05T13:00:00.000Z"),
    });
    for (const [principalId, teamId] of [
      ["admin-a", TEAM_A],
      ["admin-b", TEAM_B],
    ] as const) {
      await domain.decide({
        businessId: record.businessId,
        operationId: operation.id,
        actor: {
          principalId,
          principalKind: "user",
          companyAdmin: false,
          administeredTeamIds: [teamId],
        },
        representedTeamId: teamId,
        outcome: "approved",
      });
    }
    const access = new AssetOwnershipAccessService({
      ownership,
      memberships,
      everyoneTeamId: async () => TEAM_A,
      now: () => NOW,
    });
    const projector = new KnowledgeOwnershipProjector(ownership, access);

    await projector.consumeDestructiveApproval(record.businessId, "page", "page-1", operation.id);

    await expect(ownership.getOperation(record.businessId, operation.id)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(approvals.get(record.businessId, operation.approvalId)).resolves.toMatchObject({
      consumedAt: NOW,
    });
  });
});

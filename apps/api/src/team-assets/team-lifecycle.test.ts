import { InMemoryAssetOwnershipRepo } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { TeamAssetLifecycle } from "./team-lifecycle";

const BUSINESS_ID = "business-1";
const TEAM_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_TEAM_ID = "123e4567-e89b-42d3-a456-426614174001";
const NOW = new Date("2026-09-05T12:00:00.000Z");

function ownership(
  owners: readonly string[],
  shares: readonly { teamId: string; access: "view" | "use" | "edit" }[] = []
) {
  return {
    businessId: BUSINESS_ID,
    assetType: "agent" as const,
    assetId: "agent-1",
    owners: owners.map((teamId) => ({ kind: "team" as const, teamId })),
    shares,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("TeamAssetLifecycle", () => {
  it("projects repository ownership and sharing into Team move impact", async () => {
    const lifecycle = new TeamAssetLifecycle({
      ownership: new InMemoryAssetOwnershipRepo([
        ownership([TEAM_ID], [{ teamId: OTHER_TEAM_ID, access: "use" }]),
      ]),
    });

    await expect(
      lifecycle.listTeamAssetLinks(BUSINESS_ID, [TEAM_ID, OTHER_TEAM_ID])
    ).resolves.toEqual([
      {
        assetType: "agent",
        assetId: "agent-1",
        teamId: TEAM_ID,
        relation: "owner",
        access: "edit",
        revision: 3,
      },
      {
        assetType: "agent",
        assetId: "agent-1",
        teamId: OTHER_TEAM_ID,
        relation: "share",
        access: "use",
        revision: 3,
      },
    ]);
  });
});

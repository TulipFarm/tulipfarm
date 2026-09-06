import type { TeamMoveAssetImpactPort, TeamMoveAssetLink } from "@tulipfarm/authz";
import type { AssetOwnershipRecord } from "@tulipfarm/storage";

interface TeamAssetLifecycleDeps {
  readonly ownership: {
    listByTeam(businessId: string, teamIds: readonly string[]): Promise<AssetOwnershipRecord[]>;
  };
}

export class TeamAssetLifecycle implements TeamMoveAssetImpactPort {
  constructor(private readonly deps: TeamAssetLifecycleDeps) {}

  async listTeamAssetLinks(
    businessId: string,
    teamIds: readonly string[]
  ): Promise<readonly TeamMoveAssetLink[]> {
    const included = new Set(teamIds);
    const records = await this.deps.ownership.listByTeam(businessId, teamIds);
    return records.flatMap((record) => [
      ...record.owners.flatMap((owner) =>
        owner.kind === "team" && included.has(owner.teamId)
          ? [
              {
                assetType: record.assetType,
                assetId: record.assetId,
                teamId: owner.teamId,
                relation: "owner" as const,
                access: "edit" as const,
                revision: record.revision,
              },
            ]
          : []
      ),
      ...record.shares.flatMap((share) =>
        included.has(share.teamId)
          ? [
              {
                assetType: record.assetType,
                assetId: record.assetId,
                teamId: share.teamId,
                relation: "share" as const,
                access: share.access,
                revision: record.revision,
              },
            ]
          : []
      ),
    ]);
  }
}

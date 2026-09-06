import { AssetOwnershipAccessService, AssetOwnershipError, TeamService } from "@tulipfarm/authz";
import { FileError, type FileOwnershipPort } from "@tulipfarm/files";
import {
  PgAssetOwnershipRepo,
  PgPrincipalRepo,
  PgTeamRepo,
  type TransactionPort,
} from "@tulipfarm/storage";

export function buildFileOwnershipPort(transactions: TransactionPort): FileOwnershipPort {
  const teams = new PgTeamRepo(transactions);
  const memberships = new TeamService({
    teams,
    principals: new PgPrincipalRepo(transactions),
    lifecycleGuard: {
      async assertArchiveReady() {},
      async assertDeleteReady() {},
    },
    facts: { async emit() {} },
  });
  const access = new AssetOwnershipAccessService({
    ownership: new PgAssetOwnershipRepo(transactions),
    memberships,
    everyoneTeamId: async (businessId) => (await teams.ensureEveryone(businessId)).id,
    activeTeamIds: async (businessId) =>
      (await teams.listTeams(businessId))
        .filter((team) => team.status === "active")
        .map((team) => team.id),
  });

  return {
    createPersonal: async (businessId, fileId, principalId) => {
      await access.ensurePersonal(businessId, "file", fileId, principalId);
    },
    get: async (businessId, fileId) => {
      const ownership = await access.get(businessId, "file", fileId);
      return ownership === undefined ? undefined : { ...ownership, assetType: "file" as const };
    },
    accessFor: (ownership, principalId, principalKind) =>
      access.accessFor(ownership, { principalId, principalKind }),
    consumeDestructiveApproval: async (ownership, action, operationId) => {
      try {
        await access.consumeDestructiveApproval(ownership, action, operationId);
      } catch (error) {
        if (error instanceof AssetOwnershipError) {
          throw new FileError("invalid_state", error.message);
        }
        throw error;
      }
    },
    teamReadableFileIds: (businessId, principalId, principalKind) =>
      access.teamReachableAssetIds(businessId, "file", { principalId, principalKind }),
    teamGrantCounts: (businessId, fileIds) => access.teamGrantCounts(businessId, "file", fileIds),
    unreadableAmong: (businessId, principalId, principalKind, fileIds) =>
      access.unviewableAmong(businessId, "file", { principalId, principalKind }, fileIds),
  };
}

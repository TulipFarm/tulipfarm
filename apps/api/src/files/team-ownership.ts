import { AssetOwnershipAccessService, AssetOwnershipError, TeamService } from "@tulipfarm/authz";
import { FileError, type FileOwnershipPort } from "@tulipfarm/files";
import type { PrincipalRepo, TeamRepo } from "@tulipfarm/storage";
import {
  PgApprovalGrantRepo,
  PgAssetOwnershipRepo,
  type TransactionPort,
} from "@tulipfarm/storage";

export function buildFileOwnershipPort(
  transactions: TransactionPort,
  teams: TeamRepo,
  principals: PrincipalRepo
): FileOwnershipPort {
  const memberships = new TeamService({
    teams,
    principals,
    lifecycleGuard: {
      async assertArchiveReady() {},
      async assertDeleteReady() {},
    },
    facts: { async emit() {} },
  });
  const access = new AssetOwnershipAccessService({
    ownership: new PgAssetOwnershipRepo(transactions),
    approvals: new PgApprovalGrantRepo(transactions),
    memberships,
    everyoneTeamId: async (businessId) => (await teams.ensureEveryone(businessId)).id,
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
  };
}

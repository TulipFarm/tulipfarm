import type { AssetOwnershipRecord, AssetOwnershipService } from "@tulipfarm/authz";
import { AssetOwnershipError } from "@tulipfarm/authz";
import type { TeamAssetAccessLevel, TeamAssetType } from "@tulipfarm/schema";
import type {
  ApprovalGrantRecord,
  AssetOwnershipCursor,
  AssetOwnershipOperationRecord,
  TeamRecord,
} from "@tulipfarm/storage";
import type { AssetPrincipal } from "./service";

export type TeamAssetSource = "owned" | "inherited" | "shared";
export type TeamAssetLifecycleStatus = "active" | "archived" | "pending";

export interface TeamAssetCatalogMetadata {
  readonly assetType: TeamAssetType;
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly href: string | null;
  readonly lifecycleStatus: Exclude<TeamAssetLifecycleStatus, "pending">;
}

export interface TeamAssetCatalogMetadataProvider {
  load(
    records: readonly Pick<AssetOwnershipRecord, "assetType" | "assetId">[]
  ): Promise<ReadonlyMap<string, TeamAssetCatalogMetadata>>;
}

export interface TeamAssetCatalogDeps {
  readonly businessId: string;
  readonly ownership: AssetOwnershipService;
  readonly ownershipRepo: {
    listByTeamsPage(
      businessId: string,
      teamIds: readonly string[],
      options: {
        readonly limit: number;
        readonly after?: AssetOwnershipCursor;
        readonly assetType?: TeamAssetType;
        readonly ownerTeamId?: string;
      }
    ): Promise<{ readonly records: readonly AssetOwnershipRecord[]; readonly hasMore: boolean }>;
  };
  readonly teams: {
    getTeam(businessId: string, teamId: string): Promise<TeamRecord | undefined>;
    listTeams(businessId: string): Promise<TeamRecord[]>;
  };
  readonly approvals: {
    getMany(businessId: string, approvalIds: readonly string[]): Promise<ApprovalGrantRecord[]>;
  };
  readonly operations: {
    listOperationsForAssets(
      businessId: string,
      assets: readonly AssetOwnershipCursor[],
      status?: "pending" | "completed"
    ): Promise<AssetOwnershipOperationRecord[]>;
  };
  readonly metadata: TeamAssetCatalogMetadataProvider;
  readonly now?: () => Date;
}

export interface TeamAssetCatalogQuery {
  readonly teamId: string;
  readonly principal: AssetPrincipal;
  readonly assetType?: TeamAssetType;
  readonly source?: TeamAssetSource;
  readonly access?: TeamAssetAccessLevel;
  readonly ownerTeamId?: string;
  readonly lifecycleStatus?: TeamAssetLifecycleStatus;
  readonly cursor?: string;
  readonly limit: number;
  readonly approvalActor: {
    readonly principalId: string;
    readonly companyAdmin: boolean;
    readonly administeredTeamIds: readonly string[];
  };
}

const READ_BATCH = 100;
const MAX_SCANNED = 500;

export function teamAssetKey(assetType: TeamAssetType, assetId: string): string {
  return `${assetType}\u0000${assetId}`;
}

function encodeCursor(cursor: AssetOwnershipCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): AssetOwnershipCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      assetType?: unknown;
      assetId?: unknown;
    };
    if (
      typeof parsed.assetType !== "string" ||
      !["agent", "skill", "routine", "file", "knowledge"].includes(parsed.assetType) ||
      typeof parsed.assetId !== "string" ||
      parsed.assetId.length === 0
    ) {
      return undefined;
    }
    return { assetType: parsed.assetType as TeamAssetType, assetId: parsed.assetId };
  } catch {
    return undefined;
  }
}

function ancestorsOf(team: TeamRecord, teams: readonly TeamRecord[]): string[] {
  const byId = new Map(teams.map((candidate) => [candidate.id, candidate]));
  const ancestors: string[] = [];
  const seen = new Set([team.id]);
  let parentId = team.parentTeamId;
  while (parentId !== undefined && ancestors.length < 10) {
    if (seen.has(parentId)) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent.id);
    seen.add(parent.id);
    parentId = parent.parentTeamId;
  }
  return ancestors;
}

function sourceFor(
  ownership: AssetOwnershipRecord,
  teamId: string,
  ancestorTeamIds: ReadonlySet<string>
): { readonly source: TeamAssetSource; readonly sourceTeamIds: readonly string[] } | undefined {
  const exactOwners = ownership.owners.flatMap((owner) =>
    owner.kind === "team" && owner.teamId === teamId ? [owner.teamId] : []
  );
  if (exactOwners.length > 0) return { source: "owned", sourceTeamIds: exactOwners };

  const inheritedOwners = ownership.owners.flatMap((owner) =>
    owner.kind === "team" && ancestorTeamIds.has(owner.teamId) ? [owner.teamId] : []
  );
  if (inheritedOwners.length > 0) {
    return { source: "inherited", sourceTeamIds: inheritedOwners };
  }

  const relevantTeams = new Set([teamId, ...ancestorTeamIds]);
  const shares = ownership.shares
    .filter((share) => relevantTeams.has(share.teamId))
    .map((share) => share.teamId);
  return shares.length === 0 ? undefined : { source: "shared", sourceTeamIds: shares };
}

function pendingApprovalSummary(
  operation: AssetOwnershipOperationRecord,
  approval: ApprovalGrantRecord,
  actor: TeamAssetCatalogQuery["approvalActor"]
) {
  const denied = approval.decisions.some((decision) => decision.outcome === "denied");
  const requiredTeamIds = approval.requiredApproverRoles
    .map((role) => /^team:(.+):admin$/.exec(role)?.[1])
    .filter((teamId): teamId is string => teamId !== undefined);
  const representedTeamId = requiredTeamIds.find(
    (teamId) =>
      actor.administeredTeamIds.includes(teamId) &&
      !approval.decisions.some((decision) => decision.approverPrincipalId === actor.principalId)
  );
  const readyToComplete =
    !denied &&
    approval.requiredApproverRoles.every((role) =>
      approval.decisions.some(
        (decision) => decision.outcome === "approved" && decision.satisfiedApproverRole === role
      )
    );
  return {
    approvalId: approval.approvalId,
    operationId: operation.id,
    action: operation.action,
    risk: approval.risk,
    preview: approval.preview,
    riskSummary: approval.riskSummary,
    status: denied ? ("denied" as const) : ("pending" as const),
    requiredTeamIds,
    decisions: approval.decisions.length,
    requiredDecisions: approval.requiredApproverRoles.length,
    readyToComplete,
    representedTeamId: representedTeamId ?? null,
    canDecide: representedTeamId !== undefined && !denied && approval.expiresAt > new Date(),
    expiresAt: approval.expiresAt.toISOString(),
    createdAt: approval.createdAt.toISOString(),
  };
}

export class TeamAssetCatalogService {
  private readonly now: () => Date;

  constructor(private readonly deps: TeamAssetCatalogDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(query: TeamAssetCatalogQuery) {
    const team = await this.deps.teams.getTeam(this.deps.businessId, query.teamId);
    if (!team) throw new AssetOwnershipError("not_found", "Team was not found");
    const ancestors = ancestorsOf(team, await this.deps.teams.listTeams(this.deps.businessId));
    const relevantTeamIds = [team.id, ...ancestors];
    const ancestorSet = new Set(ancestors);
    const items: Array<{
      id: string;
      type: TeamAssetType;
      label: string;
      description: string | null;
      href: string | null;
      lifecycleStatus: TeamAssetLifecycleStatus;
      source: TeamAssetSource;
      sourceTeamIds: readonly string[];
      effectiveLevels: readonly TeamAssetAccessLevel[];
      canManageOwnership: boolean;
      ownership: {
        revision: number;
        owners: AssetOwnershipRecord["owners"];
        shares: AssetOwnershipRecord["shares"];
      } | null;
      pendingApprovals: readonly ReturnType<typeof pendingApprovalSummary>[];
    }> = [];
    let after = decodeCursor(query.cursor);
    if (query.cursor !== undefined && after === undefined) {
      throw new AssetOwnershipError("invalid_ownership", "Invalid Team asset cursor");
    }
    let scanned = 0;
    let hasMore = false;

    while (items.length < query.limit && scanned < MAX_SCANNED) {
      const batch = await this.deps.ownershipRepo.listByTeamsPage(
        this.deps.businessId,
        relevantTeamIds,
        {
          limit: Math.min(READ_BATCH, MAX_SCANNED - scanned),
          ...(after === undefined ? {} : { after }),
          ...(query.assetType === undefined ? {} : { assetType: query.assetType }),
          ...(query.ownerTeamId === undefined ? {} : { ownerTeamId: query.ownerTeamId }),
        }
      );
      if (batch.records.length === 0) {
        hasMore = false;
        break;
      }
      scanned += batch.records.length;
      const [metadata, access, operations] = await Promise.all([
        this.deps.metadata.load(batch.records),
        this.deps.ownership.accessMany(batch.records, {
          principalId: query.principal.id,
          principalKind: query.principal.kind,
        }),
        this.deps.operations.listOperationsForAssets(
          this.deps.businessId,
          batch.records.map((record) => ({
            assetType: record.assetType,
            assetId: record.assetId,
          })),
          "pending"
        ),
      ]);
      const approvals = await this.deps.approvals.getMany(
        this.deps.businessId,
        operations.map((operation) => operation.approvalId)
      );
      const approvalById = new Map(approvals.map((approval) => [approval.approvalId, approval]));
      const approvalsByAsset = new Map<string, ReturnType<typeof pendingApprovalSummary>[]>();
      for (const operation of operations) {
        const approval = approvalById.get(operation.approvalId);
        if (
          !approval ||
          approval.consumedAt ||
          approval.revokedAt ||
          approval.expiresAt <= this.now() ||
          approval.decisions.some((decision) => decision.outcome === "denied")
        ) {
          continue;
        }
        const key = teamAssetKey(operation.assetType, operation.assetId);
        approvalsByAsset.set(key, [
          ...(approvalsByAsset.get(key) ?? []),
          pendingApprovalSummary(operation, approval, query.approvalActor),
        ]);
      }

      let processed = 0;
      for (const ownership of batch.records) {
        processed += 1;
        after = { assetType: ownership.assetType, assetId: ownership.assetId };
        const source = sourceFor(ownership, team.id, ancestorSet);
        const rowMetadata = metadata.get(teamAssetKey(ownership.assetType, ownership.assetId));
        const projection = access.get(teamAssetKey(ownership.assetType, ownership.assetId));
        if (!source || !rowMetadata || !projection) continue;
        if (projection.levels.length === 0 && !query.approvalActor.companyAdmin) continue;
        const canSeeGovernance = query.approvalActor.companyAdmin || projection.canManageOwnership;
        const pendingApprovals =
          approvalsByAsset.get(teamAssetKey(ownership.assetType, ownership.assetId)) ?? [];
        const lifecycleStatus =
          canSeeGovernance && pendingApprovals.length > 0 ? "pending" : rowMetadata.lifecycleStatus;
        if (
          (query.source !== undefined && source.source !== query.source) ||
          (query.access !== undefined && !projection.levels.includes(query.access)) ||
          (query.lifecycleStatus !== undefined && lifecycleStatus !== query.lifecycleStatus)
        ) {
          continue;
        }
        items.push({
          id: ownership.assetId,
          type: ownership.assetType,
          label: rowMetadata.label,
          description: rowMetadata.description,
          href: rowMetadata.href,
          lifecycleStatus,
          source: source.source,
          sourceTeamIds: canSeeGovernance ? source.sourceTeamIds : [],
          effectiveLevels: projection.levels,
          canManageOwnership: projection.canManageOwnership,
          ownership: canSeeGovernance
            ? {
                revision: ownership.revision,
                owners: ownership.owners,
                shares: ownership.shares,
              }
            : null,
          pendingApprovals: canSeeGovernance ? pendingApprovals : [],
        });
        if (items.length === query.limit) break;
      }
      hasMore = processed < batch.records.length || batch.hasMore;
      if (items.length === query.limit || !batch.hasMore) break;
    }

    return {
      items,
      nextCursor: hasMore && after !== undefined ? encodeCursor(after) : null,
    };
  }
}

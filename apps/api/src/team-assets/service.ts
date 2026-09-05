import {
  type AssetAccessProjection,
  AssetOwnershipError,
  type AssetOwnershipOperationAction,
  type AssetOwnershipRecord,
  type AssetOwnershipService,
  type TeamActorCapabilities,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  TeamAssetAccessLevel,
  TeamAssetType,
  TeamBusinessAssetOwnership,
} from "@tulipfarm/schema";
import type {
  ApprovalGrantRecord,
  ApprovalRepo,
  AssetOwnershipCursor,
  AssetOwnershipOperationCursor,
  AssetOwnershipOperationRecord,
  TeamRepo,
} from "@tulipfarm/storage";
import {
  type TeamAssetCatalogMetadataProvider,
  type TeamAssetCatalogQuery,
  TeamAssetCatalogService,
} from "./catalog";

export interface AssetPrincipal {
  readonly id: string;
  readonly kind: string;
  readonly companyAdmin?: boolean;
}

const NO_ACCESS: AssetAccessProjection = {
  levels: [],
  canManageOwnership: false,
  evidence: [],
};

export interface FileKnowledgeReconciler {
  /**
   * @param widening Whether the change only added readers. A narrowing change that cannot be
   * propagated must fail closed, because the alternative leaves a revoked reader able to retrieve
   * the File through Knowledge.
   */
  sync(fileId: string, widening: boolean): Promise<void>;
}

export interface TeamAssetServiceDeps {
  readonly ownership: AssetOwnershipService;
  readonly ownershipRepo: {
    get(
      businessId: string,
      assetType: TeamAssetType,
      assetId: string
    ): Promise<AssetOwnershipRecord | undefined>;
    getOperation(
      businessId: string,
      operationId: string
    ): Promise<
      | {
          readonly assetType: TeamAssetType;
          readonly assetId: string;
          readonly action: AssetOwnershipOperationAction;
          readonly status: "pending" | "completed";
          readonly expectedOwnershipRevision: number;
        }
      | undefined
    >;
    delete(businessId: string, assetType: TeamAssetType, assetId: string): Promise<void>;
    listOperations(
      businessId: string,
      status?: "pending" | "completed"
    ): Promise<AssetOwnershipOperationRecord[]>;
    listOperationsPage(
      businessId: string,
      options: {
        readonly status?: "pending" | "completed";
        readonly assetType?: TeamAssetType;
        readonly assetId?: string;
        readonly after?: AssetOwnershipOperationCursor;
        readonly limit: number;
      }
    ): Promise<{
      readonly records: readonly AssetOwnershipOperationRecord[];
      readonly hasMore: boolean;
    }>;
    listOperationsForAssets(
      businessId: string,
      assets: readonly AssetOwnershipCursor[],
      status?: "pending" | "completed"
    ): Promise<AssetOwnershipOperationRecord[]>;
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
  readonly approvals: Pick<ApprovalRepo, "get" | "getMany" | "getOpenMany">;
  readonly teams: TeamRepo;
  /**
   * Re-points an indexed File's Knowledge Page at its current readership.
   *
   * A File's Page carries an ACL written from the File's owners and shares, so an ownership change
   * that never reaches it leaves a revoked Team still retrieving the text. Absent leaves the
   * reconciliation undone, which is only correct in compositions that index nothing.
   */
  readonly fileKnowledge?: FileKnowledgeReconciler;
  readonly catalogMetadata?: TeamAssetCatalogMetadataProvider;
  readonly catalogMemberships?: {
    resolvePrincipalForTeams(
      businessId: string,
      teamIds: readonly string[],
      principalId: string
    ): Promise<ReadonlyMap<string, readonly unknown[]>>;
  };
  readonly businessId?: string;
  readonly now?: () => Date;
}

interface TeamAssetApprovalQuery {
  readonly teamId?: string;
  readonly assetType?: TeamAssetType;
  readonly assetId?: string;
  readonly cursor?: string;
  readonly limit: number;
}

interface TeamAssetApprovalPage {
  readonly items: ReturnType<typeof approvalView>[];
  readonly nextCursor: string | null;
}

export class TeamAssetService {
  private readonly businessId: string;
  private readonly now: () => Date;

  constructor(private readonly deps: TeamAssetServiceDeps) {
    this.businessId = deps.businessId ?? DEPLOYMENT_BUSINESS_ID;
    this.now = deps.now ?? (() => new Date());
  }

  async ensure(
    assetType: Extract<TeamAssetType, "agent" | "skill" | "routine">,
    assetId: string,
    metadata?: TeamBusinessAssetOwnership
  ): Promise<AssetOwnershipRecord> {
    const current = await this.deps.ownershipRepo.get(this.businessId, assetType, assetId);
    if (current) return current;
    const ownerTeamIds = metadata?.owners.map((owner) => owner.teamId) ?? [
      (await this.deps.teams.ensureEveryone(this.businessId)).id,
    ];
    if (new Set(ownerTeamIds).size !== ownerTeamIds.length) {
      throw new AssetOwnershipError("invalid_ownership", "An owning Team may be listed only once");
    }
    const shareTeamIds = metadata?.shares?.map((share) => share.teamId) ?? [];
    if (new Set(shareTeamIds).size !== shareTeamIds.length) {
      throw new AssetOwnershipError("invalid_ownership", "A shared Team may be listed only once");
    }
    for (const teamId of [...ownerTeamIds, ...shareTeamIds]) {
      const team = await this.deps.teams.getTeam(this.businessId, teamId);
      if (team?.status !== "active") {
        throw new AssetOwnershipError(
          "invalid_ownership",
          "Asset owners and shares must name active Teams"
        );
      }
    }
    try {
      return await this.deps.ownership.create({
        businessId: this.businessId,
        assetType,
        assetId,
        owners: ownerTeamIds.map((teamId) => ({ kind: "team" as const, teamId })),
        shares: metadata?.shares ?? [],
      });
    } catch (error) {
      const raced = await this.deps.ownershipRepo.get(this.businessId, assetType, assetId);
      if (raced) return raced;
      throw error;
    }
  }

  async access(
    assetType: TeamAssetType,
    assetId: string,
    principal: AssetPrincipal,
    metadata?: TeamBusinessAssetOwnership
  ): Promise<AssetAccessProjection> {
    if (metadata) {
      await this.ensureBusinessAsset(assetType, assetId, metadata);
    } else if (!(await this.deps.ownershipRepo.get(this.businessId, assetType, assetId))) {
      return NO_ACCESS;
    }
    return this.deps.ownership.access(this.businessId, assetType, assetId, {
      principalId: principal.id,
      principalKind: principal.kind,
    });
  }

  async projection(
    assetType: TeamAssetType,
    assetId: string,
    principal: AssetPrincipal,
    metadata?: TeamBusinessAssetOwnership
  ) {
    const ownership = metadata
      ? await this.ensureBusinessAsset(assetType, assetId, metadata)
      : await this.requireExisting(assetType, assetId);
    const access = await this.deps.ownership.access(this.businessId, assetType, assetId, {
      principalId: principal.id,
      principalKind: principal.kind,
    });
    return { ownership, access };
  }

  async listCatalog(
    query: Omit<TeamAssetCatalogQuery, "approvalActor" | "principal">,
    principal: AssetPrincipal
  ) {
    if (this.deps.catalogMetadata === undefined) {
      throw new AssetOwnershipError("not_found", "Team asset catalog is unavailable");
    }
    if (!principal.companyAdmin) {
      const membership = await this.deps.catalogMemberships?.resolvePrincipalForTeams(
        this.businessId,
        [query.teamId],
        principal.id
      );
      if ((membership?.get(query.teamId)?.length ?? 0) === 0) {
        throw new AssetOwnershipError("forbidden", "Team membership is required");
      }
    }
    const actor = await this.actor(principal);
    return new TeamAssetCatalogService({
      businessId: this.businessId,
      ownership: this.deps.ownership,
      ownershipRepo: this.deps.ownershipRepo,
      teams: this.deps.teams,
      approvals: this.deps.approvals,
      operations: this.deps.ownershipRepo,
      metadata: this.deps.catalogMetadata,
    }).list({
      ...query,
      principal,
      approvalActor: {
        principalId: actor.principalId,
        companyAdmin: actor.companyAdmin,
        administeredTeamIds: actor.administeredTeamIds,
      },
    });
  }

  async listApprovals(principal: AssetPrincipal): Promise<TeamAssetApprovalPage["items"]> {
    return (await this.queryApprovals(principal, { limit: 100 })).items;
  }

  listApprovalsPage(
    principal: AssetPrincipal,
    query: TeamAssetApprovalQuery
  ): Promise<TeamAssetApprovalPage> {
    return this.queryApprovals(principal, query);
  }

  private async queryApprovals(
    principal: AssetPrincipal,
    query: TeamAssetApprovalQuery
  ): Promise<TeamAssetApprovalPage> {
    const actor = await this.actor(principal);
    if (query.teamId && !actor.companyAdmin && !actor.administeredTeamIds.includes(query.teamId)) {
      throw new AssetOwnershipError("forbidden", "An exact Team admin is required");
    }
    const requiredTeamIds = query.teamId
      ? [query.teamId]
      : actor.companyAdmin
        ? undefined
        : actor.administeredTeamIds;
    if (requiredTeamIds?.length === 0) {
      return { items: [], nextCursor: null };
    }
    let after = decodeApprovalCursor(query.cursor);
    if (query.cursor !== undefined && after === undefined) {
      throw new AssetOwnershipError("invalid_ownership", "Invalid Approval cursor");
    }
    const items: ReturnType<typeof approvalView>[] = [];
    let hasMore = false;
    let scanned = 0;
    while (items.length < query.limit && scanned < MAX_APPROVALS_SCANNED) {
      const page = await this.deps.ownershipRepo.listOperationsPage(this.businessId, {
        status: "pending",
        limit: Math.min(APPROVAL_READ_BATCH, MAX_APPROVALS_SCANNED - scanned),
        ...(query.assetType === undefined ? {} : { assetType: query.assetType }),
        ...(query.assetId === undefined ? {} : { assetId: query.assetId }),
        ...(after === undefined ? {} : { after }),
      });
      if (page.records.length === 0) {
        hasMore = false;
        break;
      }
      scanned += page.records.length;
      const approvals = await this.deps.approvals.getOpenMany(
        this.businessId,
        page.records.map((operation) => operation.approvalId),
        {
          at: this.now(),
          ...(requiredTeamIds === undefined ? {} : { requiredTeamIds }),
        }
      );
      const approvalById = new Map(approvals.map((approval) => [approval.approvalId, approval]));
      let processed = 0;
      for (const operation of page.records) {
        processed += 1;
        after = { createdAt: operation.createdAt, id: operation.id };
        const approval = approvalById.get(operation.approvalId);
        if (!approval) continue;
        const requiredTeamIds = approval.requiredApproverRoles
          .map(teamIdFromApprovalRole)
          .filter((teamId): teamId is string => teamId !== undefined);
        const representedTeamId = requiredTeamIds.find(
          (teamId) =>
            actor.administeredTeamIds.includes(teamId) &&
            !approval.decisions.some(
              (decision) => decision.approverPrincipalId === actor.principalId
            )
        );
        items.push(
          approvalView(operation, approval, requiredTeamIds, representedTeamId, this.now())
        );
        if (items.length === query.limit) break;
      }
      hasMore = processed < page.records.length || page.hasMore;
      if (items.length === query.limit || !page.hasMore) break;
    }
    return {
      items,
      nextCursor: hasMore && after !== undefined ? encodeApprovalCursor(after) : null,
    };
  }

  async require(
    assetType: TeamAssetType,
    assetId: string,
    principal: AssetPrincipal,
    level: TeamAssetAccessLevel,
    metadata?: TeamBusinessAssetOwnership
  ): Promise<AssetAccessProjection> {
    const projection = await this.access(assetType, assetId, principal, metadata);
    if (!projection.levels.includes(level)) {
      throw new AssetOwnershipError("forbidden", `${level} access is required`);
    }
    return projection;
  }

  async propose(
    input: {
      assetType: TeamAssetType;
      assetId: string;
      action: AssetOwnershipOperationAction;
      teamId?: string;
      expectedRevision: number;
      expiresAt: Date;
    },
    principal: AssetPrincipal
  ) {
    if (input.action === "add_owner" && input.teamId) {
      const team = await this.deps.teams.getTeam(this.businessId, input.teamId);
      if (team?.status !== "active") {
        throw new AssetOwnershipError("invalid_ownership", "A new owner must be an active Team");
      }
    }
    return this.deps.ownership.propose({
      businessId: this.businessId,
      ...input,
      proposerPrincipalId: principal.id,
      actor: await this.actor(principal),
    });
  }

  async decide(
    operationId: string,
    representedTeamId: string,
    outcome: "approved" | "denied",
    principal: AssetPrincipal
  ) {
    const approval = await this.deps.ownership.decide({
      businessId: this.businessId,
      operationId,
      actor: await this.actor(principal),
      representedTeamId,
      outcome,
    });
    const operation = await this.deps.ownershipRepo.getOperation(this.businessId, operationId);
    const readyToComplete =
      outcome === "approved" &&
      approval.requiredApproverRoles.every((role) =>
        approval.decisions.some(
          (decision) => decision.outcome === "approved" && decision.satisfiedApproverRole === role
        )
      );
    if (
      readyToComplete &&
      operation &&
      (operation.action === "add_owner" || operation.action === "remove_owner")
    ) {
      try {
        const ownership = await this.deps.ownership.complete(this.businessId, operationId);
        await this.reconcileFileOwners(operation.assetType, operation.assetId, operation.action);
        return {
          ...approval,
          completion: { status: "completed" as const, readyToComplete: false },
          ownership,
        };
      } catch (error) {
        if (!(error instanceof AssetOwnershipError) || error.reason !== "pending_approval") {
          throw error;
        }
      }
    }
    return {
      ...approval,
      completion: {
        status: readyToComplete ? ("ready" as const) : ("pending" as const),
        readyToComplete,
      },
      ownership: null,
    };
  }

  async emergencyOverride(
    assetType: TeamAssetType,
    assetId: string,
    operationId: string,
    reason: string,
    principal: AssetPrincipal
  ) {
    const operation = await this.deps.ownershipRepo.getOperation(this.businessId, operationId);
    if (!operation || operation.assetType !== assetType || operation.assetId !== assetId) {
      throw new AssetOwnershipError("not_found", "Ownership operation was not found");
    }
    const overridden = await this.deps.ownership.emergencyOverride({
      businessId: this.businessId,
      assetType,
      assetId,
      operationId,
      actor: await this.actor(principal),
      reason,
    });
    // An override completes the same owner change an approval would have, so it moves readership
    // the same way and owes the Page the same reconciliation.
    await this.reconcileFileOwners(assetType, assetId, operation.action);
    return overridden;
  }

  async complete(
    assetType: TeamAssetType,
    assetId: string,
    operationId: string,
    principal: AssetPrincipal
  ) {
    const operation = await this.deps.ownershipRepo.getOperation(this.businessId, operationId);
    if (!operation || operation.assetType !== assetType || operation.assetId !== assetId) {
      throw new AssetOwnershipError("not_found", "Ownership operation was not found");
    }
    if (operation.action !== "add_owner" && operation.action !== "remove_owner") {
      throw new AssetOwnershipError(
        "pending_approval",
        "Lifecycle Approval is consumed by the asset mutation"
      );
    }
    const actor = await this.actor(principal);
    if (!actor.companyAdmin) {
      const access = await this.deps.ownership.access(this.businessId, assetType, assetId, {
        principalId: principal.id,
        principalKind: principal.kind,
      });
      if (!access.canManageOwnership) {
        throw new AssetOwnershipError("forbidden", "An exact owning-Team human admin is required");
      }
    }
    const completed = await this.deps.ownership.complete(this.businessId, operationId);
    await this.reconcileFileOwners(assetType, assetId, operation.action);
    return completed;
  }

  async consumeLifecycleApproval(
    assetType: TeamAssetType,
    assetId: string,
    action: Extract<AssetOwnershipOperationAction, "move" | "archive" | "delete">,
    operationId: string
  ): Promise<void> {
    const operation = await this.deps.ownershipRepo.getOperation(this.businessId, operationId);
    if (
      !operation ||
      operation.assetType !== assetType ||
      operation.assetId !== assetId ||
      operation.action !== action
    ) {
      throw new AssetOwnershipError(
        "forbidden",
        "A pending Approval for this exact asset action is required"
      );
    }
    if (operation.status === "completed") {
      const ownership = await this.deps.ownershipRepo.get(this.businessId, assetType, assetId);
      if (!ownership || ownership.revision !== operation.expectedOwnershipRevision) {
        throw new AssetOwnershipError("stale", "Ownership changed after emergency override");
      }
      const approval = await this.deps.approvals.get(this.businessId, operationId);
      if (approval && !approval.consumedAt && !approval.revokedAt) return;
      throw new AssetOwnershipError(
        "forbidden",
        "An emergency override for this exact asset action is required"
      );
    }
    await this.deps.ownership.complete(this.businessId, operationId);
  }

  async remove(assetType: TeamAssetType, assetId: string): Promise<void> {
    await this.deps.ownershipRepo.delete(this.businessId, assetType, assetId);
    // Dropping the projection drops every Team that read the File through it, so this is the
    // narrowest change there is and the Page has to be told.
    if (assetType === "file" && this.deps.fileKnowledge) {
      await this.deps.fileKnowledge.sync(assetId, false);
    }
  }

  /**
   * Re-points a File's Knowledge Page after its owners changed.
   *
   * Removing an owner narrows who may read the File, and the Page's ACL is written from those same
   * owners — so without this the removed Team keeps retrieving the text it can no longer open.
   */
  private async reconcileFileOwners(
    assetType: TeamAssetType,
    assetId: string,
    action: AssetOwnershipOperationAction
  ): Promise<void> {
    if (assetType !== "file" || !this.deps.fileKnowledge) return;
    if (action !== "add_owner" && action !== "remove_owner") return;
    await this.deps.fileKnowledge.sync(assetId, action === "add_owner");
  }

  async updateShares(
    assetType: TeamAssetType,
    assetId: string,
    shares: readonly { teamId: string; access: TeamAssetAccessLevel }[],
    expectedRevision: number,
    principal: AssetPrincipal
  ) {
    for (const share of shares) {
      const team = await this.deps.teams.getTeam(this.businessId, share.teamId);
      if (team?.status !== "active") {
        throw new AssetOwnershipError("invalid_ownership", "Shares must name active Teams");
      }
    }
    const before = await this.deps.ownershipRepo.get(this.businessId, assetType, assetId);
    const updated = await this.deps.ownership.updateShares({
      businessId: this.businessId,
      assetType,
      assetId,
      shares,
      expectedRevision,
      actor: { principalId: principal.id, principalKind: principal.kind },
    });
    if (assetType === "file" && this.deps.fileKnowledge) {
      const kept = new Set(shares.map((share) => share.teamId));
      const widening = (before?.shares ?? []).every((share) => kept.has(share.teamId));
      await this.deps.fileKnowledge.sync(assetId, widening);
    }
    return updated;
  }

  private async actor(
    principal: AssetPrincipal
  ): Promise<TeamActorCapabilities & { readonly principalKind: string }> {
    const now = new Date();
    const memberships = await this.deps.teams.listPrincipalMemberships(
      this.businessId,
      principal.id,
      now
    );
    return {
      principalId: principal.id,
      principalKind: principal.kind,
      companyAdmin: principal.companyAdmin === true,
      administeredTeamIds: memberships
        .filter(
          (membership) =>
            membership.principalKind === "user" &&
            membership.level === "admin" &&
            (!membership.expiresAt || membership.expiresAt > now)
        )
        .map((membership) => membership.teamId),
    };
  }

  private async requireExisting(
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord> {
    const ownership = await this.deps.ownershipRepo.get(this.businessId, assetType, assetId);
    if (!ownership) {
      throw new AssetOwnershipError("not_found", "Asset ownership was not found");
    }
    return ownership;
  }

  private ensureBusinessAsset(
    assetType: TeamAssetType,
    assetId: string,
    metadata: TeamBusinessAssetOwnership
  ): Promise<AssetOwnershipRecord> {
    if (assetType !== "agent" && assetType !== "skill" && assetType !== "routine") {
      throw new AssetOwnershipError("invalid_ownership", "Business asset metadata is unsupported");
    }
    return this.ensure(assetType, assetId, metadata);
  }
}

function teamIdFromApprovalRole(role: string): string | undefined {
  const match = /^team:(.+):admin$/.exec(role);
  return match?.[1];
}

function approvalView(
  operation: AssetOwnershipOperationRecord,
  approval: ApprovalGrantRecord,
  requiredTeamIds: readonly string[],
  representedTeamId: string | undefined,
  now: Date
) {
  const denied = approval.decisions.some((decision) => decision.outcome === "denied");
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
    assetType: operation.assetType,
    assetId: operation.assetId,
    action: operation.action,
    risk: approval.risk,
    preview: approval.preview,
    riskSummary: approval.riskSummary,
    status: denied ? "denied" : "pending",
    requiredTeamIds,
    decisions: approval.decisions.length,
    requiredDecisions: approval.requiredApproverRoles.length,
    readyToComplete,
    representedTeamId: representedTeamId ?? null,
    canDecide: representedTeamId !== undefined && !denied && approval.expiresAt > now,
    expiresAt: approval.expiresAt.toISOString(),
    createdAt: approval.createdAt.toISOString(),
  };
}

export { AssetOwnershipError };

const APPROVAL_READ_BATCH = 100;
const MAX_APPROVALS_SCANNED = 500;

function encodeApprovalCursor(cursor: AssetOwnershipOperationCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
    "utf8"
  ).toString("base64url");
}

function decodeApprovalCursor(
  cursor: string | undefined
): AssetOwnershipOperationCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return undefined;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || parsed.id.length === 0) return undefined;
    return { createdAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

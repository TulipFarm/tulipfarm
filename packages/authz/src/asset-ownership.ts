import { randomUUID } from "node:crypto";
import {
  canonicalHash,
  type TeamAssetAccessLevel,
  type TeamAssetOwner,
  type TeamAssetType,
} from "@tulipfarm/schema";
import type { ApprovalBinding } from "./approval/binding";
import type { ApprovalDecisionRecord, ApprovalOutcome } from "./approval/decision";
import { type ResolvedTeamMember, type TeamActorCapabilities, TeamServiceError } from "./teams";

export interface AssetTeamShare {
  readonly teamId: string;
  readonly access: TeamAssetAccessLevel;
}

export interface AssetOwnershipRecord {
  readonly businessId: string;
  readonly assetType: TeamAssetType;
  readonly assetId: string;
  readonly owners: readonly TeamAssetOwner[];
  readonly shares: readonly AssetTeamShare[];
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type AssetOwnershipOperationAction =
  | "add_owner"
  | "remove_owner"
  | "move"
  | "archive"
  | "delete";

export interface AssetOwnershipOperation {
  readonly id: string;
  readonly approvalId: string;
  readonly businessId: string;
  readonly assetType: TeamAssetType;
  readonly assetId: string;
  readonly action: AssetOwnershipOperationAction;
  readonly teamId?: string;
  readonly expectedOwnershipRevision: number;
  readonly status: "pending" | "completed";
  readonly revision: number;
  readonly createdAt: Date;
  readonly completedAt?: Date;
}

export interface AssetOwnershipRepoPort {
  create(record: AssetOwnershipRecord): Promise<void>;
  get(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord | undefined>;
  put(record: AssetOwnershipRecord, expectedRevision: number): Promise<void>;
  delete(businessId: string, assetType: TeamAssetType, assetId: string): Promise<void>;
  createOperation(operation: AssetOwnershipOperation): Promise<void>;
  createOperationWithApproval(
    operation: AssetOwnershipOperation,
    approval: NewOwnershipApproval
  ): Promise<void>;
  getOperation(
    businessId: string,
    operationId: string
  ): Promise<AssetOwnershipOperation | undefined>;
  listOperations(
    businessId: string,
    status?: "pending" | "completed"
  ): Promise<AssetOwnershipOperation[]>;
  completeApprovedOperation(input: {
    readonly businessId: string;
    readonly operationId: string;
    readonly binding: ApprovalBinding;
    readonly at: Date;
    readonly updatedOwnership?: AssetOwnershipRecord;
  }): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperation;
  }>;
  completeEmergencyOperation(input: {
    readonly businessId: string;
    readonly operationId: string;
    readonly at: Date;
    readonly updatedOwnership?: AssetOwnershipRecord;
  }): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperation;
  }>;
}

export interface AssetMembershipPort {
  resolveMembers(businessId: string, teamId: string): Promise<readonly ResolvedTeamMember[]>;
  resolvePrincipalForTeams?(
    businessId: string,
    teamIds: readonly string[],
    principalId: string
  ): Promise<ReadonlyMap<string, readonly ResolvedTeamMember[]>>;
}

export interface OwnershipApprovalRecord {
  readonly approvalId: string;
  readonly businessId: string;
  readonly binding: ApprovalBinding;
  readonly risk: "low" | "medium" | "high";
  readonly allowedApproverRoles: readonly string[];
  readonly requiredApproverRoles: readonly string[];
  readonly proposerPrincipalId: string;
  readonly preview: string;
  readonly riskSummary: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly decisions: readonly ApprovalDecisionRecord[];
  readonly consumedAt?: Date;
  readonly revokedAt?: Date;
}

export type NewOwnershipApproval = Omit<
  OwnershipApprovalRecord,
  "decisions" | "consumedAt" | "revokedAt"
>;

export interface OwnershipApprovalPort {
  create(record: NewOwnershipApproval): Promise<OwnershipApprovalRecord>;
  get(businessId: string, approvalId: string): Promise<OwnershipApprovalRecord | undefined>;
  appendDecision(
    businessId: string,
    approvalId: string,
    decision: ApprovalDecisionRecord
  ): Promise<OwnershipApprovalRecord>;
  consume(
    businessId: string,
    approvalId: string,
    binding: ApprovalBinding,
    at: Date
  ): Promise<OwnershipApprovalRecord>;
}

export interface OwnershipFact {
  readonly action:
    | "asset.sharing.updated"
    | "asset.ownership.approval_requested"
    | "asset.ownership.approval_decided"
    | "asset.ownership.changed"
    | "asset.ownership.emergency_override";
  readonly businessId: string;
  readonly assetType: TeamAssetType;
  readonly assetId: string;
  readonly operation?: AssetOwnershipOperationAction;
  readonly actorPrincipalId: string;
  readonly reason?: string;
  readonly highVisibility?: true;
  readonly teamIds?: readonly string[];
  readonly outcome?: ApprovalOutcome;
  readonly occurredAt: Date;
}

export interface OwnershipFactPort {
  emit(fact: OwnershipFact): Promise<void>;
}

export type AssetOwnershipErrorReason =
  | "not_found"
  | "forbidden"
  | "invalid_ownership"
  | "conflict"
  | "stale"
  | "expired"
  | "duplicate_decision"
  | "pending_approval"
  | "already_completed"
  | "reason_required";

export class AssetOwnershipError extends Error {
  constructor(
    readonly reason: AssetOwnershipErrorReason,
    message: string
  ) {
    super(message);
    this.name = "AssetOwnershipError";
  }
}

export interface AssetAccessProjection {
  readonly levels: readonly TeamAssetAccessLevel[];
  readonly canManageOwnership: boolean;
  readonly evidence: readonly {
    readonly source: "personal_owner" | "team_owner" | "team_share";
    readonly teamId?: string;
    readonly access: TeamAssetAccessLevel;
    readonly inherited: boolean;
  }[];
}

export interface AssetOwnershipAccessDeps {
  readonly ownership: AssetOwnershipRepoPort;
  readonly approvals?: Pick<OwnershipApprovalPort, "get">;
  readonly memberships: AssetMembershipPort;
  readonly everyoneTeamId: (businessId: string) => Promise<string>;
  readonly now?: () => Date;
}

/**
 * Read-side adapter for asset domains.
 *
 * Domains keep their existing gates and ask this service to project Team ownership into them. The
 * projection remains the single T11 decision rather than being copied into Files or Knowledge.
 */
export class AssetOwnershipAccessService {
  private readonly now: () => Date;

  constructor(private readonly deps: AssetOwnershipAccessDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async get(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord | undefined> {
    return await this.deps.ownership.get(businessId, assetType, assetId);
  }

  async ensurePersonal(
    businessId: string,
    assetType: Extract<TeamAssetType, "file" | "knowledge">,
    assetId: string,
    principalId: string
  ): Promise<AssetOwnershipRecord> {
    return await this.ensure({
      businessId,
      assetType,
      assetId,
      owners: [{ kind: "principal", principalId, principalKind: "user" }],
      shares: [],
    });
  }

  async ensureBusiness(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord> {
    return await this.ensure({
      businessId,
      assetType,
      assetId,
      owners: [{ kind: "team", teamId: await this.deps.everyoneTeamId(businessId) }],
      shares: [],
    });
  }

  async accessFor(
    record: AssetOwnershipRecord,
    principal: { readonly principalId: string; readonly principalKind: string }
  ): Promise<AssetAccessProjection> {
    return await projectAssetAccess(record, principal, this.deps.memberships, this.now());
  }

  async consumeDestructiveApproval(
    record: AssetOwnershipRecord,
    action: Extract<AssetOwnershipOperationAction, "archive" | "delete">,
    operationId: string | undefined
  ): Promise<void> {
    if (teamOwnerIds(record).length <= 1) return;
    if (operationId === undefined) {
      throw new AssetOwnershipError(
        "pending_approval",
        "Joint-Team destructive actions require owner Approval"
      );
    }
    const operation = await this.deps.ownership.getOperation(record.businessId, operationId);
    if (
      !operation ||
      operation.assetType !== record.assetType ||
      operation.assetId !== record.assetId ||
      operation.action !== action ||
      operation.expectedOwnershipRevision !== record.revision
    ) {
      throw new AssetOwnershipError(
        "pending_approval",
        "Joint-Team destructive actions require owner Approval"
      );
    }
    if (operation.status === "completed") {
      const approval = await this.deps.approvals?.get(record.businessId, operation.approvalId);
      if (approval && !approval.consumedAt && !approval.revokedAt) return;
      throw new AssetOwnershipError(
        "pending_approval",
        "Joint-Team destructive actions require owner Approval"
      );
    }
    try {
      await this.deps.ownership.completeApprovedOperation({
        businessId: record.businessId,
        operationId,
        binding: ownershipBinding(record, operation),
        at: this.now(),
      });
    } catch (error) {
      throw translateApprovalError(error);
    }
  }

  private async ensure(
    input: Omit<AssetOwnershipRecord, "revision" | "createdAt" | "updatedAt">
  ): Promise<AssetOwnershipRecord> {
    const existing = await this.deps.ownership.get(
      input.businessId,
      input.assetType,
      input.assetId
    );
    if (existing !== undefined) return existing;
    validateOwnership(input.assetType, input.owners);
    const now = this.now();
    const record = { ...input, revision: 1, createdAt: now, updatedAt: now };
    try {
      await this.deps.ownership.create(record);
      return record;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "duplicate"
      ) {
        const raced = await this.deps.ownership.get(
          input.businessId,
          input.assetType,
          input.assetId
        );
        if (raced !== undefined) return raced;
      }
      throw error;
    }
  }
}

const ACCESS_LEVELS: readonly TeamAssetAccessLevel[] = ["view", "use", "edit"];

function levelsThrough(level: TeamAssetAccessLevel): readonly TeamAssetAccessLevel[] {
  return ACCESS_LEVELS.slice(0, ACCESS_LEVELS.indexOf(level) + 1);
}

function teamOwnerIds(record: AssetOwnershipRecord): readonly string[] {
  return record.owners
    .filter((owner): owner is Extract<TeamAssetOwner, { kind: "team" }> => owner.kind === "team")
    .map((owner) => owner.teamId);
}

function validateOwnership(assetType: TeamAssetType, owners: readonly TeamAssetOwner[]): void {
  const personalOwners = owners.filter((owner) => owner.kind === "principal");
  const teamOwners = owners.filter((owner) => owner.kind === "team");
  const ownerKeys = owners.map((owner) =>
    owner.kind === "team" ? `team:${owner.teamId}` : `principal:${owner.principalId}`
  );
  const personalAllowed = assetType === "file" || assetType === "knowledge";
  if (
    owners.length === 0 ||
    new Set(ownerKeys).size !== ownerKeys.length ||
    (!personalAllowed && personalOwners.length > 0) ||
    personalOwners.length > 1 ||
    (personalOwners.length > 0 && teamOwners.length > 0) ||
    (personalOwners.length === 0 && teamOwners.length === 0)
  ) {
    throw new AssetOwnershipError(
      "invalid_ownership",
      "Shared assets require a Team owner; only personal Files and Knowledge may have a person owner"
    );
  }
}

async function matchingMemberships(
  memberships: AssetMembershipPort,
  record: AssetOwnershipRecord,
  teamId: string,
  principalId: string,
  at: Date
): Promise<readonly ResolvedTeamMember[]> {
  let resolved: readonly ResolvedTeamMember[];
  try {
    resolved = await memberships.resolveMembers(record.businessId, teamId);
  } catch (error) {
    if (
      error instanceof TeamServiceError &&
      (error.reason === "not_found" || error.reason === "invalid")
    ) {
      return [];
    }
    throw error;
  }
  return resolved.filter(
    (member) =>
      member.principalId === principalId &&
      (member.expiresAt === undefined || member.expiresAt > at)
  );
}

function preferredMembership(
  memberships: readonly ResolvedTeamMember[],
  teamId: string
): ResolvedTeamMember | undefined {
  return memberships.find((membership) => membership.sourceTeamId === teamId) ?? memberships[0];
}

export async function projectAssetAccess(
  record: AssetOwnershipRecord,
  principal: { readonly principalId: string; readonly principalKind: string },
  memberships: AssetMembershipPort,
  at: Date = new Date()
): Promise<AssetAccessProjection> {
  const levels = new Set<TeamAssetAccessLevel>();
  const evidence: AssetAccessProjection["evidence"][number][] = [];
  let canManageOwnership = false;

  for (const owner of record.owners) {
    if (owner.kind === "principal") {
      if (owner.principalId === principal.principalId && principal.principalKind === "user") {
        for (const level of ACCESS_LEVELS) levels.add(level);
        canManageOwnership = true;
        evidence.push({ source: "personal_owner", access: "edit", inherited: false });
      }
      continue;
    }
    const matching = await matchingMemberships(
      memberships,
      record,
      owner.teamId,
      principal.principalId,
      at
    );
    const membership = preferredMembership(matching, owner.teamId);
    if (!membership) continue;
    levels.add("view");
    levels.add("use");
    const exactHumanAdmin = matching.some(
      (candidate) =>
        candidate.sourceTeamId === owner.teamId &&
        candidate.level === "admin" &&
        candidate.principalKind === "user"
    );
    const canManage = exactHumanAdmin && principal.principalKind === "user";
    if (canManage) {
      levels.add("edit");
      canManageOwnership = true;
    }
    evidence.push({
      source: "team_owner",
      teamId: owner.teamId,
      access: canManage ? "edit" : "use",
      inherited: membership.sourceTeamId !== owner.teamId,
    });
  }

  for (const share of record.shares) {
    const matching = await matchingMemberships(
      memberships,
      record,
      share.teamId,
      principal.principalId,
      at
    );
    const membership = preferredMembership(matching, share.teamId);
    if (!membership) continue;
    for (const level of levelsThrough(share.access)) levels.add(level);
    evidence.push({
      source: "team_share",
      teamId: share.teamId,
      access: share.access,
      inherited: membership.sourceTeamId !== share.teamId,
    });
  }

  return {
    levels: ACCESS_LEVELS.filter((level) => levels.has(level)),
    canManageOwnership,
    evidence,
  };
}

function approvalRole(teamId: string): string {
  return `team:${teamId}:admin`;
}

function ownershipBinding(
  record: AssetOwnershipRecord,
  operation: Pick<AssetOwnershipOperation, "action" | "teamId" | "expectedOwnershipRevision">
): ApprovalBinding {
  return {
    intentDigest: canonicalHash({
      assetType: record.assetType,
      assetId: record.assetId,
      action: operation.action,
      teamId: operation.teamId ?? null,
      expectedOwnershipRevision: operation.expectedOwnershipRevision,
    }),
    evidenceDigest: canonicalHash({
      owners: [...teamOwnerIds(record)].sort(),
      shares: record.shares.map((share) => `${share.teamId}:${share.access}`).sort(),
    }),
    guardrailRevision: "asset-ownership-v1",
  };
}

export interface AssetOwnershipServiceDeps {
  readonly ownership: AssetOwnershipRepoPort;
  readonly approvals: OwnershipApprovalPort;
  readonly memberships: AssetMembershipPort;
  readonly facts: OwnershipFactPort;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ProposeOwnershipOperationInput {
  readonly businessId: string;
  readonly assetType: TeamAssetType;
  readonly assetId: string;
  readonly action: AssetOwnershipOperationAction;
  readonly teamId?: string;
  readonly expectedRevision: number;
  readonly proposerPrincipalId: string;
  readonly actor: TeamActorCapabilities & { readonly principalKind: string };
  readonly expiresAt: Date;
}

export class AssetOwnershipService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: AssetOwnershipServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async create(
    input: Omit<AssetOwnershipRecord, "revision" | "createdAt" | "updatedAt">
  ): Promise<AssetOwnershipRecord> {
    validateOwnership(input.assetType, input.owners);
    const now = this.now();
    const record = { ...input, revision: 1, createdAt: now, updatedAt: now };
    await this.deps.ownership.create(record);
    return record;
  }

  async access(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string,
    principal: { readonly principalId: string; readonly principalKind: string }
  ): Promise<AssetAccessProjection> {
    return projectAssetAccess(
      await this.requireOwnership(businessId, assetType, assetId),
      principal,
      this.deps.memberships,
      this.now()
    );
  }

  async requireAccess(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string,
    principal: { readonly principalId: string; readonly principalKind: string },
    required: TeamAssetAccessLevel
  ): Promise<AssetAccessProjection> {
    const projection = await this.access(businessId, assetType, assetId, principal);
    if (!projection.levels.includes(required)) {
      throw new AssetOwnershipError("forbidden", `${required} access is required`);
    }
    return projection;
  }

  async accessMany(
    records: readonly AssetOwnershipRecord[],
    principal: { readonly principalId: string; readonly principalKind: string }
  ): Promise<ReadonlyMap<string, AssetAccessProjection>> {
    const teamIds = [
      ...new Set(
        records.flatMap((record) => [
          ...record.owners.flatMap((owner) => (owner.kind === "team" ? [owner.teamId] : [])),
          ...record.shares.map((share) => share.teamId),
        ])
      ),
    ];
    const resolved =
      this.deps.memberships.resolvePrincipalForTeams === undefined
        ? undefined
        : await this.deps.memberships.resolvePrincipalForTeams(
            records[0]?.businessId ?? "",
            teamIds,
            principal.principalId
          );
    const memberships: AssetMembershipPort =
      resolved === undefined
        ? this.deps.memberships
        : {
            resolveMembers: async (_businessId, teamId) => resolved.get(teamId) ?? [],
          };
    const projections = await Promise.all(
      records.map(
        async (record) =>
          [
            `${record.assetType}\u0000${record.assetId}`,
            await projectAssetAccess(record, principal, memberships, this.now()),
          ] as const
      )
    );
    return new Map(projections);
  }

  async updateShares(input: {
    readonly businessId: string;
    readonly assetType: TeamAssetType;
    readonly assetId: string;
    readonly shares: readonly AssetTeamShare[];
    readonly expectedRevision: number;
    readonly actor: { readonly principalId: string; readonly principalKind: string };
  }): Promise<AssetOwnershipRecord> {
    const record = await this.requireOwnership(input.businessId, input.assetType, input.assetId);
    if (record.revision !== input.expectedRevision) {
      throw new AssetOwnershipError("stale", "Ownership changed before shares were updated");
    }
    const projection = await projectAssetAccess(
      record,
      input.actor,
      this.deps.memberships,
      this.now()
    );
    if (!projection.canManageOwnership) {
      throw new AssetOwnershipError("forbidden", "An exact owning-Team human admin is required");
    }
    const seen = new Set<string>();
    for (const share of input.shares) {
      if (seen.has(share.teamId)) {
        throw new AssetOwnershipError("invalid_ownership", "A Team may be shared only once");
      }
      seen.add(share.teamId);
    }
    const updated = {
      ...record,
      shares: [...input.shares],
      revision: record.revision + 1,
      updatedAt: this.now(),
    };
    await this.deps.ownership.put(updated, record.revision);
    await this.deps.facts.emit({
      action: "asset.sharing.updated",
      businessId: input.businessId,
      assetType: input.assetType,
      assetId: input.assetId,
      actorPrincipalId: input.actor.principalId,
      teamIds: input.shares.map((share) => share.teamId),
      occurredAt: this.now(),
    });
    return updated;
  }

  async propose(input: ProposeOwnershipOperationInput): Promise<AssetOwnershipOperation> {
    const record = await this.requireOwnership(input.businessId, input.assetType, input.assetId);
    if (record.revision !== input.expectedRevision) {
      throw new AssetOwnershipError("stale", "Ownership changed before the proposal was created");
    }
    const projection = await projectAssetAccess(
      record,
      input.actor,
      this.deps.memberships,
      this.now()
    );
    if (!projection.canManageOwnership) {
      throw new AssetOwnershipError("forbidden", "An exact owning-Team human admin is required");
    }
    if (
      (input.action === "add_owner" || input.action === "remove_owner") &&
      input.teamId === undefined
    ) {
      throw new AssetOwnershipError("invalid_ownership", "Owner changes require a Team");
    }
    if (input.action === "remove_owner" && !teamOwnerIds(record).includes(input.teamId as string)) {
      throw new AssetOwnershipError("invalid_ownership", "The Team is not a current owner");
    }
    if (input.action === "add_owner" && teamOwnerIds(record).includes(input.teamId as string)) {
      throw new AssetOwnershipError("invalid_ownership", "The Team is already an owner");
    }
    if (input.action === "remove_owner" && input.teamId) {
      validateOwnership(
        record.assetType,
        record.owners.filter((owner) => owner.kind !== "team" || owner.teamId !== input.teamId)
      );
    }
    // Refused here rather than at completion, so a person cannot spend an Approval on an ownership
    // this service would never have created. Adding a Team to a personally owned File is not a
    // transfer: it would leave the File owned by a person *and* a Team at once, which every other
    // entry point rejects.
    if (input.action === "add_owner" && input.teamId) {
      validateOwnership(record.assetType, [
        ...record.owners,
        { kind: "team", teamId: input.teamId },
      ]);
    }

    const operationId = this.newId();
    const operation: AssetOwnershipOperation = {
      id: operationId,
      approvalId: operationId,
      businessId: input.businessId,
      assetType: input.assetType,
      assetId: input.assetId,
      action: input.action,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      expectedOwnershipRevision: input.expectedRevision,
      status: "pending",
      revision: 1,
      createdAt: this.now(),
    };
    const requiredRoles = [
      ...teamOwnerIds(record).map(approvalRole),
      ...(input.action === "add_owner" && input.teamId ? [approvalRole(input.teamId)] : []),
    ];
    await this.deps.ownership.createOperationWithApproval(operation, {
      approvalId: operation.approvalId,
      businessId: operation.businessId,
      binding: ownershipBinding(record, operation),
      risk: "high",
      allowedApproverRoles: requiredRoles,
      requiredApproverRoles: requiredRoles,
      proposerPrincipalId: input.proposerPrincipalId,
      preview: `${input.action} ${input.assetType} ${input.assetId}`,
      riskSummary: "Changes shared asset ownership or lifecycle",
      expiresAt: input.expiresAt,
      createdAt: operation.createdAt,
    });
    await this.deps.facts.emit({
      action: "asset.ownership.approval_requested",
      businessId: input.businessId,
      assetType: input.assetType,
      assetId: input.assetId,
      operation: input.action,
      actorPrincipalId: input.actor.principalId,
      ...(input.teamId ? { teamIds: [input.teamId] } : {}),
      occurredAt: operation.createdAt,
    });
    return operation;
  }

  async decide(input: {
    readonly businessId: string;
    readonly operationId: string;
    readonly actor: TeamActorCapabilities & { readonly principalKind: string };
    readonly representedTeamId: string;
    readonly outcome: ApprovalOutcome;
  }): Promise<OwnershipApprovalRecord> {
    const operation = await this.requireOperation(input.businessId, input.operationId);
    const approval = await this.deps.approvals.get(input.businessId, operation.approvalId);
    if (!approval) throw new AssetOwnershipError("not_found", "Approval was not found");
    const role = approvalRole(input.representedTeamId);
    if (
      input.actor.principalKind !== "user" ||
      !input.actor.administeredTeamIds.includes(input.representedTeamId) ||
      !approval.requiredApproverRoles.includes(role)
    ) {
      throw new AssetOwnershipError(
        "forbidden",
        "Only an exact required Team human admin may decide"
      );
    }
    try {
      const approval = await this.deps.approvals.appendDecision(
        input.businessId,
        operation.approvalId,
        {
          approverPrincipalId: input.actor.principalId,
          approverRoles: [role],
          satisfiedApproverRole: role,
          outcome: input.outcome,
          decidedAt: this.now(),
        }
      );
      await this.deps.facts.emit({
        action: "asset.ownership.approval_decided",
        businessId: input.businessId,
        assetType: operation.assetType,
        assetId: operation.assetId,
        operation: operation.action,
        actorPrincipalId: input.actor.principalId,
        teamIds: [input.representedTeamId],
        outcome: input.outcome,
        occurredAt: this.now(),
      });
      return approval;
    } catch (error) {
      throw translateApprovalError(error);
    }
  }

  async complete(businessId: string, operationId: string): Promise<AssetOwnershipRecord> {
    const operation = await this.requireOperation(businessId, operationId);
    if (operation.status !== "pending") {
      throw new AssetOwnershipError("already_completed", "Ownership operation is already complete");
    }
    const record = await this.requireOwnership(businessId, operation.assetType, operation.assetId);
    if (record.revision !== operation.expectedOwnershipRevision) {
      throw new AssetOwnershipError("stale", "Ownership changed after Approval was requested");
    }
    let updated = record;
    if (operation.action === "add_owner" && operation.teamId) {
      updated = {
        ...record,
        owners: [...record.owners, { kind: "team", teamId: operation.teamId }],
        revision: record.revision + 1,
        updatedAt: this.now(),
      };
      // Re-checked because the record may have gained a personal owner since the proposal.
      validateOwnership(updated.assetType, updated.owners);
    } else if (operation.action === "remove_owner" && operation.teamId) {
      updated = {
        ...record,
        owners: record.owners.filter(
          (owner) => owner.kind !== "team" || owner.teamId !== operation.teamId
        ),
        revision: record.revision + 1,
        updatedAt: this.now(),
      };
      validateOwnership(updated.assetType, updated.owners);
    }
    try {
      const completed = await this.deps.ownership.completeApprovedOperation({
        businessId,
        operationId,
        binding: ownershipBinding(record, operation),
        at: this.now(),
        ...(updated === record ? {} : { updatedOwnership: updated }),
      });
      updated = completed.ownership;
    } catch (error) {
      throw translateApprovalError(error);
    }
    await this.deps.facts.emit({
      action: "asset.ownership.changed",
      businessId,
      assetType: operation.assetType,
      assetId: operation.assetId,
      operation: operation.action,
      actorPrincipalId: "system",
      ...(operation.teamId ? { teamIds: [operation.teamId] } : {}),
      occurredAt: this.now(),
    });
    return updated;
  }

  async emergencyOverride(input: {
    readonly businessId: string;
    readonly assetType: TeamAssetType;
    readonly assetId: string;
    readonly operationId: string;
    readonly actor: TeamActorCapabilities & { readonly principalKind: string };
    readonly reason: string;
  }): Promise<AssetOwnershipRecord> {
    if (!input.actor.companyAdmin || input.actor.principalKind !== "user") {
      throw new AssetOwnershipError("forbidden", "Company admin capability is required");
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new AssetOwnershipError("reason_required", "Emergency override requires a reason");
    }
    const operation = await this.requireOperation(input.businessId, input.operationId);
    if (operation.assetType !== input.assetType || operation.assetId !== input.assetId) {
      throw new AssetOwnershipError(
        "forbidden",
        "Emergency override must bind to an operation for this exact asset"
      );
    }
    const ownership = await this.requireOwnership(input.businessId, input.assetType, input.assetId);
    if (ownership.revision !== operation.expectedOwnershipRevision) {
      throw new AssetOwnershipError("stale", "Ownership changed after Approval was requested");
    }
    const updated =
      operation.action === "add_owner" && operation.teamId
        ? {
            ...ownership,
            owners: [...ownership.owners, { kind: "team" as const, teamId: operation.teamId }],
            revision: ownership.revision + 1,
            updatedAt: this.now(),
          }
        : operation.action === "remove_owner" && operation.teamId
          ? {
              ...ownership,
              owners: ownership.owners.filter(
                (owner) => owner.kind !== "team" || owner.teamId !== operation.teamId
              ),
              revision: ownership.revision + 1,
              updatedAt: this.now(),
            }
          : undefined;
    if (updated !== undefined) {
      validateOwnership(updated.assetType, updated.owners);
    }
    let completed: AssetOwnershipRecord;
    try {
      completed = (
        await this.deps.ownership.completeEmergencyOperation({
          businessId: input.businessId,
          operationId: input.operationId,
          at: this.now(),
          ...(updated === undefined ? {} : { updatedOwnership: updated }),
        })
      ).ownership;
    } catch (error) {
      throw translateApprovalError(error);
    }
    await this.deps.facts.emit({
      action: "asset.ownership.emergency_override",
      businessId: input.businessId,
      assetType: input.assetType,
      assetId: input.assetId,
      operation: operation.action,
      actorPrincipalId: input.actor.principalId,
      reason,
      highVisibility: true,
      teamIds: [
        ...new Set([...teamOwnerIds(ownership), ...(operation.teamId ? [operation.teamId] : [])]),
      ],
      occurredAt: this.now(),
    });
    return completed;
  }

  private async requireOwnership(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord> {
    const record = await this.deps.ownership.get(businessId, assetType, assetId);
    if (!record) throw new AssetOwnershipError("not_found", "Asset ownership was not found");
    return record;
  }

  private async requireOperation(
    businessId: string,
    operationId: string
  ): Promise<AssetOwnershipOperation> {
    const operation = await this.deps.ownership.getOperation(businessId, operationId);
    if (!operation) throw new AssetOwnershipError("not_found", "Ownership operation was not found");
    return operation;
  }
}

function translateApprovalError(error: unknown): AssetOwnershipError {
  if (error instanceof AssetOwnershipError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  const reason: AssetOwnershipErrorReason =
    code === "duplicate_approver"
      ? "duplicate_decision"
      : code === "expired"
        ? "expired"
        : code === "binding_mismatch" || code === "revision_conflict"
          ? "stale"
          : code === "already_used"
            ? "already_completed"
            : code === "insufficient_approvals" || code === "denied"
              ? "pending_approval"
              : code === "not_found"
                ? "not_found"
                : "forbidden";
  return new AssetOwnershipError(reason, "Ownership Approval was rejected");
}

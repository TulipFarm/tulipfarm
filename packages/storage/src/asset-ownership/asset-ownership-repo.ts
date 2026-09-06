import type { TeamAssetAccessLevel, TeamAssetOwner, TeamAssetType } from "@tulipfarm/schema";
import {
  type ApprovalBindingRecord,
  type ApprovalGrantRecord,
  type ApprovalRepo,
  consumeApprovalInTransaction,
  createApprovalInTransaction,
  type NewApprovalGrant,
} from "../approvals/approval-repo";
import { withInMemoryTeamMutationLock } from "../auth/team-repo";
import type { Queryable, TransactionPort } from "../ports";

export interface AssetTeamShareRecord {
  readonly teamId: string;
  readonly access: TeamAssetAccessLevel;
}

export interface AssetOwnershipRecord {
  readonly businessId: string;
  readonly assetType: TeamAssetType;
  readonly assetId: string;
  readonly owners: readonly TeamAssetOwner[];
  readonly shares: readonly AssetTeamShareRecord[];
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

export interface AssetOwnershipOperationRecord {
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

export type AssetOwnershipStoreErrorCode = "not_found" | "duplicate" | "revision_conflict";

export class AssetOwnershipStoreError extends Error {
  constructor(
    readonly code: AssetOwnershipStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AssetOwnershipStoreError";
  }
}

export interface CompleteApprovedOwnershipOperationInput {
  readonly businessId: string;
  readonly operationId: string;
  readonly binding: ApprovalBindingRecord;
  readonly at: Date;
  readonly updatedOwnership?: AssetOwnershipRecord;
}

export interface AssetOwnershipCursor {
  readonly assetType: TeamAssetType;
  readonly assetId: string;
}

export interface AssetOwnershipOperationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface AssetOwnershipRepo {
  create(record: AssetOwnershipRecord): Promise<void>;
  get(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord | undefined>;
  /**
   * The ownership records for `assetIds`, omitting any that has none.
   *
   * A page of assets asks the same question once rather than once per row: a listing that has to
   * know who owns each of its rows would otherwise cost a query per row, which is how an
   * ownership-aware list becomes slower than the list it replaced.
   */
  getMany(
    businessId: string,
    assetType: TeamAssetType,
    assetIds: readonly string[]
  ): Promise<AssetOwnershipRecord[]>;
  listByTeam(businessId: string, teamIds: readonly string[]): Promise<AssetOwnershipRecord[]>;
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
  put(record: AssetOwnershipRecord, expectedRevision: number): Promise<void>;
  delete(businessId: string, assetType: TeamAssetType, assetId: string): Promise<void>;
  createOperation(operation: AssetOwnershipOperationRecord): Promise<void>;
  createOperationWithApproval(
    operation: AssetOwnershipOperationRecord,
    approval: NewApprovalGrant
  ): Promise<void>;
  getOperation(
    businessId: string,
    operationId: string
  ): Promise<AssetOwnershipOperationRecord | undefined>;
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
  completeApprovedOperation(input: CompleteApprovedOwnershipOperationInput): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }>;
  completeEmergencyOperation(
    input: Omit<CompleteApprovedOwnershipOperationInput, "binding">
  ): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }>;
}

export interface AssetOwnershipTeamPort {
  getTeam(
    businessId: string,
    teamId: string
  ): Promise<{ readonly status: "active" | "archived" } | undefined>;
}

interface InMemoryApprovalPort extends Pick<ApprovalRepo, "create" | "consume"> {
  restore(record: ApprovalGrantRecord): void;
}

function freezeOwnership(record: AssetOwnershipRecord): AssetOwnershipRecord {
  return Object.freeze({
    ...record,
    owners: Object.freeze(record.owners.map((owner) => Object.freeze({ ...owner }))),
    shares: Object.freeze(record.shares.map((share) => Object.freeze({ ...share }))),
    createdAt: new Date(record.createdAt.getTime()),
    updatedAt: new Date(record.updatedAt.getTime()),
  });
}

function freezeOperation(operation: AssetOwnershipOperationRecord): AssetOwnershipOperationRecord {
  return Object.freeze({
    ...operation,
    createdAt: new Date(operation.createdAt.getTime()),
    completedAt:
      operation.completedAt === undefined ? undefined : new Date(operation.completedAt.getTime()),
  });
}

export class InMemoryAssetOwnershipRepo implements AssetOwnershipRepo {
  private readonly ownership = new Map<string, AssetOwnershipRecord>();
  private readonly operations = new Map<string, AssetOwnershipOperationRecord>();

  constructor(
    ownership: readonly AssetOwnershipRecord[] = [],
    operations: readonly AssetOwnershipOperationRecord[] = [],
    private readonly approvals?: InMemoryApprovalPort,
    private readonly teams?: AssetOwnershipTeamPort
  ) {
    for (const record of ownership) {
      this.ownership.set(
        this.ownershipKey(record.businessId, record.assetType, record.assetId),
        freezeOwnership(record)
      );
    }

    for (const operation of operations) {
      this.operations.set(
        this.operationKey(operation.businessId, operation.id),
        freezeOperation(operation)
      );
    }
  }

  private ownershipKey(businessId: string, assetType: TeamAssetType, assetId: string): string {
    return JSON.stringify([businessId, assetType, assetId]);
  }

  private operationKey(businessId: string, operationId: string): string {
    return JSON.stringify([businessId, operationId]);
  }

  async create(record: AssetOwnershipRecord): Promise<void> {
    return withInMemoryTeamMutationLock(() => this.createUnlocked(record));
  }

  private async createUnlocked(record: AssetOwnershipRecord): Promise<void> {
    const key = this.ownershipKey(record.businessId, record.assetType, record.assetId);
    if (this.ownership.has(key)) {
      throw new AssetOwnershipStoreError("duplicate", "Asset ownership already exists");
    }
    await this.assertActiveTeams(record);
    this.ownership.set(key, freezeOwnership(record));
  }

  async get(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord | undefined> {
    const record = this.ownership.get(this.ownershipKey(businessId, assetType, assetId));
    return record === undefined ? undefined : freezeOwnership(record);
  }

  async getMany(
    businessId: string,
    assetType: TeamAssetType,
    assetIds: readonly string[]
  ): Promise<AssetOwnershipRecord[]> {
    const wanted = new Set(assetIds);
    return [...this.ownership.values()]
      .filter(
        (record) =>
          record.businessId === businessId &&
          record.assetType === assetType &&
          wanted.has(record.assetId)
      )
      .sort((left, right) => left.assetId.localeCompare(right.assetId))
      .map(freezeOwnership);
  }

  async listByTeam(
    businessId: string,
    teamIds: readonly string[]
  ): Promise<AssetOwnershipRecord[]> {
    const ids = new Set(teamIds);
    return [...this.ownership.values()]
      .filter(
        (record) =>
          record.businessId === businessId &&
          (record.owners.some((owner) => owner.kind === "team" && ids.has(owner.teamId)) ||
            record.shares.some((share) => ids.has(share.teamId)))
      )
      .sort(
        (left, right) =>
          left.assetType.localeCompare(right.assetType) || left.assetId.localeCompare(right.assetId)
      )
      .map(freezeOwnership);
  }

  async listByTeamsPage(
    businessId: string,
    teamIds: readonly string[],
    options: {
      readonly limit: number;
      readonly after?: AssetOwnershipCursor;
      readonly assetType?: TeamAssetType;
      readonly ownerTeamId?: string;
    }
  ): Promise<{ readonly records: readonly AssetOwnershipRecord[]; readonly hasMore: boolean }> {
    const relevant = new Set(teamIds);
    const filtered = [...this.ownership.values()]
      .filter(
        (record) =>
          record.businessId === businessId &&
          (options.assetType === undefined || record.assetType === options.assetType) &&
          (options.ownerTeamId === undefined ||
            record.owners.some(
              (owner) => owner.kind === "team" && owner.teamId === options.ownerTeamId
            )) &&
          (record.owners.some((owner) => owner.kind === "team" && relevant.has(owner.teamId)) ||
            record.shares.some((share) => relevant.has(share.teamId))) &&
          (options.after === undefined ||
            record.assetType > options.after.assetType ||
            (record.assetType === options.after.assetType &&
              record.assetId > options.after.assetId))
      )
      .sort(
        (left, right) =>
          left.assetType.localeCompare(right.assetType) || left.assetId.localeCompare(right.assetId)
      );
    return {
      records: filtered.slice(0, options.limit).map(freezeOwnership),
      hasMore: filtered.length > options.limit,
    };
  }

  async put(record: AssetOwnershipRecord, expectedRevision: number): Promise<void> {
    return withInMemoryTeamMutationLock(() => this.putUnlocked(record, expectedRevision));
  }

  private async putUnlocked(record: AssetOwnershipRecord, expectedRevision: number): Promise<void> {
    const key = this.ownershipKey(record.businessId, record.assetType, record.assetId);
    const current = this.ownership.get(key);
    if (!current) throw new AssetOwnershipStoreError("not_found", "Asset ownership was not found");
    if (current.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
      throw new AssetOwnershipStoreError("revision_conflict", "Asset ownership revision conflict");
    }
    await this.assertActiveTeams(record);
    this.ownership.set(key, freezeOwnership(record));
  }

  async delete(businessId: string, assetType: TeamAssetType, assetId: string): Promise<void> {
    return withInMemoryTeamMutationLock(() => this.deleteUnlocked(businessId, assetType, assetId));
  }

  private async deleteUnlocked(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<void> {
    this.ownership.delete(this.ownershipKey(businessId, assetType, assetId));
  }

  async createOperation(operation: AssetOwnershipOperationRecord): Promise<void> {
    return withInMemoryTeamMutationLock(() => this.createOperationUnlocked(operation));
  }

  private async createOperationUnlocked(operation: AssetOwnershipOperationRecord): Promise<void> {
    const key = this.operationKey(operation.businessId, operation.id);
    if (this.operations.has(key)) {
      throw new AssetOwnershipStoreError("duplicate", "Ownership operation already exists");
    }
    if (operation.teamId) {
      await this.assertActiveTeam(operation.businessId, operation.teamId);
    }
    this.operations.set(key, freezeOperation(operation));
  }

  async createOperationWithApproval(
    operation: AssetOwnershipOperationRecord,
    approval: NewApprovalGrant
  ): Promise<void> {
    return withInMemoryTeamMutationLock(() =>
      this.createOperationWithApprovalUnlocked(operation, approval)
    );
  }

  private async createOperationWithApprovalUnlocked(
    operation: AssetOwnershipOperationRecord,
    approval: NewApprovalGrant
  ): Promise<void> {
    if (!this.approvals) {
      throw new AssetOwnershipStoreError(
        "not_found",
        "Approval repository is required to create an approved operation"
      );
    }
    const key = this.operationKey(operation.businessId, operation.id);
    if (this.operations.has(key)) {
      throw new AssetOwnershipStoreError("duplicate", "Ownership operation already exists");
    }
    if (operation.teamId !== undefined) {
      await this.assertActiveTeam(operation.businessId, operation.teamId);
    }
    await this.approvals.create(approval);
    this.operations.set(key, freezeOperation(operation));
  }

  async getOperation(
    businessId: string,
    operationId: string
  ): Promise<AssetOwnershipOperationRecord | undefined> {
    const operation = this.operations.get(this.operationKey(businessId, operationId));
    return operation === undefined ? undefined : freezeOperation(operation);
  }

  async listOperations(
    businessId: string,
    status?: "pending" | "completed"
  ): Promise<AssetOwnershipOperationRecord[]> {
    return [...this.operations.values()]
      .filter(
        (operation) =>
          operation.businessId === businessId &&
          (status === undefined || operation.status === status)
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map(freezeOperation);
  }

  async listOperationsPage(
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
  }> {
    const filtered = [...this.operations.values()]
      .filter(
        (operation) =>
          operation.businessId === businessId &&
          (options.status === undefined || operation.status === options.status) &&
          (options.assetType === undefined || operation.assetType === options.assetType) &&
          (options.assetId === undefined || operation.assetId === options.assetId) &&
          (options.after === undefined ||
            operation.createdAt > options.after.createdAt ||
            (operation.createdAt.getTime() === options.after.createdAt.getTime() &&
              operation.id > options.after.id))
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
      );
    return {
      records: filtered.slice(0, options.limit).map(freezeOperation),
      hasMore: filtered.length > options.limit,
    };
  }

  async listOperationsForAssets(
    businessId: string,
    assets: readonly AssetOwnershipCursor[],
    status?: "pending" | "completed"
  ): Promise<AssetOwnershipOperationRecord[]> {
    const keys = new Set(assets.map((asset) => `${asset.assetType}\u0000${asset.assetId}`));
    return [...this.operations.values()]
      .filter(
        (operation) =>
          operation.businessId === businessId &&
          keys.has(`${operation.assetType}\u0000${operation.assetId}`) &&
          (status === undefined || operation.status === status)
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map(freezeOperation);
  }

  async completeApprovedOperation(input: CompleteApprovedOwnershipOperationInput): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }> {
    return withInMemoryTeamMutationLock(() => this.completeApprovedOperationUnlocked(input));
  }

  private async completeApprovedOperationUnlocked(
    input: CompleteApprovedOwnershipOperationInput
  ): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }> {
    const operationKey = this.operationKey(input.businessId, input.operationId);
    const operation = this.operations.get(operationKey);
    if (!operation) {
      throw new AssetOwnershipStoreError("not_found", "Ownership operation was not found");
    }
    if (operation.status !== "pending") {
      throw new AssetOwnershipStoreError(
        "revision_conflict",
        "Ownership operation revision conflict"
      );
    }
    const ownershipKey = this.ownershipKey(
      input.businessId,
      operation.assetType,
      operation.assetId
    );
    const current = this.ownership.get(ownershipKey);
    if (!current) {
      throw new AssetOwnershipStoreError("not_found", "Asset ownership was not found");
    }
    if (current.revision !== operation.expectedOwnershipRevision) {
      throw new AssetOwnershipStoreError("revision_conflict", "Asset ownership revision conflict");
    }
    const updated = input.updatedOwnership ?? current;
    if (
      updated.businessId !== current.businessId ||
      updated.assetType !== current.assetType ||
      updated.assetId !== current.assetId ||
      (input.updatedOwnership !== undefined && updated.revision !== current.revision + 1)
    ) {
      throw new AssetOwnershipStoreError("revision_conflict", "Asset ownership revision conflict");
    }
    if (!this.approvals) {
      throw new AssetOwnershipStoreError(
        "not_found",
        "Approval repository is required to complete an approved operation"
      );
    }
    if (input.updatedOwnership !== undefined) {
      await this.assertActiveTeams(updated);
    }
    const consumedApproval = await this.approvals.consume(
      input.businessId,
      operation.approvalId,
      input.binding,
      input.at
    );
    const completed = freezeOperation({
      ...operation,
      status: "completed",
      revision: operation.revision + 1,
      completedAt: input.at,
    });
    try {
      if (input.updatedOwnership !== undefined) {
        await this.assertActiveTeams(updated);
      }
    } catch (error) {
      this.approvals.restore({ ...consumedApproval, consumedAt: undefined });
      throw error;
    }
    if (input.updatedOwnership !== undefined) {
      this.ownership.set(ownershipKey, freezeOwnership(updated));
    }
    this.operations.set(operationKey, completed);
    return {
      ownership: freezeOwnership(updated),
      operation: freezeOperation(completed),
    };
  }

  async completeEmergencyOperation(
    input: Omit<CompleteApprovedOwnershipOperationInput, "binding">
  ): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }> {
    return withInMemoryTeamMutationLock(() => this.completeEmergencyOperationUnlocked(input));
  }

  private async completeEmergencyOperationUnlocked(
    input: Omit<CompleteApprovedOwnershipOperationInput, "binding">
  ): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }> {
    const operationKey = this.operationKey(input.businessId, input.operationId);
    const operation = this.operations.get(operationKey);
    if (!operation) {
      throw new AssetOwnershipStoreError("not_found", "Ownership operation was not found");
    }
    if (operation.status !== "pending") {
      throw new AssetOwnershipStoreError(
        "revision_conflict",
        "Ownership operation revision conflict"
      );
    }
    const ownershipKey = this.ownershipKey(
      input.businessId,
      operation.assetType,
      operation.assetId
    );
    const current = this.ownership.get(ownershipKey);
    if (!current) {
      throw new AssetOwnershipStoreError("not_found", "Asset ownership was not found");
    }
    if (current.revision !== operation.expectedOwnershipRevision) {
      throw new AssetOwnershipStoreError("revision_conflict", "Asset ownership revision conflict");
    }
    const updated = input.updatedOwnership ?? current;
    if (
      updated.businessId !== current.businessId ||
      updated.assetType !== current.assetType ||
      updated.assetId !== current.assetId ||
      (input.updatedOwnership !== undefined && updated.revision !== current.revision + 1)
    ) {
      throw new AssetOwnershipStoreError("revision_conflict", "Asset ownership revision conflict");
    }
    const completed = freezeOperation({
      ...operation,
      status: "completed",
      revision: operation.revision + 1,
      completedAt: input.at,
    });
    if (input.updatedOwnership !== undefined) {
      await this.assertActiveTeams(updated);
      this.ownership.set(ownershipKey, freezeOwnership(updated));
    }
    this.operations.set(operationKey, completed);
    return {
      ownership: freezeOwnership(updated),
      operation: freezeOperation(completed),
    };
  }

  private async assertActiveTeams(record: AssetOwnershipRecord): Promise<void> {
    const teamIds = [
      ...record.owners.flatMap((owner) => (owner.kind === "team" ? [owner.teamId] : [])),
      ...record.shares.map((share) => share.teamId),
    ];
    for (const teamId of new Set(teamIds)) {
      await this.assertActiveTeam(record.businessId, teamId);
    }
  }

  private async assertActiveTeam(businessId: string, teamId: string): Promise<void> {
    if (!this.teams) return;
    const team = await this.teams.getTeam(businessId, teamId);
    if (team?.status !== "active") {
      throw new AssetOwnershipStoreError(
        "not_found",
        "Asset owners, shares, and pending operations must name active Teams"
      );
    }
  }
}

interface OwnershipRow {
  business_id: string;
  asset_type: TeamAssetType;
  asset_id: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface OwnerRow {
  owner_kind: "team" | "principal";
  team_id: string | null;
  principal_id: string | null;
  principal_kind: string | null;
}

interface ShareRow {
  team_id: string;
  access: TeamAssetAccessLevel;
}

interface OperationRow {
  id: string;
  approval_id: string;
  business_id: string;
  asset_type: TeamAssetType;
  asset_id: string;
  action: AssetOwnershipOperationAction;
  team_id: string | null;
  expected_ownership_revision: number;
  status: "pending" | "completed";
  revision: number;
  created_at: Date;
  completed_at: Date | null;
}

function ownerFromRow(row: OwnerRow): TeamAssetOwner {
  if (row.owner_kind === "team" && row.team_id !== null) {
    return { kind: "team", teamId: row.team_id };
  }
  if (row.principal_id === null) {
    throw new AssetOwnershipStoreError("not_found", "Asset owner row is malformed");
  }
  return {
    kind: "principal",
    principalId: row.principal_id,
    principalKind: "user",
  };
}

function operationFromRow(row: OperationRow): AssetOwnershipOperationRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    businessId: row.business_id,
    assetType: row.asset_type,
    assetId: row.asset_id,
    action: row.action,
    ...(row.team_id === null ? {} : { teamId: row.team_id }),
    expectedOwnershipRevision: row.expected_ownership_revision,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export class PgAssetOwnershipRepo implements AssetOwnershipRepo {
  constructor(private readonly transactions: TransactionPort) {}

  private async insertOperationInTransaction(
    tx: Queryable,
    operation: AssetOwnershipOperationRecord
  ): Promise<void> {
    await tx.query(
      `INSERT INTO asset_ownership_operations
         (id, approval_id, business_id, asset_type, asset_id, action, team_id,
          expected_ownership_revision, status, revision, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        operation.id,
        operation.approvalId,
        operation.businessId,
        operation.assetType,
        operation.assetId,
        operation.action,
        operation.teamId ?? null,
        operation.expectedOwnershipRevision,
        operation.status,
        operation.revision,
        operation.createdAt,
        operation.completedAt ?? null,
      ]
    );
  }

  async create(record: AssetOwnershipRecord): Promise<void> {
    try {
      await this.transactions.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO asset_ownership
             (business_id, asset_type, asset_id, revision, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            record.businessId,
            record.assetType,
            record.assetId,
            record.revision,
            record.createdAt,
            record.updatedAt,
          ]
        );
        await this.replaceOwnersAndShares(tx, record);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AssetOwnershipStoreError("duplicate", "Asset ownership already exists");
      }
      throw error;
    }
  }

  async get(
    businessId: string,
    assetType: TeamAssetType,
    assetId: string
  ): Promise<AssetOwnershipRecord | undefined> {
    return await this.transactions.withTransaction((tx) =>
      this.getInTransaction(tx, businessId, assetType, assetId)
    );
  }

  async put(record: AssetOwnershipRecord, expectedRevision: number): Promise<void> {
    const updated = await this.transactions.withTransaction(async (tx) => {
      const result = await tx.query(
        `UPDATE asset_ownership
            SET revision = $4, updated_at = $5
          WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3
            AND revision = $6 AND $4 = $6 + 1
          RETURNING asset_id`,
        [
          record.businessId,
          record.assetType,
          record.assetId,
          record.revision,
          record.updatedAt,
          expectedRevision,
        ]
      );
      if (result.rows.length === 0) return false;
      await tx.query(
        `DELETE FROM asset_owners
          WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3`,
        [record.businessId, record.assetType, record.assetId]
      );
      await tx.query(
        `DELETE FROM asset_team_shares
          WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3`,
        [record.businessId, record.assetType, record.assetId]
      );
      await this.replaceOwnersAndShares(tx, record);
      return true;
    });
    if (!updated) {
      throw new AssetOwnershipStoreError("revision_conflict", "Asset ownership revision conflict");
    }
  }

  async delete(businessId: string, assetType: TeamAssetType, assetId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `DELETE FROM asset_ownership
            WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3`,
        [businessId, assetType, assetId]
      );
    });
  }

  async getMany(
    businessId: string,
    assetType: TeamAssetType,
    assetIds: readonly string[]
  ): Promise<AssetOwnershipRecord[]> {
    if (assetIds.length === 0) return [];
    return await this.transactions.withTransaction(async (tx) => {
      const records = await this.getManyInTransaction(
        tx,
        businessId,
        [...new Set(assetIds)].map((assetId) => ({ asset_type: assetType, asset_id: assetId }))
      );
      return records.sort((left, right) => left.assetId.localeCompare(right.assetId));
    });
  }

  async listByTeam(
    businessId: string,
    teamIds: readonly string[]
  ): Promise<AssetOwnershipRecord[]> {
    if (teamIds.length === 0) return [];
    return await this.transactions.withTransaction(async (tx) => {
      const rows = await tx.query<Pick<OwnershipRow, "asset_type" | "asset_id">>(
        `SELECT DISTINCT ownership.asset_type, ownership.asset_id
           FROM asset_ownership ownership
          WHERE ownership.business_id = $1
            AND (
              EXISTS (
                SELECT 1
                  FROM asset_owners owner
                 WHERE owner.business_id = ownership.business_id
                   AND owner.asset_type = ownership.asset_type
                   AND owner.asset_id = ownership.asset_id
                   AND owner.owner_kind = 'team'
                   AND owner.team_id::text = ANY($2::text[])
              )
              OR EXISTS (
                SELECT 1
                  FROM asset_team_shares share
                 WHERE share.business_id = ownership.business_id
                   AND share.asset_type = ownership.asset_type
                   AND share.asset_id = ownership.asset_id
                   AND share.team_id::text = ANY($2::text[])
              )
            )
          ORDER BY ownership.asset_type, ownership.asset_id`,
        [businessId, teamIds]
      );
      return await this.getManyInTransaction(tx, businessId, rows.rows);
    });
  }

  async listByTeamsPage(
    businessId: string,
    teamIds: readonly string[],
    options: {
      readonly limit: number;
      readonly after?: AssetOwnershipCursor;
      readonly assetType?: TeamAssetType;
      readonly ownerTeamId?: string;
    }
  ): Promise<{ readonly records: readonly AssetOwnershipRecord[]; readonly hasMore: boolean }> {
    if (teamIds.length === 0) return { records: [], hasMore: false };
    return await this.transactions.withTransaction(async (tx) => {
      const params: unknown[] = [businessId, [...teamIds]];
      const conditions = [
        "ownership.business_id = $1",
        `(
          EXISTS (
            SELECT 1
              FROM asset_owners owner
             WHERE owner.business_id = ownership.business_id
               AND owner.asset_type = ownership.asset_type
               AND owner.asset_id = ownership.asset_id
               AND owner.owner_kind = 'team'
               AND owner.team_id::text = ANY($2::text[])
          )
          OR EXISTS (
            SELECT 1
              FROM asset_team_shares share
             WHERE share.business_id = ownership.business_id
               AND share.asset_type = ownership.asset_type
               AND share.asset_id = ownership.asset_id
               AND share.team_id::text = ANY($2::text[])
          )
        )`,
      ];
      if (options.assetType !== undefined) {
        params.push(options.assetType);
        conditions.push(`ownership.asset_type = $${params.length}`);
      }
      if (options.ownerTeamId !== undefined) {
        params.push(options.ownerTeamId);
        conditions.push(`EXISTS (
          SELECT 1
            FROM asset_owners requested_owner
           WHERE requested_owner.business_id = ownership.business_id
             AND requested_owner.asset_type = ownership.asset_type
             AND requested_owner.asset_id = ownership.asset_id
             AND requested_owner.owner_kind = 'team'
             AND requested_owner.team_id::text = $${params.length}
        )`);
      }
      if (options.after !== undefined) {
        params.push(options.after.assetType, options.after.assetId);
        conditions.push(
          `(ownership.asset_type, ownership.asset_id) > ($${params.length - 1}, $${params.length})`
        );
      }
      params.push(options.limit + 1);
      const keys = await tx.query<Pick<OwnershipRow, "asset_type" | "asset_id">>(
        `SELECT ownership.asset_type, ownership.asset_id
           FROM asset_ownership ownership
          WHERE ${conditions.join(" AND ")}
          ORDER BY ownership.asset_type, ownership.asset_id
          LIMIT $${params.length}`,
        params
      );
      const pageKeys = keys.rows.slice(0, options.limit);
      return {
        records: await this.getManyInTransaction(tx, businessId, pageKeys),
        hasMore: keys.rows.length > options.limit,
      };
    });
  }

  async createOperation(operation: AssetOwnershipOperationRecord): Promise<void> {
    try {
      await this.transactions.withTransaction(async (tx) => {
        await this.insertOperationInTransaction(tx, operation);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AssetOwnershipStoreError("duplicate", "Ownership operation already exists");
      }
      throw error;
    }
  }

  async createOperationWithApproval(
    operation: AssetOwnershipOperationRecord,
    approval: NewApprovalGrant
  ): Promise<void> {
    try {
      await this.transactions.withTransaction(async (tx) => {
        await createApprovalInTransaction(tx, approval);
        await this.insertOperationInTransaction(tx, operation);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AssetOwnershipStoreError("duplicate", "Ownership operation already exists");
      }
      throw error;
    }
  }

  async getOperation(
    businessId: string,
    operationId: string
  ): Promise<AssetOwnershipOperationRecord | undefined> {
    return await this.transactions.withTransaction(async (tx) => {
      const result = await tx.query<OperationRow>(
        `SELECT id::text, approval_id::text, business_id, asset_type, asset_id, action,
                team_id::text, expected_ownership_revision, status, revision, created_at,
                completed_at
           FROM asset_ownership_operations
          WHERE business_id = $1 AND id = $2`,
        [businessId, operationId]
      );
      const row = result.rows[0];
      return row === undefined ? undefined : operationFromRow(row);
    });
  }

  async listOperations(
    businessId: string,
    status?: "pending" | "completed"
  ): Promise<AssetOwnershipOperationRecord[]> {
    return await this.transactions.withTransaction(async (tx) => {
      const params: unknown[] = [businessId];
      const statusClause = status === undefined ? "" : " AND status = $2";
      if (status !== undefined) params.push(status);
      const result = await tx.query<OperationRow>(
        `SELECT id::text, approval_id::text, business_id, asset_type, asset_id, action,
                team_id::text, expected_ownership_revision, status, revision, created_at,
                completed_at
           FROM asset_ownership_operations
          WHERE business_id = $1${statusClause}
          ORDER BY created_at, id`,
        params
      );
      return result.rows.map(operationFromRow);
    });
  }

  async listOperationsPage(
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
  }> {
    return this.transactions.withTransaction(async (tx) => {
      const params: unknown[] = [businessId];
      const conditions = ["business_id = $1"];
      if (options.status !== undefined) {
        conditions.push(`status = $${params.push(options.status)}`);
      }
      if (options.assetType !== undefined) {
        conditions.push(`asset_type = $${params.push(options.assetType)}`);
      }
      if (options.assetId !== undefined) {
        conditions.push(`asset_id = $${params.push(options.assetId)}`);
      }
      if (options.after !== undefined) {
        conditions.push(
          `(created_at, id) > ($${params.push(options.after.createdAt)}, $${params.push(
            options.after.id
          )})`
        );
      }
      params.push(options.limit + 1);
      const result = await tx.query<OperationRow>(
        `SELECT id::text, approval_id::text, business_id, asset_type, asset_id, action,
                team_id::text, expected_ownership_revision, status, revision, created_at,
                completed_at
           FROM asset_ownership_operations
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at, id
          LIMIT $${params.length}`,
        params
      );
      return {
        records: result.rows.slice(0, options.limit).map(operationFromRow),
        hasMore: result.rows.length > options.limit,
      };
    });
  }

  async listOperationsForAssets(
    businessId: string,
    assets: readonly AssetOwnershipCursor[],
    status?: "pending" | "completed"
  ): Promise<AssetOwnershipOperationRecord[]> {
    if (assets.length === 0) return [];
    const assetTypes = [...new Set(assets.map((asset) => asset.assetType))];
    const assetIds = [...new Set(assets.map((asset) => asset.assetId))];
    const exactKeys = new Set(assets.map((asset) => `${asset.assetType}\u0000${asset.assetId}`));
    return await this.transactions.withTransaction(async (tx) => {
      const params: unknown[] = [businessId, assetTypes, assetIds];
      const statusClause = status === undefined ? "" : ` AND status = $${params.push(status)}`;
      const result = await tx.query<OperationRow>(
        `SELECT id::text, approval_id::text, business_id, asset_type, asset_id, action,
                team_id::text, expected_ownership_revision, status, revision, created_at,
                completed_at
           FROM asset_ownership_operations
          WHERE business_id = $1
            AND asset_type = ANY($2::text[])
            AND asset_id = ANY($3::text[])${statusClause}
          ORDER BY created_at, id`,
        params
      );
      return result.rows
        .map(operationFromRow)
        .filter((operation) => exactKeys.has(`${operation.assetType}\u0000${operation.assetId}`));
    });
  }

  async completeApprovedOperation(input: CompleteApprovedOwnershipOperationInput): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }> {
    return await this.transactions.withTransaction(async (tx) => {
      const operationResult = await tx.query<OperationRow>(
        `SELECT id::text, approval_id::text, business_id, asset_type, asset_id, action,
                team_id::text, expected_ownership_revision, status, revision, created_at,
                completed_at
           FROM asset_ownership_operations
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [input.businessId, input.operationId]
      );
      const operationRow = operationResult.rows[0];
      if (operationRow === undefined) {
        throw new AssetOwnershipStoreError("not_found", "Ownership operation was not found");
      }
      const operation = operationFromRow(operationRow);
      if (operation.status !== "pending") {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Ownership operation revision conflict"
        );
      }
      const current = await this.getInTransaction(
        tx,
        input.businessId,
        operation.assetType,
        operation.assetId,
        true
      );
      if (!current) {
        throw new AssetOwnershipStoreError("not_found", "Asset ownership was not found");
      }
      if (current.revision !== operation.expectedOwnershipRevision) {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Asset ownership revision conflict"
        );
      }
      const updated = input.updatedOwnership ?? current;
      if (
        updated.businessId !== current.businessId ||
        updated.assetType !== current.assetType ||
        updated.assetId !== current.assetId ||
        (input.updatedOwnership !== undefined && updated.revision !== current.revision + 1)
      ) {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Asset ownership revision conflict"
        );
      }
      await consumeApprovalInTransaction(
        tx,
        input.businessId,
        operation.approvalId,
        input.binding,
        input.at
      );
      if (input.updatedOwnership !== undefined) {
        const ownershipResult = await tx.query(
          `UPDATE asset_ownership
              SET revision = $4, updated_at = $5
            WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3
              AND revision = $6 AND $4 = $6 + 1
            RETURNING asset_id`,
          [
            updated.businessId,
            updated.assetType,
            updated.assetId,
            updated.revision,
            updated.updatedAt,
            current.revision,
          ]
        );
        if (ownershipResult.rows.length === 0) {
          throw new AssetOwnershipStoreError(
            "revision_conflict",
            "Asset ownership revision conflict"
          );
        }
        await tx.query(
          `DELETE FROM asset_owners
            WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3`,
          [updated.businessId, updated.assetType, updated.assetId]
        );
        await tx.query(
          `DELETE FROM asset_team_shares
            WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3`,
          [updated.businessId, updated.assetType, updated.assetId]
        );
        await this.replaceOwnersAndShares(tx, updated);
      }
      const completedResult = await tx.query<OperationRow>(
        `UPDATE asset_ownership_operations
            SET status = 'completed', revision = revision + 1, completed_at = $3
          WHERE business_id = $1 AND id = $2 AND revision = $4 AND status = 'pending'
          RETURNING id::text, approval_id::text, business_id, asset_type, asset_id, action,
                    team_id::text, expected_ownership_revision, status, revision, created_at,
                    completed_at`,
        [input.businessId, input.operationId, input.at, operation.revision]
      );
      const completedRow = completedResult.rows[0];
      if (completedRow === undefined) {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Ownership operation revision conflict"
        );
      }
      return {
        ownership: input.updatedOwnership === undefined ? current : updated,
        operation: operationFromRow(completedRow),
      };
    });
  }

  async completeEmergencyOperation(
    input: Omit<CompleteApprovedOwnershipOperationInput, "binding">
  ): Promise<{
    readonly ownership: AssetOwnershipRecord;
    readonly operation: AssetOwnershipOperationRecord;
  }> {
    return await this.transactions.withTransaction(async (tx) => {
      const operationResult = await tx.query<OperationRow>(
        `SELECT id::text, approval_id::text, business_id, asset_type, asset_id, action,
                team_id::text, expected_ownership_revision, status, revision, created_at,
                completed_at
           FROM asset_ownership_operations
          WHERE business_id = $1 AND id = $2
          FOR UPDATE`,
        [input.businessId, input.operationId]
      );
      const operationRow = operationResult.rows[0];
      if (operationRow === undefined) {
        throw new AssetOwnershipStoreError("not_found", "Ownership operation was not found");
      }
      const operation = operationFromRow(operationRow);
      if (operation.status !== "pending") {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Ownership operation revision conflict"
        );
      }
      const current = await this.getInTransaction(
        tx,
        input.businessId,
        operation.assetType,
        operation.assetId,
        true
      );
      if (!current) {
        throw new AssetOwnershipStoreError("not_found", "Asset ownership was not found");
      }
      if (current.revision !== operation.expectedOwnershipRevision) {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Asset ownership revision conflict"
        );
      }
      const updated = input.updatedOwnership ?? current;
      if (
        updated.businessId !== current.businessId ||
        updated.assetType !== current.assetType ||
        updated.assetId !== current.assetId ||
        (input.updatedOwnership !== undefined && updated.revision !== current.revision + 1)
      ) {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Asset ownership revision conflict"
        );
      }
      if (input.updatedOwnership !== undefined) {
        const ownershipResult = await tx.query(
          `UPDATE asset_ownership
              SET revision = $4, updated_at = $5
            WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3
              AND revision = $6 AND $4 = $6 + 1
            RETURNING asset_id`,
          [
            updated.businessId,
            updated.assetType,
            updated.assetId,
            updated.revision,
            updated.updatedAt,
            current.revision,
          ]
        );
        if (ownershipResult.rows.length === 0) {
          throw new AssetOwnershipStoreError(
            "revision_conflict",
            "Asset ownership revision conflict"
          );
        }
        await tx.query(
          `DELETE FROM asset_owners
            WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3`,
          [updated.businessId, updated.assetType, updated.assetId]
        );
        await tx.query(
          `DELETE FROM asset_team_shares
            WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3`,
          [updated.businessId, updated.assetType, updated.assetId]
        );
        await this.replaceOwnersAndShares(tx, updated);
      }
      const completedResult = await tx.query<OperationRow>(
        `UPDATE asset_ownership_operations
            SET status = 'completed', revision = revision + 1, completed_at = $3
          WHERE business_id = $1 AND id = $2 AND revision = $4 AND status = 'pending'
          RETURNING id::text, approval_id::text, business_id, asset_type, asset_id, action,
                    team_id::text, expected_ownership_revision, status, revision, created_at,
                    completed_at`,
        [input.businessId, input.operationId, input.at, operation.revision]
      );
      const completedRow = completedResult.rows[0];
      if (completedRow === undefined) {
        throw new AssetOwnershipStoreError(
          "revision_conflict",
          "Ownership operation revision conflict"
        );
      }
      return {
        ownership: input.updatedOwnership === undefined ? current : updated,
        operation: operationFromRow(completedRow),
      };
    });
  }

  private async getInTransaction(
    tx: Queryable,
    businessId: string,
    assetType: TeamAssetType,
    assetId: string,
    lock = false
  ): Promise<AssetOwnershipRecord | undefined> {
    const result = await tx.query<OwnershipRow>(
      `SELECT business_id, asset_type, asset_id, revision, created_at, updated_at
         FROM asset_ownership
        WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3${lock ? " FOR UPDATE" : ""}`,
      [businessId, assetType, assetId]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const [owners, shares] = await Promise.all([
      tx.query<OwnerRow>(
        `SELECT owner_kind, team_id::text, principal_id, principal_kind
           FROM asset_owners
          WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3
          ORDER BY owner_kind, team_id, principal_id`,
        [businessId, assetType, assetId]
      ),
      tx.query<ShareRow>(
        `SELECT team_id::text, access
           FROM asset_team_shares
          WHERE business_id = $1 AND asset_type = $2 AND asset_id = $3
          ORDER BY team_id`,
        [businessId, assetType, assetId]
      ),
    ]);
    return {
      businessId: row.business_id,
      assetType: row.asset_type,
      assetId: row.asset_id,
      owners: owners.rows.map(ownerFromRow),
      shares: shares.rows.map((share) => ({
        teamId: share.team_id,
        access: share.access,
      })),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async getManyInTransaction(
    tx: Queryable,
    businessId: string,
    keys: readonly Pick<OwnershipRow, "asset_type" | "asset_id">[]
  ): Promise<AssetOwnershipRecord[]> {
    if (keys.length === 0) return [];
    const assetTypes = [...new Set(keys.map((key) => key.asset_type))];
    const assetIds = [...new Set(keys.map((key) => key.asset_id))];
    const [ownership, owners, shares] = await Promise.all([
      tx.query<OwnershipRow>(
        `SELECT business_id, asset_type, asset_id, revision, created_at, updated_at
           FROM asset_ownership
          WHERE business_id = $1
            AND asset_type = ANY($2::text[])
            AND asset_id = ANY($3::text[])`,
        [businessId, assetTypes, assetIds]
      ),
      tx.query<OwnerRow & { asset_type: TeamAssetType; asset_id: string }>(
        `SELECT asset_type, asset_id, owner_kind, team_id::text, principal_id, principal_kind
           FROM asset_owners
          WHERE business_id = $1
            AND asset_type = ANY($2::text[])
            AND asset_id = ANY($3::text[])
          ORDER BY owner_kind, team_id, principal_id`,
        [businessId, assetTypes, assetIds]
      ),
      tx.query<ShareRow & { asset_type: TeamAssetType; asset_id: string }>(
        `SELECT asset_type, asset_id, team_id::text, access
           FROM asset_team_shares
          WHERE business_id = $1
            AND asset_type = ANY($2::text[])
            AND asset_id = ANY($3::text[])
          ORDER BY team_id`,
        [businessId, assetTypes, assetIds]
      ),
    ]);
    const keyOf = (assetType: TeamAssetType, assetId: string) => `${assetType}\u0000${assetId}`;
    const ownershipByKey = new Map(
      ownership.rows.map((row) => [keyOf(row.asset_type, row.asset_id), row])
    );
    const ownersByKey = new Map<string, TeamAssetOwner[]>();
    for (const row of owners.rows) {
      const key = keyOf(row.asset_type, row.asset_id);
      ownersByKey.set(key, [...(ownersByKey.get(key) ?? []), ownerFromRow(row)]);
    }
    const sharesByKey = new Map<string, AssetTeamShareRecord[]>();
    for (const row of shares.rows) {
      const key = keyOf(row.asset_type, row.asset_id);
      sharesByKey.set(key, [
        ...(sharesByKey.get(key) ?? []),
        { teamId: row.team_id, access: row.access },
      ]);
    }
    return keys.flatMap((key) => {
      const row = ownershipByKey.get(keyOf(key.asset_type, key.asset_id));
      return row === undefined
        ? []
        : [
            {
              businessId: row.business_id,
              assetType: row.asset_type,
              assetId: row.asset_id,
              owners: ownersByKey.get(keyOf(row.asset_type, row.asset_id)) ?? [],
              shares: sharesByKey.get(keyOf(row.asset_type, row.asset_id)) ?? [],
              revision: row.revision,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            },
          ];
    });
  }

  private async replaceOwnersAndShares(tx: Queryable, record: AssetOwnershipRecord): Promise<void> {
    for (const owner of record.owners) {
      await tx.query(
        `INSERT INTO asset_owners
           (business_id, asset_type, asset_id, owner_kind, team_id, principal_id, principal_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.businessId,
          record.assetType,
          record.assetId,
          owner.kind,
          owner.kind === "team" ? owner.teamId : null,
          owner.kind === "principal" ? owner.principalId : null,
          owner.kind === "principal" ? owner.principalKind : null,
        ]
      );
    }
    for (const share of record.shares) {
      await tx.query(
        `INSERT INTO asset_team_shares
           (business_id, asset_type, asset_id, team_id, access)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.businessId, record.assetType, record.assetId, share.teamId, share.access]
      );
    }
  }
}

export const ASSET_OWNERSHIP_ACTIVE_TEAM_GUARD_STATEMENTS: readonly string[] = [
  `CREATE OR REPLACE FUNCTION enforce_active_asset_team_reference()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      referenced_team_id uuid;
      team_status text;
    BEGIN
      IF TG_TABLE_NAME = 'asset_owners' AND to_jsonb(NEW)->>'owner_kind' <> 'team' THEN
        RETURN NEW;
      END IF;
      referenced_team_id := (to_jsonb(NEW)->>'team_id')::uuid;
      IF referenced_team_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT status INTO team_status
        FROM teams
       WHERE business_id = NEW.business_id AND id = referenced_team_id
       FOR UPDATE;
      IF team_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'Asset owners, shares, and pending operations must name active Teams';
      END IF;
      RETURN NEW;
    END;
    $$`,
  `DROP TRIGGER IF EXISTS asset_owners_active_team_guard ON asset_owners`,
  `CREATE TRIGGER asset_owners_active_team_guard
    BEFORE INSERT OR UPDATE ON asset_owners
    FOR EACH ROW EXECUTE FUNCTION enforce_active_asset_team_reference()`,
  `DROP TRIGGER IF EXISTS asset_team_shares_active_team_guard ON asset_team_shares`,
  `CREATE TRIGGER asset_team_shares_active_team_guard
    BEFORE INSERT OR UPDATE ON asset_team_shares
    FOR EACH ROW EXECUTE FUNCTION enforce_active_asset_team_reference()`,
  `DROP TRIGGER IF EXISTS asset_ownership_operations_active_team_guard
     ON asset_ownership_operations`,
  `CREATE TRIGGER asset_ownership_operations_active_team_guard
    BEFORE INSERT OR UPDATE ON asset_ownership_operations
    FOR EACH ROW EXECUTE FUNCTION enforce_active_asset_team_reference()`,
];

export const ASSET_OWNERSHIP_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asset_ownership (
    business_id text NOT NULL,
    asset_type text NOT NULL CHECK (asset_type IN ('agent', 'skill', 'routine', 'file', 'knowledge')),
    asset_id text NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, asset_type, asset_id)
  )`,
  `CREATE TABLE IF NOT EXISTS asset_owners (
    business_id text NOT NULL,
    asset_type text NOT NULL,
    asset_id text NOT NULL,
    owner_kind text NOT NULL CHECK (owner_kind IN ('team', 'principal')),
    team_id uuid,
    principal_id text,
    principal_kind text,
    CHECK (
      (owner_kind = 'team' AND team_id IS NOT NULL AND principal_id IS NULL AND principal_kind IS NULL)
      OR
      (owner_kind = 'principal' AND team_id IS NULL AND principal_id IS NOT NULL AND principal_kind = 'user')
    ),
    FOREIGN KEY (business_id, asset_type, asset_id)
      REFERENCES asset_ownership (business_id, asset_type, asset_id) ON DELETE CASCADE,
    UNIQUE NULLS NOT DISTINCT (business_id, asset_type, asset_id, owner_kind, team_id, principal_id)
  )`,
  `CREATE TABLE IF NOT EXISTS asset_team_shares (
    business_id text NOT NULL,
    asset_type text NOT NULL,
    asset_id text NOT NULL,
    team_id uuid NOT NULL,
    access text NOT NULL CHECK (access IN ('view', 'use', 'edit')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (business_id, asset_type, asset_id)
      REFERENCES asset_ownership (business_id, asset_type, asset_id) ON DELETE CASCADE,
    PRIMARY KEY (business_id, asset_type, asset_id, team_id)
  )`,
  `CREATE TABLE IF NOT EXISTS asset_ownership_operations (
    id uuid PRIMARY KEY,
    approval_id uuid NOT NULL UNIQUE,
    business_id text NOT NULL,
    asset_type text NOT NULL CHECK (asset_type IN ('agent', 'skill', 'routine', 'file', 'knowledge')),
    asset_id text NOT NULL,
    action text NOT NULL CHECK (action IN ('add_owner', 'remove_owner', 'move', 'archive', 'delete')),
    team_id uuid,
    expected_ownership_revision integer NOT NULL CHECK (expected_ownership_revision >= 1),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    completed_at timestamptz(3),
    FOREIGN KEY (business_id, asset_type, asset_id)
      REFERENCES asset_ownership (business_id, asset_type, asset_id) ON DELETE CASCADE,
    CHECK (
      (status = 'pending' AND completed_at IS NULL)
      OR
      (status = 'completed' AND completed_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS asset_owners_team_reference_idx
     ON asset_owners (business_id, team_id, asset_type, asset_id)
     WHERE owner_kind = 'team'`,
  `CREATE INDEX IF NOT EXISTS asset_team_shares_team_reference_idx
     ON asset_team_shares (business_id, team_id, asset_type, asset_id)`,
  `CREATE INDEX IF NOT EXISTS asset_ownership_operations_pending_team_idx
     ON asset_ownership_operations (business_id, team_id, approval_id)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS asset_ownership_operations_pending_asset_idx
     ON asset_ownership_operations (business_id, asset_type, asset_id, approval_id)
     WHERE status = 'pending'`,
  ...ASSET_OWNERSHIP_ACTIVE_TEAM_GUARD_STATEMENTS,
];

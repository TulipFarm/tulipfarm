/** Approval storage keeps safe summaries/digests, append-only decisions, and atomic spend. */
import type { Queryable, TransactionPort } from "../ports";

/** Digests identifying the exact intent, evidence, and Guardrail revision an Approval covers. */
export interface ApprovalBindingRecord {
  readonly intentDigest: string;
  readonly evidenceDigest: string;
  readonly guardrailRevision: string;
}

export type ApprovalRiskLevel = "low" | "medium" | "high";

export interface ApprovalDecisionEntry {
  readonly approverPrincipalId: string;
  readonly approverRoles: readonly string[];
  readonly satisfiedApproverRole?: string;
  readonly outcome: "approved" | "denied";
  readonly decidedAt: Date;
}

export interface ApprovalGrantRecord {
  readonly approvalId: string;
  readonly businessId: string;
  readonly binding: ApprovalBindingRecord;
  readonly risk: ApprovalRiskLevel;
  readonly allowedApproverRoles: readonly string[];
  readonly requiredApproverRoles: readonly string[];
  readonly proposerPrincipalId: string;
  readonly performerPrincipalId?: string;
  readonly agentPrincipalId?: string;
  /** Readable diff/preview shown to approvers. Safe summary text only. */
  readonly preview: string;
  /** Readable risk summary shown to approvers. Safe summary text only. */
  readonly riskSummary: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly decisions: readonly ApprovalDecisionEntry[];
  readonly consumedAt?: Date;
  readonly revokedAt?: Date;
}

export interface OpenApprovalQuery {
  readonly at: Date;
  readonly requiredTeamIds?: readonly string[];
}

/** A new Approval: decisions, consumption, and revocation are recorded through the repo. */
export type NewApprovalGrant = Omit<
  ApprovalGrantRecord,
  "decisions" | "consumedAt" | "revokedAt" | "requiredApproverRoles"
> & {
  readonly requiredApproverRoles?: readonly string[];
};

export type ApprovalStoreErrorCode =
  | "not_found"
  | "duplicate_approval"
  | "duplicate_approver"
  | "already_used"
  | "revoked"
  | "binding_mismatch"
  | "expired"
  | "self_approval"
  | "approver_not_qualified"
  | "denied"
  | "insufficient_approvals";

export class ApprovalStoreError extends Error {
  constructor(
    public readonly code: ApprovalStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ApprovalStoreError";
  }
}

export interface ApprovalRepo {
  create(grant: NewApprovalGrant): Promise<ApprovalGrantRecord>;
  get(businessId: string, approvalId: string): Promise<ApprovalGrantRecord | undefined>;
  getMany(businessId: string, approvalIds: readonly string[]): Promise<ApprovalGrantRecord[]>;
  getOpenMany(
    businessId: string,
    approvalIds: readonly string[],
    query: OpenApprovalQuery
  ): Promise<ApprovalGrantRecord[]>;
  /** All Approvals of one business, oldest first — the rehydration source after a restart. */
  list(businessId: string): Promise<ApprovalGrantRecord[]>;
  appendDecision(
    businessId: string,
    approvalId: string,
    decision: ApprovalDecisionEntry
  ): Promise<ApprovalGrantRecord>;
  /** Atomic one-use spend: state, binding, quorum, and consumed marker must validate together. */
  consume(
    businessId: string,
    approvalId: string,
    binding: ApprovalBindingRecord,
    at: Date
  ): Promise<ApprovalGrantRecord>;
  revoke(businessId: string, approvalId: string, at: Date): Promise<ApprovalGrantRecord>;
}

export type ApprovalRoleResolver = (
  businessId: string,
  principalId: string,
  at: Date
) => Promise<readonly string[]>;

function freeze(record: ApprovalGrantRecord): ApprovalGrantRecord {
  return Object.freeze({
    ...record,
    binding: Object.freeze({ ...record.binding }),
    allowedApproverRoles: Object.freeze([...record.allowedApproverRoles]),
    requiredApproverRoles: Object.freeze([...record.requiredApproverRoles]),
    expiresAt: new Date(record.expiresAt.getTime()),
    createdAt: new Date(record.createdAt.getTime()),
    decisions: Object.freeze(
      record.decisions.map((entry) =>
        Object.freeze({
          ...entry,
          approverRoles: Object.freeze([...entry.approverRoles]),
          decidedAt: new Date(entry.decidedAt.getTime()),
        })
      )
    ),
    consumedAt: record.consumedAt === undefined ? undefined : new Date(record.consumedAt.getTime()),
    revokedAt: record.revokedAt === undefined ? undefined : new Date(record.revokedAt.getTime()),
  });
}

function bindingsEqual(a: ApprovalBindingRecord, b: ApprovalBindingRecord): boolean {
  return (
    a.intentDigest === b.intentDigest &&
    a.evidenceDigest === b.evidenceDigest &&
    a.guardrailRevision === b.guardrailRevision
  );
}

function teamIdFromAdminRole(role: string | undefined): string | undefined {
  if (!role?.startsWith("team:") || !role.endsWith(":admin")) return undefined;
  const teamId = role.slice("team:".length, -":admin".length);
  return teamId.length > 0 ? teamId : undefined;
}

function qualifiedDecision(
  record: ApprovalGrantRecord,
  decision: ApprovalDecisionEntry,
  liveRoles: ReadonlySet<string>
): boolean {
  const prohibited = [
    record.proposerPrincipalId,
    record.performerPrincipalId,
    record.agentPrincipalId,
  ].filter((id): id is string => id !== undefined);
  if (
    prohibited.includes(decision.approverPrincipalId) ||
    !decision.approverRoles.some((role) => record.allowedApproverRoles.includes(role))
  ) {
    return false;
  }
  const teamRole =
    decision.satisfiedApproverRole ??
    decision.approverRoles.find(
      (role) =>
        record.allowedApproverRoles.includes(role) && teamIdFromAdminRole(role) !== undefined
    );
  return (
    teamIdFromAdminRole(teamRole) === undefined ||
    liveRoles.has(`${decision.approverPrincipalId}\u0000${teamRole}`)
  );
}

function assertConsumable(
  record: ApprovalGrantRecord,
  binding: ApprovalBindingRecord,
  at: Date,
  liveRoles: ReadonlySet<string>
): void {
  if (!bindingsEqual(record.binding, binding)) {
    throw new ApprovalStoreError(
      "binding_mismatch",
      `Approval ${record.approvalId} was not granted for this binding`
    );
  }
  if (record.decisions.some((decision) => decision.outcome === "denied")) {
    throw new ApprovalStoreError("denied", `Approval ${record.approvalId} was denied`);
  }
  if (
    !record.requiredApproverRoles.every((requiredRole) =>
      record.decisions.some(
        (decision) =>
          decision.outcome === "approved" &&
          decision.satisfiedApproverRole === requiredRole &&
          decision.approverRoles.includes(requiredRole) &&
          qualifiedDecision(record, decision, liveRoles)
      )
    )
  ) {
    throw new ApprovalStoreError(
      "insufficient_approvals",
      `Approval ${record.approvalId} lacks a live decision from every required approver role`
    );
  }
  const qualifiedApprovers = new Set(
    record.decisions
      .filter(
        (decision) =>
          decision.outcome === "approved" && qualifiedDecision(record, decision, liveRoles)
      )
      .map((decision) => decision.approverPrincipalId)
  );
  const required =
    record.requiredApproverRoles.length > 0
      ? record.requiredApproverRoles.length
      : record.risk === "high"
        ? 2
        : 1;
  if (qualifiedApprovers.size < required) {
    throw new ApprovalStoreError(
      "insufficient_approvals",
      `Approval ${record.approvalId} lacks the required number of live qualified approvers`
    );
  }
  if (record.expiresAt <= at) {
    throw new ApprovalStoreError("expired", `Approval ${record.approvalId} has expired`);
  }
}

/** Process-local ApprovalRepo double; durable adapters enforce the same constraints in storage. */
export class InMemoryApprovalRepo implements ApprovalRepo {
  private readonly records = new Map<string, ApprovalGrantRecord>();

  /** `seed` rehydrates previously stored rows, as a restarted process would. */
  constructor(
    seed: readonly ApprovalGrantRecord[] = [],
    private readonly resolveRoles?: ApprovalRoleResolver
  ) {
    for (const record of seed) {
      this.records.set(this.key(record.businessId, record.approvalId), freeze({ ...record }));
    }
  }

  private key(businessId: string, approvalId: string): string {
    return JSON.stringify([businessId, approvalId]);
  }

  /** The stored record, or a `not_found` error. Callers must not await between this and a write. */
  private require(businessId: string, approvalId: string): ApprovalGrantRecord {
    const record = this.records.get(this.key(businessId, approvalId));
    if (!record) {
      throw new ApprovalStoreError("not_found", `Approval ${approvalId} does not exist`);
    }
    return record;
  }

  private assertOpen(record: ApprovalGrantRecord, at?: Date): void {
    if (record.revokedAt !== undefined) {
      throw new ApprovalStoreError("revoked", `Approval ${record.approvalId} was revoked`);
    }
    if (record.consumedAt !== undefined) {
      throw new ApprovalStoreError(
        "already_used",
        `Approval ${record.approvalId} was already used`
      );
    }
    if (at !== undefined && record.expiresAt <= at) {
      throw new ApprovalStoreError("expired", `Approval ${record.approvalId} has expired`);
    }
  }

  private qualified(record: ApprovalGrantRecord, decision: ApprovalDecisionEntry): boolean {
    const prohibited = [
      record.proposerPrincipalId,
      record.performerPrincipalId,
      record.agentPrincipalId,
    ].filter((id): id is string => id !== undefined);
    return (
      !prohibited.includes(decision.approverPrincipalId) &&
      decision.approverRoles.some((role) => record.allowedApproverRoles.includes(role))
    );
  }

  private write(record: ApprovalGrantRecord): ApprovalGrantRecord {
    const stored = freeze(record);
    this.records.set(this.key(stored.businessId, stored.approvalId), stored);
    return freeze(stored);
  }

  async create(grant: NewApprovalGrant): Promise<ApprovalGrantRecord> {
    if (this.records.has(this.key(grant.businessId, grant.approvalId))) {
      throw new ApprovalStoreError(
        "duplicate_approval",
        `Approval ${grant.approvalId} already exists`
      );
    }
    return this.write({
      ...grant,
      requiredApproverRoles: grant.requiredApproverRoles ?? [],
      decisions: [],
    });
  }

  async get(businessId: string, approvalId: string): Promise<ApprovalGrantRecord | undefined> {
    const record = this.records.get(this.key(businessId, approvalId));
    return record === undefined ? undefined : freeze(record);
  }

  restore(record: ApprovalGrantRecord): void {
    this.write(record);
  }

  async getMany(
    businessId: string,
    approvalIds: readonly string[]
  ): Promise<ApprovalGrantRecord[]> {
    return approvalIds.flatMap((approvalId) => {
      const record = this.records.get(this.key(businessId, approvalId));
      return record === undefined ? [] : [freeze(record)];
    });
  }

  async getOpenMany(
    businessId: string,
    approvalIds: readonly string[],
    query: OpenApprovalQuery
  ): Promise<ApprovalGrantRecord[]> {
    if (query.requiredTeamIds?.length === 0) return [];
    const requiredRoles = query.requiredTeamIds?.map((teamId) => `team:${teamId}:admin`);
    return approvalIds.flatMap((approvalId) => {
      const record = this.records.get(this.key(businessId, approvalId));
      if (
        record === undefined ||
        record.consumedAt !== undefined ||
        record.revokedAt !== undefined ||
        record.expiresAt <= query.at ||
        record.decisions.some((decision) => decision.outcome === "denied") ||
        (requiredRoles !== undefined &&
          !record.requiredApproverRoles.some((role) => requiredRoles.includes(role)))
      ) {
        return [];
      }
      return [freeze(record)];
    });
  }

  async list(businessId: string): Promise<ApprovalGrantRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.businessId === businessId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(freeze);
  }

  async appendDecision(
    businessId: string,
    approvalId: string,
    decision: ApprovalDecisionEntry
  ): Promise<ApprovalGrantRecord> {
    const record = this.require(businessId, approvalId);
    this.assertOpen(record, decision.decidedAt);
    if (
      decision.approverPrincipalId === record.proposerPrincipalId ||
      decision.approverPrincipalId === record.performerPrincipalId ||
      decision.approverPrincipalId === record.agentPrincipalId
    ) {
      throw new ApprovalStoreError(
        "self_approval",
        `the proposing, performing, or executing principal cannot decide Approval ${approvalId}`
      );
    }
    if (!this.qualified(record, decision)) {
      throw new ApprovalStoreError(
        "approver_not_qualified",
        `approver holds no role allowed to decide Approval ${approvalId}`
      );
    }
    if (
      record.decisions.some((entry) => entry.approverPrincipalId === decision.approverPrincipalId)
    ) {
      throw new ApprovalStoreError(
        "duplicate_approver",
        `approver already decided Approval ${approvalId}`
      );
    }
    return this.write({ ...record, decisions: [...record.decisions, decision] });
  }

  async consume(
    businessId: string,
    approvalId: string,
    binding: ApprovalBindingRecord,
    at: Date
  ): Promise<ApprovalGrantRecord> {
    const initial = this.require(businessId, approvalId);
    this.assertOpen(initial, at);
    const liveRoles = new Set<string>();
    const teamDecisions = initial.decisions.filter(
      (decision) =>
        decision.outcome === "approved" &&
        (teamIdFromAdminRole(decision.satisfiedApproverRole) !== undefined ||
          decision.approverRoles.some((role) => teamIdFromAdminRole(role) !== undefined))
    );
    for (const decision of teamDecisions) {
      for (const role of (await this.resolveRoles?.(
        businessId,
        decision.approverPrincipalId,
        at
      )) ?? []) {
        liveRoles.add(`${decision.approverPrincipalId}\u0000${role}`);
      }
    }
    // Re-read after live resolution so a concurrent consumer cannot spend the same Approval.
    const current = this.require(businessId, approvalId);
    this.assertOpen(current, at);
    assertConsumable(current, binding, at, liveRoles);
    return this.write({ ...current, consumedAt: at });
  }

  async revoke(businessId: string, approvalId: string, at: Date): Promise<ApprovalGrantRecord> {
    const record = this.require(businessId, approvalId);
    this.assertOpen(record);
    return this.write({ ...record, revokedAt: at });
  }
}

interface ApprovalGrantRow {
  approval_id: string;
  business_id: string;
  intent_digest: string;
  evidence_digest: string;
  guardrail_revision: string;
  risk: ApprovalRiskLevel;
  allowed_approver_roles: string[];
  required_approver_roles: string[];
  proposer_principal_id: string;
  performer_principal_id: string | null;
  agent_principal_id: string | null;
  preview: string;
  risk_summary: string;
  expires_at: Date | string;
  created_at: Date | string;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface ApprovalDecisionRow {
  approval_id?: string;
  approver_principal_id: string;
  approver_roles: string[];
  satisfied_approver_role: string | null;
  outcome: "approved" | "denied";
  decided_at: Date | string;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function approvalFromRows(
  row: ApprovalGrantRow,
  decisions: readonly ApprovalDecisionRow[]
): ApprovalGrantRecord {
  return {
    approvalId: row.approval_id,
    businessId: row.business_id,
    binding: {
      intentDigest: row.intent_digest,
      evidenceDigest: row.evidence_digest,
      guardrailRevision: row.guardrail_revision,
    },
    risk: row.risk,
    allowedApproverRoles: row.allowed_approver_roles,
    requiredApproverRoles: row.required_approver_roles,
    proposerPrincipalId: row.proposer_principal_id,
    ...(row.performer_principal_id === null
      ? {}
      : { performerPrincipalId: row.performer_principal_id }),
    ...(row.agent_principal_id === null ? {} : { agentPrincipalId: row.agent_principal_id }),
    preview: row.preview,
    riskSummary: row.risk_summary,
    expiresAt: asDate(row.expires_at),
    createdAt: asDate(row.created_at),
    decisions: decisions.map((decision) => ({
      approverPrincipalId: decision.approver_principal_id,
      approverRoles: decision.approver_roles,
      ...(decision.satisfied_approver_role === null
        ? {}
        : { satisfiedApproverRole: decision.satisfied_approver_role }),
      outcome: decision.outcome,
      decidedAt: asDate(decision.decided_at),
    })),
    ...(row.consumed_at === null ? {} : { consumedAt: asDate(row.consumed_at) }),
    ...(row.revoked_at === null ? {} : { revokedAt: asDate(row.revoked_at) }),
  };
}

async function getApprovalInTransaction(
  transaction: Queryable,
  businessId: string,
  approvalId: string,
  lock = false
): Promise<ApprovalGrantRecord | undefined> {
  const result = await transaction.query<ApprovalGrantRow>(
    `SELECT approval_id, business_id, intent_digest, evidence_digest, guardrail_revision, risk,
            allowed_approver_roles, required_approver_roles, proposer_principal_id,
            performer_principal_id, agent_principal_id, preview, risk_summary, expires_at,
            created_at, consumed_at, revoked_at
       FROM asset_ownership_approvals
      WHERE business_id = $1 AND approval_id = $2${lock ? " FOR UPDATE" : ""}`,
    [businessId, approvalId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const decisions = await transaction.query<ApprovalDecisionRow>(
    `SELECT approver_principal_id, approver_roles, satisfied_approver_role, outcome, decided_at
       FROM asset_ownership_approval_decisions
      WHERE approval_id = $1 ORDER BY decided_at, approver_principal_id`,
    [approvalId]
  );
  return approvalFromRows(row, decisions.rows);
}

async function liveTeamAdminRoles(
  transaction: Queryable,
  record: ApprovalGrantRecord,
  at: Date
): Promise<ReadonlySet<string>> {
  const approvingPrincipals = [
    ...new Set(
      record.decisions
        .filter(
          (decision) =>
            decision.outcome === "approved" &&
            (teamIdFromAdminRole(decision.satisfiedApproverRole) !== undefined ||
              decision.approverRoles.some((role) => teamIdFromAdminRole(role) !== undefined))
        )
        .map((decision) => decision.approverPrincipalId)
    ),
  ];
  if (approvingPrincipals.length === 0) return new Set();
  const result = await transaction.query<{ principal_id: string; team_id: string }>(
    `SELECT membership.principal_id, membership.team_id::text
       FROM team_memberships membership
       JOIN teams team ON team.id = membership.team_id
       JOIN principals principal
         ON principal.business_id = team.business_id
        AND principal.id = membership.principal_id
      WHERE team.business_id = $1
        AND membership.principal_id = ANY($2::text[])
        AND membership.principal_kind = 'user'
        AND membership.level = 'admin'
        AND (membership.expires_at IS NULL OR membership.expires_at > $3)
        AND team.status = 'active'
        AND principal.kind = 'user'
        AND principal.status = 'active'
        AND (principal.expires_at IS NULL OR principal.expires_at > $3)
      ORDER BY team.id, membership.principal_id
      FOR UPDATE OF membership, team, principal`,
    [record.businessId, approvingPrincipals, at]
  );
  return new Set(result.rows.map((row) => `${row.principal_id}\u0000team:${row.team_id}:admin`));
}

export async function consumeApprovalInTransaction(
  transaction: Queryable,
  businessId: string,
  approvalId: string,
  binding: ApprovalBindingRecord,
  at: Date
): Promise<ApprovalGrantRecord> {
  const record = await getApprovalInTransaction(transaction, businessId, approvalId, true);
  if (!record) throw new ApprovalStoreError("not_found", "Approval was not found");
  if (record.revokedAt) throw new ApprovalStoreError("revoked", "Approval was revoked");
  if (record.consumedAt) throw new ApprovalStoreError("already_used", "Approval was consumed");
  const liveRoles = await liveTeamAdminRoles(transaction, record, at);
  assertConsumable(record, binding, at, liveRoles);
  const result = await transaction.query<{ approval_id: string }>(
    `UPDATE asset_ownership_approvals SET consumed_at = $3
      WHERE business_id = $1 AND approval_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL
    RETURNING approval_id`,
    [businessId, approvalId, at]
  );
  if (result.rows.length === 0) {
    throw new ApprovalStoreError("already_used", "Approval was already consumed");
  }
  const consumed = await getApprovalInTransaction(transaction, businessId, approvalId);
  if (!consumed) throw new ApprovalStoreError("not_found", "Approval was not found");
  return consumed;
}

export async function createApprovalInTransaction(
  transaction: Queryable,
  grant: NewApprovalGrant
): Promise<ApprovalGrantRecord> {
  try {
    await transaction.query(
      `INSERT INTO asset_ownership_approvals (
         approval_id, business_id, intent_digest, evidence_digest, guardrail_revision, risk,
         allowed_approver_roles, required_approver_roles, proposer_principal_id,
         performer_principal_id, agent_principal_id, preview, risk_summary, expires_at,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15
       )`,
      [
        grant.approvalId,
        grant.businessId,
        grant.binding.intentDigest,
        grant.binding.evidenceDigest,
        grant.binding.guardrailRevision,
        grant.risk,
        JSON.stringify(grant.allowedApproverRoles),
        JSON.stringify(grant.requiredApproverRoles ?? []),
        grant.proposerPrincipalId,
        grant.performerPrincipalId ?? null,
        grant.agentPrincipalId ?? null,
        grant.preview,
        grant.riskSummary,
        grant.expiresAt,
        grant.createdAt,
      ]
    );
  } catch (error) {
    if (String(error).includes("unique")) {
      throw new ApprovalStoreError("duplicate_approval", "Approval already exists");
    }
    throw error;
  }
  const created = await getApprovalInTransaction(transaction, grant.businessId, grant.approvalId);
  if (!created) throw new ApprovalStoreError("not_found", "Approval was not created");
  return created;
}

export class PgApprovalGrantRepo implements ApprovalRepo {
  constructor(private readonly transactions: TransactionPort) {}

  async create(grant: NewApprovalGrant): Promise<ApprovalGrantRecord> {
    return this.transactions.withTransaction((transaction) =>
      createApprovalInTransaction(transaction, grant)
    );
  }

  async get(businessId: string, approvalId: string): Promise<ApprovalGrantRecord | undefined> {
    return this.transactions.withTransaction((transaction) =>
      getApprovalInTransaction(transaction, businessId, approvalId)
    );
  }

  async getMany(
    businessId: string,
    approvalIds: readonly string[]
  ): Promise<ApprovalGrantRecord[]> {
    if (approvalIds.length === 0) return [];
    return this.transactions.withTransaction(async (transaction) => {
      const grants = await transaction.query<ApprovalGrantRow>(
        `SELECT approval_id, business_id, intent_digest, evidence_digest, guardrail_revision, risk,
                allowed_approver_roles, required_approver_roles, proposer_principal_id,
                performer_principal_id, agent_principal_id, preview, risk_summary, expires_at,
                created_at, consumed_at, revoked_at
           FROM asset_ownership_approvals
          WHERE business_id = $1 AND approval_id::text = ANY($2::text[])`,
        [businessId, [...approvalIds]]
      );
      const decisions = await transaction.query<ApprovalDecisionRow & { approval_id: string }>(
        `SELECT approval_id::text, approver_principal_id, approver_roles,
                satisfied_approver_role, outcome, decided_at
           FROM asset_ownership_approval_decisions
          WHERE approval_id::text = ANY($1::text[])
          ORDER BY decided_at, approver_principal_id`,
        [[...approvalIds]]
      );
      const decisionsByApproval = new Map<string, ApprovalDecisionRow[]>();
      for (const decision of decisions.rows) {
        decisionsByApproval.set(decision.approval_id, [
          ...(decisionsByApproval.get(decision.approval_id) ?? []),
          decision,
        ]);
      }
      const grantsById = new Map(
        grants.rows.map((grant) => [
          grant.approval_id,
          approvalFromRows(grant, decisionsByApproval.get(grant.approval_id) ?? []),
        ])
      );
      return approvalIds.flatMap((approvalId) => {
        const grant = grantsById.get(approvalId);
        return grant === undefined ? [] : [grant];
      });
    });
  }

  async getOpenMany(
    businessId: string,
    approvalIds: readonly string[],
    query: OpenApprovalQuery
  ): Promise<ApprovalGrantRecord[]> {
    if (approvalIds.length === 0 || query.requiredTeamIds?.length === 0) return [];
    return this.transactions.withTransaction(async (transaction) => {
      const params: unknown[] = [businessId, [...approvalIds], query.at];
      const teamClause =
        query.requiredTeamIds === undefined
          ? ""
          : ` AND EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(approval.required_approver_roles) AS role(value)
                 WHERE role.value = ANY($${params.push(
                   query.requiredTeamIds.map((teamId) => `team:${teamId}:admin`)
                 )}::text[])
              )`;
      const grants = await transaction.query<ApprovalGrantRow>(
        `SELECT approval.approval_id, approval.business_id, approval.intent_digest,
                approval.evidence_digest, approval.guardrail_revision, approval.risk,
                approval.allowed_approver_roles, approval.required_approver_roles,
                approval.proposer_principal_id, approval.performer_principal_id,
                approval.agent_principal_id, approval.preview, approval.risk_summary,
                approval.expires_at, approval.created_at, approval.consumed_at,
                approval.revoked_at
           FROM asset_ownership_approvals approval
          WHERE approval.business_id = $1
            AND approval.approval_id::text = ANY($2::text[])
            AND approval.consumed_at IS NULL
            AND approval.revoked_at IS NULL
            AND approval.expires_at > $3
            AND NOT EXISTS (
              SELECT 1
                FROM asset_ownership_approval_decisions decision
               WHERE decision.approval_id = approval.approval_id
                 AND decision.outcome = 'denied'
            )${teamClause}`,
        params
      );
      const ids = grants.rows.map((grant) => grant.approval_id);
      if (ids.length === 0) return [];
      const decisions = await transaction.query<ApprovalDecisionRow & { approval_id: string }>(
        `SELECT approval_id::text, approver_principal_id, approver_roles,
                satisfied_approver_role, outcome, decided_at
           FROM asset_ownership_approval_decisions
          WHERE approval_id::text = ANY($1::text[])
          ORDER BY decided_at, approver_principal_id`,
        [ids]
      );
      const decisionsByApproval = new Map<string, ApprovalDecisionRow[]>();
      for (const decision of decisions.rows) {
        decisionsByApproval.set(decision.approval_id, [
          ...(decisionsByApproval.get(decision.approval_id) ?? []),
          decision,
        ]);
      }
      const grantsById = new Map(
        grants.rows.map((grant) => [
          grant.approval_id,
          approvalFromRows(grant, decisionsByApproval.get(grant.approval_id) ?? []),
        ])
      );
      return approvalIds.flatMap((approvalId) => {
        const grant = grantsById.get(approvalId);
        return grant === undefined ? [] : [grant];
      });
    });
  }

  async list(businessId: string): Promise<ApprovalGrantRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ approval_id: string }>(
        `SELECT approval_id FROM asset_ownership_approvals
          WHERE business_id = $1 ORDER BY created_at, approval_id`,
        [businessId]
      );
      const ids = result.rows.map((row) => row.approval_id);
      if (ids.length === 0) return [];
      const grants = await transaction.query<ApprovalGrantRow>(
        `SELECT approval_id, business_id, intent_digest, evidence_digest, guardrail_revision, risk,
                allowed_approver_roles, required_approver_roles, proposer_principal_id,
                performer_principal_id, agent_principal_id, preview, risk_summary, expires_at,
                created_at, consumed_at, revoked_at
           FROM asset_ownership_approvals
          WHERE business_id = $1 AND approval_id::text = ANY($2::text[])`,
        [businessId, ids]
      );
      const decisions = await transaction.query<ApprovalDecisionRow & { approval_id: string }>(
        `SELECT approval_id::text, approver_principal_id, approver_roles,
                satisfied_approver_role, outcome, decided_at
           FROM asset_ownership_approval_decisions
          WHERE approval_id::text = ANY($1::text[])
          ORDER BY decided_at, approver_principal_id`,
        [ids]
      );
      const byApproval = new Map<string, ApprovalDecisionRow[]>();
      for (const decision of decisions.rows) {
        byApproval.set(decision.approval_id, [
          ...(byApproval.get(decision.approval_id) ?? []),
          decision,
        ]);
      }
      const byId = new Map(
        grants.rows.map((grant) => [
          grant.approval_id,
          approvalFromRows(grant, byApproval.get(grant.approval_id) ?? []),
        ])
      );
      return ids.flatMap((id) => {
        const record = byId.get(id);
        return record === undefined ? [] : [record];
      });
    });
  }

  async appendDecision(
    businessId: string,
    approvalId: string,
    decision: ApprovalDecisionEntry
  ): Promise<ApprovalGrantRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const record = await this.requireOpen(
        transaction,
        businessId,
        approvalId,
        decision.decidedAt
      );
      if (
        decision.approverPrincipalId === record.proposerPrincipalId ||
        decision.approverPrincipalId === record.performerPrincipalId ||
        decision.approverPrincipalId === record.agentPrincipalId
      ) {
        throw new ApprovalStoreError("self_approval", "The proposer cannot approve this operation");
      }
      if (!decision.approverRoles.some((role) => record.allowedApproverRoles.includes(role))) {
        throw new ApprovalStoreError(
          "approver_not_qualified",
          "The approver holds no required Team role"
        );
      }
      try {
        await transaction.query(
          `INSERT INTO asset_ownership_approval_decisions (
             approval_id, approver_principal_id, approver_roles, satisfied_approver_role,
             outcome, decided_at
           ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
          [
            approvalId,
            decision.approverPrincipalId,
            JSON.stringify(decision.approverRoles),
            decision.satisfiedApproverRole ?? null,
            decision.outcome,
            decision.decidedAt,
          ]
        );
      } catch (error) {
        if (String(error).includes("unique")) {
          throw new ApprovalStoreError("duplicate_approver", "Approver already decided");
        }
        throw error;
      }
      const updated = await getApprovalInTransaction(transaction, businessId, approvalId);
      if (!updated) throw new ApprovalStoreError("not_found", "Approval was not found");
      return updated;
    });
  }

  async consume(
    businessId: string,
    approvalId: string,
    binding: ApprovalBindingRecord,
    at: Date
  ): Promise<ApprovalGrantRecord> {
    return this.transactions.withTransaction((transaction) =>
      consumeApprovalInTransaction(transaction, businessId, approvalId, binding, at)
    );
  }

  async revoke(businessId: string, approvalId: string, at: Date): Promise<ApprovalGrantRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      await this.requireOpen(transaction, businessId, approvalId);
      await transaction.query(
        `UPDATE asset_ownership_approvals SET revoked_at = $3
          WHERE business_id = $1 AND approval_id = $2`,
        [businessId, approvalId, at]
      );
      const revoked = await getApprovalInTransaction(transaction, businessId, approvalId);
      if (!revoked) throw new ApprovalStoreError("not_found", "Approval was not found");
      return revoked;
    });
  }

  private async requireOpen(
    transaction: Queryable,
    businessId: string,
    approvalId: string,
    at?: Date
  ): Promise<ApprovalGrantRecord> {
    const record = await getApprovalInTransaction(transaction, businessId, approvalId, true);
    if (!record) throw new ApprovalStoreError("not_found", "Approval was not found");
    if (record.revokedAt) throw new ApprovalStoreError("revoked", "Approval was revoked");
    if (record.consumedAt) throw new ApprovalStoreError("already_used", "Approval was consumed");
    if (at && record.expiresAt <= at) throw new ApprovalStoreError("expired", "Approval expired");
    return record;
  }
}

export const ASSET_OWNERSHIP_APPROVAL_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asset_ownership_approvals (
    approval_id uuid PRIMARY KEY,
    business_id text NOT NULL,
    intent_digest text NOT NULL,
    evidence_digest text NOT NULL,
    guardrail_revision text NOT NULL,
    risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
    allowed_approver_roles jsonb NOT NULL,
    required_approver_roles jsonb NOT NULL,
    proposer_principal_id text NOT NULL,
    performer_principal_id text,
    agent_principal_id text,
    preview text NOT NULL,
    risk_summary text NOT NULL,
    expires_at timestamptz(3) NOT NULL,
    created_at timestamptz(3) NOT NULL,
    consumed_at timestamptz(3),
    revoked_at timestamptz(3),
    CHECK (jsonb_typeof(allowed_approver_roles) = 'array'),
    CHECK (jsonb_typeof(required_approver_roles) = 'array'),
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
  )`,
  `CREATE TABLE IF NOT EXISTS asset_ownership_approval_decisions (
    approval_id uuid NOT NULL REFERENCES asset_ownership_approvals(approval_id) ON DELETE CASCADE,
    approver_principal_id text NOT NULL,
    approver_roles jsonb NOT NULL,
    satisfied_approver_role text,
    outcome text NOT NULL CHECK (outcome IN ('approved', 'denied')),
    decided_at timestamptz(3) NOT NULL,
    PRIMARY KEY (approval_id, approver_principal_id),
    CHECK (jsonb_typeof(approver_roles) = 'array')
  )`,
];

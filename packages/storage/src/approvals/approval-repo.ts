/**
 * Persistence for Approvals and their decisions (SPEC §11.2). Storage owns the durable mechanics —
 * uniqueness, append-only decisions, and the atomic one-use consumption — while `@tulipfarm/authz`
 * owns whether an Approval is valid. Everything an Approval decision depends on lives in the
 * record, never in process memory, so decisions, expiry, and the spent one-use marker survive a
 * restart; an adapter rehydrates the same rows and reaches the same answers.
 *
 * The binding is stored as digests only, and the human-facing `preview`/`riskSummary` are safe
 * summary text — no intent arguments, Credential material, or Secrets are persisted here
 * (SPEC §13, §20).
 */

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
  readonly outcome: "approved" | "denied";
  readonly decidedAt: Date;
}

export interface ApprovalGrantRecord {
  readonly approvalId: string;
  readonly businessId: string;
  readonly binding: ApprovalBindingRecord;
  readonly risk: ApprovalRiskLevel;
  readonly allowedApproverRoles: readonly string[];
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

/** A new Approval: decisions, consumption, and revocation are recorded through the repo. */
export type NewApprovalGrant = Omit<ApprovalGrantRecord, "decisions" | "consumedAt" | "revokedAt">;

export type ApprovalStoreErrorCode =
  | "not_found"
  | "duplicate_approval"
  | "duplicate_approver"
  | "already_used"
  | "revoked"
  | "binding_mismatch";

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
  /** All Approvals of one business, oldest first — the rehydration source after a restart. */
  list(businessId: string): Promise<ApprovalGrantRecord[]>;
  appendDecision(
    businessId: string,
    approvalId: string,
    decision: ApprovalDecisionEntry
  ): Promise<ApprovalGrantRecord>;
  /**
   * Spends the one-use decision, but only for the exact `binding` it was granted for. Consumption
   * is atomic: of any number of concurrent attempts exactly one succeeds and the rest see
   * `already_used`.
   */
  consume(
    businessId: string,
    approvalId: string,
    binding: ApprovalBindingRecord,
    at: Date
  ): Promise<ApprovalGrantRecord>;
  revoke(businessId: string, approvalId: string, at: Date): Promise<ApprovalGrantRecord>;
}

function freeze(record: ApprovalGrantRecord): ApprovalGrantRecord {
  return Object.freeze({
    ...record,
    binding: Object.freeze({ ...record.binding }),
    allowedApproverRoles: Object.freeze([...record.allowedApproverRoles]),
    decisions: Object.freeze(
      record.decisions.map((entry) =>
        Object.freeze({ ...entry, approverRoles: Object.freeze([...entry.approverRoles]) })
      )
    ),
  });
}

function bindingsEqual(a: ApprovalBindingRecord, b: ApprovalBindingRecord): boolean {
  return (
    a.intentDigest === b.intentDigest &&
    a.evidenceDigest === b.evidenceDigest &&
    a.guardrailRevision === b.guardrailRevision
  );
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link ApprovalRepo} contract, where `create` maps to a
 * primary key, `appendDecision` to a unique `(approval_id, approver_principal_id)` constraint, and
 * `consume` to a conditional `UPDATE … WHERE consumed_at IS NULL` returning the affected row.
 */
export class InMemoryApprovalRepo implements ApprovalRepo {
  private readonly records = new Map<string, ApprovalGrantRecord>();

  /** `seed` rehydrates previously stored rows, as a restarted process would. */
  constructor(seed: readonly ApprovalGrantRecord[] = []) {
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

  private assertOpen(record: ApprovalGrantRecord): void {
    if (record.revokedAt !== undefined) {
      throw new ApprovalStoreError("revoked", `Approval ${record.approvalId} was revoked`);
    }
    if (record.consumedAt !== undefined) {
      throw new ApprovalStoreError(
        "already_used",
        `Approval ${record.approvalId} was already used`
      );
    }
  }

  private write(record: ApprovalGrantRecord): ApprovalGrantRecord {
    const stored = freeze(record);
    this.records.set(this.key(stored.businessId, stored.approvalId), stored);
    return stored;
  }

  async create(grant: NewApprovalGrant): Promise<ApprovalGrantRecord> {
    if (this.records.has(this.key(grant.businessId, grant.approvalId))) {
      throw new ApprovalStoreError(
        "duplicate_approval",
        `Approval ${grant.approvalId} already exists`
      );
    }
    return this.write({ ...grant, decisions: [] });
  }

  async get(businessId: string, approvalId: string): Promise<ApprovalGrantRecord | undefined> {
    return this.records.get(this.key(businessId, approvalId));
  }

  async list(businessId: string): Promise<ApprovalGrantRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.businessId === businessId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async appendDecision(
    businessId: string,
    approvalId: string,
    decision: ApprovalDecisionEntry
  ): Promise<ApprovalGrantRecord> {
    const record = this.require(businessId, approvalId);
    this.assertOpen(record);
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
    // Check and mark in one synchronous step: no await may separate them, or two concurrent
    // callers could both observe an unconsumed Approval and both spend it.
    const record = this.require(businessId, approvalId);
    this.assertOpen(record);
    if (!bindingsEqual(record.binding, binding)) {
      throw new ApprovalStoreError(
        "binding_mismatch",
        `Approval ${approvalId} was not granted for this binding`
      );
    }
    return this.write({ ...record, consumedAt: at });
  }

  async revoke(businessId: string, approvalId: string, at: Date): Promise<ApprovalGrantRecord> {
    const record = this.require(businessId, approvalId);
    this.assertOpen(record);
    return this.write({ ...record, revokedAt: at });
  }
}

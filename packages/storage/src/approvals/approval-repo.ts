/** Approval storage keeps safe summaries/digests, append-only decisions, and atomic spend. */

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

function freeze(record: ApprovalGrantRecord): ApprovalGrantRecord {
  return Object.freeze({
    ...record,
    binding: Object.freeze({ ...record.binding }),
    allowedApproverRoles: Object.freeze([...record.allowedApproverRoles]),
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

/** Process-local ApprovalRepo double; durable adapters enforce the same constraints in storage. */
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
    return this.write({ ...grant, decisions: [] });
  }

  async get(businessId: string, approvalId: string): Promise<ApprovalGrantRecord | undefined> {
    const record = this.records.get(this.key(businessId, approvalId));
    return record === undefined ? undefined : freeze(record);
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
    // Check and mark in one synchronous step: no await may separate them, or two concurrent
    // callers could both observe an unconsumed Approval and both spend it.
    const record = this.require(businessId, approvalId);
    this.assertOpen(record, at);
    if (!bindingsEqual(record.binding, binding)) {
      throw new ApprovalStoreError(
        "binding_mismatch",
        `Approval ${approvalId} was not granted for this binding`
      );
    }
    if (record.decisions.some((decision) => decision.outcome === "denied")) {
      throw new ApprovalStoreError("denied", `Approval ${approvalId} was denied`);
    }
    const qualifiedApprovers = new Set(
      record.decisions
        .filter((decision) => decision.outcome === "approved" && this.qualified(record, decision))
        .map((decision) => decision.approverPrincipalId)
    );
    const required = record.risk === "high" ? 2 : 1;
    if (qualifiedApprovers.size < required) {
      throw new ApprovalStoreError(
        "insufficient_approvals",
        `Approval ${approvalId} lacks the required number of qualified approvers`
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

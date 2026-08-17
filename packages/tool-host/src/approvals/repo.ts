import { type ApprovalGuardrailEvidence, approvalEvidenceDigest } from "./evidence";

/**
 * Narrower than `@tulipfarm/storage`'s `Queryable` on purpose: this repo runs against a pg Pool,
 * a PGlite test client and a storage transaction alike, and only the non-generic call site is
 * common to all three.
 */
export interface ApprovalsQueryable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type ApprovalKind = "tool_call" | "routine_state";
export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout";

export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  payload: unknown;
  expiresAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
  /** Set the instant the one-use decision was spent; a consumed row never authorizes again. */
  consumedAt: Date | null;
  /** The Tool call that spent it, so only a redelivery of that same call may ride it again. */
  consumedByCallId: string | null;
  /** The principal whose Turn asked for this effect; four-eyes is enforced against it (I-13). */
  requesterPrincipalId: string | null;
  /** The policy evaluation that demanded a human, exactly as it was recorded at that instant. */
  guardrailEvidence: unknown;
  /** Content address of {@link guardrailEvidence}, written once with it. */
  guardrailEvidenceDigest: string | null;
  /** Who decided. Compared against {@link requesterPrincipalId} to audit four-eyes after the fact. */
  approverPrincipalId: string | null;
}

function rowToApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: row.id as string,
    kind: row.kind as ApprovalKind,
    status: row.status as ApprovalStatus,
    payload: row.payload,
    expiresAt: row.expires_at as Date,
    createdAt: row.created_at as Date,
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    consumedAt: (row.consumed_at as Date | null) ?? null,
    consumedByCallId: (row.consumed_by_call_id as string | null) ?? null,
    requesterPrincipalId: (row.requester_principal_id as string | null) ?? null,
    guardrailEvidence: row.guardrail_evidence ?? null,
    guardrailEvidenceDigest: (row.guardrail_evidence_digest as string | null) ?? null,
    approverPrincipalId: (row.approver_principal_id as string | null) ?? null,
  };
}

const APPROVAL_COLUMNS =
  "id, kind, status, payload, expires_at, created_at, resolved_at, consumed_at, consumed_by_call_id, " +
  "requester_principal_id, guardrail_evidence, guardrail_evidence_digest, approver_principal_id";

/**
 * Migration v60. Guardrail evidence and the requesting principal are stored on the approval row
 * itself, not referenced: an approval that points at a row someone can still edit proves nothing
 * about what the approver was shown. `approvals_evidence_immutable` makes the columns write-once
 * so the row is its own evidence, and `approvals_tool_call_evidence` makes an approval that
 * carries none impossible to create rather than merely unusual (I-13).
 *
 * The CHECK is added NOT VALID on purpose: rows written before this migration legitimately have
 * no evidence, and rewriting history to satisfy a constraint would fabricate the very thing the
 * constraint exists to guarantee. Those rows expire within the approval TTL, and
 * `ToolApprovalService.signal` refuses them meanwhile.
 */
export const APPROVAL_EVIDENCE_STORAGE_STATEMENTS: readonly string[] = [
  "ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requester_principal_id text",
  "ALTER TABLE approvals ADD COLUMN IF NOT EXISTS guardrail_evidence jsonb",
  "ALTER TABLE approvals ADD COLUMN IF NOT EXISTS guardrail_evidence_digest text",
  "ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approver_principal_id text",
  `DO $$ BEGIN
     ALTER TABLE approvals ADD CONSTRAINT approvals_tool_call_evidence CHECK (
       kind <> 'tool_call' OR (
         requester_principal_id IS NOT NULL
         AND guardrail_evidence IS NOT NULL
         AND guardrail_evidence_digest IS NOT NULL
       )
     ) NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE OR REPLACE FUNCTION approvals_reject_evidence_change() RETURNS trigger AS $$
   BEGIN
     IF NEW.requester_principal_id IS DISTINCT FROM OLD.requester_principal_id
       OR NEW.guardrail_evidence IS DISTINCT FROM OLD.guardrail_evidence
       OR NEW.guardrail_evidence_digest IS DISTINCT FROM OLD.guardrail_evidence_digest THEN
       RAISE EXCEPTION 'approval % has immutable Guardrail evidence', OLD.id;
     END IF;
     RETURN NEW;
   END $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS approvals_evidence_immutable ON approvals",
  `CREATE TRIGGER approvals_evidence_immutable BEFORE UPDATE ON approvals
     FOR EACH ROW EXECUTE FUNCTION approvals_reject_evidence_change()`,
];

/** DB-backed approvals settle pending rows atomically to prevent replayed decisions. */
export class ApprovalsRepo {
  constructor(private readonly db: ApprovalsQueryable) {}

  /**
   * A `tool_call` approval cannot be created without the evidence that demanded it or the
   * principal that requested it — both are required arguments, and the row constraint rejects the
   * write if a caller reaches this table another way.
   */
  async insert(row: {
    id: string;
    kind: ApprovalKind;
    payload: unknown;
    expiresAt: Date;
    requesterPrincipalId?: string;
    evidence?: ApprovalGuardrailEvidence;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO approvals (id, kind, status, payload, expires_at, created_at,
                              requester_principal_id, guardrail_evidence, guardrail_evidence_digest)
       VALUES ($1, $2, 'pending', $3, $4, now(), $5, $6, $7)`,
      [
        row.id,
        row.kind,
        JSON.stringify(row.payload),
        row.expiresAt,
        row.requesterPrincipalId ?? null,
        row.evidence === undefined ? null : JSON.stringify(row.evidence),
        row.evidence === undefined ? null : approvalEvidenceDigest(row.evidence),
      ]
    );
  }

  async settle(id: string, status: Exclude<ApprovalStatus, "pending">): Promise<void> {
    await this.db.query(`UPDATE approvals SET status = $2, resolved_at = now() WHERE id = $1`, [
      id,
      status,
    ]);
  }

  async settlePending(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    approverPrincipalId?: string
  ): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE approvals
       SET status = $2, resolved_at = now(), approver_principal_id = COALESCE($3, approver_principal_id)
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [id, status, approverPrincipalId ?? null]
    );
    return rows.length === 1;
  }

  /**
   * Principals other than `excludingPrincipalId` who could decide an approval. Only active users
   * can: the approval surface is granted to the `admin` and `member` Roles both, and a service
   * principal has no way to reach it. Four-eyes turns on this count being non-zero.
   */
  async countOtherEligibleApprovers(excludingPrincipalId: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS eligible
       FROM users
       WHERE status = 'active' AND ('user:' || id::text) <> $1`,
      [excludingPrincipalId]
    );
    const value = rows[0]?.eligible;
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  /** The Role principals a deciding principal holds, in the form a durable wait allows. */
  async rolesForPrincipal(principalId: string): Promise<readonly string[]> {
    const { rows } = await this.db.query(
      `SELECT role FROM users WHERE status = 'active' AND ('user:' || id::text) = $1`,
      [principalId]
    );
    return rows.map((row) => `role:${row.role as string}`);
  }

  /**
   * Patch payload keys only; whole-payload writes would race the request that first parked the Run.
   */
  async mergePayload(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.db.query(`UPDATE approvals SET payload = payload || $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify(patch),
    ]);
  }

  /**
   * The decision `toolCallId` may still ride: an unspent row, so a resumed Run reuses the standing
   * decision instead of asking again, or the row this exact call already spent, so a redelivered
   * dispatch of it stays idempotent. A row spent by a *different* call is deliberately invisible
   * here — that absence is what makes the next identical call ask a human again (I-13).
   */
  async findByIntent(
    runId: string,
    intentDigest: string,
    toolCallId: string
  ): Promise<ApprovalRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${APPROVAL_COLUMNS}
       FROM approvals
       WHERE kind = 'tool_call'
         AND payload->>'runId' = $1
         AND payload->>'intentDigest' = $2
         AND (consumed_by_call_id IS NULL OR consumed_by_call_id = $3)
       ORDER BY (consumed_by_call_id IS NOT NULL) DESC, created_at DESC
       LIMIT 1`,
      [runId, intentDigest, toolCallId]
    );
    return rows.length > 0 ? rowToApproval(rows[0]) : null;
  }

  /**
   * Spends an approved decision for one Tool call. The predicate and the write are one statement,
   * so two identical calls racing to dispatch cannot both win: the loser sees `false` and its
   * caller must fail closed rather than ride a decision it did not get.
   *
   * Re-spending by the same `toolCallId` succeeds, and `consumed_at` keeps its first value: that
   * is a redelivery of one authorized dispatch, not a second one.
   */
  async consume(id: string, toolCallId: string, now: Date): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE approvals
       SET consumed_at = COALESCE(consumed_at, $3), consumed_by_call_id = $2
       WHERE id = $1
         AND status = 'approved'
         AND (consumed_by_call_id IS NULL OR consumed_by_call_id = $2)
       RETURNING id`,
      [id, toolCallId, now]
    );
    return rows.length === 1;
  }

  /**
   * Routine State approvals are keyed by occurrence; settled rows prevent replay from asking again.
   */
  async findByRunState(runId: string, stateKey: string): Promise<ApprovalRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${APPROVAL_COLUMNS}
       FROM approvals
       WHERE kind = 'routine_state'
         AND payload->>'runId' = $1
         AND payload->>'stateKey' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [runId, stateKey]
    );
    return rows.length > 0 ? rowToApproval(rows[0]) : null;
  }

  /** A Run parks on at most one Tool approval, so the newest pending row is the active wait. */
  async findPendingByRun(runId: string): Promise<ApprovalRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${APPROVAL_COLUMNS}
       FROM approvals
       WHERE kind = 'tool_call'
         AND status = 'pending'
         AND payload->>'runId' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [runId]
    );
    return rows.length > 0 ? rowToApproval(rows[0]) : null;
  }

  async findById(id: string): Promise<ApprovalRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${APPROVAL_COLUMNS}
       FROM approvals WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? rowToApproval(rows[0]) : null;
  }

  async listPending(kind?: ApprovalKind): Promise<ApprovalRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${APPROVAL_COLUMNS}
       FROM approvals WHERE status = 'pending' ${kind ? "AND kind = $1" : ""}
       ORDER BY created_at`,
      kind ? [kind] : []
    );
    return rows.map(rowToApproval);
  }

  async listExpiredPending(kind: ApprovalKind, now: Date): Promise<ApprovalRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${APPROVAL_COLUMNS}
       FROM approvals WHERE status = 'pending' AND kind = $1 AND expires_at <= $2`,
      [kind, now]
    );
    return rows.map(rowToApproval);
  }
}

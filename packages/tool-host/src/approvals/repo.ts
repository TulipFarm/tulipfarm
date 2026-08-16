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
  };
}

const APPROVAL_COLUMNS =
  "id, kind, status, payload, expires_at, created_at, resolved_at, consumed_at, consumed_by_call_id";

/** DB-backed approvals settle pending rows atomically to prevent replayed decisions. */
export class ApprovalsRepo {
  constructor(private readonly db: ApprovalsQueryable) {}

  async insert(row: {
    id: string;
    kind: ApprovalKind;
    payload: unknown;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO approvals (id, kind, status, payload, expires_at, created_at)
       VALUES ($1, $2, 'pending', $3, $4, now())`,
      [row.id, row.kind, JSON.stringify(row.payload), row.expiresAt]
    );
  }

  async settle(id: string, status: Exclude<ApprovalStatus, "pending">): Promise<void> {
    await this.db.query(`UPDATE approvals SET status = $2, resolved_at = now() WHERE id = $1`, [
      id,
      status,
    ]);
  }

  async settlePending(id: string, status: Exclude<ApprovalStatus, "pending">): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE approvals
       SET status = $2, resolved_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [id, status]
    );
    return rows.length === 1;
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

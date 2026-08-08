import type { Queryable } from "../db";

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
  };
}

/**
 * Authoritative DB-backed store for Tool Approval and Routine human-approval rows.
 * Atomic pending-state settlement prevents replayed decisions.
 */
export class ApprovalsRepo {
  constructor(private readonly db: Queryable) {}

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
   * Merges keys into an existing row's payload, leaving every other key as it stands.
   *
   * Used to bind a wait to the approval it belongs to, after the Run has actually parked. A
   * whole-payload write would race the request that created the row.
   */
  async mergePayload(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.db.query(`UPDATE approvals SET payload = payload || $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify(patch),
    ]);
  }

  /**
   * The approval recorded for one Run's Tool intent, whatever it was decided.
   *
   * Settled rows count: a resumed turn re-proposes the approved call and must be told the decision
   * that was already made, not asked to collect it a second time.
   */
  async findByIntent(runId: string, intentDigest: string): Promise<ApprovalRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, kind, status, payload, expires_at, created_at, resolved_at
       FROM approvals
       WHERE kind = 'tool_call'
         AND payload->>'runId' = $1
         AND payload->>'intentDigest' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [runId, intentDigest]
    );
    return rows.length > 0 ? rowToApproval(rows[0]) : null;
  }

  /**
   * The approval opened for one Routine State occurrence, whatever it was decided.
   *
   * Keyed by the durable occurrence key rather than the State name, so a fan-out unit gets its own
   * question. Settled rows count: a replayed Run must read the decision back, not ask again.
   */
  async findByRunState(runId: string, stateKey: string): Promise<ApprovalRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, kind, status, payload, expires_at, created_at, resolved_at
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

  /**
   * The pending Tool approval currently open for one Run, if any.
   *
   * A Run parks on at most one tool-call approval at a time, so the newest pending row for the
   * Run is the one it's waiting on — older rows for the same Run are already settled.
   */
  async findPendingByRun(runId: string): Promise<ApprovalRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, kind, status, payload, expires_at, created_at, resolved_at
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
      `SELECT id, kind, status, payload, expires_at, created_at, resolved_at
       FROM approvals WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? rowToApproval(rows[0]) : null;
  }

  /** Pending rows (optionally by kind), oldest first — the routine_state approvals list. */
  async listPending(kind?: ApprovalKind): Promise<ApprovalRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, kind, status, payload, expires_at, created_at, resolved_at
       FROM approvals WHERE status = 'pending' ${kind ? "AND kind = $1" : ""}
       ORDER BY created_at`,
      kind ? [kind] : []
    );
    return rows.map(rowToApproval);
  }

  /** Pending rows past their expiry — settled to `timeout` by the routine sweep. */
  async listExpiredPending(kind: ApprovalKind, now: Date): Promise<ApprovalRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, kind, status, payload, expires_at, created_at, resolved_at
       FROM approvals WHERE status = 'pending' AND kind = $1 AND expires_at <= $2`,
      [kind, now]
    );
    return rows.map(rowToApproval);
  }
}

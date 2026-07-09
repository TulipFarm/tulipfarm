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
 * DB-backed store for approval rows (AGT-V1-002). Serves as an audit trail for
 * tool-call approvals and will store routine human_approval states (v0.11).
 * Tool-call approvals remain in-memory-authoritative; this repo is write-through only.
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

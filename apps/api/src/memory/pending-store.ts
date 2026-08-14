import type { PendingMemory, PendingMemoryStore, RememberRequest } from "@tulipfarm/memory";
import type { Queryable } from "../db";

/** Pending inferred statements live outside `memory_assertions`; rejects are hard-deleted. */
export class PgPendingMemoryStore implements PendingMemoryStore {
  constructor(private readonly db: Queryable) {}

  async put(pending: PendingMemory): Promise<void> {
    await this.db.query(
      `INSERT INTO memory_pending (business_id, pending_id, request, requested_at, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (business_id, pending_id) DO UPDATE SET
         request = EXCLUDED.request,
         requested_at = EXCLUDED.requested_at,
         expires_at = EXCLUDED.expires_at`,
      [
        pending.businessId,
        pending.pendingId,
        JSON.stringify(pending.request),
        pending.requestedAt,
        pending.expiresAt,
      ]
    );
  }

  async get(businessId: string, pendingId: string): Promise<PendingMemory | undefined> {
    const { rows } = await this.db.query(
      `SELECT business_id, pending_id, request, requested_at, expires_at
       FROM memory_pending WHERE business_id = $1 AND pending_id = $2`,
      [businessId, pendingId]
    );
    const row = rows[0] as
      | {
          business_id: string;
          pending_id: string;
          request: RememberRequest;
          requested_at: Date;
          expires_at: Date;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      pendingId: row.pending_id,
      businessId: row.business_id,
      request: row.request,
      requestedAt: row.requested_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /** Lists only this principal's non-expired records; SQL filters before anything can leak. */
  async listForPrincipal(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<readonly PendingMemory[]> {
    const { rows } = await this.db.query(
      `SELECT business_id, pending_id, request, requested_at, expires_at
       FROM memory_pending
       WHERE business_id = $1
         AND expires_at > $3
         AND request -> 'target' ->> 'subjectPrincipalId' = $2
       ORDER BY requested_at, pending_id`,
      [businessId, principalId, now.toISOString()]
    );
    return (
      rows as unknown as {
        business_id: string;
        pending_id: string;
        request: RememberRequest;
        requested_at: Date;
        expires_at: Date;
      }[]
    ).map((row) => ({
      pendingId: row.pending_id,
      businessId: row.business_id,
      request: row.request,
      requestedAt: row.requested_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));
  }

  /** Hard-deletes everything past its confirmation window. Nothing expired is ever durable. */
  async purgeExpired(businessId: string, now: Date): Promise<number> {
    const { rows } = await this.db.query(
      "DELETE FROM memory_pending WHERE business_id = $1 AND expires_at <= $2 RETURNING pending_id",
      [businessId, now.toISOString()]
    );
    return rows.length;
  }

  async queueStats(
    businessId: string,
    now: Date
  ): Promise<{ readonly depth: number; readonly oldestAgeMs: number }> {
    const { rows } = await this.db.query(
      `SELECT count(*)::text AS depth, min(requested_at) AS oldest
       FROM memory_pending
       WHERE business_id = $1 AND expires_at > $2`,
      [businessId, now.toISOString()]
    );
    const row = rows[0] as { depth: string; oldest: Date | null } | undefined;
    const depth = Number(row?.depth ?? 0);
    const oldestAgeMs =
      row?.oldest === null || row?.oldest === undefined
        ? 0
        : Math.max(0, now.getTime() - row.oldest.getTime());
    return { depth, oldestAgeMs };
  }

  async delete(businessId: string, pendingId: string): Promise<void> {
    await this.db.query("DELETE FROM memory_pending WHERE business_id = $1 AND pending_id = $2", [
      businessId,
      pendingId,
    ]);
  }

  async deleteReferencingAssertion(
    businessId: string,
    assertionId: string,
    statement: string
  ): Promise<number> {
    const { rows } = await this.db.query(
      `DELETE FROM memory_pending
        WHERE business_id = $1
          AND (
            request ->> 'supersedesId' = $2
            OR position($2 in request::text) > 0
            OR ($3 <> '' AND position($3 in request::text) > 0)
          )
       RETURNING pending_id`,
      [businessId, assertionId, statement]
    );
    return rows.length;
  }
}

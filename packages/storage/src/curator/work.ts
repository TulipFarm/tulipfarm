import type { CuratorWorkReason } from "@tulipfarm/schema";
import type { Queryable } from "../ports";

/**
 * One durable unit of Curator work for one user.
 *
 * `sourceKey` is part of the identity — the Turn id, Proposal id, candidate id, or the ISO date for
 * `daily_refresh_due`. Without it, deduplication would collapse two genuinely distinct pieces of
 * work into one and silently drop the second.
 */
export interface CuratorWorkRef {
  readonly businessId: string;
  readonly userId: string;
  readonly reason: CuratorWorkReason;
  readonly sourceKey: string;
}

export type CuratorWorkStatus = "due" | "claimed" | "done" | "skipped";

export const CURATOR_WORK_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS curator_user_work (
    business_id  text NOT NULL,
    user_id      text NOT NULL,
    reason       text NOT NULL CHECK (reason IN
                   ('turn_completed', 'proposal_resolved', 'daily_refresh_due',
                    'proposal_seed_ready')),
    source_key   text NOT NULL CHECK (length(source_key) > 0),
    status       text NOT NULL DEFAULT 'due'
                   CHECK (status IN ('due', 'claimed', 'done', 'skipped')),
    job_id       uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    claimed_at   timestamptz,
    completed_at timestamptz,
    PRIMARY KEY (business_id, user_id, reason, source_key)
  )`,
  // Oldest-backlog-first fairness, and the claim query's only scan.
  `CREATE INDEX IF NOT EXISTS curator_user_work_due_idx
     ON curator_user_work (business_id, created_at)
     WHERE status = 'due'`,
];

/**
 * Records work in the caller's transaction. This must share the transaction that completes the
 * Turn: written afterwards, any Turn whose process crashed in between is lost to the Curator
 * forever, and no later sweep can discover it.
 */
export async function recordCuratorWork(
  tx: Queryable,
  ref: CuratorWorkRef,
  now: Date
): Promise<void> {
  await tx.query(
    `INSERT INTO curator_user_work (business_id, user_id, reason, source_key, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, user_id, reason, source_key) DO NOTHING`,
    [ref.businessId, ref.userId, ref.reason, ref.sourceKey, now]
  );
}

/**
 * Claims up to `limit` due rows for one user and binds them to `jobId`, in the caller's
 * transaction so the claim commits with the job that owns it.
 *
 * Oldest first, because a user whose backlog is never drained is a user the loop has abandoned.
 * `SKIP LOCKED` lets two concurrent mints for different users proceed; the live-job unique index,
 * not this query, is what stops two mints for the *same* user. Rows beyond the cap stay `due` and
 * are picked up by the next Run rather than overflowing this one's context.
 */
export async function claimCuratorWork(
  tx: Queryable,
  input: { businessId: string; userId: string; jobId: string; limit: number; now: Date }
): Promise<CuratorWorkRef[]> {
  // The LIMIT must live in a CTE, not in an `UPDATE ... FROM (subselect FOR UPDATE ...)`: in that
  // form Postgres re-evaluates the locking subquery per outer row and the cap silently stops
  // applying, claiming the entire backlog into one Run. Verified against PGlite 0.5.
  const claimed = await tx.query<{ reason: CuratorWorkReason; source_key: string }>(
    `WITH due AS (
        SELECT reason, source_key
          FROM curator_user_work
         WHERE business_id = $1 AND user_id = $2 AND status = 'due'
         ORDER BY created_at, reason, source_key
         LIMIT $4
           FOR UPDATE SKIP LOCKED)
      UPDATE curator_user_work AS w
         SET status = 'claimed', job_id = $3, claimed_at = $5
        FROM due
       WHERE w.business_id = $1 AND w.user_id = $2
         AND w.reason = due.reason AND w.source_key = due.source_key
      RETURNING w.reason, w.source_key`,
    [input.businessId, input.userId, input.jobId, input.limit, input.now]
  );
  return claimed.rows
    .map((row) => ({
      businessId: input.businessId,
      userId: input.userId,
      reason: row.reason,
      sourceKey: row.source_key,
    }))
    .sort((a, b) => (a.reason + a.sourceKey).localeCompare(b.reason + b.sourceKey));
}

/**
 * Returns the users whose backlog the next sweep should mint for, oldest backlog first.
 *
 * Fairness is the point of the ordering: a user whose oldest due row is the oldest in the business
 * gets served before one whose work arrived a minute ago, so a busy person cannot starve a quiet
 * one. Only `active` users are returned — inviting someone or disabling them must not spend model
 * budget on a person who cannot read the result. Filtering on the positive status rather than
 * excluding known-bad ones keeps that true when a new status is added.
 */
export async function listUsersWithDueWork(
  db: Queryable,
  input: { businessId: string; limit: number }
): Promise<readonly string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT w.user_id
       FROM curator_user_work AS w
       JOIN users AS u ON u.id::text = w.user_id
      WHERE w.business_id = $1 AND w.status = 'due' AND u.status = 'active'
      GROUP BY w.user_id
      ORDER BY min(w.created_at), w.user_id
      LIMIT $2`,
    [input.businessId, input.limit]
  );
  return rows.map((row) => row.user_id);
}

/**
 * Age in seconds of the oldest work nobody has served yet, or `null` when the backlog is empty.
 *
 * This is the loop's real staleness: mint counts say the sweep ran, but only this says whether it
 * is keeping up. Read once per sweep rather than per mint — the index that orders the fan-out
 * serves it, so the cost is one cheap read every five minutes.
 */
export async function oldestDueWorkAgeSeconds(
  db: Queryable,
  businessId: string
): Promise<number | null> {
  const { rows } = await db.query<{ age_seconds: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) AS age_seconds
       FROM curator_user_work
      WHERE business_id = $1 AND status = 'due'`,
    [businessId]
  );
  const age = rows[0]?.age_seconds;
  return age == null ? null : Number(age);
}

/**
 * Returns a job's claimed work to `due`. Every path that abandons a job — admission refusal,
 * provider denial, a Run that died before reasoning succeeded — must call this, or the work is
 * stranded in `claimed` behind a job that will never finish.
 */
export async function releaseCuratorWork(tx: Queryable, jobId: string): Promise<number> {
  const released = await tx.query<{ source_key: string }>(
    `UPDATE curator_user_work SET status = 'due', job_id = NULL, claimed_at = NULL
      WHERE job_id = $1 AND status = 'claimed'
      RETURNING source_key`,
    [jobId]
  );
  return released.rows.length;
}

/** Retires a job's claimed work once its reasoning settled. */
export async function completeCuratorWork(
  tx: Queryable,
  jobId: string,
  now: Date
): Promise<number> {
  const done = await tx.query<{ source_key: string }>(
    `UPDATE curator_user_work SET status = 'done', completed_at = $2
      WHERE job_id = $1 AND status = 'claimed'
      RETURNING source_key`,
    [jobId, now]
  );
  return done.rows.length;
}

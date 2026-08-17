/**
 * Reads for the shadow review surface.
 *
 * Kept apart from `repo.ts` because nothing here participates in the loop: no claim, no state
 * transition, no write. A review read that could mutate a job would be a way to disturb the very
 * behaviour it exists to observe.
 */

import type { Queryable } from "../ports";

export interface CuratorCount {
  readonly count: number;
}

export interface CuratorShadowSummary {
  readonly jobs: readonly (CuratorCount & { readonly scope: string; readonly state: string })[];
  readonly effects: readonly (CuratorCount & { readonly kind: string; readonly state: string })[];
  readonly rejections: readonly (CuratorCount & { readonly reason: string })[];
}

export interface CuratorShadowEffectRow {
  readonly id: string;
  readonly jobId: string;
  readonly scope: string;
  readonly userId: string | null;
  readonly kind: string;
  readonly state: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/** Counts only, so a summary is safe to serve to any operator regardless of who it reasoned over. */
export async function summarizeCuratorShadow(
  db: Queryable,
  businessId: string,
  since: Date
): Promise<CuratorShadowSummary> {
  const jobs = await db.query<{ scope: string; state: string; n: number }>(
    `SELECT scope, state, count(*)::int AS n FROM curator_job
      WHERE business_id = $1 AND created_at >= $2 GROUP BY scope, state ORDER BY scope, state`,
    [businessId, since]
  );
  const effects = await db.query<{ kind: string; state: string; n: number }>(
    `SELECT kind, state, count(*)::int AS n FROM curator_effect
      WHERE business_id = $1 AND created_at >= $2 GROUP BY kind, state ORDER BY kind, state`,
    [businessId, since]
  );
  // `curator_rejection` carries neither business nor its own window, so the job it belongs to
  // supplies both. Filtering on the job's window also keeps a job's rejections and its effects in
  // the same period, which a rejection-rate read on separate windows would quietly get wrong.
  const rejections = await db.query<{ reason: string; n: number }>(
    `SELECT r.reason, count(*)::int AS n FROM curator_rejection r
       JOIN curator_job j ON j.id = r.job_id
      WHERE j.business_id = $1 AND j.created_at >= $2 GROUP BY r.reason ORDER BY r.reason`,
    [businessId, since]
  );
  return {
    jobs: jobs.rows.map((row) => ({ scope: row.scope, state: row.state, count: row.n })),
    effects: effects.rows.map((row) => ({ kind: row.kind, state: row.state, count: row.n })),
    rejections: rejections.rows.map((row) => ({ reason: row.reason, count: row.n })),
  };
}

/**
 * The most recent effects with the scope and subject of the job that produced them, so the caller
 * can decide disclosure per row. Payloads are returned raw; redaction is the caller's job because
 * it depends on who is asking, which SQL has no business knowing.
 */
export async function listCuratorShadowEffects(
  db: Queryable,
  businessId: string,
  since: Date,
  limit: number
): Promise<CuratorShadowEffectRow[]> {
  const { rows } = await db.query<{
    id: string;
    job_id: string;
    scope: string;
    user_id: string | null;
    kind: string;
    state: string;
    payload: unknown;
    created_at: Date;
  }>(
    `SELECT e.id, e.job_id, j.scope, j.user_id, e.kind, e.state, e.payload, e.created_at
       FROM curator_effect e JOIN curator_job j ON j.id = e.job_id
      WHERE e.business_id = $1 AND e.created_at >= $2
      ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    [businessId, since, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    scope: row.scope,
    userId: row.user_id,
    kind: row.kind,
    state: row.state,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

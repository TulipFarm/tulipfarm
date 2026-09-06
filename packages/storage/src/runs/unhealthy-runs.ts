import type { Queryable } from "../ports";

export interface UnhealthyRunRow {
  readonly id: string;
  readonly status: string;
  readonly errorEvidenceRef: string | null;
  /** `bundle.routineId` — the Routine the Run pins, not its slug. */
  readonly routineId: string | null;
  readonly createdAt: Date;
}

interface Row {
  id: string;
  status: string;
  error_evidence_ref: string | null;
  routine_id: string | null;
  created_at: Date;
}

/** A Run holding `queued` past this has plainly not been picked up, whatever the lease says. */
export const DEFAULT_STALL_AFTER_MS = 30 * 60_000;

/**
 * Runs the Runtime will not finish on its own.
 *
 * Two disjoint populations, deliberately in one query so the Doctor sees one ordered picture:
 *
 * - `needs_reconciliation`, unconditionally. Nothing requeues it — `requeueParkedRunRows` acts
 *   only on `dispatch:handler_error`, and only once — so age is irrelevant: it is stuck the moment
 *   it parks. Its `finished_at` stays null and it emits no further Run events, which is precisely
 *   why no surface can tell it from a Run still in flight.
 * - `queued` older than the stall window, or `claimed`/`running` past an expired lease. The lease
 *   reclaimer normally rescues the second kind; one that is still here after a reclaim window has
 *   passed is not being rescued.
 *
 * Ordered oldest first so a bounded sweep always works on the longest-stuck Run rather than
 * rediscovering whatever broke most recently.
 */
export async function listUnhealthyRuns(
  db: Queryable,
  businessId: string,
  options: { readonly now: Date; readonly stallAfterMs?: number; readonly limit: number }
): Promise<readonly UnhealthyRunRow[]> {
  const cutoff = new Date(
    options.now.getTime() - (options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS)
  ).toISOString();
  const result = await db.query<Row>(
    `SELECT id, status, error_evidence_ref, bundle->>'routineId' AS routine_id, created_at
       FROM runs
      WHERE business_id = $1
        AND (
          status = 'needs_reconciliation'
          OR (status = 'queued' AND created_at < $2::timestamptz)
          OR (status IN ('claimed', 'running')
              AND lease_expires_at < $2::timestamptz)
        )
      ORDER BY created_at
      LIMIT $3`,
    [businessId, cutoff, options.limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    errorEvidenceRef: row.error_evidence_ref,
    routineId: row.routine_id,
    createdAt: row.created_at,
  }));
}

/** Stamped on a Run the Doctor closed because the Routine it pins was repaired underneath it. */
export const DOCTOR_SUPERSEDED_REF = "doctor:superseded_by_repair";

/**
 * Closes Runs a repair has made unrepeatable.
 *
 * A Run pins the bundle it started with, so republishing a fixed Routine does nothing for a Run
 * already parked against the broken one — requeueing it would replay the same unresolvable
 * mapping and park it again. Failing it is the honest end: the Run cannot succeed, and while it
 * sits at `needs_reconciliation` with a null `finished_at` every surface reads it as in flight.
 *
 * Restricted to `routine:input_not_evaluable:*`, which is recorded before any effect is
 * dispatched. A Run parked for another reason may have work in flight, and closing that one would
 * hide a half-applied effect rather than report it.
 */
export async function closeSupersededRuns(
  db: Queryable,
  businessId: string,
  routineId: string,
  limit: number
): Promise<readonly string[]> {
  const result = await db.query<{ id: string }>(
    `WITH candidates AS (
       SELECT id
         FROM runs
        WHERE business_id = $1
          AND status = 'needs_reconciliation'
          AND bundle->>'routineId' = $2
          AND error_evidence_ref LIKE 'routine:input_not_evaluable:%'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE runs
        SET status = 'failed',
            version = version + 1,
            finished_at = now(),
            error_evidence_ref = $3,
            lease_owner = NULL,
            lease_expires_at = NULL
       FROM candidates
      WHERE runs.id = candidates.id
     RETURNING runs.id`,
    [businessId, routineId, DOCTOR_SUPERSEDED_REF, Math.max(0, limit)]
  );
  return result.rows.map((row) => row.id);
}

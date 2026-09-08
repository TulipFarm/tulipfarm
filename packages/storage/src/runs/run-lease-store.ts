import type { Queryable } from "../ports";
import { persistedRun, type RunRow } from "./run-row";
import type { ClaimNextQueuedInput, HeartbeatInput, PersistedRun } from "./run-store";

/** Extends an owned lease without changing status; fails if the lease moved to another worker. */
export async function heartbeatRun(
  transaction: Queryable,
  businessId: string,
  runId: string,
  owner: string,
  heartbeat: HeartbeatInput
): Promise<boolean> {
  const result = await transaction.query<{ id: string }>(
    `UPDATE runs
        SET version = version + 1,
            lease_expires_at = $5::timestamptz
      WHERE business_id = $1
        AND id = $2
        AND version = $3
        AND lease_owner = $4
        AND status IN ('claimed', 'running')
      RETURNING id`,
    [businessId, runId, heartbeat.expectedVersion, owner, heartbeat.leaseExpiresAt]
  );
  return result.rows.length === 1;
}

/**
 * Requeues work that never entered a handler and parks abandoned running work for effect-aware
 * recovery. A provider call may have landed before a running worker died.
 */
export async function reclaimExpiredRunRows(
  transaction: Queryable,
  businessId: string,
  now: string,
  limit: number
): Promise<readonly PersistedRun[]> {
  const result = await transaction.query<RunRow>(
    `WITH candidates AS (
       SELECT id
         FROM runs
        WHERE business_id = $1
          AND status IN ('claimed', 'running')
          AND lease_expires_at <= $2::timestamptz
        ORDER BY lease_expires_at
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE runs
        SET status = CASE
              WHEN runs.status = 'claimed' THEN 'queued'
              ELSE 'needs_reconciliation'
            END,
            version = version + 1,
            error_evidence_ref = CASE
              WHEN runs.status = 'running' THEN $4
              ELSE runs.error_evidence_ref
            END,
            lease_owner = NULL,
            lease_expires_at = NULL
       FROM candidates
      WHERE runs.id = candidates.id
     RETURNING runs.id, runs.business_id, runs.source, runs.bundle, runs.identity,
               runs.status, runs.version, runs.created_at, runs.started_at, runs.finished_at,
               runs.result_artifact_id, runs.error_evidence_ref, runs.lease_owner,
               runs.lease_expires_at`,
    [businessId, now, Math.max(0, limit), DISPATCH_LEASE_EXPIRED_REF]
  );
  return result.rows.map(persistedRun);
}

/** Claims a batch of queued Runs with an owned, timed lease so a worker can start them. */
export async function claimNextQueuedRunRows(
  transaction: Queryable,
  businessId: string,
  owner: string,
  input: ClaimNextQueuedInput
): Promise<readonly PersistedRun[]> {
  const leaseExpiresAt = new Date(
    new Date(input.now).getTime() + input.leaseDurationMs
  ).toISOString();
  const result = await transaction.query<RunRow>(
    `WITH candidates AS (
       SELECT id
         FROM runs
        WHERE business_id = $1
          AND status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE runs
        SET status = 'claimed',
            version = version + 1,
            lease_owner = $2,
            lease_expires_at = $3::timestamptz
       FROM candidates
      WHERE runs.id = candidates.id
     RETURNING runs.id, runs.business_id, runs.source, runs.bundle, runs.identity,
               runs.status, runs.version, runs.created_at, runs.started_at, runs.finished_at,
               runs.result_artifact_id, runs.error_evidence_ref, runs.lease_owner,
               runs.lease_expires_at`,
    [businessId, owner, leaseExpiresAt, Math.max(0, input.limit)]
  );
  return result.rows.map(persistedRun);
}

/**
 * Requeues a waiting Run whose durable wait resolved. Idempotent by construction: only a Run
 * still in `waiting` moves, so a duplicate resume never requeues the same Run twice.
 */
export async function requeueWaitingRunRow(
  transaction: Queryable,
  businessId: string,
  runId: string
): Promise<boolean> {
  const result = await transaction.query<{ id: string }>(
    `UPDATE runs
        SET status = 'queued',
            version = version + 1
      WHERE business_id = $1
        AND id = $2
        AND status = 'waiting'
      RETURNING id`,
    [businessId, runId]
  );
  return result.rows.length === 1;
}

/** The evidence ref the dispatcher records when a handler throw parks a Run. */
export const DISPATCH_HANDLER_ERROR_REF = "dispatch:handler_error";

/** Recorded when a worker lease expires after a Run entered its handler. */
export const DISPATCH_LEASE_EXPIRED_REF = "dispatch:lease_expired";

/**
 * Stamped in place of {@link DISPATCH_HANDLER_ERROR_REF} once a Run has been requeued. It is what
 * makes the requeue bounded: the sweep's own `WHERE` no longer matches, so a Run can never be
 * requeued twice, and the dispatcher reads it to fail a second throw outright.
 */
export const DISPATCH_REQUEUED_ONCE_REF = "dispatch:requeued_once";

/**
 * Recorded when an executor *returns* `needs_reconciliation` (rather than throwing) without
 * naming its own reason. Without this, such a park carries a null `error_evidence_ref` and the
 * recovery sweep's candidate query (`error_evidence_ref IN (...)`) never selects it — the Run
 * parks forever, invisible to the reconciliation path that would otherwise requeue or escalate it.
 */
export const DISPATCH_UNSPECIFIED_PARK_REF = "dispatch:unspecified_park";

/** Lists the bounded recovery cases a manager must classify against durable effects. */
export async function listRecoveryCandidateRows(
  transaction: Queryable,
  businessId: string,
  limit: number
): Promise<readonly PersistedRun[]> {
  const result = await transaction.query<RunRow>(
    `SELECT id, business_id, source, bundle, identity, status, version, created_at, started_at,
            finished_at, result_artifact_id, error_evidence_ref, lease_owner, lease_expires_at
       FROM runs
      WHERE business_id = $1
        AND status = 'needs_reconciliation'
        AND error_evidence_ref IN ($2, $3)
      ORDER BY created_at
      LIMIT $4`,
    [businessId, DISPATCH_HANDLER_ERROR_REF, DISPATCH_LEASE_EXPIRED_REF, Math.max(0, limit)]
  );
  return result.rows.map(persistedRun);
}

/** Requeues one classified recovery under status, version, and evidence CAS fences. */
export async function requeueParkedRunRow(
  transaction: Queryable,
  businessId: string,
  runId: string,
  expectedVersion: number,
  expectedEvidenceRef: string
): Promise<PersistedRun | null> {
  const result = await transaction.query<RunRow>(
    `UPDATE runs
        SET status = 'queued',
            version = version + 1,
            error_evidence_ref = $5,
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE business_id = $1
        AND id = $2
        AND version = $3
        AND status = 'needs_reconciliation'
        AND error_evidence_ref = $4
      RETURNING id, business_id, source, bundle, identity, status, version, created_at, started_at,
                finished_at, result_artifact_id, error_evidence_ref, lease_owner, lease_expires_at`,
    [businessId, runId, expectedVersion, expectedEvidenceRef, DISPATCH_REQUEUED_ONCE_REF]
  );
  return result.rows[0] === undefined ? null : persistedRun(result.rows[0]);
}

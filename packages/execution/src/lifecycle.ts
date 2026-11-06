import { z } from 'zod';
import { executionJobStateSchema, type ExecutionJobState, type ExecutionPolicy } from '@tulipfarm/execution-contract';
import { requireGeneration, type ExecutionAllocationRecord } from './allocations.ts';
import { appendStatus, jobSchema, readJob, type ExecutionJobRecord } from './jobs.ts';
import { enqueueIntent, ExecutionConflict, table, type ExecutionArea, type ExecutionTransaction } from './state.ts';

/** A false launch result means inspect the existing job; it never authorizes another command start. */
export async function beginJob(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  jobId: string,
  allocation: ExecutionAllocationRecord,
  policy: ExecutionPolicy,
) {
  await requireGeneration(tx, area.id, area.generation);
  const job = await readJob(tx, area.id, jobId);
  if (job.generation !== area.generation) throw new ExecutionConflict('stale');
  if (job.state !== 'queued') return { launch: false, job };
  const expired = (
    await tx.client.query(
      `SELECT 1 FROM ${table(tx, 'tf_execution_jobs')} WHERE id=$1 AND queue_deadline<=clock_timestamp()`,
      [job.id],
    )
  ).rowCount;
  if (expired) {
    const timedOut = jobSchema.parse(
      (
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_execution_jobs')} SET state='timed-out',finished_at=clock_timestamp(),
        result='{"state":"timed-out"}'::jsonb WHERE id=$1 RETURNING *`,
          [job.id],
        )
      ).rows[0],
    );
    await appendStatus(tx, area, timedOut);
    await enqueueIntent(tx, area, 'resume', `${job.id}:resume`, job.id);
    return { launch: false, job: timedOut };
  }
  const blocked = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_execution_jobs')} WHERE area_id=$1 AND
      (state IN ('starting','running','saving','outcome-unknown') OR
       (state='queued' AND (created_at,id)<(SELECT created_at,id FROM ${table(tx, 'tf_execution_jobs')} WHERE id=$2)))
      LIMIT 1`,
    [area.id, job.id],
  );
  if (blocked.rowCount) throw new ExecutionConflict('busy');
  const row = (
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_execution_jobs')} j SET state='starting',allocation_id=a.id,
      deadline=LEAST(a.deadline,clock_timestamp()+($5::double precision*interval '1 second'))
      FROM ${table(tx, 'tf_execution_allocations')} a
      WHERE j.id=$1 AND j.state='queued' AND j.cancel_requested_at IS NULL
        AND a.id=$2 AND a.area_id=j.area_id AND a.generation=j.generation AND a.runner_id=$3
        AND a.state='ready' AND a.deadline>clock_timestamp() AND j.generation=$4 RETURNING j.*`,
      [job.id, allocation.id, allocation.runner_id, area.generation, policy.limits.jobTimeoutSeconds],
    )
  ).rows[0];
  if (!row) throw new ExecutionConflict('stale');
  const started = jobSchema.parse(row);
  await appendStatus(tx, area, started);
  return { launch: true, job: started };
}

/** A terminal backend receipt enters saving first; retained files must commit before the user sees completion. */
export async function observeJob(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  jobId: string,
  value: ExecutionJobState,
) {
  const observed = executionJobStateSchema.parse(value);
  await requireGeneration(tx, area.id, area.generation);
  const job = await readJob(tx, area.id, jobId);
  if (job.generation !== area.generation) throw new ExecutionConflict('stale');
  if (['completed', 'cancelled', 'timed-out', 'saving'].includes(job.state)) return job;
  if (job.state === 'queued') throw new ExecutionConflict('request-conflict');
  const state =
    observed.state === 'running' ? 'running' : observed.state === 'outcome-unknown' ? 'outcome-unknown' : 'saving';
  const updated = jobSchema.parse(
    (
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_execution_jobs')} SET state=$2,result=$3,
      save_after=CASE WHEN $2='saving' THEN clock_timestamp() ELSE NULL END WHERE id=$1 RETURNING *`,
        [job.id, state, observed],
      )
    ).rows[0],
  );
  await appendStatus(tx, area, updated);
  return updated;
}

export async function finishSavedJob(tx: ExecutionTransaction, area: ExecutionArea, jobId: string, manifestId: string) {
  z.uuid().parse(manifestId);
  await requireGeneration(tx, area.id, area.generation);
  const job = await readJob(tx, area.id, jobId);
  if (job.generation !== area.generation) throw new ExecutionConflict('stale');
  if (['completed', 'cancelled', 'timed-out'].includes(job.state)) return job;
  const result = executionJobStateSchema.parse(job.result);
  if (job.state !== 'saving' || !['completed', 'cancelled', 'timed-out'].includes(result.state))
    throw new ExecutionConflict('request-conflict');
  if (result.state === 'completed' && !job.output_complete) throw new ExecutionConflict('busy');
  const current = await tx.client.query(
    `SELECT m.id,m.created_at FROM ${table(tx, 'tf_execution_areas')} a JOIN ${table(tx, 'tf_execution_manifests')} m
      ON m.id=a.manifest_id AND m.area_id=a.id WHERE a.id=$1 AND m.id=$2 AND m.generation=$3
        AND m.created_at>= (SELECT save_after FROM ${table(tx, 'tf_execution_jobs')} WHERE id=$4)`,
    [area.id, manifestId, area.generation, job.id],
  );
  if (!current.rowCount) throw new ExecutionConflict('stale');
  const manifest = z.object({ id: z.uuid(), created_at: z.date() }).parse(current.rows[0]);
  const finished = jobSchema.parse(
    (
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_execution_jobs')} SET state=$2,finished_at=clock_timestamp(),file_save=$3 WHERE id=$1 RETURNING *`,
        [
          job.id,
          result.state,
          { state: 'complete', manifestId: manifest.id, savedAt: manifest.created_at.toISOString() },
        ],
      )
    ).rows[0],
  );
  await appendStatus(tx, area, finished);
  await enqueueIntent(tx, area, 'resume', `${job.id}:resume`, job.id);
  return finished;
}

/** A confirmed forced stop keeps the last committed files; it never claims to have saved newer guest bytes. */
export async function finishInterruptedJob(tx: ExecutionTransaction, area: ExecutionArea, jobId: string) {
  await requireGeneration(tx, area.id, area.generation);
  const job = await readJob(tx, area.id, jobId);
  if (job.generation !== area.generation) throw new ExecutionConflict('stale');
  if (['completed', 'cancelled', 'timed-out'].includes(job.state)) return job;
  const result = executionJobStateSchema.parse(job.result);
  if (job.state !== 'saving' || !['cancelled', 'timed-out'].includes(result.state))
    throw new ExecutionConflict('request-conflict');
  const stopped = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_execution_allocations')}
      WHERE id=$1 AND area_id=$2 AND generation=$3 AND state='stopped'`,
    [job.allocation_id, area.id, area.generation],
  );
  if (!stopped.rowCount) throw new ExecutionConflict('busy');
  const manifest = z.object({ id: z.uuid().nullable(), created_at: z.date().nullable() }).parse(
    (
      await tx.client.query(
        `SELECT m.id,m.created_at FROM ${table(tx, 'tf_execution_areas')} a
        LEFT JOIN ${table(tx, 'tf_execution_manifests')} m ON m.area_id=a.id AND m.id=a.manifest_id
        WHERE a.id=$1`,
        [area.id],
      )
    ).rows[0],
  );
  const finished = jobSchema.parse(
    (
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_execution_jobs')} SET state=$2,finished_at=clock_timestamp(),file_save=$3 WHERE id=$1 RETURNING *`,
        [
          job.id,
          result.state,
          { state: 'partial', manifestId: manifest.id, savedAt: manifest.created_at?.toISOString() ?? null },
        ],
      )
    ).rows[0],
  );
  await appendStatus(tx, area, finished);
  await enqueueIntent(tx, area, 'resume', `${job.id}:resume`, job.id);
  return finished;
}

export function executionJobReference(job: ExecutionJobRecord) {
  if (!job.allocation_id || !job.deadline) throw new ExecutionConflict('stale');
  return { areaId: job.area_id, allocationId: job.allocation_id, generation: job.generation, jobId: job.id };
}

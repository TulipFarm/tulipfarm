import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { executionCommandSchema, type ExecutionPolicy } from '@tulipfarm/execution-contract';
import { nextJobGeneration, requireGeneration } from './allocations.ts';
import {
  enqueueIntent,
  ExecutionConflict,
  requestHash,
  table,
  type ExecutionArea,
  type ExecutionTransaction,
} from './state.ts';

export const jobRequestSchema = z.strictObject({
  callId: z.uuid(),
  turnId: z.uuid(),
  turnGeneration: z.number().int().nonnegative(),
  turnEpoch: z.number().int().nonnegative(),
  command: executionCommandSchema,
});
export const jobSchema = z.object({
  id: z.uuid(),
  area_id: z.uuid(),
  conversation_id: z.uuid(),
  generation: z.number().int().positive(),
  turn_id: z.uuid(),
  turn_generation: z.number().int().nonnegative(),
  turn_epoch: z.number().int().nonnegative(),
  call_id: z.uuid(),
  membership_id: z.uuid(),
  consent_revision: z.number().int().positive(),
  request_hash: z.string(),
  state: z.enum(['queued', 'starting', 'running', 'saving', 'completed', 'cancelled', 'timed-out', 'outcome-unknown']),
  command: executionCommandSchema,
  sources: z.array(z.unknown()),
  allocation_id: z.uuid().nullable(),
  cancel_requested_at: z.date().nullable(),
  queue_deadline: z.date(),
  deadline: z.date().nullable(),
  next_event: z.number().int().positive(),
  output_cursor: z.number().int().nonnegative(),
  output_bytes: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output_truncated: z.boolean(),
  output_complete: z.boolean(),
  result: z.unknown(),
  file_save: z
    .strictObject({
      state: z.enum(['complete', 'partial']),
      manifestId: z.uuid().nullable(),
      savedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});
export type ExecutionJobRecord = z.infer<typeof jobSchema>;

export async function readJob(tx: ExecutionTransaction, areaId: string, jobId: string) {
  const job = jobSchema
    .optional()
    .parse(
      (
        await tx.client.query(`SELECT * FROM ${table(tx, 'tf_execution_jobs')} WHERE id=$1 AND area_id=$2 FOR UPDATE`, [
          z.uuid().parse(jobId),
          areaId,
        ])
      ).rows[0],
    );
  if (!job) throw new ExecutionConflict('not-found');
  return job;
}

/** Caller checks current chat, source, consent and turn authority in this same transaction. */
export async function enqueueJob(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  membershipId: string,
  input: z.infer<typeof jobRequestSchema>,
  sources: unknown[],
  policy: ExecutionPolicy,
) {
  const request = jobRequestSchema.parse(input);
  const hash = requestHash({ request, sources });
  const existing = jobSchema
    .optional()
    .parse(
      (
        await tx.client.query(`SELECT * FROM ${table(tx, 'tf_execution_jobs')} WHERE call_id=$1 FOR UPDATE`, [
          request.callId,
        ])
      ).rows[0],
    );
  if (existing) {
    if (existing.area_id !== area.id || existing.membership_id !== membershipId || existing.request_hash !== hash)
      throw new ExecutionConflict('request-conflict');
    return existing;
  }
  if (area.state !== 'active') throw new ExecutionConflict('not-found');
  area = await nextJobGeneration(tx, area);
  const job = jobSchema.parse(
    (
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_execution_jobs')}
      (id,area_id,conversation_id,generation,turn_id,turn_generation,turn_epoch,call_id,request_hash,consent_revision,
       membership_id,command,sources,queue_deadline)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+($14::double precision*interval '1 second')) RETURNING *`,
        [
          randomUUID(),
          area.id,
          area.conversation_id,
          area.generation,
          request.turnId,
          request.turnGeneration,
          request.turnEpoch,
          request.callId,
          hash,
          area.consent_revision,
          membershipId,
          request.command,
          JSON.stringify(sources),
          policy.limits.queueTimeoutSeconds,
        ],
      )
    ).rows[0],
  );
  await enqueueIntent(tx, area, 'start', `${job.id}:start`, job.id);
  await appendStatus(tx, area, job);
  return job;
}

export async function cancelJob(tx: ExecutionTransaction, area: ExecutionArea, job: ExecutionJobRecord) {
  if (['completed', 'cancelled', 'timed-out'].includes(job.state)) return job;
  const updated = jobSchema.parse(
    (
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_execution_jobs')} SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
      finished_at=CASE WHEN state='queued' THEN clock_timestamp() ELSE finished_at END,
      state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END WHERE id=$1 RETURNING *`,
        [job.id],
      )
    ).rows[0],
  );
  const operation = updated.state === 'cancelled' ? 'resume' : 'stop';
  await enqueueIntent(tx, { id: area.id, generation: job.generation }, operation, `${job.id}:${operation}`, job.id);
  await appendStatus(tx, area, updated);
  return updated;
}

export async function appendStatus(tx: ExecutionTransaction, area: ExecutionArea, job: ExecutionJobRecord) {
  if (area.generation !== job.generation) throw new ExecutionConflict('stale');
  await requireGeneration(tx, area.id, job.generation);
  const sequence = z.object({ sequence: z.number().int().positive() }).parse(
    (
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_execution_jobs')} SET next_event=next_event+1 WHERE id=$1 AND area_id=$2 AND generation=$3
      RETURNING next_event-1 AS sequence`,
        [job.id, area.id, area.generation],
      )
    ).rows[0],
  ).sequence;
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_events')} (job_id,sequence,kind,value) VALUES ($1,$2,'status',$3)`,
    [job.id, sequence, { state: job.state, cancelRequested: job.cancel_requested_at !== null }],
  );
}

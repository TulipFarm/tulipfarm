import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  executionOutputBytes,
  executionOutputSchema,
  type ExecutionOutput,
  type ExecutionPolicy,
} from '@tulipfarm/execution-contract';
import { requireGeneration } from './allocations.ts';
import { readJob, type ExecutionJobRecord } from './jobs.ts';
import { ExecutionConflict, table, type ExecutionArea, type ExecutionTransaction } from './state.ts';

/** Caller checks current job authority before publishing a runner's output. */
export async function appendOutput(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  jobId: string,
  input: ExecutionOutput[],
  limits: ExecutionPolicy['limits'],
) {
  const events = z.array(executionOutputSchema).max(64).parse(input);
  await requireGeneration(tx, area.id, area.generation);
  const job = await readJob(tx, area.id, jobId);
  if (job.generation !== area.generation) throw new ExecutionConflict('stale');
  const prior = z.array(z.object({ source_sequence: z.number().int().positive(), value: executionOutputSchema })).parse(
    (
      await tx.client.query(
        `SELECT source_sequence,value FROM ${table(tx, 'tf_execution_events')}
      WHERE job_id=$1 AND source_sequence=ANY($2::integer[])`,
        [job.id, events.map(event => event.sequence)],
      )
    ).rows,
  );
  const known = new Map(prior.map(row => [row.source_sequence, row.value]));
  let cursor = job.output_cursor,
    bytes = job.output_bytes,
    truncated = job.output_truncated,
    complete = job.output_complete,
    nextEvent = job.next_event;
  const pending: { sequence: number; source_sequence: number; value: ExecutionOutput }[] = [];
  for (const event of events) {
    if (event.sequence <= cursor) {
      if (!isDeepStrictEqual(known.get(event.sequence), event)) throw new ExecutionConflict('request-conflict');
      continue;
    }
    if (
      complete ||
      event.sequence !== cursor + 1 ||
      !['starting', 'running', 'saving', 'outcome-unknown'].includes(job.state) ||
      (truncated && event.kind !== 'end')
    )
      throw new ExecutionConflict('request-conflict');
    bytes += executionOutputBytes(event);
    if (!Number.isSafeInteger(bytes) || bytes > limits.outputBytes) throw new ExecutionConflict('quota');
    truncated ||= event.kind === 'truncated';
    complete = event.kind === 'end';
    cursor = event.sequence;
    known.set(cursor, event);
    pending.push({ sequence: nextEvent++, source_sequence: cursor, value: event });
  }
  if (pending.length) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_execution_events')} (job_id,sequence,source_sequence,kind,value)
      SELECT $1,r.sequence,r.source_sequence,'output',r.value
      FROM jsonb_to_recordset($2::jsonb) AS r(sequence integer,source_sequence integer,value jsonb)`,
      [job.id, JSON.stringify(pending)],
    );
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_execution_jobs')} SET output_cursor=$2,output_bytes=$3,
      output_truncated=$4,output_complete=$5,next_event=$6 WHERE id=$1`,
      [job.id, cursor, bytes, truncated, complete, nextEvent],
    );
  }
  return { cursor, bytes, truncated, complete };
}

export async function readOutput(tx: ExecutionTransaction, job: ExecutionJobRecord, after: number, limit: number) {
  z.number().int().nonnegative().max(2147483647).parse(after);
  z.number().int().min(1).max(64).parse(limit);
  if (after > job.output_cursor) throw new ExecutionConflict('request-conflict');
  return z
    .array(z.object({ value: executionOutputSchema }))
    .parse(
      (
        await tx.client.query(
          `SELECT value FROM ${table(tx, 'tf_execution_events')}
      WHERE job_id=$1 AND kind='output' AND source_sequence>$2 ORDER BY source_sequence LIMIT $3`,
          [job.id, after, limit],
        )
      ).rows,
    )
    .map(row => row.value);
}

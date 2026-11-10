import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ExecutionConflict, table, type ExecutionTransaction } from './state.ts';

const claimSchema = z.object({
  id: z.uuid(),
  area_id: z.uuid(),
  generation: z.number().int().positive(),
  job_id: z.uuid().nullable(),
  object_id: z.uuid().nullable(),
  operation: z.enum(['start', 'poll', 'stop', 'cleanup', 'resume', 'file-cleanup']),
  lease_id: z.uuid(),
  attempts: z.number().int().positive(),
});
export type ExecutionIntent = z.infer<typeof claimSchema>;

export async function claimIntent(
  tx: ExecutionTransaction,
  leaseSeconds: number,
  operation?: ExecutionIntent['operation'],
) {
  z.number().int().positive().max(300).parse(leaseSeconds);
  if (operation !== undefined) claimSchema.shape.operation.parse(operation);
  return claimSchema.optional().parse(
    (
      await tx.client.query(
        `WITH candidate AS (
       SELECT id FROM ${table(tx, 'tf_execution_outbox')}
       WHERE completed_at IS NULL AND available_at<=clock_timestamp()
         AND (lease_until IS NULL OR lease_until<=clock_timestamp())
         AND ($3::text IS NULL OR operation=$3)
       ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
     ) UPDATE ${table(tx, 'tf_execution_outbox')} o SET lease_id=$1,
       lease_until=clock_timestamp()+($2::double precision*interval '1 second'),attempts=attempts+1
       FROM candidate c WHERE o.id=c.id RETURNING o.*`,
        [randomUUID(), leaseSeconds, operation ?? null],
      )
    ).rows[0],
  );
}

export async function finishIntent(tx: ExecutionTransaction, claim: ExecutionIntent, retrySeconds?: number) {
  if (retrySeconds !== undefined) z.number().int().positive().max(300).parse(retrySeconds);
  const result = await tx.client.query(
    `UPDATE ${table(tx, 'tf_execution_outbox')} SET lease_id=NULL,lease_until=NULL,
      completed_at=CASE WHEN $3::integer IS NULL THEN clock_timestamp() ELSE NULL END,
      available_at=clock_timestamp()+(COALESCE($3,0)::double precision*interval '1 second')
      WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() AND completed_at IS NULL`,
    [claim.id, claim.lease_id, retrySeconds ?? null],
  );
  if (result.rowCount !== 1) throw new ExecutionConflict('stale');
}

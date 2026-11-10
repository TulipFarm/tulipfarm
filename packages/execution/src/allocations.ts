import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { areaSchema, ExecutionConflict, table, type ExecutionArea, type ExecutionTransaction } from './state.ts';

const allocationSchema = z.object({
  id: z.uuid(),
  area_id: z.uuid(),
  generation: z.number().int().positive(),
  runner_id: z.uuid(),
  state: z.enum(['preparing', 'ready', 'stopping', 'stopped', 'recovery-required']),
  deadline: z.date(),
});
export type ExecutionAllocationRecord = z.infer<typeof allocationSchema>;

export async function nextJobGeneration(tx: ExecutionTransaction, area: ExecutionArea) {
  const row = (
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_execution_areas')} a SET generation=generation+1
      WHERE a.id=$1 AND a.generation=$2 AND a.state='active'
      AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_execution_allocations')} x
        WHERE x.area_id=a.id AND x.generation=a.generation AND x.state='stopped')
      AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_execution_jobs')} j
        WHERE j.area_id=a.id AND j.state NOT IN ('completed','cancelled','timed-out'))
      RETURNING a.*`,
      [area.id, area.generation],
    )
  ).rows[0];
  return row ? areaSchema.parse(row) : area;
}

export async function requireGeneration(tx: ExecutionTransaction, areaId: string, generation: number) {
  const result = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_execution_areas')} WHERE id=$1 AND generation=$2 AND state='active' FOR UPDATE`,
    [z.uuid().parse(areaId), z.number().int().positive().parse(generation)],
  );
  if (result.rowCount !== 1) throw new ExecutionConflict('stale');
}

/** Persist launch intent before contacting a runner; retrying returns the same logical allocation. */
export async function reserveAllocation(
  tx: ExecutionTransaction,
  area: ExecutionArea,
  runnerId: string,
  deadline: string,
) {
  z.uuid().parse(runnerId);
  z.iso.datetime().parse(deadline);
  await requireGeneration(tx, area.id, area.generation);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_execution_allocations')} (id,area_id,generation,runner_id,state,deadline)
      SELECT $1,$2,$3,$4,'preparing',$5::timestamptz WHERE $5::timestamptz>clock_timestamp()
      ON CONFLICT (area_id,generation) DO NOTHING`,
    [randomUUID(), area.id, area.generation, runnerId, deadline],
  );
  const record = allocationSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT * FROM ${table(tx, 'tf_execution_allocations')} WHERE area_id=$1 AND generation=$2 FOR UPDATE`,
          [area.id, area.generation],
        )
      ).rows[0],
    );
  if (!record || record.runner_id !== runnerId || record.state === 'stopped') throw new ExecutionConflict('stale');
  return record;
}

export async function transitionAllocation(
  tx: ExecutionTransaction,
  allocation: ExecutionAllocationRecord,
  next: ExecutionAllocationRecord['state'],
) {
  const transitions: Record<ExecutionAllocationRecord['state'], readonly ExecutionAllocationRecord['state'][]> = {
    preparing: ['ready', 'stopping', 'recovery-required'],
    ready: ['stopping', 'recovery-required'],
    stopping: ['stopped', 'recovery-required'],
    'recovery-required': ['stopping', 'stopped'],
    stopped: [],
  };
  if (!transitions[allocation.state].includes(next)) throw new ExecutionConflict('request-conflict');
  // Cleanup must remain possible after deletion or consent revocation.
  const area = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_execution_areas')} WHERE id=$1 AND generation=$2
      AND ($3<>'ready' OR state='active') FOR UPDATE`,
    [allocation.area_id, allocation.generation, next],
  );
  if (!area.rowCount) throw new ExecutionConflict('stale');
  const row = (
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_execution_allocations')} SET state=$2 WHERE id=$1 AND state=$3 AND runner_id=$4
      AND ($2<>'ready' OR deadline>clock_timestamp()) RETURNING *`,
      [allocation.id, next, allocation.state, allocation.runner_id],
    )
  ).rows[0];
  if (!row) throw new ExecutionConflict('stale');
  return allocationSchema.parse(row);
}

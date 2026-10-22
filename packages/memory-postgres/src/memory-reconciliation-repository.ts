import type { MemoryReconciliationRepository } from '@tulipfarm/memory-core/ports/memory-reconciliation-repository';
import { memoryTable, type PostgresMemoryNames } from './names.ts';
import type { MemoryQueryClient } from './query-client.ts';

export function createPostgresMemoryReconciliationRepository(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
): MemoryReconciliationRepository {
  const table = (name: string) => memoryTable(names, name);
  return {
    progress: values =>
      client.query(
        `SELECT memory_complete,memory_chunk,memory_step,memory_base_revision,memory_manual_at::text,memory_reconciled_through::text
      FROM ${table('conversation_maintenance')} WHERE id=$1`,
        values,
      ),
    owner: values =>
      client.query(`SELECT owner_membership_id,project_id FROM ${table('conversations')} WHERE id=$1`, values),
    complete: values =>
      client.query(`UPDATE ${table('conversation_maintenance')} SET memory_complete=true WHERE id=$1`, values),
    timestamps: values =>
      client.query(
        `SELECT manual_updated_at::text,reconciled_through::text FROM ${table('personal_memory')}
      WHERE membership_id=$1`,
        values,
      ),
    completeEmpty: values =>
      client.query(
        `UPDATE ${table('conversation_maintenance')} SET memory_complete=true,memory_base_revision=NULL WHERE id=$1`,
        values,
      ),
    saveProgress: values =>
      client.query(
        `UPDATE ${table('conversation_maintenance')} SET memory_chunk=$2,memory_step=$3,memory_base_revision=$4,memory_manual_at=$5,memory_reconciled_through=$6 WHERE id=$1`,
        values,
      ),
    watermark: values =>
      client.query(
        `SELECT reconciled_through::text FROM ${table('personal_memory')}
      WHERE membership_id=$1`,
        values,
      ),
    clearStep: values =>
      client.query(
        `DELETE FROM ${table('conversation_maintenance_steps')} WHERE job_id=$1 AND purpose='memory'`,
        values,
      ),
    restart: values =>
      client.query(
        `UPDATE ${table('conversation_maintenance')} SET memory_step=memory_step+1,memory_base_revision=NULL WHERE id=$1`,
        values,
      ),
    advanceWatermark: values =>
      client.query(
        `UPDATE ${table('personal_memory')} SET reconciled_through=GREATEST(reconciled_through,$2::timestamptz)
      WHERE membership_id=$1`,
        values,
      ),
    finish: values =>
      client.query(
        `UPDATE ${table('conversation_maintenance')} SET memory_chunk=$2,memory_step=$3,memory_base_revision=NULL,memory_complete=$4 WHERE id=$1`,
        values,
      ),
  };
}

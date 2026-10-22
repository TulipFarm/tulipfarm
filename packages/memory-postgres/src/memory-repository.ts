import type { MemoryRepository } from '@tulipfarm/memory-core/ports/memory-repository';
import { memoryTable, type PostgresMemoryNames } from './names.ts';
import type { MemoryQueryClient } from './query-client.ts';

export function createPostgresMemoryRepository(
  client: MemoryQueryClient,
  names: PostgresMemoryNames,
): MemoryRepository {
  const table = (name: string) => memoryTable(names, name);
  return {
    read: values =>
      client.query(`SELECT content,revision FROM ${table('personal_memory')} WHERE membership_id=$1`, values),
    insert: values =>
      client.query(
        `INSERT INTO ${table('personal_memory')} (membership_id,content,revision,manual_updated_at,reconciled_through)
      VALUES ($1,$2,1,CASE WHEN $3 THEN NULL ELSE clock_timestamp() END,$4)
      ON CONFLICT (membership_id) DO NOTHING RETURNING content,revision`,
        values,
      ),
    replace: values =>
      client.query(
        `UPDATE ${table('personal_memory')} SET content=$2,revision=revision+1,
      manual_updated_at=CASE WHEN $4 THEN manual_updated_at ELSE clock_timestamp() END,
      reconciled_through=GREATEST(reconciled_through,$5::timestamptz)
      WHERE membership_id=$1 AND revision=$3 RETURNING content,revision`,
        values,
      ),
    clearPending: values =>
      client.query(
        `DELETE FROM ${table('conversation_maintenance_steps')} s
    USING ${table('conversation_maintenance')} j
    WHERE s.job_id=j.id AND s.purpose='memory' AND j.requester_membership_id=$1`,
        values,
      ),
  };
}

import type { MemoryQueryClient } from './query-client.ts';

/** Publications among `publications` that have coverage gaps. Workspaces on an older common stream have no gaps table. */
export async function readCoverageGaps(client: MemoryQueryClient, gaps: string, values: [publications: string[]]) {
  const installed = await client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [gaps]);
  if (installed.rows[0]?.installed === false) return { rows: [], rowCount: 0 };
  return client.query(`SELECT DISTINCT publication_id FROM ${gaps} WHERE publication_id=ANY($1::uuid[])`, values);
}

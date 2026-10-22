import { Client, type Pool } from 'pg';
import { z } from 'zod';
import { fenceWorkspaceAccess, qualified, workspaceNames } from '@tulipfarm/workspace-storage/runtime';

export function createInvitationExpirySweep(
  registry: Pick<Pool, 'query'>,
  resolve: (workspaceId: string) => Promise<{ connectionString: string }>,
) {
  let after: string | null = null;
  return async () => {
    const rows = z
      .array(z.object({ workspace_id: z.uuid() }))
      .parse(
        (
          await registry.query(
            `SELECT workspace_id FROM app.workspace_storage WHERE stage = 'ready' AND ($1::uuid IS NULL OR workspace_id > $1) ORDER BY workspace_id LIMIT 100`,
            [after],
          )
        ).rows,
      );
    let cleared = 0;
    const failures: unknown[] = [];
    for (const { workspace_id: workspaceId } of rows) {
      const { schema } = workspaceNames(workspaceId);
      let client: Client | undefined;
      try {
        client = new Client({
          connectionString: (await resolve(workspaceId)).connectionString,
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
          options: '-c search_path=pg_catalog',
        });
        await client.connect();
        await client.query('BEGIN');
        await fenceWorkspaceAccess(client, workspaceId);
        {
          const invitations = qualified(schema, 'tf_invitations');
          const result = await client.query(
            `UPDATE ${invitations} SET copy_material = NULL WHERE id IN (SELECT id FROM ${invitations} WHERE expires_at <= clock_timestamp() AND copy_material IS NOT NULL ORDER BY expires_at, id LIMIT 1000) AND expires_at <= clock_timestamp()`,
          );
          cleared += result.rowCount ?? 0;
        }
        await client.query('COMMIT');
      } catch (error) {
        failures.push(error);
      } finally {
        await client?.end();
      }
      after = workspaceId;
    }
    if (rows.length < 100) after = null;
    if (failures.length) throw new AggregateError(failures, 'Invitation expiry sweep incomplete');
    return cleared;
  };
}

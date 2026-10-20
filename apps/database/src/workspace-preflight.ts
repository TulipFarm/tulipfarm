import type { Client } from 'pg';
import { DatabaseError } from './config.ts';

export async function workspaceStoragePreflight(client: Client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query('SET LOCAL row_security = off');
    const registry = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('app.workspaces')::text AS relation",
    );
    if (registry.rows[0]?.relation) {
      const existing = await client.query('SELECT 1 FROM app.workspaces LIMIT 1');
      if (existing.rowCount)
        throw new DatabaseError(
          'Workspace data exists. Stop cutover and prepare a preservation plan. No data was changed.',
        );
    }
    const schemas = await client.query("SELECT 1 FROM pg_namespace WHERE nspname ~ '^ws_' LIMIT 1");
    if (schemas.rowCount)
      throw new DatabaseError(
        'Workspace schemas already exist. Use reconciliation instead of fresh cutover. No data was changed.',
      );
    await client.query('COMMIT');
    return { status: 'fresh-workspace-installation', identityPreserved: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

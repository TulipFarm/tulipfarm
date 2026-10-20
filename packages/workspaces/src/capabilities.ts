import type { Pool } from 'pg';
import { z } from 'zod';
import { workspaceNames } from '@tulipfarm/workspace-storage/runtime';
import { credentialKeyring, decryptCredential } from './credentials.ts';

function resolver(pool: Pool, capability: 'migration' | 'confirmation') {
  const key = credentialKeyring(capability);
  const rowSchema = z.object({ generation: z.number().int().positive(), credential: z.unknown() });
  const column = capability === 'migration' ? 'migration_credential' : 'confirmation_credential';
  return async (workspaceId: string) => {
    const names = workspaceNames(workspaceId);
    const result = await pool.query(
      `SELECT generation, ${column} AS credential FROM app.workspace_storage
      WHERE workspace_id = $1 AND stage = 'ready'`,
      [names.workspaceId],
    );
    const row = rowSchema.parse(result.rows[0]);
    const connectionString = decryptCredential(
      row.credential,
      { workspaceId: names.workspaceId, generation: row.generation, capability },
      key,
    );
    if (decodeURIComponent(new URL(connectionString).username) !== names[capability])
      throw new Error('Workspace capability login mismatch');
    return { connectionString, generation: row.generation };
  };
}

export function createMigrationCredentialResolver(pool: Pool) {
  return resolver(pool, 'migration');
}

export function createConfirmationCredentialResolver(pool: Pool) {
  return resolver(pool, 'confirmation');
}

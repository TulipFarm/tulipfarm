import type { Pool } from 'pg';
import { z } from 'zod';
import {
  createWorkspaceRuntime,
  runtimeCredentialSchema,
  StorageUnavailableError,
} from '@tulipfarm/workspace-storage/runtime';
import { credentialKeyring, decryptCredential } from './credentials.ts';

export { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export const workspaceStorageCapability = 'isolated-v1';
export type WorkspaceRuntime = ReturnType<typeof createWorkspaceRuntime>;
export type WorkspaceStore = { pool: Pool; runtime: Pick<WorkspaceRuntime, 'transaction'> };

export function isolatedStorageEnabled() {
  const capability = process.env.WORKSPACE_STORAGE_CAPABILITY;
  if (capability && capability !== 'disabled' && capability !== workspaceStorageCapability)
    throw new Error('Unsupported workspace storage capability');
  return capability === workspaceStorageCapability;
}

export function workspaceRuntime(pool: Pool) {
  const key = credentialKeyring('runtime');
  const rowSchema = z.object({ generation: z.number().int(), runtime_credential: z.unknown() });
  return createWorkspaceRuntime({
    maxPools: optionalNumber('WORKSPACE_STORAGE_MAX_POOLS'),
    connectionsPerPool: optionalNumber('WORKSPACE_STORAGE_CONNECTIONS_PER_POOL'),
    maxConcurrentTransactions: optionalNumber('WORKSPACE_STORAGE_MAX_TRANSACTIONS'),
    maxBackgroundTransactions: optionalNumber('WORKSPACE_STORAGE_MAX_BACKGROUND_TRANSACTIONS'),
    idleTimeoutMs: optionalNumber('WORKSPACE_STORAGE_IDLE_TIMEOUT_MS'),
    replicaCount: Number(process.env.WORKSPACE_RUNTIME_REPLICAS ?? 4),
    reservedConnections: 40,
    databaseConnectionBudget: Number(process.env.WORKSPACE_DATABASE_CONNECTION_BUDGET ?? 120),
    async resolveCredential(workspaceId) {
      const result = await pool.query(
        `SELECT generation, runtime_credential, stage FROM app.workspace_storage
        WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (result.rows[0]?.stage !== 'ready') throw new StorageUnavailableError('disabled');
      const row = rowSchema.parse(result.rows[0]);
      return runtimeCredentialSchema.parse({
        workspaceId,
        generation: row.generation,
        connectionString: decryptCredential(
          row.runtime_credential,
          { workspaceId, generation: row.generation, capability: 'runtime' },
          key,
        ),
      });
    },
  });
}

function optionalNumber(name: string) {
  const value = process.env[name];
  return value ? Number(value) : undefined;
}

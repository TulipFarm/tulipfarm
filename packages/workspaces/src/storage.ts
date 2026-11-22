import type { Pool } from 'pg';
import { z } from 'zod';
import { databaseConnectionFleet, fleetConnections } from '@tulipfarm/config/database-connections';
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
  // Each transaction rereads the row, so a disabled workspace or a new generation still applies at once; only the
  // decryption of an unchanged envelope is reused. Connection pools already hold these connection strings.
  const decrypted = new Map<string, { generation: number; envelope: string; connectionString: string }>();
  const databaseConnectionBudget = Number(process.env.WORKSPACE_DATABASE_CONNECTION_BUDGET ?? 120);
  const fleet = databaseConnectionFleet();
  const needed = fleet && fleetConnections(fleet);
  if (needed && needed > databaseConnectionBudget)
    throw new Error(
      `The deployment's ${needed} database connections exceed its connection budget of ${databaseConnectionBudget}`,
    );
  return createWorkspaceRuntime({
    maxPools: optionalNumber('WORKSPACE_STORAGE_MAX_POOLS'),
    connectionsPerPool: optionalNumber('WORKSPACE_STORAGE_CONNECTIONS_PER_POOL'),
    maxConcurrentTransactions: optionalNumber('WORKSPACE_STORAGE_MAX_TRANSACTIONS'),
    maxBackgroundTransactions: optionalNumber('WORKSPACE_STORAGE_MAX_BACKGROUND_TRANSACTIONS'),
    reservedBackgroundTransactions: optionalNumber('WORKSPACE_STORAGE_RESERVED_BACKGROUND_TRANSACTIONS'),
    maxQueue: optionalNumber('WORKSPACE_STORAGE_MAX_QUEUE'),
    idleTimeoutMs: optionalNumber('WORKSPACE_STORAGE_IDLE_TIMEOUT_MS'),
    // A declared fleet was checked above; without one, assume every replica holds this process's pools plus 40.
    ...(fleet
      ? { replicaCount: 1, reservedConnections: 0 }
      : { replicaCount: Number(process.env.WORKSPACE_RUNTIME_REPLICAS ?? 4), reservedConnections: 40 }),
    databaseConnectionBudget,
    async resolveCredential(workspaceId) {
      const result = await pool.query(
        `SELECT generation, runtime_credential, stage FROM app.workspace_storage
        WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (result.rows[0]?.stage !== 'ready') throw new StorageUnavailableError('disabled');
      const row = rowSchema.parse(result.rows[0]);
      const envelope = JSON.stringify(row.runtime_credential);
      let credential = decrypted.get(workspaceId);
      if (credential?.generation !== row.generation || credential.envelope !== envelope) {
        credential = {
          generation: row.generation,
          envelope,
          connectionString: decryptCredential(
            row.runtime_credential,
            { workspaceId, generation: row.generation, capability: 'runtime' },
            key,
          ),
        };
        decrypted.delete(workspaceId);
        decrypted.set(workspaceId, credential);
        if (decrypted.size > 1000) decrypted.delete(decrypted.keys().next().value!);
      }
      return runtimeCredentialSchema.parse({
        workspaceId,
        generation: row.generation,
        connectionString: credential.connectionString,
      });
    },
  });
}

function optionalNumber(name: string) {
  const value = process.env[name];
  return value ? Number(value) : undefined;
}

import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { emitHook } from '@tulipfarm/extensions';
import {
  assertPublishedTarget,
  inTransaction,
  provisionWorkspace,
  type Migration,
} from '@tulipfarm/workspace-storage/provisioning';
import {
  afterCommit,
  commonTables,
  createWorkspaceRuntime,
  qualified,
  runtimeCredentialSchema,
  workspaceNames,
} from '@tulipfarm/workspace-storage/runtime';
import { credentialKeyring, decryptCredential, encryptCredential } from './credentials.ts';
import { initializeSoul, soulStorageConfig } from './soul.ts';
import { workspaceSeed } from './store.ts';
import { commonCompatibility, isolatedStorageEnabled } from './storage.ts';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';

const storageRowSchema = z.object({
  initial_membership_id: z.uuid(),
  generation: z.number().int().positive(),
  stage: z.enum(['reserved', 'database', 'ready', 'unavailable']),
  runtime_credential: z.unknown(),
  migration_credential: z.unknown(),
  confirmation_credential: z.unknown(),
});

export function createWorkspaceMaintenance(options: { migrations: readonly Migration[] }) {
  if (!isolatedStorageEnabled()) throw new Error('Storage maintenance requires isolated-v1');
  const connectionString = z.url().parse(process.env.WORKSPACE_PROVISIONING_DATABASE_URL);
  const endpoint = new URL(z.url().parse(process.env.WORKSPACE_DATABASE_ENDPOINT));
  if (endpoint.username || endpoint.password)
    throw new Error('Workspace database endpoint must not include credentials');
  const keys = {
    runtime: credentialKeyring('runtime'),
    migration: credentialKeyring('migration'),
    confirmation: credentialKeyring('confirmation'),
  };
  if (new Set(Object.values(keys).map(key => key.key.toString('hex'))).size !== 3)
    throw new Error('Workspace capability keys must be independent');
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    options: '-c search_path=pg_catalog',
  });
  pool.on('error', () => undefined);
  const storage = soulStorageConfig();

  async function initializeWorkspaceStorage(workspaceIdInput: string) {
    const names = workspaceNames(workspaceIdInput);
    const workspaceId = names.workspaceId;
    const client = await pool.connect();
    let locked = false;
    try {
      const lock = z
        .object({ locked: z.boolean() })
        .parse(
          (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 739)) AS locked', [workspaceId]))
            .rows[0],
        );
      if (!lock.locked) throw new Error('Workspace setup already running');
      locked = true;
      let row = storageRowSchema.parse(
        (await client.query('SELECT * FROM app.workspace_storage WHERE workspace_id = $1', [workspaceId])).rows[0],
      );
      if (row.stage === 'unavailable') throw new Error('Workspace is permanently disabled');
      if (row.stage === 'ready') return;
      const seed = await workspaceSeed(pool, workspaceId);
      if (row.runtime_credential === null) {
        const envelopes = [];
        for (const capability of ['runtime', 'migration', 'confirmation'] as const) {
          const url = new URL(endpoint);
          url.username = names[capability];
          url.password = randomBytes(32).toString('base64url');
          envelopes.push(
            encryptCredential(url.href, { workspaceId, generation: row.generation, capability }, keys[capability]),
          );
        }
        row = storageRowSchema.parse(
          (
            await client.query(
              `UPDATE app.workspace_storage
          SET runtime_credential = $2, migration_credential = $3, confirmation_credential = $4, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND runtime_credential IS NULL RETURNING *`,
              [workspaceId, ...envelopes],
            )
          ).rows[0],
        );
      }
      const credentials = {
        runtime: decryptCredential(
          row.runtime_credential,
          { workspaceId, generation: row.generation, capability: 'runtime' },
          keys.runtime,
        ),
        migration: decryptCredential(
          row.migration_credential,
          { workspaceId, generation: row.generation, capability: 'migration' },
          keys.migration,
        ),
        confirmation: decryptCredential(
          row.confirmation_credential,
          { workspaceId, generation: row.generation, capability: 'confirmation' },
          keys.confirmation,
        ),
      };
      await provisionWorkspace({
        connectionString,
        workspaceId,
        migrations: options.migrations,
        initialAdmin: { userId: seed.createdBy, membershipId: row.initial_membership_id },
        passwords: {
          runtime: decodeURIComponent(new URL(credentials.runtime).password),
          migration: decodeURIComponent(new URL(credentials.migration).password),
          confirmation: decodeURIComponent(new URL(credentials.confirmation).password),
        },
      });
      await client.query(
        `UPDATE app.workspace_storage SET stage = 'database', error_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = $1 AND stage = 'reserved'`,
        [workspaceId],
      );
      const soul = await initializeSoul(storage, seed);
      const runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 4,
        maxPools: 1,
        connectionsPerPool: 1,
        resolveCredential: async () =>
          runtimeCredentialSchema.parse({
            workspaceId,
            generation: row.generation,
            connectionString: credentials.runtime,
          }),
      });
      try {
        await runtime.transaction(workspaceId, commonCompatibility, async ({ client: workspaceClient, schema }) => {
          const lock = await workspaceClient.query(
            `SELECT id FROM ${qualified(schema, commonTables.authorizationLock)} WHERE id = 1 FOR UPDATE`,
          );
          if (lock.rowCount !== 1) throw new Error('Workspace authorization lock is missing');
          await workspaceClient.query(
            `UPDATE ${qualified(schema, commonTables.soulHead)} SET revision = $1 WHERE id = 1 AND revision IS NULL`,
            [soul.commit],
          );
          const head = await workspaceClient.query(
            `SELECT revision FROM ${qualified(schema, commonTables.soulHead)} WHERE id = 1`,
          );
          if (head.rows[0]?.revision !== soul.commit) throw new Error('Workspace initial Soul head mismatch');
          await recordRecommendationChange(
            { client: workspaceClient, schema },
            {
              id: row.initial_membership_id,
              kind: 'seed',
              sourceId: workspaceId,
              membershipIds: [row.initial_membership_id],
            },
          );
        });
        await runtime.transaction(workspaceId, commonCompatibility, async ({ client: workspaceClient, schema }) => {
          await workspaceClient.query(
            `SELECT id FROM ${qualified(schema, commonTables.authorizationLock)} WHERE id = 1 FOR SHARE`,
          );
          const member = await workspaceClient.query(
            `SELECT id FROM ${qualified(schema, commonTables.memberships)}
            WHERE id = $1 AND user_id = $2 AND role = 'admin' AND removed_at IS NULL`,
            [row.initial_membership_id, seed.createdBy],
          );
          if (member.rowCount !== 1) throw new Error('Initial workspace admission is no longer active');
          await inTransaction(client, async transaction => {
            await assertPublishedTarget(transaction, workspaceId);
            const ready = await transaction.query(
              `UPDATE app.workspaces SET soul_commit = $2, soul_bucket = $3, soul_key = $4, ready_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND ready_at IS NULL RETURNING name`,
              [workspaceId, soul.commit, soul.bucket, soul.key],
            );
            const workspaceName = (ready.rows[0] as { name: string } | undefined)?.name;
            if (workspaceName !== undefined)
              afterCommit(
                transaction,
                () => void emitHook('workspace.created', { workspaceId, workspaceName, userId: seed.createdBy }),
              );
            await transaction.query(
              `UPDATE app.workspace_storage SET stage = 'ready', error_code = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE workspace_id = $1 AND generation = $2`,
              [workspaceId, row.generation],
            );
          });
        });
      } finally {
        await runtime.close();
      }
    } catch {
      if (locked)
        await client
          .query(
            `UPDATE app.workspace_storage SET error_code = 'setup_failed', updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = $1 AND stage IN ('reserved', 'database')`,
            [workspaceId],
          )
          .catch(() => undefined);
      throw new Error('Workspace setup failed; retry the same setup');
    } finally {
      if (locked)
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 739))', [workspaceId])
          .catch(() => undefined);
      client.release(true);
    }
  }

  return {
    initializeWorkspaceStorage,
    async close() {
      storage.client.destroy();
      await pool.end();
    },
  };
}

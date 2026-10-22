import { randomBytes } from 'node:crypto';
import { escapeIdentifier, escapeLiteral, type Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { workspaceNames } from '@tulipfarm/workspace-storage/runtime';
import { credentialKeyring, decryptCredential, encryptCredential } from './credentials.ts';

const inputSchema = z.object({
  workspaceId: z.uuid(),
  operationId: z.uuid(),
  expectedGeneration: z.number().int().positive(),
  kind: z.enum(['rotate-passwords', 'rotate-keys']),
});
const rowSchema = z.object({
  generation: z.number().int().positive(),
  stage: z.enum(['reserved', 'database', 'ready', 'unavailable']),
  runtime_credential: z.unknown(),
  migration_credential: z.unknown(),
  confirmation_credential: z.unknown(),
});
const receiptSchema = z.object({
  kind: z.enum(['rotate-passwords', 'rotate-keys', 'disable']),
  expected_generation: z.number().int(),
  generation: z.number().int(),
  key_ids: z.record(z.string(), z.string()),
});
export class WorkspaceOperatorConflict extends Error {}

async function locked<T>(pool: Pool, workspaceId: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SET LOCAL search_path = pg_catalog; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'",
    );
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 739))', [workspaceId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release(true);
  }
}

export async function rotateWorkspaceCredentials(pool: Pool, input: z.infer<typeof inputSchema>) {
  const command = inputSchema.parse(input);
  const names = workspaceNames(command.workspaceId);
  const keys = {
    runtime: credentialKeyring('runtime'),
    migration: credentialKeyring('migration'),
    confirmation: credentialKeyring('confirmation'),
  };
  if (new Set(Object.values(keys).map(key => key.key.toString('hex'))).size !== 3)
    throw new Error('Workspace capability keys must be independent');
  const keyIds = Object.fromEntries(Object.entries(keys).map(([capability, key]) => [capability, key.keyId]));
  return locked(pool, names.workspaceId, async client => {
    const row = rowSchema.parse(
      (
        await client.query('SELECT * FROM app.workspace_storage WHERE workspace_id = $1 FOR UPDATE', [
          names.workspaceId,
        ])
      ).rows[0],
    );
    if (row.stage === 'unavailable') throw new WorkspaceOperatorConflict('Workspace is permanently disabled');
    const previous = (
      await client.query(
        'SELECT * FROM app.workspace_storage_operations WHERE workspace_id = $1 AND operation_id = $2',
        [names.workspaceId, command.operationId],
      )
    ).rows[0];
    if (previous) {
      const receipt = receiptSchema.parse(previous);
      if (
        receipt.kind !== command.kind ||
        receipt.expected_generation !== command.expectedGeneration ||
        Object.entries(keyIds).some(([capability, id]) => receipt.key_ids[capability] !== id)
      )
        throw new WorkspaceOperatorConflict('Operation ID was already used with different inputs');
      return { workspaceId: names.workspaceId, operationId: command.operationId, generation: receipt.generation };
    }
    if (row.stage !== 'ready' || row.generation !== command.expectedGeneration)
      throw new WorkspaceOperatorConflict('Workspace is not ready at the expected credential generation');
    const generation = row.generation + 1;
    const envelopes = [];
    for (const capability of ['runtime', 'migration', 'confirmation'] as const) {
      const stored = row[`${capability}_credential`];
      const url = new URL(
        decryptCredential(
          stored,
          { workspaceId: names.workspaceId, generation: row.generation, capability },
          keys[capability],
        ),
      );
      if (
        decodeURIComponent(url.username) !== names[capability] ||
        url.searchParams.has('user') ||
        url.searchParams.has('options')
      )
        throw new Error('Workspace credential identity mismatch');
      if (command.kind === 'rotate-passwords') {
        const password = randomBytes(32).toString('base64url');
        await client.query(`ALTER ROLE ${escapeIdentifier(names[capability])} PASSWORD ${escapeLiteral(password)}`);
        url.password = password;
      }
      envelopes.push(
        encryptCredential(url.href, { workspaceId: names.workspaceId, generation, capability }, keys[capability]),
      );
    }
    await client.query(
      `UPDATE app.workspace_storage SET generation = $2, runtime_credential = $3,
      migration_credential = $4, confirmation_credential = $5, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = $1`,
      [names.workspaceId, generation, ...envelopes],
    );
    await client.query(
      `INSERT INTO app.workspace_storage_operations
      (workspace_id, operation_id, kind, operator, expected_generation, generation, key_ids)
      VALUES ($1, $2, $3, session_user, $4, $5, $6)`,
      [names.workspaceId, command.operationId, command.kind, command.expectedGeneration, generation, keyIds],
    );
    return { workspaceId: names.workspaceId, operationId: command.operationId, generation };
  });
}

export async function disableWorkspace(pool: Pool, workspaceIdInput: string, operationIdInput: string) {
  const workspaceId = workspaceNames(workspaceIdInput).workspaceId;
  const operationId = z.uuid().parse(operationIdInput);
  return locked(pool, workspaceId, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 740))', [workspaceId]);
    const row = rowSchema.parse(
      (await client.query('SELECT * FROM app.workspace_storage WHERE workspace_id = $1 FOR UPDATE', [workspaceId]))
        .rows[0],
    );
    if (row.stage === 'unavailable') return { workspaceId, stage: 'unavailable' as const };
    const existing = await client.query(
      'SELECT 1 FROM app.workspace_storage_operations WHERE workspace_id = $1 AND operation_id = $2',
      [workspaceId, operationId],
    );
    if (existing.rowCount) throw new WorkspaceOperatorConflict('Operation ID was already used');
    await client.query(
      `UPDATE app.workspace_storage SET stage = 'unavailable', disabled_at = CURRENT_TIMESTAMP,
      disabled_operation_id = $2, error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = $1`,
      [workspaceId, operationId],
    );
    await client.query(
      `INSERT INTO app.workspace_storage_operations
      (workspace_id, operation_id, kind, operator, expected_generation, generation, key_ids)
      VALUES ($1, $2, 'disable', session_user, $3, $3, '{}')`,
      [workspaceId, operationId, row.generation],
    );
    return { workspaceId, stage: 'unavailable' as const };
  });
}

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { Client, escapeIdentifier } from 'pg';
import { z } from 'zod';
import { creditGate } from '@tulipfarm/extensions';
import { qualified, workspaceNames } from './names.ts';
import { inTransaction, type SqlClient } from './transactions.ts';

export const commonMigrationDirectory = fileURLToPath(new URL('../common/', import.meta.url));
export const migrationSchema = z.object({
  name: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/),
  sql: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Migration = z.infer<typeof migrationSchema>;
const receiptSchema = z.object({ name: z.string(), checksum: z.string() });

export class MigrationDriftError extends Error {
  constructor() {
    super('Applied migration history differs from the supplied stream');
    this.name = 'MigrationDriftError';
  }
}
export class StaleRolloutTargetError extends Error {
  constructor() {
    super('The supplied common stream is not the current rollout target');
    this.name = 'StaleRolloutTargetError';
  }
}
export class PendingTableWorkError extends Error {
  constructor() {
    super('Common upgrade refused because unfinished table work must drain first');
    this.name = 'PendingTableWorkError';
  }
}

export async function readMigrations(directory: string = commonMigrationDirectory): Promise<Migration[]> {
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const migrations = await Promise.all(
    files.map(async name => {
      const sql = await readFile(join(directory, name), 'utf8');
      return migrationSchema.parse({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
    }),
  );
  validateMigrations(migrations);
  return migrations;
}

export function validateMigrations(input: readonly Migration[]) {
  let previous = '';
  for (const item of input) {
    const migration = migrationSchema.parse(item);
    if (
      migration.name.slice(0, 4) <= previous ||
      createHash('sha256').update(migration.sql).digest('hex') !== migration.checksum
    )
      throw new MigrationDriftError();
    previous = migration.name.slice(0, 4);
  }
}

export function migrationTarget(migrations: readonly Migration[]) {
  validateMigrations(migrations);
  return createHash('sha256')
    .update(JSON.stringify(migrations.map(({ name, checksum }) => [name, checksum])))
    .digest('hex');
}

export async function lockWorkspaceMigration(client: SqlClient, workspaceId: string) {
  const names = workspaceNames(workspaceId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 734129))', [names.workspaceId]);
}

export async function applyMigrationStream(
  client: SqlClient,
  options: {
    migrations: readonly Migration[];
    ledger: string;
    render: (sql: string) => string;
    afterMigration?: ((migration: Migration) => Promise<void>) | undefined;
    beforeUpgrade?: (() => Promise<void>) | undefined;
  },
) {
  validateMigrations(options.migrations);
  const installed = z
    .array(receiptSchema)
    .parse((await client.query(`SELECT name, checksum FROM ${options.ledger} ORDER BY name`)).rows);
  for (const [index, receipt] of installed.entries()) {
    const migration = options.migrations[index];
    if (!migration || migration.name !== receipt.name || migration.checksum !== receipt.checksum)
      throw new MigrationDriftError();
  }
  if (installed.length > 0 && installed.length < options.migrations.length) await options.beforeUpgrade?.();
  for (const migration of options.migrations.slice(installed.length)) {
    await client.query(options.render(migration.sql));
    await options.afterMigration?.(migration);
    await client.query(`INSERT INTO ${options.ledger} (name, checksum) VALUES ($1, $2)`, [
      migration.name,
      migration.checksum,
    ]);
  }
  return options.migrations.length;
}

export async function applyCommonMigrations(
  client: SqlClient,
  workspaceId: string,
  migrations: readonly Migration[],
  afterMigration?: (migration: Migration) => Promise<void>,
) {
  const names = workspaceNames(workspaceId);
  await lockWorkspaceMigration(client, workspaceId);
  const authorizationLock = qualified(names.schema, 'tf_authorization_lock');
  const authorized = Boolean(
    (await client.query('SELECT to_regclass($1) AS relation', [authorizationLock])).rows[0]?.relation,
  );
  // Joins lockAuthorization's arrival-order queue before any table lock. A bare FOR UPDATE starves behind
  // overlapping shared holders, and queueing after the ledger lock could deadlock with a reader of the ledger.
  if (authorized) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 518204))', [names.schema]);
  const ledger = qualified(names.schema, 'tf_common_migrations');
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${ledger} (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  await client.query(`LOCK TABLE ${ledger} IN ACCESS EXCLUSIVE MODE`);
  if (authorized) await client.query(`SELECT id FROM ${authorizationLock} WHERE id = 1 FOR UPDATE`);
  return applyMigrationStream(client, {
    migrations,
    ledger,
    afterMigration,
    beforeUpgrade: async () => {
      const pending =
        await client.query(`SELECT 1 FROM ${qualified(names.schema, 'tf_authoring_commands')} WHERE status = 'preparing'
      UNION ALL SELECT 1 FROM ${qualified(names.schema, 'tf_migration_jobs')} WHERE status NOT IN ('applied', 'rejected', 'superseded') LIMIT 1`);
      if (pending.rowCount) throw new PendingTableWorkError();
      const executions = qualified(names.schema, 'tf_table_executions');
      if (
        (await client.query('SELECT to_regclass($1) AS relation', [executions])).rows[0]?.relation &&
        (
          await client.query(
            `SELECT 1 FROM ${executions} WHERE phase IN ('publishing','copying','reconciling') LIMIT 1`,
          )
        ).rowCount
      ) {
        throw new PendingTableWorkError();
      }
    },
    render: sql => {
      for (const [key, name] of Object.entries(names)) sql = sql.replaceAll(`{{${key}}}`, escapeIdentifier(name));
      return sql;
    },
  });
}

export async function initializeRolloutTables(client: SqlClient) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS database_management;
    REVOKE ALL ON SCHEMA database_management FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS database_management.common_target (
      id integer PRIMARY KEY CHECK (id = 1), target text NOT NULL, stream jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS database_management.common_rollouts (
      target text NOT NULL, workspace_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'blocked')),
      error_code text, attempts integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (target, workspace_id)
    )`);
}

export async function lockRolloutTarget(client: SqlClient, migrations: readonly Migration[], publish = false) {
  const target = migrationTarget(migrations);
  await client.query('SELECT pg_advisory_xact_lock(734129, 0)');
  await initializeRolloutTables(client);
  const rows = (await client.query('SELECT target, stream FROM database_management.common_target WHERE id = 1')).rows;
  if (rows.length) {
    const current = z.object({ target: z.string(), stream: z.array(receiptSchema) }).parse(rows[0]);
    if (current.target !== target) {
      if (!publish) throw new StaleRolloutTargetError();
      for (const [index, prior] of current.stream.entries()) {
        const next = migrations[index];
        if (!next || next.name !== prior.name || next.checksum !== prior.checksum) throw new MigrationDriftError();
      }
    }
  }
  await client.query(
    'INSERT INTO database_management.common_target (id, target, stream) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET target = EXCLUDED.target, stream = EXCLUDED.stream',
    [target, JSON.stringify(migrations.map(({ name, checksum }) => ({ name, checksum })))],
  );
  return target;
}

export async function assertPublishedTarget(client: SqlClient, workspaceId: string) {
  const names = workspaceNames(workspaceId);
  await client.query('SELECT pg_advisory_xact_lock_shared(734129, 0)');
  const published = z
    .object({ stream: z.array(receiptSchema) })
    .parse((await client.query('SELECT stream FROM database_management.common_target WHERE id = 1')).rows[0]).stream;
  const installed = z
    .array(receiptSchema)
    .parse(
      (
        await client.query(
          `SELECT name, checksum FROM ${qualified(names.schema, 'tf_common_migrations')} ORDER BY name`,
        )
      ).rows,
    );
  if (!isDeepStrictEqual(installed, published)) throw new StaleRolloutTargetError();
}

export async function connectMaintenance(connectionString: string) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    options: '-c search_path=pg_catalog',
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}

export type RolloutResult = { workspaceId: string; status: 'applied' | 'failed' | 'blocked'; errorCode: string | null };

const rolloutLockAttempts = 3;
// A busy workspace's authorization holders finish within their own 30s statement and idle limits, so a rollout
// waiting this long in the arrival-order queue always gets its turn.
const rolloutTransactionSettings = { lockTimeoutMs: 60_000, statementTimeoutMs: 120_000 };

/** Whether the workspace ledger already matches `migrations`, read without taking any rollout locks. */
async function commonMigrationsCurrent(client: SqlClient, workspaceId: string, migrations: readonly Migration[]) {
  const ledger = qualified(workspaceNames(workspaceId).schema, 'tf_common_migrations');
  if (!(await client.query('SELECT to_regclass($1) AS relation', [ledger])).rows[0]?.relation) return false;
  const installed = z
    .array(receiptSchema)
    .parse((await client.query(`SELECT name, checksum FROM ${ledger} ORDER BY name`)).rows);
  return (
    installed.length === migrations.length &&
    installed.every(
      (receipt, index) => receipt.name === migrations[index]?.name && receipt.checksum === migrations[index]?.checksum,
    )
  );
}

/** Retries a workspace's rollout when a busy workspace keeps it waiting past the lock timeout or deadlocks it. */
async function retryLockWaits(apply: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await apply();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (attempt >= rolloutLockAttempts || (code !== '55P03' && code !== '40P01')) throw error;
      await delay(1_000 * attempt);
    }
  }
}

export async function rolloutCommonMigrations(options: {
  connectionString: string;
  migrations: readonly Migration[];
  listWorkspaceIds: () => Promise<string[]>;
  concurrency?: number;
  afterWorkspace?: (result: RolloutResult) => Promise<void>;
}) {
  const concurrency = z
    .number()
    .int()
    .min(1)
    .max(16)
    .parse(options.concurrency ?? 4);
  const controller = await connectMaintenance(options.connectionString);
  const results = new Map<string, RolloutResult>();
  try {
    const target = await inTransaction(controller, client => lockRolloutTarget(client, options.migrations, true));
    for (;;) {
      const candidates = [
        ...new Set((await options.listWorkspaceIds()).map(id => workspaceNames(id).workspaceId)),
      ].filter(id => !results.has(id));
      if (!candidates.length) break;
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
          const client = await connectMaintenance(options.connectionString);
          try {
            for (;;) {
              const workspaceId = candidates.shift();
              if (!workspaceId) break;
              await client.query(
                "INSERT INTO database_management.common_rollouts (target, workspace_id, status) VALUES ($1, $2, 'pending') ON CONFLICT (target, workspace_id) DO UPDATE SET status = 'pending', error_code = NULL",
                [target, workspaceId],
              );
              let result: RolloutResult;
              const applied = (transaction: SqlClient) =>
                transaction.query(
                  "UPDATE database_management.common_rollouts SET status = 'applied', error_code = NULL, attempts = attempts + 1, updated_at = now() WHERE target = $1 AND workspace_id = $2",
                  [target, workspaceId],
                );
              try {
                const gate = creditGate();
                const current = await commonMigrationsCurrent(client, workspaceId, options.migrations);
                if (current && !gate.provision) await applied(client);
                else
                  await retryLockWaits(() =>
                    inTransaction(
                      client,
                      async transaction => {
                        if (current) await lockWorkspaceMigration(transaction, workspaceId);
                        else await applyCommonMigrations(transaction, workspaceId, options.migrations);
                        // Workspaces provisioned before the gate was registered, or by an older gate, get its state.
                        await gate.provision?.({ client: transaction, schema: workspaceNames(workspaceId).schema });
                        await applied(transaction);
                      },
                      rolloutTransactionSettings,
                    ),
                  );
                result = { workspaceId, status: 'applied', errorCode: null };
              } catch (error) {
                const status =
                  error instanceof MigrationDriftError || error instanceof PendingTableWorkError ? 'blocked' : 'failed';
                const parsed = z.object({ code: z.string().regex(/^[A-Z0-9]{5}$/) }).safeParse(error);
                const errorCode =
                  error instanceof MigrationDriftError
                    ? 'history_drift'
                    : error instanceof PendingTableWorkError
                      ? 'pending_table_work'
                      : parsed.success
                        ? parsed.data.code
                        : 'migration_failed';
                await client.query(
                  'UPDATE database_management.common_rollouts SET status = $3, error_code = $4, attempts = attempts + 1, updated_at = now() WHERE target = $1 AND workspace_id = $2',
                  [target, workspaceId, status, errorCode],
                );
                result = { workspaceId, status, errorCode };
              }
              results.set(workspaceId, result);
              await options.afterWorkspace?.(result);
            }
          } finally {
            await client.end();
          }
        }),
      );
      const failures = workers.flatMap(worker => (worker.status === 'rejected' ? [worker.reason] : []));
      if (failures.length)
        throw new AggregateError(failures, 'Common migration rollout failed after draining all workers');
    }
    return { target, results: [...results.values()] };
  } finally {
    await controller.end();
  }
}

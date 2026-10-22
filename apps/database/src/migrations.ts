import { escapeIdentifier, type Client } from 'pg';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { extensionMigrations, loadConfiguredExtensions, type ExtensionMigrations } from '@tulipfarm/extensions';
import { inTransaction, MigrationDriftError, type Migration } from '@tulipfarm/workspace-storage/provisioning';
import { DatabaseError } from './config.ts';
import { grantApplicationAccess, storageCapability } from './postgres.ts';

const filename = z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/);
const receiptSchema = z.object({ name: z.string(), checksum: z.string() });

export async function readMigrations(directory: string): Promise<Migration[]> {
  try {
    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    const migrations = await Promise.all(
      files.map(async name => {
        filename.parse(name);
        const sql = await readFile(join(directory, name), 'utf8');
        return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
      }),
    );
    for (const [index, migration] of migrations.entries()) {
      if (index > 0 && migration.name.slice(0, 4) === migrations[index - 1]?.name.slice(0, 4))
        throw new MigrationDriftError();
    }
    return migrations;
  } catch (error) {
    if (error instanceof MigrationDriftError) throw new DatabaseError('Duplicate migration numbers.', { cause: error });
    if (error instanceof Error && error.name === 'ZodError')
      throw new DatabaseError('Invalid migration filename.', { cause: error });
    throw error;
  }
}

/** Loads the TULIPFARM_EXTENSIONS modules for the database app so migrate() applies their migrations too. */
export function loadDatabaseExtensions() {
  return loadConfiguredExtensions('database', { resolve: specifier => import.meta.resolve(specifier) });
}

type ExtensionMigrationSet = ExtensionMigrations & { readonly extension?: string };

async function ensureLedger(client: Client, ledger: string) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${ledger} (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

/** Returns migrations not yet in the ledger, or throws MigrationDriftError if recorded history differs. */
async function pendingMigrations(client: Client, ledger: string, migrations: readonly Migration[]) {
  const receipts = z
    .array(receiptSchema)
    .parse((await client.query(`SELECT name, checksum FROM ${ledger} ORDER BY name`)).rows);
  const source = new Map(migrations.map(migration => [migration.name, migration.checksum]));
  for (const receipt of receipts) {
    if (source.get(receipt.name) !== receipt.checksum) throw new MigrationDriftError();
  }
  const installed = new Set(receipts.map(receipt => receipt.name));
  let missingNumber: string | undefined;
  for (const migration of migrations) {
    const number = migration.name.slice(0, 4);
    if (!installed.has(migration.name)) missingNumber ??= number;
    else if (missingNumber !== undefined && missingNumber !== number) throw new MigrationDriftError();
  }
  return migrations.filter(item => !installed.has(item.name));
}

/**
 * Applies each extension's migrations after TulipFarm's, in registration order. Every set runs in its
 * own schema with its own ledger, `<schema>.schema_migrations`; TulipFarm's ledger never records them.
 */
async function migrateExtensions(client: Client, sets: readonly ExtensionMigrationSet[]) {
  for (const set of sets) {
    const schema = escapeIdentifier(set.schema),
      ledger = `${schema}.schema_migrations`;
    const migrations = set.migrations.map(({ name, sql }) => ({
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    }));
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await ensureLedger(client, ledger);
    let pending: Migration[];
    try {
      pending = await pendingMigrations(client, ledger, migrations);
    } catch (error) {
      if (error instanceof MigrationDriftError)
        throw new DatabaseError(
          `Applied migration in extension schema "${set.schema}" was removed, reordered, or modified.`,
          { cause: error },
        );
      throw error;
    }
    for (const migration of pending) {
      await inTransaction(
        client,
        async transaction => {
          await transaction.query(`SET LOCAL search_path TO ${schema}, app, public`);
          await transaction.query(migration.sql);
          await transaction.query(`INSERT INTO ${ledger} (name, checksum) VALUES ($1, $2)`, [
            migration.name,
            migration.checksum,
          ]);
        },
        { statementTimeoutMs: 60_000, lockTimeoutMs: 60_000 },
      );
      process.stdout.write(`Applied ${set.schema}/${migration.name}\n`);
    }
  }
}

/** Applies TulipFarm's migrations, then each loaded extension's (see migrateExtensions). */
export async function migrate(
  client: Client,
  directory: string,
  extensions: readonly ExtensionMigrationSet[] = extensionMigrations(),
) {
  const capability = storageCapability();
  const migrations = await readMigrations(directory);
  await client.query('SELECT pg_advisory_lock(734128, 2)');
  // Forward migration RAISE NOTICE reports; skip server notices such as "already exists, skipping".
  const report = (notice: { code?: string | undefined; message?: string | undefined }) => {
    if (notice.code === '00000' && notice.message) process.stdout.write(`${notice.message}\n`);
  };
  client.on('notice', report);
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS database_management');
    const ledger = 'database_management.migrations';
    await ensureLedger(client, ledger);
    for (const migration of await pendingMigrations(client, ledger, migrations)) {
      await inTransaction(
        client,
        async transaction => {
          await transaction.query('SET LOCAL search_path TO app, public');
          // The legacy reset fence is deferred; queued events block ALTER TABLE after UPDATE in one migration.
          await transaction.query('SET CONSTRAINTS ALL IMMEDIATE');
          await transaction.query(migration.sql);
          await transaction.query(`INSERT INTO ${ledger} (name, checksum) VALUES ($1, $2)`, [
            migration.name,
            migration.checksum,
          ]);
          await grantApplicationAccess(transaction, capability);
        },
        { statementTimeoutMs: 60_000, lockTimeoutMs: 60_000 },
      );
      process.stdout.write(`Applied ${migration.name}\n`);
    }
    await inTransaction(client, transaction => grantApplicationAccess(transaction, capability));
    process.stdout.write('Application migrations are current.\n');
    if (extensions.length) {
      await migrateExtensions(client, extensions);
      process.stdout.write('Extension migrations are current.\n');
    }
  } catch (error) {
    if (error instanceof MigrationDriftError)
      throw new DatabaseError('Applied migration was removed, reordered, or modified.', { cause: error });
    throw error;
  } finally {
    client.off('notice', report);
    await client.query('SELECT pg_advisory_unlock(734128, 2)');
  }
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Client } from 'pg';
import { escapeIdentifier } from 'pg';
import { grantWorkspaceSettingsAuthority } from '@tulipfarm/workspace-storage/provisioning';
import { connect } from './postgres.ts';

export type WorkspaceSnapshot = Awaited<ReturnType<typeof inspectWorkspaceSnapshot>>;

function workspaceSchema(schema: string) {
  if (!/^ws_[a-f0-9]{32}$/.test(schema)) throw new Error('invalid-workspace-schema');
  return escapeIdentifier(schema);
}

function localDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('rehearsal-requires-local-database');
  if (url.search) throw new Error('rehearsal-url-overrides-forbidden');
  return url;
}

export function disposableDatabase(connectionString: string) {
  const url = localDatabase(connectionString);
  if (!/^\/(workspace_operations_test|storage_test)_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error('explicit-disposable-target-required');
  return url;
}

async function postgresTool(command: 'pg_dump' | 'pg_restore', connectionString: string, args: string[]) {
  const url = localDatabase(connectionString);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        PATH: process.env.PATH,
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGCONNECT_TIMEOUT: '10',
        PGOPTIONS: '-c statement_timeout=60000 -c lock_timeout=5000',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.resume();
    child.once('error', () => reject(new Error('postgres-tool-unavailable')));
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${command}-failed`))));
  });
}

export async function inspectWorkspaceSnapshot(client: Client, schema: string) {
  workspaceSchema(schema);
  const tables = await client.query<{ name: string; owner: string; grants: string[]; columnGrants: string[] }>(
    `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
      ARRAY(SELECT acl::text FROM unnest(COALESCE(c.relacl, acldefault('r', c.relowner))) acl ORDER BY acl::text) AS grants,
      ARRAY(SELECT a.attname || ':' || acl::text FROM pg_attribute a CROSS JOIN LATERAL unnest(a.attacl) acl
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname,acl::text) AS "columnGrants"
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
    [schema],
  );
  const result: {
    name: string;
    owner: string;
    grants: string[];
    columnGrants: string[];
    rows: string;
    digest: string;
  }[] = [];
  for (const table of tables.rows) {
    const data = await client.query<{ rows: string; digest: string }>(
      `SELECT count(*)::text AS rows, md5(COALESCE(string_agg(row_digest, '' ORDER BY row_digest), '')) AS digest
       FROM (SELECT md5(to_jsonb(record)::text) AS row_digest FROM ${workspaceSchema(schema)}.${escapeIdentifier(table.name)} record) hashes`,
    );
    const row = data.rows[0];
    if (!row) throw new Error('snapshot-unavailable');
    result.push({ ...table, ...row });
  }
  if (!result.length) throw new Error('workspace-schema-empty');
  return result;
}

export async function backupDisposableWorkspace(options: {
  connectionString: string;
  schema: string;
  archivePath: string;
}) {
  disposableDatabase(options.connectionString);
  workspaceSchema(options.schema);
  await postgresTool('pg_dump', options.connectionString, [
    '--format=custom',
    '--strict-names',
    `--schema=${options.schema}`,
    `--file=${options.archivePath}`,
  ]);
  return {
    sha256: createHash('sha256')
      .update(await readFile(options.archivePath))
      .digest('hex'),
  };
}

export async function restoreDisposableWorkspace(options: {
  connectionString: string;
  schema: string;
  archivePath: string;
  sha256: string;
  expected: WorkspaceSnapshot;
}) {
  disposableDatabase(options.connectionString);
  workspaceSchema(options.schema);
  if (
    createHash('sha256')
      .update(await readFile(options.archivePath))
      .digest('hex') !== options.sha256
  )
    throw new Error('backup-checksum-mismatch');
  const client = await connect(options.connectionString);
  try {
    if ((await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [options.schema])).rowCount)
      throw new Error('restore-target-not-empty');
    await postgresTool('pg_restore', options.connectionString, [
      '--exit-on-error',
      '--single-transaction',
      '--dbname=' + decodeURIComponent(new URL(options.connectionString).pathname.slice(1)),
      options.archivePath,
    ]);
    const actual = await inspectWorkspaceSnapshot(client, options.schema);
    if (JSON.stringify(actual) !== JSON.stringify(options.expected)) throw new Error('restored-workspace-mismatch');
    const deliveryInstalled = (
      await client.query(
        "SELECT to_regprocedure('app.invitation_delivery(uuid,uuid,text,jsonb,timestamptz)') AS routine",
      )
    ).rows[0]?.routine;
    if (deliveryInstalled) {
      const runtime = escapeIdentifier(`${options.schema}_runtime`);
      await client.query(`GRANT USAGE ON SCHEMA app TO ${runtime}`);
      await client.query(
        `GRANT EXECUTE ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) TO ${runtime}`,
      );
    }
    if (
      (await client.query("SELECT to_regprocedure('app.workspace_access(uuid,boolean)') AS routine")).rows[0]?.routine
    ) {
      for (const capability of ['runtime', 'migration', 'confirmation']) {
        const role = escapeIdentifier(`${options.schema}_${capability}`);
        await client.query(`GRANT USAGE ON SCHEMA app TO ${role}`);
        await client.query(`GRANT EXECUTE ON FUNCTION app.workspace_access(uuid, boolean) TO ${role}`);
      }
      await client.query(
        `GRANT EXECUTE ON FUNCTION app.workspace_settings(uuid, uuid, uuid, jsonb) TO ${escapeIdentifier(`${options.schema}_runtime`)}`,
      );
      await grantWorkspaceSettingsAuthority(
        client,
        options.schema.slice(3).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5'),
      );
    }
    return { status: 'verified' as const, tables: actual.length };
  } finally {
    await client.end();
  }
}

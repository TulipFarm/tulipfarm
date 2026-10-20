import { parseArgs } from 'node:util';
import { readBuildInfo } from '@tulipfarm/build-info/node';
import { fileURLToPath } from 'node:url';
import { setLogLevel } from '@azure/logger';
import { azure, DatabaseError, hasStatus } from './config.ts';
import { allowIp, connectionUrl, provision, rolePasswords } from './azure.ts';
import { readSecret, saveSecret } from './secrets.ts';
import { bootstrap, connect } from './postgres.ts';
import { loadDatabaseExtensions, migrate } from './migrations.ts';
import { installExtensions } from './extensions.ts';
import { workspaceStoragePreflight } from './workspace-preflight.ts';
import { workspaceStorageInventory } from './workspace-inventory.ts';
import { MigrationDriftError, rolloutCommonMigrations } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';

const help = `Usage: pnpm db <command> --env local|production

  provision --env production --allow-ip IPV4   Create Azure server and developer firewall rule
  allow-ip --env production --allow-ip IPV4    Replace developer firewall rule
  bootstrap --env production                 Create roles/databases and store verified connection URLs
  migrate --env local|production              Apply checked-in application SQL migrations
  extensions --env local|production           Install extensions declared in src/config.ts
  status --env local|production               Query database identity, TLS, extensions
  workspace-preflight --env local|production  Refuse fresh cutover when workspace data exists
  workspace-inventory --env local|production Read aggregate preservation inventory without row contents
  workspace-rollout --env local|production    Apply the common migration stream to every ready workspace

Production administration uses az login. Production secrets come from environment
variables (database-admin-url → DATABASE_ADMIN_URL) or the module named by
TULIPFARM_DATABASE_SECRET_STORE; provision and bootstrap need a writable store. Local commands require DATABASE_MIGRATION_URL
for migrate and DATABASE_ADMIN_URL for extensions. status uses DATABASE_URL.
workspace-rollout uses WORKSPACE_PROVISIONING_DATABASE_URL.
Run provision, bootstrap, extensions, then migrate for a new Azure server.
`;

async function main() {
  const identity = readBuildInfo('database', new URL('../version.json', import.meta.url));
  if (process.argv.includes('--version')) {
    process.stdout.write(`${JSON.stringify(identity)}\n`);
    return;
  }
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    process.stdout.write(help);
    return;
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { env: { type: 'string' }, 'allow-ip': { type: 'string' } },
    });
  } catch {
    throw new DatabaseError('Invalid arguments. Run pnpm db --help.');
  }
  const { values, positionals } = parsed;
  const [command] = positionals;
  if (
    positionals.length !== 1 ||
    ![
      'provision',
      'allow-ip',
      'bootstrap',
      'migrate',
      'extensions',
      'status',
      'workspace-preflight',
      'workspace-inventory',
      'workspace-rollout',
    ].includes(command ?? '')
  )
    throw new DatabaseError('Unknown command. Run pnpm db --help.');
  if (values.env !== 'local' && values.env !== 'production')
    throw new DatabaseError('Select --env local or production.');
  const remote = values.env === 'production';
  if (['provision', 'bootstrap', 'allow-ip'].includes(command ?? '') && !remote)
    throw new DatabaseError('This command requires --env production.');
  setLogLevel(undefined);
  if (command === 'provision' || command === 'allow-ip') {
    const ip = values['allow-ip'];
    if (!ip) throw new DatabaseError('--allow-ip is required.');
    if (command === 'provision') await provision(ip);
    else await allowIp(ip);
    return;
  }
  if (values['allow-ip']) throw new DatabaseError('--allow-ip is only for provision and allow-ip.');
  if (command === 'bootstrap') {
    const url = await readSecret('database-admin-url');
    const passwords = await rolePasswords();
    await bootstrap(url, passwords);
    const host = new URL(url).hostname;
    for (const [key, database, role, password] of [
      ['database-url', 'tulipfarm', 'tulipfarm', passwords.application],
      ['database-migration-url', 'tulipfarm', 'tulipfarm_owner', passwords.owner],
      ['temporal-database-url', 'temporal', 'temporal', passwords.temporal],
      ['temporal-visibility-database-url', 'temporal_visibility', 'temporal', passwords.temporal],
    ]) {
      if (!key || !database || !role || !password) throw new DatabaseError('Incomplete connection configuration.');
      const connection = connectionUrl(host, database, role, password);
      const client = await connect(connection);
      try {
        await client.query('SELECT 1');
      } finally {
        await client.end();
      }
      await saveSecret(key, connection);
    }
    process.stdout.write('Database roles, privileges, and connection secrets are ready.\n');
    return;
  }
  if (command === 'workspace-rollout') {
    const connectionString = remote
      ? await readSecret('workspace-provisioning-database-url')
      : process.env.WORKSPACE_PROVISIONING_DATABASE_URL;
    if (!connectionString)
      throw new DatabaseError('Set WORKSPACE_PROVISIONING_DATABASE_URL for local database access.');
    const migrations = await workspaceTableMigrations();
    const listClient = await connect(connectionString);
    try {
      const { results } = await rolloutCommonMigrations({
        connectionString,
        migrations,
        listWorkspaceIds: async () =>
          (
            await listClient.query(
              "SELECT workspace_id FROM app.workspace_storage WHERE stage = 'ready' ORDER BY workspace_id",
            )
          ).rows.map(row => String(row.workspace_id)),
      });
      const failed = results.filter(result => result.status !== 'applied');
      process.stdout.write(
        `${JSON.stringify({ migrations: migrations.length, applied: results.length - failed.length, failed })}\n`,
      );
      if (failed.length)
        throw new DatabaseError('Workspace rollout did not complete. Fix the failed workspaces before deploying.');
    } finally {
      await listClient.end();
    }
    return;
  }
  const key =
    command === 'migrate' || command === 'workspace-preflight' || command === 'workspace-inventory'
      ? 'database-migration-url'
      : command === 'extensions'
        ? 'database-admin-url'
        : 'database-url';
  const envKey = key.replaceAll('-', '_').toUpperCase();
  let url = remote ? await readSecret(key) : process.env[envKey];
  if (!url) throw new DatabaseError(`Set ${envKey} for local database access.`);
  if (command === 'extensions' && remote) {
    const parsedUrl = new URL(url);
    parsedUrl.pathname = '/tulipfarm';
    url = parsedUrl.href;
  }
  const client = await connect(url);
  try {
    if (command === 'migrate') {
      await loadDatabaseExtensions();
      await migrate(client, fileURLToPath(new URL('../migrations/', import.meta.url)));
    }
    if (command === 'extensions') await installExtensions(client, remote);
    if (command === 'workspace-preflight')
      process.stdout.write(`${JSON.stringify(await workspaceStoragePreflight(client))}\n`);
    if (command === 'workspace-inventory')
      process.stdout.write(`${JSON.stringify(await workspaceStorageInventory(client), null, 2)}\n`);
    if (command === 'status') {
      const identity = await client.query(
        "SELECT current_database() AS database, current_user AS role, current_setting('server_version') AS version, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls",
      );
      const installed = await client.query(
        'SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname',
      );
      process.stdout.write(
        `${JSON.stringify({ server: remote ? azure.serverName : 'local', ...identity.rows[0], extensions: installed.rows }, null, 2)}\n`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseError) process.stderr.write(`${error.message}\n`);
  else if (error instanceof MigrationDriftError)
    process.stderr.write(
      'Workspace rollout blocked (history_drift): supplied migrations differ from recorded history. Preserve existing migration names, checksums, and order; append new migrations after them.\n',
    );
  else {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Za-z0-9_]+$/.test(error.code)
        ? ` (${error.code})`
        : '';
    process.stderr.write(
      `Database operation failed${code}${hasStatus(error, 403) ? ': check Azure permissions' : ''}. Inspect resource state and retry; credentials were not printed.\n`,
    );
  }
  process.exitCode = 1;
});

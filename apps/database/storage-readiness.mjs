import { Client } from 'pg';
import { readSecret } from './src/secrets.ts';

let client;
try {
  client = new Client({
    connectionString: await readSecret('database-migration-url'),
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
  });
  client.on('error', () => undefined);
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const result = await client.query(
    "SELECT capability FROM database_management.storage_capabilities WHERE capability='isolated-v1'",
  );
  if (result.rowCount !== 1) throw new Error('Storage capability is not installed');
  await client.query('ROLLBACK');
  process.stdout.write('Database isolated-v1 capability verified.\n');
} catch (error) {
  process.stderr.write(
    `storage-release: Cannot verify the installed isolated-v1 database capability. Check migration completion and database access. Cause: ${error instanceof Error ? error.message : error}\n`,
  );
  process.exitCode = 1;
} finally {
  await client?.end();
}

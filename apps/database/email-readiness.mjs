import { Client } from 'pg';
import { readSecret } from './src/secrets.ts';

export async function verifyEmailDatabase(client, role = 'tulipfarm_email_delivery') {
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(
      `SELECT current_user = $1 AS identity,
      has_table_privilege(current_user, 'app.email_deliveries', 'SELECT') AND
      has_table_privilege(current_user, 'app.email_deliveries', 'UPDATE') AS outbox,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app' AND c.relname IN ('users','sessions','accounts','verifications')
        AND has_any_column_privilege(current_user,c.oid,'SELECT')) AS identity_access`,
      [role],
    );
    const row = result.rows[0];
    if (!row?.identity || !row.outbox || row.identity_access) throw new Error('Invalid email login privileges');
    await client.query(`SELECT id, kind, workspace_id, invitation_id, payload, expires_at,
      status, attempts, lease_until, created_at, sent_at FROM app.email_deliveries LIMIT 0`);
  } finally {
    await client.query('ROLLBACK');
  }
}

if (import.meta.main) {
  let client;
  try {
    const url = new URL(await readSecret('email-delivery-database-url'));
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== 'tulipfarm-cloud.postgres.database.azure.com' ||
      !['', '5432'].includes(url.port) ||
      url.pathname !== '/tulipfarm' ||
      decodeURIComponent(url.username) !== 'tulipfarm_email_delivery' ||
      url.search !== '?sslmode=verify-full' ||
      url.hash
    )
      throw new Error('Invalid email database target');
    client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
    client.on('error', () => undefined);
    await client.connect();
    await verifyEmailDatabase(client);
    process.stdout.write('Email outbox and restricted login are ready. No data changed.\n');
  } catch {
    process.stderr.write(
      'Email database check failed. Verify the migration, restricted login, secret store access, and database network access. Credential details suppressed.\n',
    );
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}

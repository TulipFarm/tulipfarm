import { Client } from 'pg';
import { installExtensions } from '../../../../apps/database/src/extensions.ts';
import { grantPgvector } from '../../src/pgvector.ts';

export async function provisionTestPgvector(admin, database, provisioner) {
  const config = admin.connectionParameters ?? admin.options;
  const url = config.connectionString ? new URL(config.connectionString) : null;
  if (url) url.pathname = `/${database}`;
  // A pg Client's connection parameters hide the password from spreading, so copy it explicitly.
  const client = new Client(url ? { connectionString: url.href } : { ...config, password: config.password, database });
  try {
    await client.connect();
    await installExtensions(client, false);
    if (provisioner) await grantPgvector(client, provisioner, true);
  } finally {
    await client.end();
  }
}

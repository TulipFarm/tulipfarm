import { randomBytes, randomUUID } from 'node:crypto';
import { escapeIdentifier } from 'pg';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { connect } from '../../../packages/workspace-storage/test/integration/fixture.mjs';

/**
 * Connects as an authoring registry login, the role a hosted worker's WORKSPACE_AUTHORING_DATABASE_URL names.
 * Provision it after the platform migrations so it receives the grants a migrate run gives it.
 */
export async function authoringPlatform(db) {
  const role = `authoring_${randomUUID().replaceAll('-', '')}`;
  const password = randomBytes(32).toString('hex');
  await provisionTableRegistry(db.platform, { capability: 'authoring', role, password });
  const url = new URL(db.connectionString);
  url.username = role;
  url.password = password;
  const client = await connect(url.href);
  return {
    client,
    async close() {
      await client.end();
      await db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
      await db.admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    },
  };
}

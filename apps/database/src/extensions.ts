import { escapeIdentifier } from 'pg';
import type { Client } from 'pg';
import { azure, DatabaseError, extensions } from './config.ts';

export async function installExtensions(client: Client, azureManaged: boolean) {
  for (const extension of extensions) {
    if (!/^[a-z][a-z0-9_-]*$/.test(extension.name)) throw new DatabaseError('Invalid extension name.');
  }
  if (azureManaged && extensions.length) {
    const { azureManagement } = await import('./azure.ts');
    const management = azureManagement();
    const current = await management.configurations.get(azure.resourceGroup, azure.serverName, 'azure.extensions');
    const allowed = new Set(
      (current.value ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
    );
    for (const extension of extensions) allowed.add(extension.name);
    const value = [...allowed].sort().join(',');
    if (value !== current.value)
      await management.configurations.beginUpdateAndWait(azure.resourceGroup, azure.serverName, 'azure.extensions', {
        value,
        source: 'user-override',
      });
  }
  for (const extension of extensions) {
    const existing = await client.query('SELECT 1 FROM pg_catalog.pg_extension WHERE extname=$1', [extension.name]);
    if (!existing.rowCount) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(extension.schema)}`);
      await client.query(
        `CREATE EXTENSION ${escapeIdentifier(extension.name)} WITH SCHEMA ${escapeIdentifier(extension.schema)}`,
      );
    }
    const qualified = await client.query(
      `SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
      WHERE e.extname=$1 AND n.nspname=$2 AND pg_catalog.string_to_array(e.extversion,'.')::int[] >= pg_catalog.string_to_array($3,'.')::int[]`,
      [extension.name, extension.schema, extension.minimumVersion],
    );
    if (!qualified.rowCount)
      throw new DatabaseError(
        `Extension ${extension.name} requires an explicit upgrade to >= ${extension.minimumVersion} in ${extension.schema}.`,
      );
    await client.query(`REVOKE ALL ON SCHEMA ${escapeIdentifier(extension.schema)} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${escapeIdentifier(extension.schema)} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON TYPE ${escapeIdentifier(extension.schema)}.vector FROM PUBLIC`);
  }
  await restrictQueryStatistics(client);
  process.stdout.write(`Verified ${extensions.length} configured extensions.\n`);
}

// pg_stat_statements grants its views to PUBLIC, which the release privilege audits reject for every role.
export async function restrictQueryStatistics(client: Client) {
  const members = await client.query<{ object: string; relation: boolean }>(
    `SELECT CASE WHEN d.classid='pg_catalog.pg_class'::regclass THEN d.objid::regclass::text
      ELSE d.objid::regprocedure::text END AS object, d.classid='pg_catalog.pg_class'::regclass AS relation
    FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
    WHERE d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e' AND e.extname='pg_stat_statements'
      AND d.classid IN ('pg_catalog.pg_class'::regclass, 'pg_catalog.pg_proc'::regclass)`,
  );
  for (const { object, relation } of members.rows) {
    await client.query(`REVOKE ALL ON ${relation ? 'TABLE' : 'FUNCTION'} ${object} FROM PUBLIC`);
    if (relation) await client.query(`GRANT SELECT ON TABLE ${object} TO pg_read_all_stats`);
  }
}

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Client, escapeIdentifier as ident } from 'pg';
import { workspaceNames } from '../../../packages/workspace-storage/src/provisioning.ts';

// Exact objects emitted by the qualification attempt interrupted at 2026-09-27T18:25:06Z.
const database = 'storage_qual_d65925e9ed5573a44695b379';
const provisioner = `${database}_provisioner`;
const roles = [
  ...['authoring', 'confirmation', 'migration'].map(capability => ({
    name: `${database}_${capability}`,
    marker: `tulipfarm.table-registry.${capability}`,
  })),
  ...['9df59c5a-426f-4b97-9a91-0e5b0290af42', '75861b63-17ad-431e-9613-369ed5934d19'].flatMap(id => {
    const names = workspaceNames(id);
    return ['runtime', 'migration', 'confirmation', 'customOwner'].map(key => ({
      name: names[key],
      marker: `tulipfarm.workspace.${id}`,
    }));
  }),
];
assert.deepEqual(process.argv.slice(2), ['--cleanup-interrupted-qualification']);
const url = new URL(process.env.DATABASE_ADMIN_URL);
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, 'tulipfarm-cloud.postgres.database.azure.com');
assert.equal(url.pathname, '/postgres');
assert.equal(url.username, 'tfadmin');
assert.equal(url.search, '?sslmode=verify-full');
const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 15000, statement_timeout: 20000 });
const events = [];
try {
  await client.connect();
  const existing = (
    await client.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [database])
  ).rows[0];
  if (existing) {
    assert.equal(existing.owner, provisioner);
    assert.equal((await client.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1', [database])).rowCount, 0);
    await client.query(`DROP DATABASE ${ident(database)}`);
  }
  for (const { name, marker } of roles) {
    const row = (
      await client.query("SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1", [
        name,
      ])
    ).rows[0];
    if (row) {
      assert.equal(row.marker, marker);
      await client.query(`SET ROLE ${ident(provisioner)}`);
      try {
        await client.query(`DROP ROLE ${ident(name)}`);
      } finally {
        await client.query('RESET ROLE');
      }
    }
  }
  if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [provisioner])).rowCount) {
    await client.query(`DROP ROLE ${ident(provisioner)}`);
  }
  const remainingRoles = (
    await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [
      [provisioner, ...roles.map(role => role.name)],
    ])
  ).rows;
  const remainingDatabases = (await client.query('SELECT datname FROM pg_database WHERE datname = $1', [database]))
    .rows;
  assert.deepEqual(remainingRoles, []);
  assert.deepEqual(remainingDatabases, []);
  events.push({
    timestamp: new Date().toISOString(),
    event: 'cleanup',
    status: 'PASS',
    database,
    roles: [provisioner, ...roles.map(role => role.name)],
    remainingRoles,
    remainingDatabases,
  });
} catch (error) {
  events.push({
    timestamp: new Date().toISOString(),
    event: 'cleanup',
    status: 'FAIL',
    database,
    code: typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNCLASSIFIED',
  });
  process.exitCode = 1;
} finally {
  await client.end();
  const evidence = `qualification-final-azure-interrupted-cleanup-${Date.now()}.json`;
  writeFileSync(new URL(evidence, import.meta.url), `${JSON.stringify(events, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ events, evidence })}\n`);
}

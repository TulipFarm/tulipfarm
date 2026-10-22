import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { connect } from '../../src/postgres.ts';
import {
  backupDisposableWorkspace,
  disposableDatabase,
  inspectWorkspaceSnapshot,
  restoreDisposableWorkspace,
} from '../../src/workspace-operations-recovery.ts';
import { createStarterBundle, git } from '../../../../packages/workspaces/src/soul.ts';

test(
  'restore preserves records, applied revisions and grants without stopping another workspace',
  { timeout: 30000 },
  async () => {
    const connectionString = process.env.TEST_ADMIN_DATABASE_URL;
    assert.ok(connectionString, 'Set TEST_ADMIN_DATABASE_URL to local PostgreSQL');
    const admin = await connect(connectionString);
    const names = Array.from({ length: 2 }, () => `workspace_operations_test_${randomUUID().replaceAll('-', '')}`);
    const schema = `ws_${randomUUID().replaceAll('-', '')}`;
    const otherSchema = `ws_${randomUUID().replaceAll('-', '')}`;
    const role = `${schema}_runtime`;
    const rolePassword = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), 'workspace-recovery-'));
    const urls = names.map(name => {
      const url = new URL(connectionString);
      url.pathname = `/${name}`;
      return url.href;
    });
    const clients = [];
    try {
      const seed = { workspaceId: randomUUID(), createdBy: randomUUID(), createdAt: new Date().toISOString() };
      const starter = await createStarterBundle(seed);
      await writeFile(join(directory, 'initial.bundle'), starter.body);
      await git(directory, ['clone', 'initial.bundle', 'soul']);
      const repository = join(directory, 'soul');
      const tableId = randomUUID();
      const fieldId = randomUUID();
      const document = {
        formatVersion: 2,
        id: tableId,
        owningTeamId: randomUUID(),
        label: 'Invoices',
        fields: [{ id: fieldId, label: 'Amount', kind: 'text', required: true, maxLength: 100 }],
        uniqueKeys: [],
      };
      await writeFile(join(repository, 'tables', `${tableId}.json`), JSON.stringify(document));
      await git(repository, ['add', '.']);
      await git(repository, ['commit', '-m', 'Save invoice definition'], seed);
      const revision = (await git(repository, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repository, ['bundle', 'create', join(directory, 'accepted.bundle'), '--all']);
      const soulDigest = createHash('sha256')
        .update(await readFile(join(directory, 'accepted.bundle')))
        .digest('hex');
      const definition = document;
      for (const name of names) await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
      clients.push(await connect(urls[0]), await connect(urls[1]));
      const [source, target] = clients;
      await admin.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD '${rolePassword}'`);
      await source.query(`CREATE SCHEMA ${schema}; CREATE SCHEMA ${otherSchema};
      CREATE TABLE ${schema}.records (id integer PRIMARY KEY, amount numeric NOT NULL);
      INSERT INTO ${schema}.records VALUES (1, 12.50), (2, 90.25);
      CREATE TABLE ${schema}.tf_table_catalog (id integer PRIMARY KEY, applied_revision text NOT NULL, applied_definition jsonb);
      INSERT INTO ${schema}.tf_table_catalog VALUES (1, '${revision}', NULL);
      CREATE TABLE ${schema}.tf_migration_ledger (migration_id integer PRIMARY KEY, applied_revision text NOT NULL);
      INSERT INTO ${schema}.tf_migration_ledger VALUES (1, '${revision}');
      CREATE TABLE ${schema}.tf_soul_revisions (revision text PRIMARY KEY, bundle_sha256 text NOT NULL);
      INSERT INTO ${schema}.tf_soul_revisions VALUES ('${revision}', '${soulDigest}');
      CREATE TABLE ${otherSchema}.records (id integer PRIMARY KEY);
      INSERT INTO ${otherSchema}.records VALUES (7);
      GRANT USAGE ON SCHEMA ${schema}, ${otherSchema} TO ${role};
      GRANT SELECT, INSERT ON ${schema}.records, ${otherSchema}.records TO ${role};
      GRANT SELECT ON ${schema}.tf_table_catalog, ${schema}.tf_migration_ledger, ${schema}.tf_soul_revisions TO ${role}`);
      await source.query(`UPDATE ${schema}.tf_table_catalog SET applied_definition=$1`, [definition]);
      const expected = await inspectWorkspaceSnapshot(source, schema);
      const archivePath = join(directory, 'workspace.dump');
      const backup = await backupDisposableWorkspace({ connectionString: urls[0], schema, archivePath });
      await assert.rejects(
        restoreDisposableWorkspace({
          connectionString: urls[1],
          schema,
          archivePath,
          expected,
          sha256: '0'.repeat(64),
        }),
        /checksum/,
      );
      let traffic = 0;
      let running = true;
      const ordinary = (async () => {
        while (running) {
          assert.equal((await source.query(`SELECT id FROM ${otherSchema}.records`)).rows[0].id, 7);
          traffic++;
          await new Promise(resolve => setTimeout(resolve, 2));
        }
      })();
      try {
        assert.deepEqual(
          await restoreDisposableWorkspace({ connectionString: urls[1], schema, archivePath, expected, ...backup }),
          { status: 'verified', tables: 4 },
        );
      } finally {
        running = false;
        await ordinary;
      }
      assert.ok(traffic > 0);
      assert.equal((await target.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [otherSchema])).rowCount, 0);
      const loginUrl = new URL(urls[1]);
      loginUrl.username = role;
      loginUrl.password = rolePassword;
      const runtime = await connect(loginUrl.href);
      try {
        assert.deepEqual((await runtime.query(`SELECT amount::text FROM ${schema}.records ORDER BY id`)).rows, [
          { amount: '12.50' },
          { amount: '90.25' },
        ]);
        assert.equal(
          (
            await runtime.query(
              `SELECT c.applied_revision = s.revision AND l.applied_revision = s.revision AS matches FROM ${schema}.tf_table_catalog c CROSS JOIN ${schema}.tf_soul_revisions s CROSS JOIN ${schema}.tf_migration_ledger l`,
            )
          ).rows[0].matches,
          true,
        );
        await git(directory, ['clone', '--bare', 'accepted.bundle', 'restored-soul']);
        await git(join(directory, 'restored-soul'), ['fsck', '--full', '--strict']);
        const restoredDocument = JSON.parse(
          (await git(join(directory, 'restored-soul'), ['show', `${revision}:resources/${tableId}.json`])).stdout,
        );
        assert.deepEqual(restoredDocument, document);
        const restoredCatalog = (
          await runtime.query(`SELECT applied_revision, applied_definition FROM ${schema}.tf_table_catalog`)
        ).rows[0];
        assert.deepEqual(restoredDocument, restoredCatalog.applied_definition);
        await runtime.query(`INSERT INTO ${schema}.records VALUES (3, 2.75)`);
        await assert.rejects(runtime.query(`UPDATE ${schema}.tf_migration_ledger SET applied_revision = 'forged'`), {
          code: '42501',
        });
      } finally {
        await runtime.end();
      }
      await assert.rejects(
        restoreDisposableWorkspace({ connectionString: urls[1], schema, archivePath, expected, ...backup }),
        /not-empty/,
      );
    } finally {
      await Promise.all(clients.map(client => client.end()));
      for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)}`);
      await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      await admin.end();
      await rm(directory, { recursive: true });
    }
  },
);

test('restore and deletion guards reject production and unmarked databases', () => {
  assert.throws(
    () => disposableDatabase('postgresql://operator@production.example/workspace_operations_test_' + 'a'.repeat(32)),
    /local/,
  );
  assert.throws(() => disposableDatabase('postgresql://operator@localhost/tulipfarm'), /disposable/);
});

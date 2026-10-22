import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { lockAuthorization } from '@tulipfarm/access';
import { createTableCleanup } from '@tulipfarm/tables/cleanup';
import { errorAttributes } from '@tulipfarm/observability';
import { conversationFixture } from '../../../conversations/test/fixture.mjs';
import { connect } from '../../../workspace-storage/test/integration/fixture.mjs';

async function seedReceipt(f, age = '32 days') {
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_table_row_requests')}
    (membership_id,table_id,request_id,input_digest,input,permission,result,created_at)
    VALUES($1,$2,$3,$4,'{}','table.row.create',$5,clock_timestamp()-$6::interval)`,
    [
      f.workspace.membershipId,
      randomUUID(),
      randomUUID(),
      'a'.repeat(64),
      { kind: 'available', id: randomUUID(), token: randomUUID() },
      age,
    ],
  );
}

async function seedImport(f, age = '32 days') {
  const conversationId = randomUUID(),
    referenceId = randomUUID();
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_table_import_objects')}
    (object_key,membership_id,conversation_id,turn_id,kind,reference_id,last_used_at)
    VALUES($1,$2,$3,$4,'integration',$5,clock_timestamp()-$6::interval)`,
    [
      `${f.workspace.id}/resource-imports/${f.workspace.membershipId}/${conversationId}/result-${referenceId}.json`,
      f.workspace.membershipId,
      conversationId,
      randomUUID(),
      referenceId,
      age,
    ],
  );
}

test('cleanup skips authorization locking when no retention work is due', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  const holder = await connect(f.db.login(f.workspace));
  t.after(async () => {
    await holder.end();
    await f.close();
  });
  await holder.query('BEGIN');
  await lockAuthorization({ client: holder, schema: f.workspace.names.schema }, 'read');
  const cleanup = createTableCleanup({ resolveMigrationCredential: async () => f.db.login(f.workspace, 'migration') });
  assert.equal(await cleanup(f.workspace.id), 'completed');
  await seedReceipt(f, '1 day');
  await seedImport(f, '1 day');
  assert.equal(await cleanup(f.workspace.id), 'completed', 'recent records do not need the write lock either');
  assert.equal((await holder.query('SELECT 1 AS open')).rows[0].open, 1, 'the reader remains open throughout cleanup');
  await f.db.platform.query(
    `UPDATE ${f.table('tf_table_row_requests')} SET created_at=clock_timestamp()-interval '32 days'`,
  );
  await assert.rejects(
    cleanup(f.workspace.id),
    error => error.code === '55P03' && errorAttributes(error)['error.stage'] === 'table-cleanup-authorization',
  );
  assert.deepEqual(
    (await f.db.platform.query(`SELECT input FROM ${f.table('tf_table_row_requests')}`)).rows[0].input,
    {},
  );
  await holder.query('ROLLBACK');
  assert.equal(
    await cleanup(f.workspace.id),
    'more',
    'a later sweep processes newly due work once the reader releases its lock',
  );
  assert.equal(
    (await f.db.platform.query(`SELECT input FROM ${f.table('tf_table_row_requests')}`)).rows[0].input,
    null,
  );
});

test('real cleanup reacquires authorization after a rolled-back lock timeout', { timeout: 60000 }, async t => {
  for (const blockedTransaction of ['first', 'second']) {
    await t.test(blockedTransaction, async t => {
      const f = await conversationFixture();
      let holder;
      t.after(async () => {
        await holder?.end();
        await f.close();
      });
      holder = await connect(f.db.login(f.workspace));
      if (blockedTransaction === 'first') await seedReceipt(f);
      else await seedImport(f);
      const hold = async () => {
        await holder.query('BEGIN');
        await lockAuthorization({ client: holder, schema: f.workspace.names.schema }, 'read');
      };
      if (blockedTransaction === 'first') await hold();
      const originalQuery = Client.prototype.query;
      const failures = [],
        events = [];
      let commits = 0;
      t.mock.method(Client.prototype, 'query', function (...args) {
        const result = originalQuery.apply(this, args);
        if (this.connectionParameters.user !== f.workspace.names.migration) return result;
        const sql = args[0];
        return result.then(
          async value => {
            if (/^(BEGIN|ROLLBACK|COMMIT)/.test(sql)) events.push(sql.split(' ')[0]);
            if (sql === 'COMMIT' && ++commits === 1 && blockedTransaction === 'second') await hold();
            if (sql === 'ROLLBACK') await holder.query('ROLLBACK');
            return value;
          },
          error => {
            if (sql.includes('tf_authorization_lock')) failures.push(error);
            throw error;
          },
        );
      });
      const cleanup = createTableCleanup({
        resolveMigrationCredential: async () => f.db.login(f.workspace, 'migration'),
      });
      assert.equal(await cleanup(f.workspace.id), 'more');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].code, '55P03');
      assert.equal(errorAttributes(failures[0])['error.stage'], 'table-cleanup-authorization');
      assert.deepEqual(
        events,
        blockedTransaction === 'first'
          ? ['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']
          : ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT'],
      );
      assert.equal(commits, 2, 'the already committed transaction is not replayed');
      if (blockedTransaction === 'first') {
        assert.equal(
          (await f.db.platform.query(`SELECT input FROM ${f.table('tf_table_row_requests')}`)).rows[0].input,
          null,
        );
      } else {
        assert.ok(
          (await f.db.platform.query(`SELECT cleanup_pending_at FROM ${f.table('tf_table_import_objects')}`)).rows[0]
            .cleanup_pending_at,
        );
      }
    });
  }
});

test('cleanup rechecks candidates under authorization before changing data', { timeout: 60000 }, async t => {
  for (const phase of ['history', 'imports']) {
    await t.test(phase, async t => {
      const f = await conversationFixture();
      t.after(() => f.close());
      if (phase === 'history') await seedReceipt(f);
      else await seedImport(f);
      const originalQuery = Client.prototype.query;
      let refreshed = false,
        locks = 0;
      t.mock.method(Client.prototype, 'query', function (...args) {
        const result = originalQuery.apply(this, args);
        if (this.connectionParameters.user !== f.workspace.names.migration) return result;
        const sql = args[0];
        if (sql.includes('"tf_authorization_lock"')) locks++;
        if (!sql.endsWith(' AS needed') || sql.includes('"tf_table_import_objects"') !== (phase === 'imports'))
          return result;
        return result.then(async value => {
          assert.equal(value.rows[0].needed, true);
          assert.equal(locks, 0);
          if (phase === 'history') {
            await f.db.platform.query(`UPDATE ${f.table('tf_table_row_requests')} SET created_at=clock_timestamp()`);
          } else {
            await f.db.platform.query(
              `UPDATE ${f.table('tf_table_import_objects')} SET last_used_at=clock_timestamp()`,
            );
          }
          refreshed = true;
          return value;
        });
      });
      const cleanup = createTableCleanup({
        resolveMigrationCredential: async () => f.db.login(f.workspace, 'migration'),
      });
      assert.equal(await cleanup(f.workspace.id), 'completed');
      assert.equal(refreshed, true);
      assert.equal(locks, 1, 'a positive preflight still requires the authorization fence');
      if (phase === 'history') {
        assert.deepEqual(
          (await f.db.platform.query(`SELECT input FROM ${f.table('tf_table_row_requests')}`)).rows[0].input,
          {},
        );
      } else {
        assert.equal(
          (await f.db.platform.query(`SELECT cleanup_pending_at FROM ${f.table('tf_table_import_objects')}`)).rows[0]
            .cleanup_pending_at,
          null,
        );
      }
    });
  }
});

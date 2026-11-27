import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pipelined, pipelinedAll } from '../../src/transaction-reads.ts';
import { Client } from 'pg';

async function client(t) {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'Set TEST_ADMIN_DATABASE_URL to a disposable local PostgreSQL server');
  const db = new Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL, statement_timeout: 10000 });
  await db.connect();
  const failures = [];
  db.on('error', error => failures.push(error));
  t.after(() => db.end().catch(() => {}));
  await db.query('BEGIN');
  return { db, failures };
}

const who = result => result.rows[0]?.who;

test('a sibling query still waiting when a pipelined batch settles gets its own reply', async t => {
  const { db, failures } = await client(t);
  // Like a lock wait beside another service in Promise.all on one transaction: the sibling's queries go out while
  // the batch has pipelining on, and the slow one is still waiting when the batch's own replies are in.
  const batch = pipelined(db, () => [db.query("SELECT 'a1' AS who"), db.query("SELECT 'a2' AS who")]);
  const sibling = (async () => {
    const first = await db.query("SELECT 'b1' AS who, pg_sleep(0.05)");
    const second = await db.query("SELECT 'b2' AS who");
    return [who(first), who(second)];
  })();
  const late = (async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return who(await db.query("SELECT 'c1' AS who"));
  })();
  const settled = await batch;
  assert.deepEqual(
    settled.map(result => who(result.value)),
    ['a1', 'a2'],
  );
  assert.deepEqual(await sibling, ['b1', 'b2']);
  assert.equal(await late, 'c1');
  assert.deepEqual(failures, []);
  assert.equal(db.pipeline, false);
  assert.equal(who(await db.query("SELECT 'after' AS who")), 'after');
});

test('concurrent pipelined batches beside plain reads each get their own rows', async t => {
  const { db, failures } = await client(t);
  const reads = Array.from({ length: 20 }, (_, index) => async () => {
    if (index % 3 === 0)
      return pipelinedAll(db, [
        async () => who(await db.query(`SELECT 'p${index}a' AS who, pg_sleep(0.002)`)),
        async () => who(await db.query(`SELECT 'p${index}b' AS who`)),
      ]);
    const first = who(await db.query(`SELECT 's${index}a' AS who, pg_sleep(0.003)`));
    return [first, who(await db.query(`SELECT 's${index}b' AS who`))];
  });
  const results = await Promise.all(reads.map(read => read()));
  assert.deepEqual(
    results,
    reads.map((_, index) => (index % 3 === 0 ? [`p${index}a`, `p${index}b`] : [`s${index}a`, `s${index}b`])),
  );
  assert.deepEqual(failures, []);
  assert.equal(db.pipeline, false);
});

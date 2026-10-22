import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool, escapeIdentifier } from 'pg';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { provisionTableRegistry } from '../../workspaces/src/table-registry.ts';
import { grantApplicationAccess } from '../../../apps/database/src/postgres.ts';
import { createKnowledgeEmbeddingCapacity } from '../dist/embedding-capacity.js';

const routine = 'app.acquire_knowledge_embedding_capacity(uuid,text,integer,uuid)';
const claims = 'app.knowledge_embedding_capacity_claims';
const request = (workspaceId = randomUUID(), tokens = 1, purpose = 'query') => ({
  workspaceId,
  tokens,
  purpose,
  attemptId: randomUUID(),
});

test(
  'persistent embedding capacity shares exact rolling budgets across restricted API and worker pools',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    const pools = [],
      roles = [];
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const authoring = {
        capability: 'authoring',
        role: `embedding_authoring_${randomUUID().replaceAll('-', '')}`,
        password: randomBytes(32).toString('hex'),
      };
      roles.push(authoring.role);
      await provisionTableRegistry(db.platform, authoring);
      assert.equal(
        (await db.admin.query("SELECT 1 FROM pg_roles WHERE rolname='tulipfarm'")).rowCount,
        0,
        'Disposable cluster must not contain a pre-existing identity role',
      );
      await db.admin.query('CREATE ROLE tulipfarm LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
      roles.push('tulipfarm');
      await db.platform.query(
        `GRANT CONNECT ON DATABASE ${escapeIdentifier(new URL(db.connectionString).pathname.slice(1))} TO tulipfarm`,
      );
      await grantApplicationAccess(db.platform, 'isolated-v1');
      const identityUrl = new URL(db.connectionString);
      identityUrl.username = 'tulipfarm';
      identityUrl.password = '';
      const workerUrl = new URL(db.connectionString);
      workerUrl.username = authoring.role;
      workerUrl.password = authoring.password;
      const api = new Pool({ connectionString: identityUrl.href, max: 8 });
      const worker = new Pool({ connectionString: workerUrl.href, max: 8 });
      pools.push(api, worker);
      const factories = [createKnowledgeEmbeddingCapacity(api), createKnowledgeEmbeddingCapacity(worker)];
      const acquire = (input, index = 0) => factories[index % 2].acquire(input);
      const reset = () => db.platform.query(`TRUNCATE ${claims}`);
      const usage = async () =>
        (
          await db.platform.query(
            `SELECT count(*)::int AS requests, coalesce(sum(tokens),0)::int AS tokens FROM ${claims}`,
          )
        ).rows[0];

      await t.test('grant replay preserves function-only access for authoring and identity', async () => {
        assert.equal(await acquire(request()), true);
        assert.equal(await acquire(request(), 1), true);
        await provisionTableRegistry(db.platform, authoring);
        await grantApplicationAccess(db.platform, 'isolated-v1');
        await provisionTableRegistry(db.platform, authoring);
        for (const [index, pool] of pools.entries()) {
          assert.equal(
            (await pool.query('SELECT current_user')).rows[0].current_user,
            index === 0 ? 'tulipfarm' : authoring.role,
          );
          assert.equal(await acquire(request(), index), true);
          for (const sql of [
            `SELECT * FROM ${claims}`,
            `DELETE FROM ${claims}`,
            `UPDATE ${claims} SET tokens=1`,
            `INSERT INTO ${claims} VALUES ('${randomUUID()}','${randomUUID()}','query',1,clock_timestamp())`,
            'UPDATE app.knowledge_embedding_capacity_gate SET observed_at=clock_timestamp()',
            `ALTER FUNCTION ${routine} SECURITY INVOKER`,
            `SET ROLE ${escapeIdentifier(db.owner)}`,
          ])
            await denied(pool, sql);
        }
        await denied(worker, 'SELECT * FROM app.accounts');
        const workspace = await db.create();
        const runtime = await connect(db.login(workspace));
        try {
          await denied(
            runtime,
            `SELECT app.acquire_knowledge_embedding_capacity('${workspace.id}','query',1,'${randomUUID()}')`,
          );
        } finally {
          await runtime.end();
        }
        for (const capability of ['confirmation', 'migration']) {
          const input = {
            capability,
            role: `embedding_${capability}_${randomUUID().replaceAll('-', '')}`,
            password: randomBytes(32).toString('hex'),
          };
          roles.push(input.role);
          await provisionTableRegistry(db.platform, input);
          const url = new URL(db.connectionString);
          url.username = input.role;
          url.password = input.password;
          const restricted = await connect(url.href);
          try {
            await denied(
              restricted,
              `SELECT app.acquire_knowledge_embedding_capacity('${workspace.id}','query',1,'${randomUUID()}')`,
            );
          } finally {
            await restricted.end();
          }
        }
      });

      await t.test('concurrent requests stop at the global request ceiling', async () => {
        await reset();
        const results = await Promise.all(Array.from({ length: 450 }, (_, index) => acquire(request(), index)));
        assert.equal(results.filter(Boolean).length, 400);
        assert.deepEqual(await usage(), { requests: 400, tokens: 400 });
        assert.equal(await createKnowledgeEmbeddingCapacity(worker).acquire(request()), false);
      });

      await t.test('background request ceiling leaves interactive room and denials cost nothing', async () => {
        await reset();
        const results = await Promise.all(
          Array.from({ length: 330 }, (_, index) => acquire(request(randomUUID(), 1, 'ingestion'), index)),
        );
        assert.equal(results.filter(Boolean).length, 300);
        const rejected = request(randomUUID(), 1, 'ingestion');
        assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => acquire(rejected))), Array(20).fill(false));
        const queries = await Promise.all(Array.from({ length: 110 }, (_, index) => acquire(request(), index)));
        assert.equal(queries.filter(Boolean).length, 100);
        assert.deepEqual(await usage(), { requests: 400, tokens: 400 });
      });

      await t.test('workspace request ceiling cannot monopolize either caller', async () => {
        await reset();
        const workspaceId = randomUUID();
        const results = await Promise.all(
          Array.from({ length: 120 }, (_, index) => acquire(request(workspaceId), index)),
        );
        assert.equal(results.filter(Boolean).length, 100);
        assert.equal(await acquire(request(workspaceId, 1, 'ingestion')), false);
        assert.equal(await acquire(request(), 1), true);
        assert.deepEqual(await usage(), { requests: 101, tokens: 101 });
      });

      await t.test('workspace ingestion request ceiling reserves queries in the same workspace', async () => {
        await reset();
        const workspaceId = randomUUID();
        const background = await Promise.all(
          Array.from({ length: 90 }, (_, index) => acquire(request(workspaceId, 1, 'ingestion'), index)),
        );
        assert.equal(background.filter(Boolean).length, 75);
        assert.equal(await acquire(request(workspaceId, 1, 'ingestion'), 1), false);
        const queries = await Promise.all(
          Array.from({ length: 30 }, (_, index) => acquire(request(workspaceId), index)),
        );
        assert.equal(queries.filter(Boolean).length, 25);
        assert.equal(await acquire(request(workspaceId)), false);
        assert.equal(await acquire(request(), 1), true);
        assert.deepEqual(await usage(), { requests: 101, tokens: 101 });
      });

      await t.test('token ceilings reserve queries globally and within the ingesting workspace', async () => {
        await reset();
        const noisy = randomUUID();
        const localBackground = await Promise.all(
          Array.from({ length: 4 }, (_, index) => acquire(request(noisy, 25000, 'ingestion'), index)),
        );
        assert.equal(localBackground.filter(Boolean).length, 3);
        assert.equal(await acquire(request(noisy, 1, 'ingestion'), 1), false);
        assert.equal(await acquire(request(noisy, 25000)), true);
        assert.equal(await acquire(request(noisy)), false);
        const background = await Promise.all(
          Array.from({ length: 4 }, (_, index) => acquire(request(randomUUID(), 75000, 'ingestion'), index)),
        );
        assert.equal(background.filter(Boolean).length, 3);
        assert.equal(await acquire(request(randomUUID(), 1, 'ingestion')), false);
        assert.equal(await acquire(request(randomUUID(), 75000), 1), true);
        assert.equal(await acquire(request()), false);
        assert.deepEqual(await usage(), { requests: 8, tokens: 400000 });
      });

      await t.test('accepted attempts replay across factories once and reject changed payloads', async () => {
        await reset();
        const input = request(randomUUID(), 75000, 'ingestion');
        assert.deepEqual(
          await Promise.all(Array.from({ length: 30 }, (_, index) => acquire(input, index))),
          Array(30).fill(true),
        );
        assert.deepEqual(await usage(), { requests: 1, tokens: 75000 });
        for (const change of [{ tokens: 1 }, { purpose: 'query' }, { workspaceId: randomUUID() }]) {
          await assert.rejects(acquire({ ...input, ...change }, 1), { code: '22023' });
        }
        assert.deepEqual(await usage(), { requests: 1, tokens: 75000 });
        assert.equal(await acquire(request(input.workspaceId, 25000)), true);
        assert.equal(await acquire(input, 1), true);
      });

      await t.test(
        'rolling expiry releases requests at ten seconds and tokens at sixty without replay refreshing time',
        async () => {
          await reset();
          const workspaceId = randomUUID();
          const inputs = Array.from({ length: 100 }, () => request(workspaceId, 1000));
          assert.deepEqual(await Promise.all(inputs.map(acquire)), Array(100).fill(true));
          await db.platform.query(`UPDATE ${claims} SET claimed_at=clock_timestamp()-interval '11 seconds'`);
          const before = (
            await db.platform.query(`SELECT claimed_at FROM ${claims} WHERE attempt_id=$1`, [inputs[0].attemptId])
          ).rows[0];
          assert.equal(await acquire(inputs[0], 1), true);
          assert.deepEqual(
            (await db.platform.query(`SELECT claimed_at FROM ${claims} WHERE attempt_id=$1`, [inputs[0].attemptId]))
              .rows[0],
            before,
          );
          assert.equal(await acquire(request(workspaceId)), false, 'Minute token budget survives request expiry');
          assert.equal(await acquire(request()), true);
          await db.platform.query(`UPDATE ${claims} SET claimed_at=clock_timestamp()-interval '61 seconds'`);
          assert.equal(await acquire(inputs[0], 1), true, 'Expired attempt must obtain a fresh reservation');
          assert.deepEqual(await usage(), { requests: 1, tokens: 1000 });
          await reset();
          assert.deepEqual(
            await Promise.all(Array.from({ length: 100 }, () => acquire(request(workspaceId)))),
            Array(100).fill(true),
          );
          const rejected = request(workspaceId);
          assert.equal(await acquire(rejected), false);
          await db.platform.query(`UPDATE ${claims} SET claimed_at=clock_timestamp()-interval '11 seconds'`);
          assert.equal(await acquire(rejected, 1), true, 'Denied attempt can retry after the rolling request window');
          assert.deepEqual(await usage(), { requests: 101, tokens: 101 });
        },
      );

      await t.test('SQL boundary rejects invalid inputs and unsafe isolation without spending capacity', async () => {
        await reset();
        for (const [purpose, tokens] of [
          ['query', 0],
          ['query', -1],
          ['other', 1],
          [null, 1],
          ['query', null],
        ]) {
          await assert.rejects(
            worker.query('SELECT app.acquire_knowledge_embedding_capacity($1,$2,$3,$4)', [
              randomUUID(),
              purpose,
              tokens,
              randomUUID(),
            ]),
            { code: '22023' },
          );
        }
        await assert.rejects(acquire(request(randomUUID(), 1.5)));
        assert.equal(await acquire(request(randomUUID(), 100001)), false);
        const transaction = await api.connect();
        try {
          await transaction.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(createKnowledgeEmbeddingCapacity(transaction).acquire(request()), { code: '25000' });
        } finally {
          await transaction.query('ROLLBACK');
          transaction.release();
        }
        assert.deepEqual(await usage(), { requests: 0, tokens: 0 });
        assert.equal(await acquire(request()), true);
      });
    } finally {
      await Promise.all(pools.map(pool => pool.end()));
      for (const role of roles.reverse()) {
        await db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
        await db.admin.query(`DROP ROLE ${escapeIdentifier(role)}`);
      }
      await db.close();
    }
  },
);

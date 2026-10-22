import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { readKnowledgeCreditGroup } from '@tulipfarm/workspace-storage/knowledge-credits';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { AccessDenied } from '@tulipfarm/access';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createKnowledgeEmbeddings, createLocalKnowledge, KnowledgeError } from '../dist/index.js';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const config = {
  kind: 'enabled',
  endpoint: 'https://example.services.ai.azure.com/',
  apiKey: 'fixture-only',
  profile: knowledgeEmbeddingProfile,
};
const vector = Array(1536).fill(0.25);
const success = () => ({
  dispatch: 'dispatched',
  inputTokensUpperBound: 1,
  requestId: 'fixture-request',
  usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
  result: { kind: 'success', model: 'text-embedding-3-large', vectors: [vector] },
});
const unknown = () => ({
  dispatch: 'dispatched',
  inputTokensUpperBound: 1,
  requestId: null,
  usage: { kind: 'unknown', reason: 'timeout' },
  result: { kind: 'error', code: 'timeout' },
});

test('durable embeddings with restricted workspace SQL', async t => {
  const db = await fixture();
  const runtimes = [];
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    const runtime = () => {
      const value = createWorkspaceRuntime({
        replicaCount: 2,
        maxPools: 16,
        connectionsPerPool: 2,
        reservedConnections: 2,
        databaseConnectionBudget: 80,
        resolveCredential: async id => {
          const ws = db.workspaces.find(item => item.id === id);
          assert.ok(ws);
          return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
        },
      });
      runtimes.push(value);
      return value;
    };
    const firstRuntime = runtime();
    const secondRuntime = runtime();
    async function workspace(balance = '10000000000000') {
      const ws = await db.create(stream);
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, [balance]);
      const group = () =>
        firstRuntime.transaction(ws.id, { minimum: stream.length, maximum: stream.length }, readKnowledgeCreditGroup);
      const make = (provider, extra = {}) =>
        createKnowledgeEmbeddings({ runtime: firstRuntime, config, capacity: async () => true, provider, ...extra });
      const prepare = (api, query, commandId = randomUUID()) =>
        api.prepareQuery(ws.id, ws.userId, { commandId, query });
      const process = (api, query) =>
        api.process({ workspaceId: ws.id, jobId: query.jobId, generation: query.generation });
      const status = (api, query) => api.queryStatus(ws.id, ws.userId, query.commandId);
      return { ws, table, group, make, prepare, process, status };
    }
    await t.test('two runtime pools singleflight exact input, persist cache and keep command IDs private', async () => {
      const w = await workspace();
      let calls = 0,
        release,
        entered;
      const started = new Promise(resolve => {
        entered = resolve;
      });
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const provider = async ({ inputs }) => {
        calls++;
        assert.deepEqual(inputs, ['private exact query']);
        entered();
        await gate;
        return success();
      };
      const api = w.make(provider);
      const other = w.make(provider, { runtime: secondRuntime });
      const a = await w.prepare(api, 'private exact query');
      const b = await w.prepare(other, 'private exact query');
      const running = w.process(api, a);
      await started;
      assert.equal((await w.process(other, b)).disposition, 'busy');
      assert.equal((await w.status(other, a)).state, 'busy');
      release();
      assert.equal((await running).disposition, 'ready');
      assert.deepEqual((await w.status(other, b)).vector, vector);
      assert.equal((await w.prepare(other, 'private exact query')).state, 'ready');
      assert.equal(calls, 1);
      assert.equal((await w.group()).known, '19500000');
      assert.equal((await w.group()).pending, '0');
      await assert.rejects(
        w.prepare(api, 'different', a.commandId),
        error => error instanceof KnowledgeError && error.code === 'conflict',
      );
      const stranger = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${w.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        stranger.membershipId,
        stranger.userId,
      ]);
      await assert.rejects(api.queryStatus(w.ws.id, stranger.userId, a.commandId), AccessDenied);
      const sameId = await api.prepareQuery(w.ws.id, stranger.userId, {
        commandId: a.commandId,
        query: 'another private query',
      });
      assert.notEqual(sameId.jobId, a.jobId);
      const login = await connect(db.login(w.ws));
      try {
        await denied(login, `UPDATE ${w.table('embedding_items')} SET input_text='changed'`);
        await denied(login, `UPDATE ${w.table('embedding_vectors')} SET vector='[]'`);
        await denied(login, `UPDATE ${w.table('embedding_profiles')} SET profile='{}'`);
      } finally {
        await login.end();
      }
    });
    await t.test('uncertainty retains hold and only an idempotent explicit retry buys another attempt', async () => {
      const w = await workspace();
      let calls = 0;
      const api = w.make(async () => {
        calls++;
        return calls === 1 ? unknown() : success();
      });
      const query = await w.prepare(api, 'uncertain query');
      assert.equal((await w.process(api, query)).disposition, 'unknown');
      const pending = (await w.group()).pending;
      assert.notEqual(pending, '0');
      assert.equal((await w.process(api, query)).disposition, 'unknown');
      assert.deepEqual(await api.due(w.ws.id), []);
      assert.equal(calls, 1);
      const retry = { commandId: randomUUID(), expectedGeneration: 1 };
      const retried = await api.retryQuery(w.ws.id, w.ws.userId, query.commandId, retry);
      assert.equal(retried.generation, 2);
      assert.equal((await api.retryQuery(w.ws.id, w.ws.userId, query.commandId, retry)).generation, 2);
      assert.equal((await w.process(api, query)).disposition, 'stale');
      assert.equal((await w.process(api, retried)).disposition, 'ready');
      assert.equal(calls, 2);
      assert.equal((await w.group()).pending, pending);
      assert.equal((await w.group()).known, '19500000');
    });
    await t.test('invalid input, disabled mode, empty credits and default capacity never dispatch', async () => {
      const w = await workspace('0');
      let calls = 0;
      const provider = async () => {
        calls++;
        return success();
      };
      const api = w.make(provider);
      const invalid = await w.prepare(api, ' '.repeat(100));
      assert.equal(invalid.state, 'invalid-input');
      assert.equal(invalid.canRetry, false);
      assert.equal((await w.process(api, invalid)).disposition, 'invalid-input');
      const query = await w.prepare(api, 'unfunded query');
      assert.equal((await w.process(api, query)).disposition, 'credits-blocked');
      assert.equal((await w.process(api, query)).disposition, 'credits-blocked');
      const disabled = w.make(provider, { config: { kind: 'disabled' } });
      assert.equal((await w.prepare(disabled, 'disabled query')).state, 'disabled');
      const noCapacity = createKnowledgeEmbeddings({ runtime: firstRuntime, config, provider });
      assert.equal(
        (await w.process(noCapacity, await w.prepare(noCapacity, 'capacity query'))).disposition,
        'capacity-blocked',
      );
      assert.equal(calls, 0);
      assert.equal((await w.group()).known, '0');
      assert.equal((await w.group()).pending, '0');
    });
    await t.test('lease recovery never repeats uncertain dispatch and accepts a late known observation', async () => {
      const w = await workspace();
      let release,
        entered,
        calls = 0;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const started = new Promise(resolve => {
        entered = resolve;
      });
      const api = w.make(async () => {
        calls++;
        entered();
        await gate;
        return success();
      });
      const query = await w.prepare(api, 'crash recovery query');
      const processing = w.process(api, query);
      await started;
      await db.platform.query(
        `UPDATE ${w.table('embedding_cache')} SET lease_until=clock_timestamp()-interval '1 second' WHERE state='dispatched'`,
      );
      const restarted = w.make(
        async () => {
          throw new Error('uncertain attempt must not dispatch again');
        },
        { runtime: secondRuntime },
      );
      assert.deepEqual(await restarted.due(w.ws.id), []);
      assert.equal((await w.status(restarted, query)).state, 'unknown');
      assert.equal((await w.process(restarted, query)).disposition, 'unknown');
      assert.notEqual((await w.group()).pending, '0');
      release();
      assert.equal((await processing).disposition, 'ready');
      assert.deepEqual((await w.status(restarted, query)).vector, vector);
      assert.equal(calls, 1);
      assert.equal((await w.group()).pending, '0');
      assert.equal((await w.group()).known, '19500000');
    });
    await t.test('true retries are bounded and workspace caches cannot cross billing boundaries', async () => {
      const w = await workspace();
      let calls = 0;
      const api = w.make(async () => {
        calls++;
        return { ...success(), result: { kind: 'error', code: 'invalid_vectors' } };
      });
      let query = await w.prepare(api, 'bounded retry query');
      for (let generation = 1; generation <= 8; generation++) {
        assert.equal((await w.process(api, query)).disposition, 'failed');
        if (generation < 8)
          query = await api.retryQuery(w.ws.id, w.ws.userId, query.commandId, {
            commandId: randomUUID(),
            expectedGeneration: generation,
          });
      }
      assert.equal((await w.status(api, query)).canRetry, false);
      await assert.rejects(
        api.retryQuery(w.ws.id, w.ws.userId, query.commandId, { commandId: randomUUID(), expectedGeneration: 8 }),
        error => error instanceof KnowledgeError && error.code === 'conflict',
      );
      assert.equal(calls, 8);
      const other = await workspace();
      const independent = other.make(async () => success());
      const fresh = await other.prepare(independent, 'bounded retry query');
      assert.equal(fresh.state, 'queued');
      assert.equal((await other.process(independent, fresh)).disposition, 'ready');
      assert.equal((await other.group()).known, '19500000');
    });
    await t.test(
      'a transient failure before commit retries the captured outcome without a second provider request',
      async () => {
        const w = await workspace();
        let saving = false,
          saves = 0,
          calls = 0;
        const faultRuntime = {
          transaction: (workspaceId, compatibility, operation) =>
            firstRuntime.transaction(workspaceId, compatibility, async tx => {
              const value = await operation(tx);
              if (saving) {
                saves++;
                if (saves === 1)
                  await tx.client.query(
                    "DO $$ BEGIN RAISE EXCEPTION 'serialization failure fixture' USING ERRCODE='40001'; END $$",
                  );
                saving = false;
              }
              return value;
            }),
        };
        const api = w.make(
          async () => {
            calls++;
            saving = true;
            return success();
          },
          { runtime: faultRuntime },
        );
        const query = await w.prepare(api, 'save the known response');
        assert.equal((await w.process(api, query)).disposition, 'ready');
        assert.equal(saves, 2);
        assert.equal(calls, 1);
        assert.deepEqual((await w.status(api, query)).vector, vector);
        assert.deepEqual(
          (
            await db.platform.query(`SELECT
        (SELECT count(*)::int FROM ${w.table('credit_observations')}) AS observations,
        (SELECT count(*)::int FROM ${w.table('embedding_vectors')}) AS vectors`)
          ).rows,
          [{ observations: 1, vectors: 1 }],
        );
        assert.equal((await w.group()).known, '19500000');
        assert.equal((await w.group()).pending, '0');
      },
    );
    for (const failure of [
      { code: '23514', saves: 1 },
      { code: '40001', saves: 3 },
    ]) {
      await t.test(`outcome persistence bounds retries for SQL ${failure.code}`, async () => {
        const w = await workspace();
        let saving = false,
          saves = 0,
          calls = 0;
        const faultRuntime = {
          transaction: (workspaceId, compatibility, operation) =>
            firstRuntime.transaction(workspaceId, compatibility, async tx => {
              const value = await operation(tx);
              if (saving) {
                saves++;
                await tx.client.query(
                  `DO $$ BEGIN RAISE EXCEPTION 'persistence failure fixture' USING ERRCODE='${failure.code}'; END $$`,
                );
              }
              return value;
            }),
        };
        const api = w.make(
          async () => {
            calls++;
            saving = true;
            return success();
          },
          { runtime: faultRuntime },
        );
        const query = await w.prepare(api, 'bounded persistence retries');
        await assert.rejects(w.process(api, query), error => error.code === failure.code);
        assert.equal(saves, failure.saves);
        assert.equal(calls, 1);
        assert.equal((await w.group()).known, '0');
        assert.notEqual((await w.group()).pending, '0');
        assert.deepEqual(
          (
            await db.platform.query(`SELECT
          (SELECT count(*)::int FROM ${w.table('credit_observations')}) AS observations,
          (SELECT count(*)::int FROM ${w.table('embedding_vectors')}) AS vectors`)
          ).rows,
          [{ observations: 0, vectors: 0 }],
        );
      });
    }
    await t.test('a lost commit acknowledgement replays one known outcome and immutable vector', async () => {
      const w = await workspace();
      let saving = false,
        saves = 0,
        calls = 0;
      const faultRuntime = {
        transaction: async (workspaceId, compatibility, operation) => {
          const value = await firstRuntime.transaction(workspaceId, compatibility, operation);
          if (saving) {
            saves++;
            if (saves === 1) throw Object.assign(new Error('lost commit acknowledgement'), { code: 'ECONNRESET' });
            saving = false;
          }
          return value;
        },
      };
      const api = w.make(
        async () => {
          calls++;
          saving = true;
          return success();
        },
        { runtime: faultRuntime },
      );
      const query = await w.prepare(api, 'commit acknowledgement loss');
      assert.equal((await w.process(api, query)).disposition, 'ready');
      assert.equal(saves, 2);
      assert.equal(calls, 1);
      assert.deepEqual((await w.status(api, query)).vector, vector);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT
        (SELECT count(*)::int FROM ${w.table('credit_observations')}) AS observations,
        (SELECT count(*)::int FROM ${w.table('embedding_vectors')}) AS vectors`)
        ).rows,
        [{ observations: 1, vectors: 1 }],
      );
      assert.equal((await w.group()).known, '19500000');
      assert.equal((await w.group()).pending, '0');
    });
    for (const replacementState of ['queued', 'claimed', 'dispatched']) {
      await t.test(`a late original vector survives a ${replacementState} replacement`, async () => {
        const w = await workspace();
        let releaseOriginal,
          originalEntered,
          releaseReplacement,
          replacementEntered,
          calls = 0;
        const originalGate = new Promise(resolve => {
          releaseOriginal = resolve;
        });
        const originalStarted = new Promise(resolve => {
          originalEntered = resolve;
        });
        const replacementGate = new Promise(resolve => {
          releaseReplacement = resolve;
        });
        const replacementStarted = new Promise(resolve => {
          replacementEntered = resolve;
        });
        const original = w.make(async () => {
          calls++;
          originalEntered();
          await originalGate;
          return success();
        });
        const replacement = w.make(
          async () => {
            calls++;
            replacementEntered();
            await replacementGate;
            return unknown();
          },
          {
            runtime: secondRuntime,
            capacity: async () => {
              if (replacementState === 'claimed') {
                replacementEntered();
                await replacementGate;
              }
              return true;
            },
          },
        );
        const query = await w.prepare(original, 'late original result');
        const first = w.process(original, query);
        await originalStarted;
        await db.platform.query(
          `UPDATE ${w.table('embedding_cache')} SET lease_until=clock_timestamp()-interval '1 second' WHERE state='dispatched'`,
        );
        assert.deepEqual(await replacement.due(w.ws.id), []);
        const retried = await replacement.retryQuery(w.ws.id, w.ws.userId, query.commandId, {
          commandId: randomUUID(),
          expectedGeneration: 1,
        });
        const second = replacementState === 'queued' ? null : w.process(replacement, retried);
        if (second) await replacementStarted;
        try {
          releaseOriginal();
          assert.equal((await first).disposition, 'ready');
          assert.deepEqual((await w.status(replacement, retried)).vector, vector);
          const accounting = await w.group();
          assert.equal(accounting.known, '19500000');
          if (replacementState === 'dispatched') assert.notEqual(accounting.pending, '0');
          else assert.equal(accounting.pending, '0');
        } finally {
          releaseOriginal();
          releaseReplacement();
        }
        assert.equal((await (second ?? w.process(replacement, retried))).disposition, 'ready');
        assert.equal(calls, replacementState === 'dispatched' ? 2 : 1);
        assert.deepEqual((await w.status(replacement, retried)).vector, vector);
        assert.deepEqual(
          (await db.platform.query(`SELECT state FROM ${w.table('credit_attempts')} ORDER BY created_at`)).rows,
          replacementState === 'dispatched' ? [{ state: 'known' }, { state: 'unknown' }] : [{ state: 'known' }],
        );
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${w.table('embedding_vectors')}`)).rows[0].count,
          1,
        );
      });
    }
    await t.test(
      'revocation during capacity prevents dispatch and late provider success settles without exposing result',
      async () => {
        const w = await workspace();
        let calls = 0;
        const revoke = () =>
          db.platform.query(`UPDATE ${w.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
            w.ws.membershipId,
          ]);
        const restore = () =>
          db.platform.query(`UPDATE ${w.table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [w.ws.membershipId]);
        const api = w.make(
          async () => {
            calls++;
            return success();
          },
          {
            capacity: async () => {
              await revoke();
              return true;
            },
          },
        );
        const query = await w.prepare(api, 'revoke before dispatch');
        assert.equal((await w.process(api, query)).disposition, 'stale');
        assert.equal(calls, 0);
        await restore();
        const late = w.make(async () => {
          calls++;
          await revoke();
          return success();
        });
        const second = await w.prepare(late, 'revoke after dispatch');
        assert.equal((await w.process(late, second)).disposition, 'stale');
        assert.equal((await w.group()).known, '19500000');
        assert.equal((await w.group()).pending, '0');
        await assert.rejects(w.status(late, second), AccessDenied);
      },
    );
    await t.test('catalogue discovery publishes complete heading-inclusive vectors by ordinal', async () => {
      const w = await workspace();
      const local = createLocalKnowledge({
        runtime: firstRuntime,
        files: createFiles(firstRuntime, {
          putIfAbsent: async () => {},
          read: async () => {
            throw new Error('unexpected object read');
          },
        }),
      });
      const saved = await local.save(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Returns',
        input: {
          kind: 'note',
          text: 'Read this first.\n\n# Returns\nReturn the order within thirty days.\n\n## Exceptions\nKeep the receipt.',
        },
      });
      assert.equal((await local.process((await local.due(w.ws.id))[0])).disposition, 'ready');
      const inputs = [];
      const api = w.make(async request => {
        inputs.push(...request.inputs);
        return success();
      });
      const due = await api.due(w.ws.id);
      assert.equal(due.length, 1);
      assert.equal((await api.process(due[0])).disposition, 'retry');
      assert.equal((await api.process(due[0])).disposition, 'retry');
      assert.equal((await api.process(due[0])).disposition, 'ready');
      const status = await api.documentStatus(w.ws.id, w.ws.userId, saved.documentId);
      assert.equal(status.state, 'ready');
      assert.equal(status.completedChunks, 3);
      assert.equal(status.totalChunks, 3);
      assert.deepEqual(inputs, [
        'Read this first.',
        '# Returns\n\nReturn the order within thirty days.',
        '# Returns\n## Exceptions\n\nKeep the receipt.',
      ]);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT tokens FROM ${w.table('embedding_items')} WHERE job_id=$1 ORDER BY ordinal`, [
            status.jobId,
          ])
        ).rows,
        [{ tokens: 4 }, { tokens: 10 }, { tokens: 10 }],
      );
      assert.deepEqual((await api.documentResult(w.ws.id, w.ws.userId, saved.documentId)).chunks[0].vector, vector);
      assert.ok(
        (
          await db.platform.query(`SELECT vector_publication_id FROM ${w.table('documents')} WHERE id=$1`, [
            saved.documentId,
          ])
        ).rows[0].vector_publication_id,
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${w.table('search_vectors')}`)).rows[0].count,
        3,
      );
      assert.equal((await local.get(w.ws.id, w.ws.userId, saved.documentId)).parsing, 'ready');
      await local.save(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: saved.documentId,
        expectedRevisionId: saved.revisionId,
        title: 'Updated',
        input: { kind: 'note', text: 'Updated return conditions.' },
      });
      await assert.rejects(
        api.documentResult(w.ws.id, w.ws.userId, saved.documentId),
        error => error instanceof KnowledgeError && error.code === 'incomplete',
      );
      assert.equal((await api.process(due[0])).disposition, 'stale');
    });
    await t.test(
      'a file grant revoked during discovery recovers its publication inputs once the grant returns',
      async () => {
        const w = await workspace();
        const reader = { userId: randomUUID(), membershipId: randomUUID() };
        await db.platform.query(`INSERT INTO ${w.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          reader.membershipId,
          reader.userId,
        ]);
        const objects = new Map();
        const files = createFiles(firstRuntime, {
          putIfAbsent: async (key, bytes) => {
            if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
          },
          read: async key => Buffer.from(objects.get(key)),
          remove: async key => {
            objects.delete(key);
          },
        });
        const local = createLocalKnowledge({ runtime: firstRuntime, files });
        const fileId = randomUUID();
        await files.upload(
          w.ws.id,
          w.ws.userId,
          fileId,
          { name: 'Returns.md', parentId: null, mediaType: 'text/markdown' },
          Buffer.from('# Returns\nReturn orders within thirty days.\n\n# Exceptions\nKeep the receipt.'),
        );
        const grant = role =>
          files.share(w.ws.id, w.ws.userId, fileId, { kind: 'individual', id: reader.membershipId }, role);
        await grant('viewer');
        const saved = await local.save(w.ws.id, reader.userId, {
          commandId: randomUUID(),
          documentId: randomUUID(),
          expectedRevisionId: null,
          title: 'Returns.md',
          input: { kind: 'file', fileId },
        });
        const parse = (await local.due(w.ws.id)).find(item => item.revisionId === saved.revisionId);
        await local.acknowledge(parse);
        assert.equal((await local.process(parse)).disposition, 'ready');
        const inputs = [];
        const api = w.make(async request => {
          inputs.push(...request.inputs);
          return success();
        });
        const items = async jobId =>
          (
            await db.platform.query(
              `SELECT ordinal,input_text FROM ${w.table('embedding_items')} WHERE job_id=$1 ORDER BY ordinal`,
              [jobId],
            )
          ).rows;
        const expected = [
          { ordinal: 0, input_text: '# Returns\n\nReturn orders within thirty days.' },
          { ordinal: 1, input_text: '# Exceptions\n\nKeep the receipt.' },
        ];

        await grant(null);
        assert.deepEqual(await api.due(w.ws.id), [], 'discovery under a revoked grant dispatches nothing');
        await assert.rejects(api.documentStatus(w.ws.id, reader.userId, saved.documentId), AccessDenied);
        await grant('viewer');
        const failed = await api.documentStatus(w.ws.id, reader.userId, saved.documentId);
        assert.deepEqual(
          {
            state: failed.state,
            canRetry: failed.canRetry,
            generation: failed.generation,
            completedChunks: failed.completedChunks,
            totalChunks: failed.totalChunks,
          },
          { state: 'failed', canRetry: true, generation: 1, completedChunks: 0, totalChunks: 2 },
        );
        assert.deepEqual(await items(failed.jobId), []);

        const retry = { commandId: randomUUID(), expectedGeneration: 1, expectedJobId: failed.jobId };
        await grant(null);
        await assert.rejects(api.retryDocument(w.ws.id, reader.userId, saved.documentId, retry), AccessDenied);
        assert.deepEqual(await items(failed.jobId), [], 'a denied retry creates no inputs');
        await grant('viewer');
        const queued = await api.retryDocument(w.ws.id, reader.userId, saved.documentId, retry);
        assert.deepEqual(
          { jobId: queued.jobId, state: queued.state, generation: queued.generation, totalChunks: queued.totalChunks },
          { jobId: failed.jobId, state: 'queued', generation: 2, totalChunks: 2 },
        );
        assert.deepEqual(await items(failed.jobId), expected);
        assert.equal(
          (await api.retryDocument(w.ws.id, reader.userId, saved.documentId, retry)).generation,
          2,
          'a replayed retry is idempotent',
        );
        await assert.rejects(
          api.retryDocument(w.ws.id, reader.userId, saved.documentId, { ...retry, commandId: randomUUID() }),
          error => error instanceof KnowledgeError && error.code === 'conflict',
        );
        assert.deepEqual(await items(failed.jobId), expected);
        assert.deepEqual(inputs, [], 'no provider request before the recovered job is processed');

        const due = await api.due(w.ws.id);
        assert.deepEqual(due, [{ workspaceId: w.ws.id, jobId: failed.jobId, generation: 2 }]);
        assert.equal((await api.process(due[0])).disposition, 'retry');
        assert.equal((await api.process(due[0])).disposition, 'ready');
        assert.deepEqual(inputs, [
          '# Returns\n\nReturn orders within thirty days.',
          '# Exceptions\n\nKeep the receipt.',
        ]);
        const ready = await api.documentStatus(w.ws.id, reader.userId, saved.documentId);
        assert.deepEqual(
          { state: ready.state, completedChunks: ready.completedChunks, totalChunks: ready.totalChunks },
          { state: 'ready', completedChunks: 2, totalChunks: 2 },
        );
        assert.deepEqual(await api.due(w.ws.id), []);
      },
    );
    await t.test('a queued ingestion job left without inputs initializes them before dispatch', async () => {
      const w = await workspace();
      const local = createLocalKnowledge({
        runtime: firstRuntime,
        files: createFiles(firstRuntime, {
          putIfAbsent: async () => {},
          read: async () => {
            throw new Error('unexpected object read');
          },
        }),
      });
      const saved = await local.save(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Orphaned job',
        input: { kind: 'note', text: '# Orchids\nWater weekly.' },
      });
      await local.process((await local.due(w.ws.id))[0]);
      const inputs = [];
      const api = w.make(async request => {
        inputs.push(...request.inputs);
        return success();
      });
      const [work] = await api.due(w.ws.id);
      await db.platform.query(`DELETE FROM ${w.table('embedding_items')} WHERE job_id=$1`, [work.jobId]);
      assert.deepEqual(await api.due(w.ws.id), [work]);
      assert.equal((await api.process(work)).disposition, 'ready');
      assert.deepEqual(inputs, ['# Orchids\n\nWater weekly.']);
      assert.equal((await api.documentStatus(w.ws.id, w.ws.userId, saved.documentId)).state, 'ready');
      assert.deepEqual(await api.due(w.ws.id), []);
    });
    await t.test('document retries cannot retarget a newer publication at the same generation', async () => {
      const w = await workspace();
      const local = createLocalKnowledge({
        runtime: firstRuntime,
        files: createFiles(firstRuntime, {
          putIfAbsent: async () => {},
          read: async () => {
            throw new Error('unexpected object read');
          },
        }),
      });
      const api = w.make(async () => unknown());
      const first = await local.save(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Original',
        input: { kind: 'note', text: 'Original passage.' },
      });
      await local.process((await local.due(w.ws.id))[0]);
      const firstWork = (await api.due(w.ws.id))[0];
      assert.equal((await api.process(firstWork)).disposition, 'unknown');
      const retry = { commandId: randomUUID(), expectedGeneration: 1, expectedJobId: firstWork.jobId };
      await local.save(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: first.documentId,
        expectedRevisionId: first.revisionId,
        title: 'New revision',
        input: { kind: 'note', text: 'Replacement passage.' },
      });
      await local.process((await local.due(w.ws.id))[0]);
      const next = (await api.due(w.ws.id))[0];
      assert.equal(next.generation, 1);
      assert.notEqual(next.jobId, firstWork.jobId);
      assert.equal((await api.process(next)).disposition, 'unknown');
      await assert.rejects(
        api.retryDocument(w.ws.id, w.ws.userId, first.documentId, retry),
        error => error instanceof KnowledgeError && error.code === 'conflict',
      );
      assert.equal((await api.documentStatus(w.ws.id, w.ws.userId, first.documentId)).generation, 1);
      assert.equal((await api.documentStatus(w.ws.id, w.ws.userId, first.documentId)).state, 'unknown');
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${w.table('embedding_retries')}`)).rows[0].count,
        0,
      );
      const accepted = await api.retryDocument(w.ws.id, w.ws.userId, first.documentId, {
        ...retry,
        expectedJobId: next.jobId,
      });
      assert.equal(accepted.generation, 2);
      assert.equal(accepted.state, 'queued');
    });
    await t.test(
      'completed chunks cannot block remaining work while a replacement retains an unknown hold',
      async () => {
        const w = await workspace();
        const local = createLocalKnowledge({
          runtime: firstRuntime,
          files: createFiles(firstRuntime, {
            putIfAbsent: async () => {},
            read: async () => {
              throw new Error('unexpected object read');
            },
          }),
        });
        const saved = await local.save(w.ws.id, w.ws.userId, {
          commandId: randomUUID(),
          documentId: randomUUID(),
          expectedRevisionId: null,
          title: 'Two passages',
          input: { kind: 'note', text: '# First\nOriginal paragraph.\n\n# Second\nRemaining paragraph.' },
        });
        await local.process((await local.due(w.ws.id))[0]);
        let releaseOriginal, originalEntered, releaseReplacement, replacementEntered;
        const originalGate = new Promise(resolve => {
          releaseOriginal = resolve;
        });
        const originalStarted = new Promise(resolve => {
          originalEntered = resolve;
        });
        const replacementGate = new Promise(resolve => {
          releaseReplacement = resolve;
        });
        const replacementStarted = new Promise(resolve => {
          replacementEntered = resolve;
        });
        const inputs = [];
        const original = w.make(async request => {
          inputs.push(...request.inputs);
          originalEntered();
          await originalGate;
          return success();
        });
        const replacement = w.make(
          async request => {
            inputs.push(...request.inputs);
            replacementEntered();
            await replacementGate;
            return {
              ...success(),
              result: { kind: 'success', model: 'text-embedding-3-large', vectors: [Array(1536).fill(0.75)] },
            };
          },
          { runtime: secondRuntime },
        );
        const remaining = w.make(async request => {
          inputs.push(...request.inputs);
          return success();
        });
        const work = (await original.due(w.ws.id))[0];
        const first = original.process(work);
        await originalStarted;
        await db.platform.query(
          `UPDATE ${w.table('embedding_cache')} SET lease_until=clock_timestamp()-interval '1 second' WHERE state='dispatched'`,
        );
        await replacement.due(w.ws.id);
        const retry = await replacement.retryDocument(w.ws.id, w.ws.userId, saved.documentId, {
          commandId: randomUUID(),
          expectedGeneration: 1,
          expectedJobId: work.jobId,
        });
        const second = replacement.process({ ...work, generation: retry.generation });
        await replacementStarted;
        try {
          releaseOriginal();
          assert.equal((await first).disposition, 'retry');
          assert.equal((await original.documentStatus(w.ws.id, w.ws.userId, saved.documentId)).state, 'queued');
          await db.platform.query(
            `UPDATE ${w.table('embedding_cache')} SET lease_until=clock_timestamp()-interval '1 second' WHERE state='dispatched'`,
          );
          const due = await remaining.due(w.ws.id);
          assert.deepEqual(due, [{ workspaceId: w.ws.id, jobId: work.jobId, generation: 2 }]);
          const held = (await w.group()).pending;
          assert.notEqual(held, '0');
          assert.equal((await remaining.process(due[0])).disposition, 'ready');
          assert.equal((await w.group()).pending, held);
          assert.deepEqual(inputs, [
            '# First\n\nOriginal paragraph.',
            '# First\n\nOriginal paragraph.',
            '# Second\n\nRemaining paragraph.',
          ]);
          const result = await remaining.documentResult(w.ws.id, w.ws.userId, saved.documentId);
          assert.deepEqual(
            result.chunks.map(chunk => chunk.vector[0]),
            [0.25, 0.25],
          );
          assert.deepEqual(
            (await db.platform.query(`SELECT state FROM ${w.table('credit_attempts')} ORDER BY created_at`)).rows,
            [{ state: 'known' }, { state: 'unknown' }, { state: 'known' }],
          );
        } finally {
          releaseOriginal();
          releaseReplacement();
        }
        assert.equal((await second).disposition, 'ready');
        assert.deepEqual(
          (await remaining.documentResult(w.ws.id, w.ws.userId, saved.documentId)).chunks[0].vector,
          vector,
        );
        assert.equal((await w.group()).known, '58500000');
        assert.equal((await w.group()).pending, '0');
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${w.table('embedding_vectors')}`)).rows[0].count,
          2,
        );
      },
    );
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.close()));
    await db.close();
  }
});

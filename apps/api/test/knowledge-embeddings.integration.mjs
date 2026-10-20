import { markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { Client, Connection } from '@temporalio/client';
import { createKnowledgeEmbeddings } from '@tulipfarm/knowledge';
import { parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import { createKnowledgeEmbeddingCapacity } from '@tulipfarm/knowledge/embedding-capacity';
import { createKnowledgeEmbeddingWorker } from '../../worker/dist/knowledge-embedding-composition.js';
import { registerKnowledgeComposition } from '../dist/knowledge-composition.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const { NativeConnection } = createRequire(new URL('../../worker/package.json', import.meta.url))('@temporalio/worker');

test(
  'HTTP document retry cannot apply an old job approval to a newer failed revision at the same generation',
  { timeout: 60000 },
  async () => {
    const env = {
      KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
      AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
      AZURE_FOUNDRY_API_KEY: 'fixture-only',
    };
    let calls = 0;
    const provider = async () => {
      calls++;
      return {
        dispatch: 'dispatched',
        inputTokensUpperBound: 1,
        requestId: `failed-revision-${calls}`,
        usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
        result: { kind: 'error', code: 'invalid_vectors' },
      };
    };
    const f = await knowledgeFixture({ filesEnabled: false, embeddings: { env, provider } });
    try {
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=2000000000000,granted=2000000000000`,
      );
      const domain = createKnowledgeEmbeddings({
        runtime: f.runtime,
        config: parseKnowledgeEmbeddingsConfig(env),
        provider,
        capacity: createKnowledgeEmbeddingCapacity(f.signed.identity).acquire,
      });
      const documentId = randomUUID(),
        path = `/documents/${documentId}/embeddings`;
      async function failedRevision(text, expectedRevisionId) {
        const input = { ...f.command({ kind: 'note', text }), expectedRevisionId };
        const saved = await f.save(documentId, input);
        assert.equal(saved.status, 200, saved.bytes.toString());
        assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
        const work = await domain.due(f.workspace.id);
        const current = await domain.documentStatus(f.workspace.id, f.signed.owner.id, documentId);
        const job = work.find(item => item.jobId === current.jobId);
        assert.ok(job);
        await domain.process(job);
        const response = await f.call(path);
        assert.equal(response.status, 200, response.bytes.toString());
        assert.equal(response.json().state, 'failed');
        assert.equal(response.json().generation, 1);
        assert.equal(response.json().canRetry, true);
        return response.json();
      }
      const first = await failedRevision('Private revision A content', null);
      const approval = { commandId: randomUUID(), expectedJobId: first.jobId, expectedGeneration: first.generation };
      const second = await failedRevision('Private revision B content', first.revisionId);
      assert.notEqual(second.jobId, first.jobId);
      const snapshot = async () => ({
        job: (
          await f.db.platform.query(
            `SELECT id,generation,state,dispatch_after FROM ${f.table('tf_knowledge_embedding_jobs')} WHERE id=$1`,
            [second.jobId],
          )
        ).rows,
        cache: (
          await f.db.platform.query(
            `SELECT c.input_hash,c.state,c.attempt_id,c.attempts FROM ${f.table('tf_knowledge_embedding_cache')} c
        JOIN ${f.table('tf_knowledge_embedding_items')} i USING (profile_id,input_hash) WHERE i.job_id=$1 ORDER BY i.ordinal`,
            [second.jobId],
          )
        ).rows,
        attempts: (
          await f.db.platform.query(
            `SELECT id,state FROM ${f.table('tf_knowledge_credit_attempts')} WHERE operation_id=$1 ORDER BY id`,
            [second.jobId],
          )
        ).rows,
        retries: (
          await f.db.platform.query(
            `SELECT command_id FROM ${f.table('tf_knowledge_embedding_retries')} WHERE job_id=$1`,
            [second.jobId],
          )
        ).rows,
      });
      const before = await snapshot();
      const stale = await f.call(`${path}/retry`, { method: 'POST', body: approval });
      assert.equal(stale.status, 409, stale.bytes.toString());
      assert.deepEqual(stale.json(), { error: 'knowledge-conflict' });
      const missingIdentity = await f.call(`${path}/retry`, {
        method: 'POST',
        body: { commandId: randomUUID(), expectedGeneration: 1 },
      });
      assert.equal(missingIdentity.status, 400);
      assert.deepEqual(await snapshot(), before);
      assert.equal(calls, 2);
      const after = await f.call(path);
      assert.deepEqual(after.json(), second);
      const currentApproval = { commandId: randomUUID(), expectedJobId: second.jobId, expectedGeneration: 1 };
      const accepted = await f.call(`${path}/retry`, { method: 'POST', body: currentApproval });
      assert.equal(accepted.status, 200, accepted.bytes.toString());
      assert.equal(accepted.json().jobId, second.jobId);
      assert.equal(accepted.json().generation, 2);
      assert.equal(accepted.json().state, 'queued');
      assert.equal(calls, 2);
    } finally {
      await f.close();
    }
  },
);

for (const initial of ['credits-blocked', 'unknown']) {
  test(
    `HTTP query retry recovers ${initial} with one new generation and idempotent accounting`,
    { timeout: 60000 },
    async () => {
      let calls = 0;
      const f = await knowledgeFixture({
        filesEnabled: false,
        embeddings: {
          env: {
            KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
            AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
            AZURE_FOUNDRY_API_KEY: 'fixture-only',
          },
          provider: async () => {
            calls++;
            if (initial === 'unknown' && calls === 1)
              return {
                dispatch: 'dispatched',
                inputTokensUpperBound: 1,
                requestId: null,
                usage: { kind: 'unknown', reason: 'transport' },
                result: { kind: 'error', code: 'transport' },
              };
            return {
              dispatch: 'dispatched',
              inputTokensUpperBound: 1,
              requestId: 'retry-fixture',
              usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
              result: { kind: 'success', model: 'text-embedding-3-large', vectors: [Array(1536).fill(0.5)] },
            };
          },
        },
      });
      try {
        const balance = initial === 'unknown' ? '2000000000000' : '0';
        await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=$1,granted=$1`, [balance]);
        const commandId = randomUUID(),
          query = 'private recovery query';
        const first = await f.call('/query-embeddings', { method: 'POST', body: { commandId, query } });
        assert.equal(first.status, 200, first.bytes.toString());
        assert.equal(first.json().state, initial);
        assert.equal(first.json().canRetry, true);
        const path = `/query-embeddings/${commandId}/retry`;
        const body = { commandId: randomUUID(), expectedGeneration: 1 };
        assert.equal((await f.call(path, { method: 'POST', body, cookie: '' })).status, 401);
        const denied = await f.call(path, { method: 'POST', body, cookie: f.signed.admin.cookie });
        assert.equal(denied.status, 404);
        assert.deepEqual(denied.json(), { error: 'knowledge-not-found' });
        const before = (await f.db.platform.query(`SELECT pending FROM ${f.table('tf_knowledge_credit_group')}`))
          .rows[0].pending;
        const oldAttempts = (
          await f.db.platform.query(`SELECT id,state FROM ${f.table('tf_knowledge_credit_attempts')} ORDER BY id`)
        ).rows;
        if (initial === 'unknown') {
          assert.equal(oldAttempts.length, 1);
          assert.equal(oldAttempts[0].state, 'unknown');
          assert.ok(BigInt(before) > 0n);
        } else {
          assert.deepEqual(oldAttempts, []);
          await f.db.platform.query(
            `UPDATE ${f.table('tf_credit_account')} SET available=2000000000000,granted=2000000000000`,
          );
        }
        for (let replay = 0; replay < 2; replay++) {
          const retry = await f.call(path, { method: 'POST', body });
          assert.equal(retry.status, 200, retry.bytes.toString());
          assert.equal(retry.json().state, 'ready');
          assert.equal(retry.json().generation, 2);
          assert.equal('vector' in retry.json(), false);
          assert.equal(retry.bytes.includes(query), false);
        }
        assert.equal(calls, initial === 'unknown' ? 2 : 1);
        const attempts = (
          await f.db.platform.query(`SELECT id,state FROM ${f.table('tf_knowledge_credit_attempts')} ORDER BY id`)
        ).rows;
        assert.equal(attempts.length, initial === 'unknown' ? 2 : 1);
        assert.equal(attempts.filter(row => row.state === 'known').length, 1);
        if (initial === 'unknown') {
          assert.deepEqual(
            attempts.find(row => row.id === oldAttempts[0].id),
            oldAttempts[0],
          );
          assert.equal(
            (await f.db.platform.query(`SELECT pending FROM ${f.table('tf_knowledge_credit_group')}`)).rows[0].pending,
            before,
          );
          const observation = (
            await f.db.platform.query(`SELECT attempt_id FROM ${f.table('tf_knowledge_credit_observations')}`)
          ).rows;
          assert.deepEqual(observation, [{ attempt_id: attempts.find(row => row.state === 'known').id }]);
        }
        assert.deepEqual(
          (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_knowledge_embedding_retries')}`))
            .rows,
          [{ count: 1 }],
        );
        const stale = await f.call(path, { method: 'POST', body: { ...body, commandId: randomUUID() } });
        assert.equal(stale.status, 409);
      } finally {
        await f.close();
      }
    },
  );
}

test('disabled query embedding HTTP command is authenticated, opaque, and leaves lexical search unchanged', async () => {
  const f = await knowledgeFixture({
    filesEnabled: false,
    embeddings: {
      env: {},
      provider: () => {
        throw new Error('Disabled provider invoked');
      },
    },
  });
  try {
    const commandId = randomUUID();
    const body = { commandId, query: 'private-disabled-query' };
    assert.equal((await f.call('/query-embeddings', { method: 'POST', body, cookie: '' })).status, 401);
    const result = await f.call('/query-embeddings', { method: 'POST', body });
    assert.equal(result.status, 200, result.bytes.toString());
    assert.equal(result.json().state, 'disabled');
    assert.equal(result.json().commandId, commandId);
    assert.equal('vector' in result.json(), false);
    assert.equal(result.bytes.includes('private-disabled-query'), false);
    const status = await f.call(`/query-embeddings/${commandId}`);
    assert.equal(status.status, 200, status.bytes.toString());
    assert.equal(status.json().state, 'disabled');
    const denied = await f.call(`/query-embeddings/${commandId}`, { cookie: f.signed.admin.cookie });
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.json(), { error: 'knowledge-not-found' });
    const input = f.command({ kind: 'note', text: 'orchard lexical remains available' });
    const documentId = randomUUID();
    assert.equal((await f.save(documentId, input)).status, 200);
    assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
    const lexical = await f.call('/search?query=orchard');
    assert.equal(lexical.status, 200);
    assert.deepEqual(
      lexical.json().hits.map(hit => hit.citation.documentId),
      [documentId],
    );
    const attempts = await f.db.platform.query(
      `SELECT count(*)::int AS count FROM ${f.table('tf_knowledge_credit_attempts')}`,
    );
    assert.deepEqual(attempts.rows, [{ count: 0 }]);
  } finally {
    await f.close();
  }
});

test(
  'API startup embedding composition discovers a parsed document without an embedding HTTP command',
  { timeout: 60000 },
  async () => {
    const f = await knowledgeFixture({ filesEnabled: false, embeddings: { env: {} } });
    let app, connection, clientConnection, composition, running;
    try {
      const input = f.command({ kind: 'note', text: 'Document discovered from the knowledge catalogue' }),
        documentId = randomUUID();
      assert.equal((await f.save(documentId, input)).status, 200);
      assert.deepEqual(await f.process(input.commandId), { disposition: 'ready' });
      await f.app.close();
      const directory = new URL('../../database/migrations/', import.meta.url);
      for (const migration of (await readdir(directory)).filter(name => /knowledge.*embedding/.test(name))) {
        await f.db.platform.query(await readFile(new URL(migration, directory), 'utf8'));
      }
      await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0,granted=0`);
      await markWorkspaceReady(f.db.platform, f.workspace.id);
      const env = {
        KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
        AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
        AZURE_FOUNDRY_API_KEY: 'fixture-only',
      };
      let providerCalls = 0;
      const provider = async () => {
        providerCalls++;
        return {
          dispatch: 'dispatched',
          inputTokensUpperBound: 1,
          requestId: 'fixture-document',
          usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
          result: { kind: 'success', model: 'text-embedding-3-large', vectors: [Array(1536).fill(0.25)] },
        };
      };
      const domain = createKnowledgeEmbeddings({
        runtime: f.runtime,
        config: parseKnowledgeEmbeddingsConfig(env),
        provider,
        capacity: createKnowledgeEmbeddingCapacity(f.signed.identity).acquire,
      });
      const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
      connection = await NativeConnection.connect({ address });
      clientConnection = await Connection.connect({ address });
      const client = new Client({ connection: clientConnection });
      composition = await createKnowledgeEmbeddingWorker({
        runtime: f.runtime,
        connection,
        env,
        pool: f.signed.identity,
        provider,
      });
      running = composition.worker.run();
      app = Fastify();
      registerKnowledgeComposition(app, {
        runtime: f.runtime,
        auth: f.signed.auth,
        pool: f.signed.identity,
        env,
        provider,
        temporal: { connection: clientConnection, client },
      });
      await app.ready();
      let status;
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          status = await domain.documentStatus(f.workspace.id, f.signed.owner.id, documentId);
        } catch (error) {
          if (error.code !== 'incomplete') throw error;
        }
        if (status?.state === 'credits-blocked') break;
        await delay(50);
      }
      assert.equal(status?.state, 'credits-blocked');
      assert.equal(providerCalls, 0);
      const path = `/workspaces/${f.workspace.id}/knowledge/documents/${documentId}/embeddings`;
      const headers = { cookie: f.signed.owner.cookie, origin: 'http://localhost:5173' };
      const before = await app.inject({ url: path, headers });
      assert.equal(before.statusCode, 200, before.body);
      assert.equal(before.json().canRetry, true);
      assert.equal('vector' in before.json(), false);
      const retryBody = {
        commandId: randomUUID(),
        expectedGeneration: before.json().generation,
        expectedJobId: before.json().jobId,
      };
      for (const method of ['GET', 'POST']) {
        const denied = await app.inject({
          method,
          url: path + (method === 'POST' ? '/retry' : ''),
          headers: { ...headers, cookie: f.signed.admin.cookie },
          ...(method === 'POST' ? { payload: retryBody } : {}),
        });
        assert.equal(denied.statusCode, 404);
        assert.deepEqual(denied.json(), { error: 'knowledge-not-found' });
      }
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=1000000000000,granted=1000000000000`,
      );
      for (let replay = 0; replay < 2; replay++) {
        const retried = await app.inject({ method: 'POST', url: `${path}/retry`, headers, payload: retryBody });
        assert.equal(retried.statusCode, 200, retried.body);
        assert.equal(retried.json().generation, 2);
        assert.equal('vector' in retried.json(), false);
      }
      for (let attempt = 0; attempt < 200; attempt++) {
        const response = await app.inject({ url: path, headers });
        assert.equal(response.statusCode, 200, response.body);
        status = response.json();
        if (status.state === 'ready') break;
        await delay(50);
      }
      await app.close();
      app = undefined;
      assert.equal(status?.state, 'ready');
      assert.equal(status.generation, 2);
      assert.equal(providerCalls, 1);
      const handle = client.workflow.getHandle(
        `knowledge-embedding-${f.workspace.id}-${status.jobId}-${status.generation}`,
      );
      await handle.result();
      assert.equal((await handle.describe()).taskQueue, 'tulipfarm-knowledge-embeddings');
      const result = await domain.documentResult(f.workspace.id, f.signed.owner.id, documentId);
      assert.equal(result.chunks[0].vector[0], 0.25);
      assert.equal(result.chunks[0].vector.length, 1536);
    } finally {
      await app?.close();
      if (composition) {
        composition.worker.shutdown();
        await running;
        await composition.close();
      }
      await connection?.close();
      await clientConnection?.close();
      await f.close();
    }
  },
);

test(
  'interactive embeddings persist after disconnect, reuse paid cache, and authorize opaque status',
  { timeout: 60000 },
  async () => {
    let release, entered;
    const providerEntered = new Promise(resolve => {
      entered = resolve;
    });
    const providerReleased = new Promise(resolve => {
      release = resolve;
    });
    let calls = 0;
    const f = await knowledgeFixture({
      filesEnabled: false,
      embeddings: {
        env: {
          KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
          AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
          AZURE_FOUNDRY_API_KEY: 'fixture-only',
        },
        provider: async ({ inputs, signal }) => {
          calls++;
          assert.equal(signal, undefined);
          assert.deepEqual(inputs, ['private-interactive-query']);
          entered();
          await providerReleased;
          return {
            dispatch: 'dispatched',
            inputTokensUpperBound: 1,
            requestId: 'fixture-request',
            usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
            result: { kind: 'success', model: 'text-embedding-3-large', vectors: [Array(1536).fill(0.125)] },
          };
        },
      },
    });
    try {
      await f.db.platform.query(
        `UPDATE ${f.table('tf_credit_account')} SET available=1000000000000,granted=1000000000000`,
      );
      const commandId = randomUUID(),
        controller = new AbortController();
      const pending = fetch(`${f.origin}${f.base}/query-embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: { cookie: f.signed.owner.cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ commandId, query: 'private-interactive-query' }),
      }).catch(error => error);
      await Promise.race([
        providerEntered,
        pending.then(() => {
          throw new Error('Command completed before provider dispatch');
        }),
      ]);
      const status = await f.call(`/query-embeddings/${commandId}`);
      assert.equal(status.status, 200, status.bytes.toString());
      assert.equal(status.json().state, 'busy');
      assert.equal('vector' in status.json(), false);
      controller.abort();
      assert.equal((await pending).name, 'AbortError');
      release();
      let ready;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await f.call(`/query-embeddings/${commandId}`);
        if (ready.json().state === 'ready') break;
        await delay(20);
      }
      assert.equal(ready.json().state, 'ready');
      assert.equal('vector' in ready.json(), false);
      assert.equal(ready.bytes.includes('private-interactive-query'), false);
      const replay = await f.call('/query-embeddings', {
        method: 'POST',
        body: { commandId: randomUUID(), query: 'private-interactive-query' },
      });
      assert.equal(replay.status, 200, replay.bytes.toString());
      assert.equal(replay.json().state, 'ready');
      assert.equal(calls, 1);
      assert.equal((await f.call(`/query-embeddings/${commandId}`, { cookie: f.signed.admin.cookie })).status, 404);
      const persisted = await f.db.platform
        .query(`SELECT (SELECT count(*)::int FROM ${f.table('tf_knowledge_embedding_vectors')}) AS vectors,
      (SELECT count(*)::int FROM ${f.table('tf_knowledge_credit_observations')}) AS observations`);
      assert.deepEqual(persisted.rows, [{ vectors: 1, observations: 1 }]);
    } finally {
      release();
      await f.close();
    }
  },
);

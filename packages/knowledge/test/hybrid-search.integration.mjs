import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createKnowledge,
  createKnowledgeEmbeddings,
  createLocalKnowledge,
  createKnowledgeSearch,
} from '../dist/index.js';
import { relevanceCases, judgmentStatus } from './fixtures/search-relevance.mjs';

const vector = axis => Array.from({ length: 1536 }, (_, index) => (index === axis ? 1 : 0));
const result = axis => ({
  dispatch: 'dispatched',
  inputTokensUpperBound: 1,
  requestId: 'hybrid-fixture',
  usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
  result: { kind: 'success', model: knowledgeEmbeddingProfile.model, vectors: [vector(axis)] },
});

test('hybrid search uses paid cache, current publications and bounded authorized pages', async t => {
  const db = await fixture();
  const runtimes = [];
  const searches = [];
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    const runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 16,
      connectionsPerPool: 2,
      reservedConnections: 2,
      databaseConnectionBudget: 40,
      resolveCredential: async id => {
        const ws = db.workspaces.find(item => item.id === id);
        assert.ok(ws);
        return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
      },
    });
    runtimes.push(runtime);
    async function setup({ balance = '10000000000000', provider } = {}) {
      const ws = await db.create(stream);
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, [balance]);
      let calls = 0;
      const bytes = new Map();
      const files = createFiles(runtime, {
        putIfAbsent: async (key, value) => {
          bytes.set(key, value);
        },
        read: async key => {
          assert.ok(bytes.has(key));
          return bytes.get(key);
        },
      });
      const local = createLocalKnowledge({ runtime, files });
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        config: {
          kind: 'enabled',
          endpoint: 'https://example.services.ai.azure.com/',
          apiKey: 'fixture-only',
          profile: knowledgeEmbeddingProfile,
        },
        capacity: async () => true,
        provider: async input => {
          calls++;
          return provider ? provider(input) : result(/supplier|payments before delivery/.test(input.inputs[0]) ? 0 : 1);
        },
      });
      const search = createKnowledgeSearch({ runtime, embeddings });
      searches.push(search);
      async function note(text, title = text, documentId = randomUUID(), expectedRevisionId = null) {
        const saved = await local.save(ws.id, ws.userId, {
          commandId: randomUUID(),
          documentId,
          expectedRevisionId,
          title,
          input: { kind: 'note', text },
        });
        for (const work of await local.due(ws.id)) await local.process(work);
        return saved;
      }
      async function index() {
        for (let step = 0; step < 100; step++) {
          const due = await embeddings.due(ws.id);
          for (const work of due) await embeddings.process(work);
          const pending = (
            await db.platform.query(
              `SELECT 1 FROM ${table('documents')} WHERE lexical_publication_id IS NOT NULL AND vector_publication_id IS NULL LIMIT 1`,
            )
          ).rowCount;
          if (!pending) return;
        }
        assert.fail('Vector publications did not become ready');
      }
      const submit = (query, extra = {}) =>
        search.search(ws.id, ws.userId, { kind: 'submitted', commandId: randomUUID(), query, ...extra });
      return { ws, table, files, local, embeddings, search, note, index, submit, calls: () => calls };
    }
    await t.test('typing is free; semantic-only result and filters reuse one paid query', async () => {
      const w = await setup();
      const supplier = await w.note('supplier advance settlement required', 'Vendor policy');
      await w.note('holiday office closure calendar', 'Office holidays');
      await w.index();
      const before = w.calls();
      const typing = await w.search.search(w.ws.id, w.ws.userId, { kind: 'typing', query: 'suppl' });
      assert.equal(typing.reason, 'typing');
      assert.equal(typing.hits[0].citation.documentId, supplier.documentId);
      assert.equal(w.calls(), before);
      assert.deepEqual((await w.local.search(w.ws.id, w.ws.userId, { query: 'payments before delivery' })).hits, []);
      const hybrid = await w.submit('payments before delivery');
      assert.equal(hybrid.mode, 'hybrid');
      assert.equal(hybrid.hits[0].citation.documentId, supplier.documentId);
      assert.equal(w.calls(), before + 1);
      const filtered = await w.submit('payments before delivery', { filters: { documentIds: [supplier.documentId] } });
      assert.equal(filtered.hits.length, 1);
      assert.equal(w.calls(), before + 1);
      const evidence = await w.local.evidence(w.ws.id, w.ws.userId, hybrid.hits[0].citation);
      assert.equal(evidence.text, 'supplier advance settlement required');
      const absent = await w.submit('private query never bought', { filters: { kinds: ['file'] } });
      assert.deepEqual(absent.hits, []);
      assert.equal(w.calls(), before + 1);
    });
    await t.test('parsed documents are keyword-searchable before embeddings and report freshness', async () => {
      const w = await setup();
      const early = await w.note('orchard irrigation schedule for quince rows', 'Irrigation plan');
      const vector = (
        await db.platform.query(
          `SELECT lexical_publication_id,vector_publication_id FROM ${w.table('documents')} WHERE id=$1`,
          [early.documentId],
        )
      ).rows[0];
      assert.ok(vector.lexical_publication_id);
      assert.equal(vector.vector_publication_id, null);
      const before = await w.submit('quince irrigation');
      const hit = before.hits.find(entry => entry.citation.documentId === early.documentId);
      assert.ok(hit, 'lexical hit before vector publication');
      assert.match(hit.freshness.indexedAt, /^\d{4}-/);
      assert.ok(Date.parse(hit.freshness.indexedAt) >= Date.parse(hit.freshness.observedAt));
      assert.equal(hit.freshness.sourceSyncedAt, null);
      await w.index();
      const after = await w.submit('quince irrigation');
      assert.equal(after.mode, 'hybrid');
      assert.equal(after.hits[0].citation.documentId, early.documentId);
      assert.equal(after.hits[0].freshness.indexedAt, hit.freshness.indexedAt);
    });
    await t.test('frozen identifier, phrase, path, table and private-content regression queries', async () => {
      const w = await setup();
      for (const example of relevanceCases) await w.note(example.text, example.title);
      await w.index();
      for (const example of relevanceCases) {
        const response = await w.submit(example.query);
        assert.equal(response.mode, 'hybrid');
        assert.equal(response.hits[0].title, example.expectedTitle, example.category);
      }
      t.diagnostic(judgmentStatus);
    });
    await t.test('continuation freezes order and mode, rechecks edits and never spends', async () => {
      const w = await setup();
      for (let index = 0; index < 24; index++) await w.note(`policy shared passage ${index}`, `Policy ${index}`);
      await w.index();
      const commandId = randomUUID();
      const first = await w.submit('policy', { commandId });
      assert.equal(first.hits.length, 20);
      assert.ok(first.continuation);
      const calls = w.calls();
      const next = await w.search.search(w.ws.id, w.ws.userId, { kind: 'continue', continuation: first.continuation });
      assert.equal(next.hits.length, 4);
      assert.equal(new Set([...first.hits, ...next.hits].map(hit => hit.citation.documentId)).size, 24);
      assert.deepEqual((await w.submit('policy', { commandId })).hits, first.hits);
      const changed = next.hits[0].citation;
      await w.note('replacement current content', 'Updated', changed.documentId, changed.revisionId);
      const replay = await w.search.search(w.ws.id, w.ws.userId, {
        kind: 'continue',
        continuation: first.continuation,
      });
      assert.equal(replay.hits.length, 3);
      assert.ok(replay.hits.every(hit => hit.citation.documentId !== changed.documentId));
      assert.equal(w.calls(), calls);
      const stranger = randomUUID();
      await db.platform.query(`INSERT INTO ${w.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        stranger,
      ]);
      await assert.rejects(w.search.search(w.ws.id, stranger, { kind: 'continue', continuation: first.continuation }));
    });
    await t.test(
      'provider wait holds no runtime integration and an intervening edit cannot return obsolete text',
      async () => {
        let release, entered;
        const gate = new Promise(resolve => {
          release = resolve;
        });
        const started = new Promise(resolve => {
          entered = resolve;
        });
        let wait = false;
        const w = await setup({
          provider: async () => {
            if (wait) {
              entered();
              await gate;
            }
            return result(0);
          },
        });
        const doc = await w.note('supplier old contractual terms');
        await w.index();
        wait = true;
        const pending = w.submit('supplier unfamiliar query');
        await started;
        assert.equal(runtime.stats().activeTransactions, 0);
        await w.note('new terms only', 'Changed', doc.documentId, doc.revisionId);
        release();
        const response = await pending;
        assert.deepEqual(response.hits, []);
        assert.equal(
          (
            await db.platform.query(`SELECT vector_publication_id FROM ${w.table('documents')} WHERE id=$1`, [
              doc.documentId,
            ])
          ).rows[0].vector_publication_id,
          null,
        );
      },
    );
    await t.test('the default search deadline permits semantic results after two seconds', async () => {
      let slow = false;
      const w = await setup({
        provider: async () => {
          if (slow) await new Promise(resolve => setTimeout(resolve, 2200));
          return result(0);
        },
      });
      const document = await w.note('supplier slow semantic evidence');
      await w.index();
      slow = true;
      const started = performance.now();
      const found = await w.submit('payments before delivery');
      assert.ok(performance.now() - started >= 2200);
      assert.equal(found.mode, 'hybrid');
      assert.equal(found.reason, null);
      assert.equal(found.hits[0].citation.documentId, document.documentId);
    });
    await t.test('an explicit two-second caller budget still falls back and caches its late paid result', async () => {
      let slow = false;
      const w = await setup({
        provider: async () => {
          if (slow) await new Promise(resolve => setTimeout(resolve, 2200));
          return result(0);
        },
      });
      await w.note('supplier known keyword policy for a delayed embedding query');
      await w.index();
      slow = true;
      const start = performance.now();
      const fallback = await w.search.search(
        w.ws.id,
        w.ws.userId,
        { kind: 'submitted', commandId: randomUUID(), query: 'supplier delayed embedding query' },
        Date.now() + 1950,
      );
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 2000, `response ${elapsed}ms`);
      assert.equal(fallback.mode, 'keyword-only');
      assert.equal(fallback.reason, 'deadline');
      assert.equal(fallback.hits.length, 1);
      await w.search.close();
      const calls = w.calls();
      const retry = await w.submit('supplier delayed embedding query');
      assert.equal(retry.mode, 'hybrid');
      assert.equal(w.calls(), calls);
      t.diagnostic(`Fixture cold-provider fallback ${elapsed.toFixed(1)}ms; not an Azure latency measurement`);
    });
    await t.test('revoked Files are removed before ranking and before the provider dispatch', async () => {
      const w = await setup();
      const fileId = randomUUID();
      await w.files.upload(
        w.ws.id,
        w.ws.userId,
        fileId,
        { name: 'Policy.txt', mediaType: 'text/plain', parentId: null },
        Buffer.from('supplier confidential source'),
      );
      const doc = await w.local.save(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Private supplier',
        input: { kind: 'file', fileId },
      });
      for (const work of await w.local.due(w.ws.id)) await w.local.process(work);
      await w.index();
      assert.equal((await w.submit('supplier file lookup')).hits[0].citation.documentId, doc.documentId);
      const calls = w.calls();
      await db.platform.query(`UPDATE ${w.table('tf_files')} SET trashed_at=clock_timestamp() WHERE id=$1`, [fileId]);
      const denied = await w.submit('supplier revoked fresh query');
      assert.deepEqual(denied.hits, []);
      assert.equal(w.calls(), calls);
      assert.equal(denied.reason, 'no-semantic-content');
    });
    await t.test('cached search stays bounded during ingestion', async () => {
      const w = await setup({
        provider: async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          return result(0);
        },
      });
      await w.note('supplier searchable operational policy');
      await w.index();
      await w.submit('supplier warm load query');
      for (let index = 0; index < 5; index++) await w.note(`new ingestion text ${index}`);
      let stop = false;
      const ingestion = (async () => {
        while (!stop) {
          for (const work of await w.embeddings.due(w.ws.id)) await w.embeddings.process(work);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      })();
      const samples = [];
      try {
        for (let index = 0; index < 10; index++) {
          const start = performance.now();
          assert.equal((await w.submit('supplier warm load query')).mode, 'hybrid');
          samples.push(performance.now() - start);
        }
      } finally {
        stop = true;
        await ingestion;
      }
      assert.ok(
        samples.every(sample => sample < 2000),
        samples.join(','),
      );
      t.diagnostic(
        `Ten sequential cached searches during five-document fixture ingestion, max ${Math.max(...samples).toFixed(1)}ms. Not the 10000-document release workload.`,
      );
    });
    await t.test('Files authority is checked again after capacity admission and during final hydration', async () => {
      const w = await setup();
      const fileId = randomUUID();
      await w.files.upload(
        w.ws.id,
        w.ws.userId,
        fileId,
        { name: 'Supplier.txt', mediaType: 'text/plain', parentId: null },
        Buffer.from('supplier inherited grant policy'),
      );
      await w.local.save(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Supplier permission',
        input: { kind: 'file', fileId },
      });
      for (const work of await w.local.due(w.ws.id)) await w.local.process(work);
      await w.index();
      let calls = 0;
      const config = {
        kind: 'enabled',
        endpoint: 'https://example.services.ai.azure.com/',
        apiKey: 'fixture-only',
        profile: knowledgeEmbeddingProfile,
      };
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        config,
        capacity: async () => {
          await db.platform.query(`UPDATE ${w.table('tf_files')} SET trashed_at=clock_timestamp() WHERE id=$1`, [
            fileId,
          ]);
          return true;
        },
        provider: async () => {
          calls++;
          return result(0);
        },
      });
      const search = createKnowledgeSearch({ runtime, embeddings });
      searches.push(search);
      const denied = await search.search(w.ws.id, w.ws.userId, {
        kind: 'submitted',
        commandId: randomUUID(),
        query: 'supplier capacity race',
      });
      assert.deepEqual(denied.hits, []);
      assert.equal(calls, 0);
      await db.platform.query(`UPDATE ${w.table('tf_files')} SET trashed_at=NULL WHERE id=$1`, [fileId]);
      const late = createKnowledgeSearch({
        runtime,
        embeddings: createKnowledgeEmbeddings({
          runtime,
          config,
          capacity: async () => true,
          provider: async () => {
            calls++;
            await db.platform.query(`UPDATE ${w.table('tf_files')} SET trashed_at=clock_timestamp() WHERE id=$1`, [
              fileId,
            ]);
            return result(0);
          },
        }),
      });
      searches.push(late);
      const response = await late.search(w.ws.id, w.ws.userId, {
        kind: 'submitted',
        commandId: randomUUID(),
        query: 'supplier provider race',
      });
      assert.deepEqual(response.hits, []);
      assert.equal(calls, 1);
    });
    await t.test('two search instances singleflight the same cold query without duplicate charges', async () => {
      const w = await setup({
        provider: async () => {
          await new Promise(resolve => setTimeout(resolve, 80));
          return result(0);
        },
      });
      await w.note('supplier concurrency policy');
      await w.index();
      const other = createKnowledgeSearch({ runtime, embeddings: w.embeddings });
      searches.push(other);
      const before = w.calls();
      const results = await Promise.all([
        w.submit('supplier simultaneous cache miss'),
        other.search(w.ws.id, w.ws.userId, {
          kind: 'submitted',
          commandId: randomUUID(),
          query: 'supplier simultaneous cache miss',
        }),
      ]);
      assert.deepEqual(
        results.map(response => response.mode),
        ['hybrid', 'hybrid'],
      );
      assert.equal(w.calls(), before + 1);
    });
    await t.test('only explicit semantic retry retries a failed paid query', async () => {
      let fail = false;
      const w = await setup({
        provider: async () => (fail ? { ...result(0), result: { kind: 'error', code: 'invalid_vectors' } } : result(0)),
      });
      await w.note('supplier retry recovery');
      await w.index();
      fail = true;
      assert.equal((await w.submit('supplier retry failed query')).reason, 'provider-unavailable');
      const calls = w.calls();
      fail = false;
      assert.equal((await w.submit('supplier retry failed query')).reason, 'provider-unavailable');
      assert.equal(w.calls(), calls);
      const commandId = randomUUID();
      assert.equal((await w.submit('supplier retry failed query', { commandId, retrySemantic: true })).mode, 'hybrid');
      assert.equal(w.calls(), calls + 1);
      assert.equal((await w.submit('supplier retry failed query', { commandId, retrySemantic: true })).mode, 'hybrid');
      assert.equal(w.calls(), calls + 1);
    });
    await t.test('cancellation before capacity completes prevents paid dispatch', async () => {
      const w = await setup();
      await w.note('supplier cancellation policy');
      await w.index();
      let release,
        entered,
        calls = 0;
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const started = new Promise(resolve => {
        entered = resolve;
      });
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        config: {
          kind: 'enabled',
          endpoint: 'https://example.services.ai.azure.com/',
          apiKey: 'fixture-only',
          profile: knowledgeEmbeddingProfile,
        },
        capacity: async () => {
          entered();
          await gate;
          return true;
        },
        provider: async () => {
          calls++;
          return result(0);
        },
      });
      const search = createKnowledgeSearch({ runtime, embeddings });
      searches.push(search);
      const controller = new AbortController();
      const commandId = randomUUID();
      const pending = search.search(
        w.ws.id,
        w.ws.userId,
        { kind: 'submitted', commandId, query: 'supplier canceled query' },
        Date.now() + 1950,
        controller.signal,
      );
      await started;
      controller.abort();
      release();
      await pending.catch(error => assert.equal(error.name, 'AbortError'));
      await search.close();
      assert.equal(calls, 0);
      const status = await embeddings.queryStatus(w.ws.id, w.ws.userId, commandId);
      await embeddings.process({ workspaceId: w.ws.id, jobId: status.jobId });
      assert.equal(calls, 0);
    });
    await t.test('expired capacity claim is recovered by the next submission without waiting two minutes', async () => {
      const w = await setup();
      await w.note('supplier capacity recovery policy');
      await w.index();
      let delayed = true,
        calls = 0;
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        config: {
          kind: 'enabled',
          endpoint: 'https://example.services.ai.azure.com/',
          apiKey: 'fixture-only',
          profile: knowledgeEmbeddingProfile,
        },
        capacity: async () => {
          if (delayed) await new Promise(resolve => setTimeout(resolve, 1600));
          return true;
        },
        provider: async () => {
          calls++;
          return result(0);
        },
      });
      const search = createKnowledgeSearch({ runtime, embeddings });
      searches.push(search);
      const submit = () =>
        search.search(
          w.ws.id,
          w.ws.userId,
          { kind: 'submitted', commandId: randomUUID(), query: 'supplier capacity deadline recovery' },
          Date.now() + 1950,
        );
      assert.equal((await submit()).reason, 'deadline');
      await search.close();
      assert.equal(calls, 0);
      delayed = false;
      assert.equal((await submit()).mode, 'hybrid');
      assert.equal(calls, 1);
    });
    await t.test('one long document cannot consume all exact semantic document candidates', async () => {
      const w = await setup({ provider: async () => result(0) });
      const long = await w.note('long source retained original');
      await createKnowledge({ runtime }).publishLexical(w.ws.id, w.ws.userId, {
        id: randomUUID(),
        documentId: long.documentId,
        revisionId: long.revisionId,
        markdown: 'repeated semantic passages',
        pages: 0,
        tokens: 210,
        chunks: Array.from({ length: 210 }, () => ({
          heading: '',
          text: 'same long document passage',
          tokens: 1,
          offset: { kind: 'passage' },
        })),
      });
      const short = await w.note('different relevant source');
      await w.index();
      const response = await w.submit('paraphrase without lexical matches');
      assert.equal(response.mode, 'hybrid');
      assert.deepEqual(
        new Set(response.hits.map(hit => hit.citation.documentId)),
        new Set([long.documentId, short.documentId]),
      );
    });
    await t.test('worker claim and capacity inherit persisted search expiry without a caller deadline', async () => {
      const w = await setup();
      await w.note('supplier worker deadline policy');
      await w.index();
      let entered,
        release,
        admission,
        calls = 0;
      const started = new Promise(resolve => {
        entered = resolve;
      });
      const gate = new Promise(resolve => {
        release = resolve;
      });
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        config: {
          kind: 'enabled',
          endpoint: 'https://example.services.ai.azure.com/',
          apiKey: 'fixture-only',
          profile: knowledgeEmbeddingProfile,
        },
        capacity: async input => {
          admission = input;
          entered();
          await gate;
          return true;
        },
        provider: async () => {
          calls++;
          return result(0);
        },
      });
      const deadlineAt = Date.now() + 1200;
      const query = await embeddings.prepareSearchQuery(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        query: 'worker persisted deadline',
        filters: { kinds: ['note', 'file'], sourceIds: [], documentIds: [] },
        deadlineAt,
        retrySemantic: false,
      });
      const pending = embeddings.process({ workspaceId: w.ws.id, jobId: query.jobId });
      const settled = pending.catch(error => error);
      await started;
      try {
        const lease = (
          await db.platform.query(
            `SELECT c.lease_until FROM ${w.table('embedding_cache')} c JOIN ${w.table('embedding_items')} i USING(profile_id,input_hash) WHERE i.job_id=$1`,
            [query.jobId],
          )
        ).rows[0].lease_until;
        assert.equal(lease.getTime(), deadlineAt);
        assert.equal(admission.deadlineAt, deadlineAt);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, deadlineAt - Date.now() + 20)));
      } finally {
        release();
        await settled;
      }
      assert.equal(calls, 0);
      const replacement = await w.submit('worker persisted deadline');
      assert.equal(replacement.mode, 'hybrid');
    });
    await t.test('session capacity evicts the oldest page without rejecting a paid search', async () => {
      const w = await setup();
      await w.note('supplier session quota');
      await w.index();
      await w.submit('supplier seed session');
      await db.platform
        .query(`INSERT INTO ${w.table('search_sessions')} (id,owner_membership_id,owner_user_id,fingerprint,filters,candidates,mode,reason,coverage,expires_at)
        SELECT gen_random_uuid(),owner_membership_id,owner_user_id,fingerprint,filters,candidates,mode,reason,coverage,expires_at
        FROM ${w.table('search_sessions')} CROSS JOIN generate_series(1,99)`);
      const response = await w.submit('supplier fresh paid query at session capacity');
      assert.equal(response.mode, 'hybrid');
      assert.equal(response.hits.length, 1);
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${w.table('search_sessions')}`)).rows[0].count,
        100,
      );
    });
    await t.test('ANN document diversification finds another source behind a long document', async () => {
      const w = await setup({ provider: async () => result(0) });
      const long = await w.note('large retained original');
      await createKnowledge({ runtime }).publishLexical(w.ws.id, w.ws.userId, {
        id: randomUUID(),
        documentId: long.documentId,
        revisionId: long.revisionId,
        markdown: 'many repeated semantic passages',
        pages: 0,
        tokens: 2100,
        chunks: Array.from({ length: 2100 }, () => ({
          heading: '',
          text: 'reused long passage',
          tokens: 1,
          offset: { kind: 'passage' },
        })),
      });
      const short = await w.note('second source semantic match');
      await w.index();
      const response = await w.submit('paraphrase with no keywords');
      assert.equal(response.mode, 'hybrid');
      assert.deepEqual(
        new Set(response.hits.map(hit => hit.citation.documentId)),
        new Set([long.documentId, short.documentId]),
      );
    });
  } finally {
    await Promise.all(searches.map(search => search.close()));
    await Promise.all(runtimes.map(runtime => runtime.close()));
    await db.close();
  }
});

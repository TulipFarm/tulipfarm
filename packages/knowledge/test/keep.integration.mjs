import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeKeepFeed,
  createKnowledgeKeepIndex,
  createKnowledgeSearch,
  createLocalKnowledge,
  keepKnowledgeMaxAttempts,
  KnowledgeKeepUnavailable,
  KnowledgeSearchUnavailable,
} from '../dist/index.js';
import { createKeepClient, keepWorkspaceKnowledgeScope } from '@tulipfarm/memory-keep';
import { fakeKnowledgeKeep } from './fake-keep.mjs';

test('Keep-backed Knowledge', async t => {
  const db = await fixture();
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
  const searches = [];
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();

    async function setup({ index: customIndex, client } = {}) {
      const ws = await db.create(stream);
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, ['10000000000000']);
      const bytes = new Map();
      const files = createFiles(runtime, {
        putIfAbsent: async (key, value) => {
          bytes.set(key, value);
        },
        read: async key => bytes.get(key),
      });
      const local = createLocalKnowledge({ runtime, files });
      const keep = fakeKnowledgeKeep();
      if (client) keep.client = client;
      // Clearing `connected.on` stands for a deployment without a Keep endpoint.
      const connected = { on: true };
      const endpoint = () => (connected.on ? keep.client : undefined);
      const feed = createKnowledgeKeepFeed({ runtime, client: endpoint });
      const embeddings = createKnowledgeEmbeddings({ runtime, config: { kind: 'disabled' } });
      const search = createKnowledgeSearch({
        runtime,
        embeddings,
        index: customIndex?.(ws) ?? createKnowledgeKeepIndex({ client: endpoint }),
      });
      searches.push(search);
      const tools = createKnowledgeAgentTools({ runtime, search });
      const membership = (
        await db.platform.query(`SELECT id FROM ${table('tf_memberships')} WHERE user_id=$1`, [ws.userId])
      ).rows[0].id;
      const actor = { kind: 'human', userId: ws.userId, membershipId: membership };
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
      async function drain() {
        const outcomes = [];
        let after = null;
        for (;;) {
          const page = await feed.due(ws.id, after, 2);
          if (!page.length) return outcomes;
          for (const work of page) outcomes.push({ ...work, ...(await feed.sync(ws.id, work.document_id)) });
          after = page.at(-1).document_id;
        }
      }
      async function member() {
        const userId = randomUUID(),
          membershipId = randomUUID();
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          membershipId,
          userId,
        ]);
        return { kind: 'human', userId, membershipId };
      }
      const row = async documentId =>
        (await db.platform.query(`SELECT * FROM ${table('tf_keep_knowledge')} WHERE document_id=$1`, [documentId]))
          .rows[0];
      const publication = async documentId =>
        (await db.platform.query(`SELECT lexical_publication_id FROM ${table('documents')} WHERE id=$1`, [documentId]))
          .rows[0].lexical_publication_id;
      // The statement connectors run when a document loses read access or its content is no longer supported.
      const unpublish = documentId =>
        db.platform.query(
          `UPDATE ${table('documents')} SET lexical_publication_id=NULL,vector_publication_id=NULL WHERE id=$1`,
          [documentId],
        );
      const republish = (documentId, publicationId) =>
        db.platform.query(`UPDATE ${table('documents')} SET lexical_publication_id=$2 WHERE id=$1`, [
          documentId,
          publicationId,
        ]);
      const ready = documentId =>
        db.platform.query(`UPDATE ${table('tf_keep_knowledge')} SET next_attempt_at=now() WHERE document_id=$1`, [
          documentId,
        ]);
      return {
        ws,
        local,
        keep,
        connected,
        feed,
        search,
        tools,
        actor,
        note,
        drain,
        member,
        row,
        publication,
        unpublish,
        republish,
        ready,
      };
    }
    const ask = (w, query, actor = w.actor) => w.tools.search(w.ws.id, actor, { query }, { commandId: randomUUID() });

    await t.test('without a Keep endpoint, Keep is never called and keyword search answers', async () => {
      const w = await setup();
      w.connected.on = false;
      const doc = await w.note('supplier payment deadline', 'Supplier policy');
      assert.deepEqual(await w.feed.due(w.ws.id, null, 100), []);
      const found = await ask(w, 'supplier');
      assert.equal(found.result.mode, 'keyword-only');
      assert.deepEqual(
        found.sources.map(source => source.documentId),
        [doc.documentId],
      );
      assert.deepEqual(w.keep.calls, []);
    });

    await t.test('a publication reaches Keep with its scope, source id and metadata', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline', 'Supplier policy');
      const publicationId = await w.publication(doc.documentId);
      assert.deepEqual(await w.drain(), [
        { document_id: doc.documentId, action: 'deliver', status: 'delivered', publicationId },
      ]);
      const [ingest] = w.keep.calls;
      assert.equal(ingest.op, 'ingest');
      assert.deepEqual(ingest.scope, keepWorkspaceKnowledgeScope(w.ws.id));
      assert.equal(ingest.sourceId, doc.documentId);
      assert.equal(ingest.title, 'Supplier policy');
      assert.equal(ingest.collection, 'note');
      assert.equal(ingest.replace, true);
      assert.deepEqual(ingest.metadata, {
        documentId: doc.documentId,
        revisionId: doc.revisionId,
        publicationId,
        provider: 'note',
      });
      assert.ok(ingest.episodes.length >= 1 && ingest.episodes.every(episode => /^\d+$/.test(episode.id)));
      assert.ok(ingest.episodes.some(episode => episode.text.includes('supplier payment deadline')));
      assert.equal((await w.row(doc.documentId)).publication_id, publicationId);
      assert.deepEqual(await w.feed.sync(w.ws.id, doc.documentId), { status: 'current' });
      assert.equal(await w.feed.pending(w.ws.id), false);
    });

    await t.test('a new revision replaces the earlier one in Keep', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline', 'Supplier policy');
      await w.drain();
      const edited = await w.note('supplier advance settlement', 'Supplier policy', doc.documentId, doc.revisionId);
      const publicationId = await w.publication(doc.documentId);
      assert.deepEqual(await w.drain(), [
        { document_id: doc.documentId, action: 'deliver', status: 'delivered', publicationId },
      ]);
      const ingest = w.keep.calls.at(-1);
      assert.equal(ingest.replace, true);
      assert.equal(ingest.metadata.revisionId, edited.revisionId);
      const stored = w.keep.corpora.get(keepWorkspaceKnowledgeScope(w.ws.id).user).get(doc.documentId);
      assert.ok([...stored.episodes.values()].every(text => !text.includes('deadline')));
    });

    await t.test('a long document is sent in small batches; only the first replaces the earlier revision', async () => {
      const w = await setup();
      const text = Array.from({ length: 400 }, (_, index) =>
        `Section ${index}. Clause ${index} covers supplier term ${index} in detail. `.repeat(12),
      ).join('\n\n');
      const doc = await w.note(text, 'Long supplier policy');
      assert.equal((await w.drain())[0].status, 'delivered');
      const ingests = w.keep.calls.filter(call => call.op === 'ingest');
      assert.ok(ingests.length > 1);
      assert.equal(ingests[0].replace, true);
      assert.ok(ingests.slice(1).every(call => call.replace === undefined));
      for (const call of ingests) {
        assert.ok(call.episodes.length <= 32);
        assert.ok(Buffer.byteLength(JSON.stringify(call.episodes)) <= 160 * 1024);
      }
      const stored = w.keep.corpora.get(keepWorkspaceKnowledgeScope(w.ws.id).user).get(doc.documentId);
      assert.equal(
        stored.episodes.size,
        ingests.reduce((sum, call) => sum + call.episodes.length, 0),
      );
    });

    await t.test('removal makes Keep forget the document; a repeated forget is harmless', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline', 'Supplier policy');
      await w.drain();
      await w.local.remove(w.ws.id, w.ws.userId, {
        commandId: randomUUID(),
        documentId: doc.documentId,
        expectedRevisionId: doc.revisionId,
      });
      assert.deepEqual(await w.drain(), [{ document_id: doc.documentId, action: 'forget', status: 'forgotten' }]);
      assert.deepEqual(w.keep.calls.at(-1), {
        op: 'forget',
        scope: keepWorkspaceKnowledgeScope(w.ws.id),
        sourceId: doc.documentId,
      });
      assert.equal(await w.row(doc.documentId), undefined);
      assert.deepEqual(await w.feed.sync(w.ws.id, doc.documentId), { status: 'skipped' });
      assert.deepEqual(await w.feed.due(w.ws.id, null, 100), []);
    });

    await t.test(
      'losing read access or supported coverage without a tombstone forgets the document; republishing replaces it',
      async () => {
        const w = await setup();
        const lost = await w.note('supplier payment deadline', 'Supplier policy');
        const unsupported = await w.note('warehouse floor plan', 'Floor plan');
        await w.drain();
        const lostPublication = await w.publication(lost.documentId);
        // A connector that can no longer read a document, or no longer supports its content, clears its publication.
        await w.unpublish(lost.documentId);
        await w.unpublish(unsupported.documentId);
        const outcomes = await w.drain();
        assert.deepEqual(
          outcomes.map(outcome => [outcome.document_id, outcome.action, outcome.status]).toSorted(),
          [
            [lost.documentId, 'forget', 'forgotten'],
            [unsupported.documentId, 'forget', 'forgotten'],
          ].toSorted(),
        );
        assert.equal(w.keep.corpora.get(keepWorkspaceKnowledgeScope(w.ws.id).user).size, 0);
        assert.equal(await w.row(lost.documentId), undefined);

        await w.republish(lost.documentId, lostPublication);
        assert.deepEqual(await w.drain(), [
          { document_id: lost.documentId, action: 'deliver', status: 'delivered', publicationId: lostPublication },
        ]);
        assert.equal(w.keep.calls.at(-1).replace, true);
      },
    );

    await t.test(
      'a failing document backs off, does not hold up later documents, and is pinned after repeated failures',
      async () => {
        const w = await setup();
        const [failing, healthy] = [
          await w.note('supplier payment deadline', 'Supplier policy'),
          await w.note('warehouse floor plan', 'Floor plan'),
        ].toSorted((a, b) => a.documentId.localeCompare(b.documentId));
        w.keep.state.timeouts.add(failing.documentId);
        const run = async () => {
          const outcomes = [];
          for (const work of await w.feed.due(w.ws.id, null, 100)) {
            try {
              outcomes.push([work.document_id, (await w.feed.sync(w.ws.id, work.document_id)).status]);
            } catch (error) {
              assert.ok(error instanceof KnowledgeKeepUnavailable);
              assert.equal(error.scope, 'document');
              await w.feed.recordFailure(w.ws.id, work.document_id, error.message, error.scope);
              outcomes.push([work.document_id, 'failed']);
            }
          }
          return outcomes;
        };
        assert.deepEqual(await run(), [
          [failing.documentId, 'failed'],
          [healthy.documentId, 'delivered'],
        ]);
        const backedOff = await w.row(failing.documentId);
        assert.equal(backedOff.attempts, 1);
        assert.equal(backedOff.last_error, 'Keep unavailable: timeout');
        assert.ok(backedOff.next_attempt_at > new Date(), 'the document waits before it is sent again');
        assert.equal(backedOff.lease_token, null);
        assert.deepEqual(await w.feed.due(w.ws.id, null, 100), [], 'a backed-off document is not due');

        for (let attempt = 2; attempt <= keepKnowledgeMaxAttempts; attempt++) {
          await w.ready(failing.documentId);
          assert.deepEqual(await run(), [[failing.documentId, 'failed']]);
        }
        const pinned = await w.row(failing.documentId);
        assert.equal(pinned.attempts, keepKnowledgeMaxAttempts);
        assert.equal(pinned.failed_publication_id, await w.publication(failing.documentId));
        await w.ready(failing.documentId);
        assert.deepEqual(await w.feed.due(w.ws.id, null, 100), [], 'a pinned publication is not sent again');

        w.keep.state.timeouts.clear();
        await w.note('supplier prepayment', 'Supplier policy', failing.documentId, failing.revisionId);
        assert.deepEqual(await run(), [[failing.documentId, 'delivered']], 'a new revision is sent again');
        const delivered = await w.row(failing.documentId);
        assert.equal(delivered.attempts, 0);
        assert.equal(delivered.next_attempt_at, null);
      },
    );

    await t.test('a Keep outage is recorded without backoff so the document is sent once Keep is back', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline', 'Supplier policy');
      w.keep.state.available = false;
      const error = await w.feed.sync(w.ws.id, doc.documentId).catch(caught => caught);
      assert.ok(error instanceof KnowledgeKeepUnavailable);
      assert.equal(error.scope, 'keep');
      await w.feed.recordFailure(w.ws.id, doc.documentId, error.message, error.scope);
      assert.equal((await w.row(doc.documentId)).next_attempt_at, null);
      assert.deepEqual(await w.feed.due(w.ws.id, null, 100), [{ document_id: doc.documentId, action: 'deliver' }]);
    });

    await t.test('two syncs of one document never send it at the same time', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline', 'Supplier policy');
      let release;
      const gate = new Promise(resolve => (release = resolve));
      let entered;
      const started = new Promise(resolve => (entered = resolve));
      w.keep.state.beforeIngest = async () => {
        entered();
        await gate;
      };
      const first = w.feed.sync(w.ws.id, doc.documentId);
      await started;
      w.keep.state.beforeIngest = undefined;
      assert.deepEqual(await w.feed.sync(w.ws.id, doc.documentId), { status: 'busy' });
      release();
      assert.equal((await first).status, 'delivered');
      assert.equal(w.keep.calls.filter(call => call.op === 'ingest').length, 1);
      assert.equal((await w.row(doc.documentId)).lease_token, null, 'the lease is released');
    });

    await t.test('connecting Keep backfills every published document, page by page', async () => {
      const w = await setup();
      w.connected.on = false;
      const ids = [];
      for (let index = 0; index < 5; index++) ids.push((await w.note(`supplier appendix ${index}`)).documentId);
      assert.deepEqual(await w.drain(), []);
      w.connected.on = true;
      assert.equal(await w.feed.pending(w.ws.id), true);
      const outcomes = await w.drain();
      assert.deepEqual(
        outcomes.map(outcome => [outcome.document_id, outcome.status]),
        ids.toSorted().map(id => [id, 'delivered']),
      );
      assert.equal(await w.feed.pending(w.ws.id), false);
    });

    await t.test('search sends Keep only readable documents and maps hits into cited results', async () => {
      const w = await setup();
      const supplier = await w.note('supplier advance settlement required before delivery', 'Supplier policy');
      await w.note('quarterly roadmap', 'Roadmap');
      await w.drain();
      const found = await ask(w, 'supplier');
      const search = w.keep.calls.findLast(call => call.op === 'search');
      assert.deepEqual(search.scope, keepWorkspaceKnowledgeScope(w.ws.id));
      assert.equal(search.sourceIds.length, 2);
      assert.deepEqual(
        found.result.hits.map(hit => hit.title),
        ['Supplier policy'],
      );
      assert.ok(/^[0-9a-f-]{36}:\d+$/.test(found.result.hits[0].citationId));
      assert.deepEqual(
        found.sources.map(source => [source.kind, source.documentId, source.revisionId]),
        [['knowledge-document', supplier.documentId, supplier.revisionId]],
      );
      const read = await w.tools.read(w.ws.id, w.actor, found.result.hits[0].citationId);
      assert.match(JSON.stringify(read.result), /advance settlement/);

      const before = w.keep.calls.length;
      const stranger = await w.member();
      assert.deepEqual((await ask(w, 'supplier', stranger)).result.hits, []);
      assert.equal(w.keep.calls.length, before, 'an actor with nothing readable never reaches Keep');
    });

    await t.test('hits that fail current authorization or name an old publication are dropped', async () => {
      let removeDuringSearch = null;
      const w = await setup({
        index: ws => ({
          configured: () => true,
          search: async (workspaceId, query, documentIds) => {
            assert.equal(workspaceId, ws.id);
            const hits = documentIds.map((documentId, rank) => ({
              documentId,
              publicationId: rank === 0 ? randomUUID() : current.get(documentId),
              ordinal: 0,
              score: 10 - rank,
            }));
            if (removeDuringSearch) await removeDuringSearch();
            return hits;
          },
        }),
      });
      const current = new Map();
      const docs = [];
      for (const title of ['Alpha', 'Beta', 'Gamma']) {
        const doc = await w.note(`supplier ${title}`, title);
        docs.push(doc);
        current.set(doc.documentId, await w.publication(doc.documentId));
      }
      const revoked = docs[2];
      removeDuringSearch = () =>
        w.local.remove(w.ws.id, w.ws.userId, {
          commandId: randomUUID(),
          documentId: revoked.documentId,
          expectedRevisionId: revoked.revisionId,
        });
      const found = await ask(w, 'supplier');
      const returned = found.sources.map(source => source.documentId);
      assert.equal(returned.length, 1, 'the stale publication and the revoked document are both dropped');
      assert.ok(!returned.includes(revoked.documentId));
    });

    await t.test('Keep unavailable is a typed failure, never an empty result', async () => {
      const w = await setup();
      await w.note('supplier payment deadline', 'Supplier policy');
      await w.drain();
      w.keep.state.available = false;
      await assert.rejects(
        w.search.search(w.ws.id, w.ws.userId, { kind: 'submitted', commandId: randomUUID(), query: 'supplier' }),
        KnowledgeSearchUnavailable,
      );
      const tool = await ask(w, 'supplier');
      assert.equal(tool.result.error, 'knowledge-unavailable');
      assert.deepEqual(tool.sources, []);
      const doc = await w.note('supplier archive', 'Archive');
      await assert.rejects(w.feed.sync(w.ws.id, doc.documentId), KnowledgeKeepUnavailable);
      assert.equal(await w.feed.pending(w.ws.id), true, 'a failed delivery stays due');
    });
    await t.test(
      'live Keep: delivery, authorized search, revision replacement and forgetting',
      { skip: !process.env.TEST_KEEP_ENDPOINT && 'set TEST_KEEP_ENDPOINT and TEST_KEEP_TOKEN' },
      async () => {
        const live = createKeepClient({
          endpoint: process.env.TEST_KEEP_ENDPOINT,
          token: process.env.TEST_KEEP_TOKEN,
          timeoutMs: 30000,
        });
        const w = await setup({ client: live });
        const doc = await w.note('supplier advance settlement required before delivery', 'Supplier policy');
        await w.note('quarterly roadmap for the warehouse', 'Roadmap');
        assert.deepEqual(
          (await w.drain()).map(outcome => outcome.status),
          ['delivered', 'delivered'],
        );
        const found = await ask(w, 'supplier settlement');
        assert.equal(found.sources[0].documentId, doc.documentId);
        const stranger = await w.member();
        assert.deepEqual((await ask(w, 'supplier settlement', stranger)).result.hits, []);

        await w.note('supplier prepayment waived for partners', 'Supplier policy', doc.documentId, doc.revisionId);
        assert.deepEqual(
          (await w.drain()).map(outcome => outcome.status),
          ['delivered'],
        );
        const edited = await ask(w, 'prepayment waived');
        assert.equal(edited.sources[0].documentId, doc.documentId);
        const raw = await live.searchKnowledge({
          scope: keepWorkspaceKnowledgeScope(w.ws.id),
          query: 'advance settlement',
          sourceIds: [doc.documentId],
        });
        assert.equal(raw.status, 'ok');
        assert.ok(
          raw.value.hits.every(hit => !hit.text.includes('advance settlement')),
          'the old revision is gone',
        );

        const current = await w.local.get(w.ws.id, w.ws.userId, doc.documentId);
        await w.local.remove(w.ws.id, w.ws.userId, {
          commandId: randomUUID(),
          documentId: doc.documentId,
          expectedRevisionId: current.revisionId,
        });
        assert.deepEqual(
          (await w.drain()).map(outcome => outcome.status),
          ['forgotten'],
        );
        const gone = await live.searchKnowledge({
          scope: keepWorkspaceKnowledgeScope(w.ws.id),
          query: 'supplier prepayment',
          sourceIds: [doc.documentId],
        });
        assert.deepEqual(gone.status === 'ok' ? gone.value.hits : gone, []);
      },
    );
  } finally {
    for (const search of searches) await search.close?.();
    await runtime.close?.();
    await db.close();
  }
});

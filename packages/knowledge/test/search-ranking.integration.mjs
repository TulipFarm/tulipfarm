import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { snapshot, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createKnowledgeEmbeddings, createKnowledgeSearch, createLocalKnowledge } from '../dist/index.js';
import { relevanceCases } from './fixtures/search-relevance.mjs';

snapshot.setResolveSnapshotPath(() =>
  fileURLToPath(new URL('../../../reports/memory-core/ranking-search.snapshot.cjs', import.meta.url)),
);

const documentId = index => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const vector = text =>
  Array.from({ length: 1536 }, (_, index) =>
    index === (/supplier|payments before delivery/.test(text) ? 0 : 1) ? 1 : 0,
  );
const corpus = [
  ...relevanceCases,
  { title: 'Vendor policy', text: 'supplier advance settlement required by policy' },
  { title: 'Office policy', text: 'Office policy sets the holiday closure calendar.' },
  { title: 'Policy index', text: 'Policy policy policy. Read the vendor and office policies.' },
];

const stableResult = result => ({
  mode: result.mode,
  reason: result.reason,
  coverage: result.coverage,
  bounded: result.bounded,
  queryBroadened: result.queryBroadened ?? false,
  hasContinuation: result.continuation !== null,
  hits: result.hits.map(hit => ({
    documentId: hit.citation.documentId,
    ordinal: hit.citation.ordinal,
    title: hit.title,
    heading: hit.heading,
    text: hit.text,
  })),
});

test('search ranking matches the fixed lexical and hybrid golden corpus', async t => {
  const db = await fixture();
  let runtime, search;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const ws = await db.create(await workspaceTableMigrations());
    const table = name => qualified(ws.names.schema, `tf_knowledge_${name}`);
    await db.platform.query(
      `UPDATE ${qualified(ws.names.schema, 'tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
    );
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 1,
      connectionsPerPool: 2,
      reservedConnections: 2,
      databaseConnectionBudget: 40,
      resolveCredential: async id => {
        assert.equal(id, ws.id);
        return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
      },
    });
    const files = createFiles(runtime, {
      putIfAbsent: async () => assert.fail('The ranking corpus contains notes only.'),
      read: async () => assert.fail('The ranking corpus contains notes only.'),
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
      provider: async input => ({
        dispatch: 'dispatched',
        inputTokensUpperBound: input.inputs.length,
        requestId: 'ranking-golden-fixture',
        usage: {
          kind: 'known',
          inputTokens: input.inputs.length,
          totalTokens: input.inputs.length,
          exceedsUpperBound: false,
        },
        result: {
          kind: 'success',
          model: knowledgeEmbeddingProfile.model,
          vectors: input.inputs.map(vector),
        },
      }),
    });
    search = createKnowledgeSearch({ runtime, embeddings });
    for (const [index, document] of corpus.entries())
      await local.save(ws.id, ws.userId, {
        commandId: randomUUID(),
        documentId: documentId(index),
        expectedRevisionId: null,
        title: document.title,
        input: { kind: 'note', text: document.text },
      });
    for (const work of await local.due(ws.id)) await local.process(work);
    let pending = true;
    for (let attempt = 0; attempt < 100 && pending; attempt++) {
      for (const work of await embeddings.due(ws.id)) await embeddings.process(work);
      pending =
        (await db.platform.query(`SELECT 1 FROM ${table('documents')} WHERE vector_publication_id IS NULL LIMIT 1`))
          .rowCount > 0;
    }
    assert.equal(pending, false, 'Every golden corpus document must have a vector publication.');
    for (const example of [
      ...relevanceCases,
      { category: 'shared-topic', query: 'policy' },
      { category: 'semantic-only', query: 'payments before delivery' },
    ]) {
      await t.test(`${example.category}: keyword ranking`, async t => {
        const result = await search.search(ws.id, ws.userId, { kind: 'typing', query: example.query });
        assert.equal(result.mode, 'keyword-only');
        t.assert.snapshot(stableResult(result));
      });
      await t.test(`${example.category}: hybrid ranking`, async t => {
        const result = await search.search(ws.id, ws.userId, {
          kind: 'submitted',
          commandId: randomUUID(),
          query: example.query,
        });
        assert.equal(result.mode, 'hybrid');
        if (example.expectedTitle) assert.equal(result.hits[0].title, example.expectedTitle);
        t.assert.snapshot(stableResult(result));
      });
    }
    await t.test('document filter keeps the authorized ranked subset', async t => {
      const result = await search.search(ws.id, ws.userId, {
        kind: 'submitted',
        commandId: randomUUID(),
        query: 'policy',
        filters: { documentIds: [documentId(5), documentId(6)] },
      });
      assert.equal(result.mode, 'hybrid');
      assert.equal(result.hits.length, 2);
      t.assert.snapshot(stableResult(result));
    });
  } finally {
    await search?.close();
    await runtime?.close();
    await db.close();
  }
});

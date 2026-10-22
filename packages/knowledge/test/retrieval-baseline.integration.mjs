import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
} from '../dist/index.js';
import { retrievalCorpus, retrievalCases } from './fixtures/retrieval-corpus.mjs';

test('paired legacy and grouped retrieval over a fixed pitch corpus', { timeout: 60_000 }, async t => {
  const db = await fixture();
  let runtime;
  let search;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const workspace = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 1,
      connectionsPerPool: 2,
      reservedConnections: 2,
      databaseConnectionBudget: 40,
      resolveCredential: async id => {
        assert.equal(id, workspace.id);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
    });
    const files = createFiles(runtime, {
      putIfAbsent: async () => assert.fail('This corpus contains notes, not uploaded files.'),
      read: async () => assert.fail('This corpus contains notes, not uploaded files.'),
    });
    const local = createLocalKnowledge({ runtime, files });
    for (const document of retrievalCorpus) {
      await local.save(workspace.id, workspace.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: document.title,
        input: { kind: 'note', text: document.text },
      });
    }
    for (const work of await local.due(workspace.id)) await local.process(work);
    const embeddings = createKnowledgeEmbeddings({ runtime, config: { kind: 'disabled' } });
    search = createKnowledgeSearch({ runtime, embeddings });
    const tools = createKnowledgeAgentTools({ runtime, search });
    const actor = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
    for (const scenario of retrievalCases) {
      const samples = [];
      for (let repetition = -1; repetition < 5; repetition++) {
        for (const variant of repetition % 2 === 0 ? ['legacy', 'grouped'] : ['grouped', 'legacy']) {
          const passages = new Map();
          let searches = 0;
          let reads = 0;
          let initialFacts = 0;
          let initialCharacters = 0;
          const started = performance.now();
          // A fixed scripted retrieval trace measures the interface, not model planning or slide creation.
          const queries =
            scenario.id === 'whole-pitch'
              ? [
                  'pitch',
                  ...retrievalCorpus.flatMap(document => document.sections.slice(1).map(section => section.heading)),
                ]
              : scenario.queries;
          if (variant === 'grouped') {
            const found = await tools.retrieve(
              workspace.id,
              actor,
              { action: 'search', query: queries[0] },
              { commandId: randomUUID() },
            );
            searches++;
            assert.ok(JSON.stringify(found).length <= 64_000);
            for (const branch of found.result.branches)
              for (const document of branch.documents) {
                assert.ok(found.sources.some(source => source.publicationId === document.publicationId));
                for (const passage of document.passages) {
                  assert.ok(passage.citationId.startsWith(`${document.publicationId}:`));
                  assert.ok(!passages.has(passage.citationId));
                  passages.set(passage.citationId, passage.text);
                }
              }
            initialCharacters = [...passages.values()].reduce((sum, text) => sum + text.length, 0);
            initialFacts = scenario.requiredFacts.filter(fact =>
              [...passages.values()].some(text => text.includes(fact)),
            ).length;
          } else
            for (const query of queries) {
              const found = await tools.search(workspace.id, actor, { query }, { commandId: randomUUID() });
              searches++;
              if (searches === 1) {
                const text = found.result.hits.map(hit => hit.excerpt).join('\n');
                initialCharacters = text.length;
                initialFacts = scenario.requiredFacts.filter(fact => text.includes(fact)).length;
              }
              for (const hit of found.result.hits) {
                if (passages.has(hit.citationId)) continue;
                const evidence = await tools.read(workspace.id, actor, hit.citationId);
                assert.equal(evidence.result.error, undefined);
                assert.ok(evidence.sources.length > 0);
                passages.set(hit.citationId, evidence.result.text);
                reads++;
              }
            }
          const text = [...passages.values()].join('\n');
          const missing = scenario.requiredFacts.filter(fact => !text.includes(fact));
          assert.deepEqual(missing, [], `The fixed baseline must cover ${scenario.id}.`);
          if (repetition >= 0)
            samples.push({
              repetition,
              variant,
              elapsedMs: performance.now() - started,
              searches,
              reads,
              initialFacts,
              initialCharacters,
              requiredFacts: scenario.requiredFacts.length,
              retainedCharacters: text.length,
              passages: passages.size,
            });
        }
      }
      const legacy = samples
        .filter(sample => sample.variant === 'legacy')
        .map(sample => sample.elapsedMs)
        .toSorted((a, b) => a - b);
      const grouped = samples
        .filter(sample => sample.variant === 'grouped')
        .map(sample => sample.elapsedMs)
        .toSorted((a, b) => a - b);
      if (scenario.id === 'whole-pitch') {
        assert.ok(
          grouped.at(-1) < legacy[0],
          'Every grouped pitch sample must beat every legacy sample, beyond measured noise.',
        );
        assert.ok(
          samples
            .filter(sample => sample.variant === 'grouped')
            .every(sample => sample.searches === 1 && sample.reads === 0),
        );
      }
      t.diagnostic(
        JSON.stringify({
          kind: 'knowledge-retrieval-comparison',
          scenario: scenario.id,
          samples,
          legacy: { medianMs: legacy[2], tailMs: legacy.at(-1), rangeMs: legacy.at(-1) - legacy[0] },
          grouped: { medianMs: grouped[2], tailMs: grouped.at(-1), rangeMs: grouped.at(-1) - grouped[0] },
          conditions:
            'One unmeasured warm-up per variant; same database, revisions, actor and disabled embeddings; alternating execution order.',
          limitations: [
            'Synthetic notes and scripted queries.',
            'Keyword-only search.',
            'No model, HTTP, Temporal, or Google Slides latency measurement.',
          ],
        }),
      );
    }
  } finally {
    await search?.close();
    await runtime?.close();
    await db.close();
  }
});

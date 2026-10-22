import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied, SourceAuthorizationUnavailable, withMcpSourceContext } from '@tulipfarm/access';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createKnowledge,
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
  knowledgeRetrieveInputSchema,
  knowledgeRetrieveResultSchema,
} from '../dist/index.js';
import { retrievalCorpus, retrievalCases } from './fixtures/retrieval-corpus.mjs';

const textOf = output =>
  output.result.branches
    .flatMap(branch => branch.documents.flatMap(document => document.passages.map(passage => passage.text)))
    .join('\n');
const passagesOf = output =>
  output.result.branches.flatMap(branch => branch.documents.flatMap(document => document.passages));
const textCharacters = output => passagesOf(output).reduce((sum, passage) => sum + passage.text.length, 0);

test('grouped knowledge retrieval', { timeout: 60_000 }, async t => {
  const db = await fixture();
  let runtime;
  let search;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const workspace = await db.create(await workspaceTableMigrations());
    const table = name => qualified(workspace.names.schema, name);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 1,
      connectionsPerPool: 3,
      reservedConnections: 2,
      databaseConnectionBudget: 40,
      resolveCredential: async id => {
        assert.equal(id, workspace.id);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
    });
    const files = createFiles(runtime, {
      putIfAbsent: async () => assert.fail('No uploaded files in this fixture.'),
      read: async () => assert.fail('No uploaded files in this fixture.'),
    });
    const local = createLocalKnowledge({ runtime, files });
    const saved = [];
    async function note(text, title) {
      const result = await local.save(workspace.id, workspace.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title,
        input: { kind: 'note', text },
      });
      for (const work of await local.due(workspace.id)) await local.process(work);
      return result;
    }
    for (const document of retrievalCorpus) saved.push(await note(document.text, document.title));
    const embeddings = createKnowledgeEmbeddings({ runtime, config: { kind: 'disabled' } });
    search = createKnowledgeSearch({ runtime, embeddings });
    const tools = createKnowledgeAgentTools({ runtime, search });
    const actor = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
    const retrieve = (input, context = {}) =>
      tools.retrieve(workspace.id, actor, input, { commandId: randomUUID(), ...context });

    await t.test('one query returns the complete small pitch with original citations', async () => {
      let queries = 0;
      const counted = createKnowledgeAgentTools({
        runtime,
        search: {
          search: (...args) => {
            queries++;
            return search.search(...args);
          },
        },
      });
      const output = await counted.retrieve(
        workspace.id,
        actor,
        { action: 'search', query: 'pitch' },
        { commandId: randomUUID() },
      );
      knowledgeRetrieveResultSchema.parse(output.result);
      assert.equal(queries, 1);
      assert.equal(output.result.branches.length, 1);
      assert.equal(output.result.branches[0].documents.length, 4);
      assert.deepEqual(
        retrievalCases[0].requiredFacts.filter(fact => !textOf(output).includes(fact)),
        [],
      );
      assert.ok(
        output.result.branches[0].documents.every(
          document => document.completeness === 'complete' && !document.omitted,
        ),
      );
      assert.equal(output.sources.length, 4);
      for (const passage of passagesOf(output)) {
        const original = await tools.read(workspace.id, actor, passage.citationId);
        assert.equal(original.result.text, passage.text);
        assert.equal(passage.truncated, false);
      }
      assert.ok(textCharacters(output) <= 16_000);
      assert.ok(JSON.stringify(output).length <= 64_000);
    });

    await t.test(
      'grouped plain-topic fallback recovers cross-document queries without changing strict search',
      async () => {
        const query = 'pitch product workflow pilot';
        const request = {
          kind: 'submitted',
          commandId: randomUUID(),
          query,
          filters: { kinds: ['note'], sourceIds: [], documentIds: [] },
        };
        assert.deepEqual((await search.search(workspace.id, workspace.userId, request)).hits, []);
        let calls = 0;
        const counted = createKnowledgeAgentTools({
          runtime,
          search: {
            search: (...args) => {
              calls++;
              return search.search(...args);
            },
          },
        });
        const output = await counted.retrieve(
          workspace.id,
          actor,
          { action: 'search', query },
          { commandId: randomUUID() },
        );
        assert.equal(calls, 1);
        assert.equal(output.result.branches[0].queryBroadened, true);
        assert.equal(output.sources.length, 4);
        assert.deepEqual(
          retrievalCases[0].requiredFacts.filter(fact => !textOf(output).includes(fact)),
          [],
        );
        assert.ok(textCharacters(output) <= 16_000);
        assert.ok(JSON.stringify(output).length <= 64_000);
        const exact = await retrieve({ action: 'search', query: 'pitch product' });
        assert.equal(exact.result.branches[0].queryBroadened, undefined);
        assert.deepEqual(
          exact.sources.map(source => source.documentId),
          [saved[0].documentId],
        );
        const scoped = await retrieve({ action: 'search', query, documentIds: [saved[1].documentId] });
        assert.equal(scoped.result.branches[0].queryBroadened, true);
        assert.deepEqual(
          scoped.sources.map(source => source.documentId),
          [saved[1].documentId],
        );
        for (const filters of [{ sourceIds: [randomUUID()] }, { kind: 'file' }]) {
          const empty = await retrieve({ action: 'search', query, ...filters });
          assert.equal(empty.result.branches[0].status, 'no-match');
          assert.deepEqual(empty.sources, []);
        }
        for (const query of ['"pitch product workflow pilot"', 'pitch -pitch', 'unfindablealpha OR unfindablebeta']) {
          const explicit = await retrieve({ action: 'search', query });
          assert.equal(explicit.result.branches[0].status, 'no-match');
          assert.equal(explicit.result.branches[0].queryBroadened, undefined);
        }
        const replayRequest = { ...request, commandId: randomUUID() };
        const broad = () =>
          search.search(workspace.id, workspace.userId, replayRequest, Date.now() + 10_000, undefined, {
            allowKeywordFallback: true,
          });
        const first = await broad();
        const replay = await broad();
        assert.equal(replay.queryBroadened, true);
        assert.deepEqual(replay.hits, first.hits);
        await assert.rejects(search.search(workspace.id, workspace.userId, replayRequest), { code: 'conflict' });
      },
    );

    await t.test('anchor expansion performs no search and obeys document scope', async () => {
      const found = await tools.search(workspace.id, actor, { query: 'pitch' }, { commandId: randomUUID() });
      const anchor = found.result.hits[0];
      const selected = found.sources.find(source => anchor.citationId.startsWith(source.publicationId));
      const noSearch = createKnowledgeAgentTools({
        runtime,
        search: { search: async () => assert.fail('An anchor-only read must not search.') },
      });
      const output = await noSearch.retrieve(
        workspace.id,
        actor,
        {
          action: 'expand',
          branches: [
            {
              reason: 'Read the remaining sections.',
              citationIds: [anchor.citationId],
              documentIds: [selected.documentId],
            },
          ],
        },
        { commandId: randomUUID() },
      );
      assert.equal(output.result.branches[0].documents.length, 1);
      assert.equal(output.result.branches[0].documents[0].completeness, 'complete');
      const outside = await noSearch.retrieve(
        workspace.id,
        actor,
        {
          action: 'expand',
          branches: [
            { reason: 'A different document.', citationIds: [anchor.citationId], documentIds: [randomUUID()] },
          ],
        },
        { commandId: randomUUID() },
      );
      assert.equal(outside.result.branches[0].status, 'unavailable');
      assert.deepEqual(outside.sources, []);
      const wrongProvider = await retrieve({
        action: 'expand',
        branches: [{ reason: 'Restrict source kind.', citationIds: [anchor.citationId], kind: 'file' }],
      });
      assert.equal(wrongProvider.result.branches[0].status, 'unavailable');
      const scoped = await retrieve({ action: 'search', query: 'pitch', sourceIds: [selected.sourceId] });
      assert.deepEqual(
        scoped.result.branches[0].documents.map(document => document.documentId).sort(),
        found.sources
          .filter(source => source.sourceId === selected.sourceId)
          .map(source => source.documentId)
          .sort(),
      );
      assert.equal(
        (await retrieve({ action: 'search', query: 'pitch', sourceIds: [randomUUID()] })).result.branches[0].status,
        'no-match',
      );
      await assert.rejects(
        retrieve(
          { action: 'expand', branches: [{ reason: 'Wrong task.', citationIds: [anchor.citationId] }] },
          { runId: randomUUID() },
        ),
        AccessDenied,
      );
    });

    await t.test('three search branches start concurrently and citations are not repeated', async () => {
      let entered = 0;
      let unblock;
      const ready = new Promise(resolve => {
        unblock = resolve;
      });
      const commands = [];
      const parallel = createKnowledgeAgentTools({
        runtime,
        search: {
          search: async (...args) => {
            commands.push(args[2].commandId);
            if (++entered === 3) unblock();
            await ready;
            return search.search(...args);
          },
        },
      });
      const output = await parallel.retrieve(
        workspace.id,
        actor,
        {
          action: 'expand',
          branches: Array.from({ length: 3 }, () => ({ query: 'pitch', reason: 'Compare the pitch sources.' })),
        },
        { commandId: randomUUID(), deadlineAt: Date.now() + 10_000 },
      );
      assert.equal(entered, 3);
      assert.equal(new Set(commands).size, 3, 'Each branch has a distinct embedding/search identity.');
      const ids = passagesOf(output).map(passage => passage.citationId);
      assert.equal(new Set(ids).size, ids.length);
      for (const branch of output.result.branches)
        assert.ok(
          branch.documents
            .flatMap(document => document.passages)
            .reduce((sum, passage) => sum + passage.text.length, 0) <= 8_000,
        );
    });

    await t.test('a failed branch is explicit and does not hide successful evidence', async () => {
      const partial = createKnowledgeAgentTools({
        runtime,
        search: {
          search: async (...args) => {
            if (args[2].query === 'timeout') throw new StorageUnavailableError('wait_timeout');
            if (args[2].query === 'authority') throw new SourceAuthorizationUnavailable();
            return search.search(...args);
          },
        },
      });
      const output = await partial.retrieve(
        workspace.id,
        actor,
        {
          action: 'expand',
          branches: [
            { query: 'timeout', reason: 'Missing evidence.' },
            { query: 'price', reason: 'Read the price.' },
            { query: 'authority', reason: 'Check source permission.' },
          ],
        },
        { commandId: randomUUID() },
      );
      assert.equal(output.result.branches[0].status, 'failed');
      assert.equal(output.result.branches[0].reason, 'wait_timeout');
      assert.equal(output.result.branches[1].status, 'evidence');
      assert.equal(output.result.branches[2].status, 'failed');
      assert.equal(output.result.branches[2].reason, 'source-authorization-unavailable');
      assert.ok(textOf(output).includes(retrievalCases[1].requiredFacts[0]));
      const unexpected = new Error('unexpected-failure');
      const broken = createKnowledgeAgentTools({
        runtime,
        search: {
          search: async () => {
            throw unexpected;
          },
        },
      });
      await assert.rejects(
        broken.retrieve(workspace.id, actor, { action: 'search', query: 'price' }, { commandId: randomUUID() }),
        error => error === unexpected,
      );
    });

    await t.test('invalid branches, cancellation and MCP egress stop before search', async () => {
      assert.equal(
        knowledgeRetrieveInputSchema.safeParse({ action: 'expand', branches: [{ reason: 'No query or anchor.' }] })
          .success,
        false,
      );
      assert.equal(
        knowledgeRetrieveInputSchema.safeParse({
          action: 'expand',
          branches: Array.from({ length: 4 }, () => ({ query: 'pitch', reason: 'gap' })),
        }).success,
        false,
      );
      const controller = new AbortController();
      const stopped = new Error('stopped');
      controller.abort(stopped);
      await assert.rejects(
        retrieve({ action: 'search', query: 'price' }, { signal: controller.signal }),
        error => error === stopped,
      );
      const mcp = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
      const tx = { schema: 'unused', client: { query: async () => assert.fail('No query expected.') } };
      await assert.rejects(
        withMcpSourceContext(tx, [mcp], () => retrieve({ action: 'search', query: 'pitch' })),
        AccessDenied,
      );
    });

    await t.test('unreadable and replaced anchors expose no title or source metadata', async () => {
      const privateNote = await note('# Secret\n\nSource with private information.', 'Private source');
      const found = await tools.search(
        workspace.id,
        actor,
        { query: 'private information' },
        { commandId: randomUUID() },
      );
      const citationId = found.result.hits.find(hit => hit.title === 'Private source').citationId;
      const stranger = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        stranger.membershipId,
        stranger.userId,
      ]);
      const denied = await tools.retrieve(
        workspace.id,
        stranger,
        {
          action: 'expand',
          branches: [{ citationIds: [citationId], reason: 'Try this source.' }],
        },
        { commandId: randomUUID() },
      );
      assert.equal(denied.result.branches[0].status, 'unavailable');
      assert.deepEqual(denied.result.branches[0].documents, []);
      assert.deepEqual(denied.sources, []);
      await local.remove(workspace.id, workspace.userId, {
        commandId: randomUUID(),
        documentId: privateNote.documentId,
        expectedRevisionId: privateNote.revisionId,
      });
      const stale = await retrieve({
        action: 'expand',
        branches: [{ citationIds: [citationId], reason: 'Read removed evidence.' }],
      });
      assert.deepEqual(stale.result.branches[0].documents, []);
    });

    await t.test('previous complete passages are excluded without claiming a complete document', async () => {
      const initial = await retrieve({ action: 'search', query: 'price' });
      const passage = passagesOf(initial)[0];
      const expanded = await retrieve(
        {
          action: 'expand',
          branches: [{ citationIds: [passage.citationId], reason: 'Read other sections.' }],
        },
        { excludeCitationIds: [passage.citationId] },
      );
      assert.ok(!passagesOf(expanded).some(item => item.citationId === passage.citationId));
      assert.equal(expanded.result.branches[0].documents[0].completeness, 'partial');
      assert.equal(expanded.result.branches[0].documents[0].omitted, true);
    });

    await t.test('large documents retain the matching chunk and report omitted sections', async () => {
      const large = await note('# Long source\n\nInitial source.', 'Long source');
      const domain = createKnowledge({ runtime });
      await domain.publishLexical(workspace.id, workspace.userId, {
        id: randomUUID(),
        documentId: large.documentId,
        revisionId: large.revisionId,
        markdown: 'A bounded synthetic long document.',
        pages: 0,
        tokens: 80,
        chunks: Array.from({ length: 80 }, (_, ordinal) => ({
          heading: `Section ${ordinal}`,
          text: `${ordinal === 70 ? 'targetneedle' : 'background'} ${'source text '.repeat(100)}`,
          tokens: 1,
          offset: { kind: 'passage' },
        })),
      });
      const output = await retrieve({ action: 'search', query: 'targetneedle' });
      const document = output.result.branches[0].documents[0];
      assert.equal(document.documentId, large.documentId);
      assert.equal(document.completeness, 'partial');
      assert.equal(document.omitted, true);
      assert.ok(
        document.passages.some(passage => passage.citationId.endsWith(':70') && passage.text.includes('targetneedle')),
      );
      assert.ok(document.passages.length <= 32);
      assert.equal(textCharacters(output), 16_000);
      assert.deepEqual(
        document.passages.map(passage => Number(passage.citationId.split(':')[1])),
        document.passages.map(passage => Number(passage.citationId.split(':')[1])).toSorted((a, b) => a - b),
      );
      const expanded = await retrieve({
        action: 'expand',
        branches: [
          {
            citationIds: [`${document.publicationId}:0`, `${document.publicationId}:70`],
            reason: 'Compare far-apart sections.',
          },
        ],
      });
      assert.ok(passagesOf(expanded).some(passage => passage.citationId.endsWith(':0')));
      assert.ok(passagesOf(expanded).some(passage => passage.citationId.endsWith(':70')));
      const excluded = document.passages.filter(passage => !passage.truncated).map(passage => passage.citationId);
      const continued = await retrieve(
        {
          action: 'expand',
          branches: [{ citationIds: [`${document.publicationId}:70`], reason: 'Read the next sections.' }],
        },
        { excludeCitationIds: excluded },
      );
      assert.ok(
        passagesOf(continued).some(
          passage => !document.passages.some(previous => previous.citationId === passage.citationId),
        ),
      );
      assert.ok(passagesOf(continued).every(passage => !excluded.includes(passage.citationId)));
      assert.equal(textCharacters(continued), 8_000);
    });

    await t.test('Unicode clipping keeps the anchor and never splits a surrogate pair', async () => {
      const source = await note('Unicode source.', 'Unicode source');
      await createKnowledge({ runtime }).publishLexical(workspace.id, workspace.userId, {
        id: randomUUID(),
        documentId: source.documentId,
        revisionId: source.revisionId,
        markdown: 'Unicode source.',
        pages: 0,
        tokens: 10,
        chunks: Array.from({ length: 10 }, (_, ordinal) => ({
          heading: `Unicode ${ordinal}`,
          text: `${'\u{1F337}'.repeat(1500)} ${ordinal === 9 ? 'unicodeneedle' : 'background'}`,
          tokens: 1,
          offset: { kind: 'passage' },
        })),
      });
      const output = await retrieve({ action: 'search', query: 'unicodeneedle' });
      assert.ok(textOf(output).includes('unicodeneedle'));
      assert.ok(textCharacters(output) <= 16_000);
      assert.ok(passagesOf(output).every(passage => passage.text.isWellFormed()));
      assert.equal(output.result.branches[0].documents[0].completeness, 'partial');
    });

    await t.test('escaping and large headings cannot exceed the serialized envelope ceiling', async () => {
      const anchors = [];
      for (let index = 0; index < 12; index++) {
        const source = await note('Envelope source.', `Envelope ${index}`);
        const publicationId = randomUUID();
        await createKnowledge({ runtime }).publishLexical(workspace.id, workspace.userId, {
          id: publicationId,
          documentId: source.documentId,
          revisionId: source.revisionId,
          markdown: 'Envelope source.',
          pages: 0,
          tokens: 8,
          chunks: Array.from({ length: 8 }, () => ({
            heading: '"'.repeat(2000),
            text: '"'.repeat(1900),
            tokens: 1,
            offset: { kind: 'passage' },
          })),
        });
        anchors.push(`${publicationId}:0`);
      }
      const output = await retrieve({
        action: 'expand',
        branches: [0, 4, 8].map(start => ({
          citationIds: anchors.slice(start, start + 4),
          reason: 'Check each source.',
        })),
      });
      assert.ok(JSON.stringify(output).length <= 64_000);
      knowledgeRetrieveResultSchema.parse(output.result);
      assert.equal(output.result.branches.flatMap(branch => branch.documents).length, 12);
      assert.ok(
        output.result.branches
          .flatMap(branch => branch.documents)
          .every(document => document.omitted && document.completeness === 'partial'),
      );
      assert.ok(textCharacters(output) <= 24_000);
    });
  } finally {
    await search?.close();
    await runtime?.close();
    await db.close();
  }
});

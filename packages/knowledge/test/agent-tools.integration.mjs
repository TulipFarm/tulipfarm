import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { knowledgeTaskSpend } from '@tulipfarm/workspace-storage/knowledge-credits';
import { AccessDenied, requireProtectedSource, withMcpSourceContext } from '@tulipfarm/access';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { createFiles } from '@tulipfarm/files';
import { requireDraftSources } from '../../agents/dist/draft-sources.js';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
  withKnowledgeSourceAuthorization,
} from '../dist/index.js';
import { creditPricing, registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// The wallet assertions below need a real credit account; without one the gate's debit is a no-op.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const vector = axis => Array.from({ length: 1536 }, (_, index) => (index === axis ? 1 : 0));
const embedding = {
  dispatch: 'dispatched',
  inputTokensUpperBound: 1,
  requestId: 'agent-tools-fixture',
  usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
  result: { kind: 'success', model: knowledgeEmbeddingProfile.model, vectors: [vector(0)] },
};

test('knowledge agent tools', async t => {
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
    async function setup({ semantic = false } = {}) {
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
      let calls = 0;
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        config: semantic
          ? {
              kind: 'enabled',
              endpoint: 'https://example.services.ai.azure.com/',
              apiKey: 'fixture-only',
              profile: knowledgeEmbeddingProfile,
            }
          : { kind: 'disabled' },
        capacity: async () => true,
        provider: async () => {
          calls++;
          return embedding;
        },
      });
      const search = createKnowledgeSearch({ runtime, embeddings });
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
      async function index() {
        for (let step = 0; step < 50; step++) {
          for (const work of await embeddings.due(ws.id)) await embeddings.process(work);
          if (
            !(
              await db.platform.query(
                `SELECT 1 FROM ${table('documents')} WHERE lexical_publication_id IS NOT NULL AND vector_publication_id IS NULL LIMIT 1`,
              )
            ).rowCount
          )
            return;
        }
        assert.fail('Vector publications did not become ready');
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
      return { ws, table, local, embeddings, tools, actor, note, index, member, calls: () => calls };
    }

    await t.test('admission, search and source metadata share one deadline; read deadlines remain errors', async () => {
      const w = await setup();
      await w.note('supplier payment deadline', 'Supplier policy');
      const deadlines = [];
      const tracked = {
        ...runtime,
        transaction: (workspace, compatibility, operation) => {
          deadlines.push(compatibility.deadlineAt);
          return runtime.transaction(workspace, compatibility, operation);
        },
      };
      const search = createKnowledgeSearch({ runtime: tracked, embeddings: w.embeddings });
      searches.push(search);
      const tools = createKnowledgeAgentTools({ runtime: tracked, search });
      const deadlineAt = Date.now() + 30_000;
      const found = await tools.search(
        w.ws.id,
        w.actor,
        { query: 'supplier' },
        { commandId: randomUUID(), deadlineAt },
      );
      assert.equal(found.result.hits.length, 1);
      assert.ok(deadlines.length >= 3);
      assert.equal(deadlines[0], deadlineAt, 'admission uses the caller deadline');
      assert.equal(deadlines.at(-1), deadlineAt, 'metadata does not reset the deadline');
      assert.ok(
        deadlines.every(deadline => deadline <= deadlineAt),
        'search stages stay inside the same budget',
      );
      deadlines.length = 0;
      const grouped = await tools.retrieve(
        w.ws.id,
        w.actor,
        { action: 'search', query: 'supplier' },
        { commandId: randomUUID(), deadlineAt },
      );
      assert.equal(grouped.result.branches[0].documents.length, 1);
      assert.ok(deadlines.length >= 3);
      assert.equal(deadlines[0], deadlineAt);
      assert.equal(deadlines.at(-1), deadlineAt);
      assert.ok(
        deadlines.every(deadline => deadline <= deadlineAt),
        'grouped stages cannot extend the shared deadline',
      );
      await db.platform.query(`BEGIN; LOCK TABLE ${w.table('tf_authorization_lock')} IN ACCESS EXCLUSIVE MODE`);
      try {
        await assert.rejects(
          tools.read(w.ws.id, w.actor, found.result.hits[0].citationId, { deadlineAt: Date.now() + 100 }),
          error => error.code === 'wait_timeout',
        );
      } finally {
        await db.platform.query('ROLLBACK');
      }
    });

    await t.test(
      'search returns bounded cited hits and read returns revision-backed evidence as the server-resolved actor',
      async () => {
        const w = await setup();
        const supplier = await w.note('supplier advance settlement required before delivery', 'Supplier policy');
        for (let index = 0; index < 12; index++) await w.note(`supplier appendix ${index}`, `Appendix ${index}`);
        const found = await w.tools.search(w.ws.id, w.actor, { query: 'supplier' }, { commandId: randomUUID() });
        assert.equal(found.result.mode, 'keyword-only');
        assert.equal(found.result.hits.length, 8);
        assert.ok(
          found.result.hits.every(
            hit => /^[0-9a-f-]{36}:\d+$/.test(hit.citationId) && hit.excerpt.length <= 600 && hit.source === 'note',
          ),
        );
        assert.equal(found.sources.length, 8);
        assert.ok(
          found.sources.every(
            source => source.kind === 'knowledge-document' && source.workspaceId === w.ws.id && source.accessEpoch >= 1,
          ),
        );
        const hit = found.result.hits.find(item => item.title === 'Supplier policy');
        assert.ok(hit);
        const read = await w.tools.read(w.ws.id, w.actor, hit.citationId);
        assert.equal(read.result.text, 'supplier advance settlement required before delivery');
        assert.deepEqual(
          read.sources.map(source => [source.documentId, source.revisionId]),
          [[supplier.documentId, supplier.revisionId]],
        );
        const empty = await w.tools.search(
          w.ws.id,
          w.actor,
          { query: 'nonexistent zebra clause' },
          { commandId: randomUUID() },
        );
        assert.deepEqual(empty.result.hits, []);
        assert.deepEqual(empty.sources, []);
        assert.match(empty.result.instruction, /No authorized knowledge matched/);
        const stranger = await w.member();
        const denied = await w.tools.read(w.ws.id, stranger, hit.citationId);
        assert.equal(denied.result.error, 'knowledge-unavailable');
        assert.deepEqual(denied.sources, []);
        assert.deepEqual(
          (await w.tools.search(w.ws.id, stranger, { query: 'supplier' }, { commandId: randomUUID() })).result.hits,
          [],
        );
        await assert.rejects(
          w.tools.search(
            w.ws.id,
            { ...w.actor, membershipId: stranger.membershipId },
            { query: 'supplier' },
            { commandId: randomUUID() },
          ),
          AccessDenied,
        );
        await assert.rejects(w.tools.read(w.ws.id, w.actor, 'not-a-citation'));
        const kind = await w.tools.search(
          w.ws.id,
          w.actor,
          { query: 'supplier', kind: 'file' },
          { commandId: randomUUID() },
        );
        assert.deepEqual(kind.result.hits, []);
        const unbound = await w.tools.read(w.ws.id, w.actor, hit.citationId, { runId: randomUUID() });
        assert.equal(unbound.result.error, 'knowledge-unavailable');
        await assert.rejects(
          w.tools.search(w.ws.id, w.actor, { query: 'supplier' }, { commandId: randomUUID(), runId: randomUUID() }),
          AccessDenied,
        );
      },
    );

    await t.test(
      'retained dependencies are rechecked through the eligibility gate after edits and removal',
      async () => {
        const w = await setup();
        const edited = await w.note('pricing escalation contact', 'Escalation');
        const removed = await w.note('pricing archive retention', 'Retention');
        const found = await w.tools.search(w.ws.id, w.actor, { query: 'pricing' }, { commandId: randomUUID() });
        const dependency = id => found.sources.find(source => source.documentId === id);
        const guarded = withKnowledgeSourceAuthorization(runtime);
        const check = (runtimeToUse, source) =>
          runtimeToUse.transaction(w.ws.id, commonCompatibility, tx => requireProtectedSource(tx, w.actor, source));
        await check(guarded, dependency(edited.documentId));
        await check(guarded, dependency(removed.documentId));
        await assert.rejects(
          check(runtime, dependency(edited.documentId)),
          AccessDenied,
          'unbound transactions fail closed',
        );
        await w.note('pricing escalation replaced', 'Escalation', edited.documentId, edited.revisionId);
        await assert.rejects(check(guarded, dependency(edited.documentId)), AccessDenied);
        await w.local.remove(w.ws.id, w.ws.userId, {
          commandId: randomUUID(),
          documentId: removed.documentId,
          expectedRevisionId: removed.revisionId,
        });
        await assert.rejects(check(guarded, dependency(removed.documentId)), AccessDenied);
        const stale = await w.tools.read(
          w.ws.id,
          w.actor,
          found.result.hits.find(hit => hit.title === 'Retention').citationId,
        );
        assert.equal(stale.result.error, 'knowledge-unavailable');
      },
    );

    await t.test('MCP-derived context cannot send a knowledge query to the embedding provider', async () => {
      const w = await setup();
      const doc = await w.note('vendor onboarding checklist', 'Onboarding');
      const mcp = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
      const tx = {
        schema: 'unused',
        client: {
          query: async () => {
            throw new Error('no query expected');
          },
        },
      };
      await assert.rejects(
        withMcpSourceContext(tx, [mcp], () =>
          w.tools.search(w.ws.id, w.actor, { query: 'vendor' }, { commandId: randomUUID() }),
        ),
        AccessDenied,
      );
      const found = await w.tools.search(w.ws.id, w.actor, { query: 'vendor' }, { commandId: randomUUID() });
      assert.equal(found.sources[0].documentId, doc.documentId);
      const guarded = withKnowledgeSourceAuthorization(runtime);
      await guarded.transaction(w.ws.id, commonCompatibility, async tx => {
        await assert.rejects(requireDraftSources(tx, w.actor, [mcp, ...found.sources]), AccessDenied);
      });
    });

    await t.test('shared audiences require every reader to be eligible for each knowledge dependency', async () => {
      const w = await setup();
      await w.note('private payroll calendar', 'Payroll');
      const found = await w.tools.search(w.ws.id, w.actor, { query: 'payroll' }, { commandId: randomUUID() });
      const other = await w.member();
      const guarded = withKnowledgeSourceAuthorization(runtime);
      await guarded.transaction(w.ws.id, commonCompatibility, async tx => {
        await requireDraftSources(tx, w.actor, found.sources, new Set(), undefined, true);
        await assert.rejects(requireDraftSources(tx, other, found.sources, new Set(), undefined, true), AccessDenied);
      });
    });

    await t.test(
      'task-triggered query embeddings are attributed to the task without a second wallet charge',
      async () => {
        const w = await setup({ semantic: true });
        await w.note('supplier advance settlement required', 'Vendor policy');
        await w.index();
        const before = BigInt(
          (await db.platform.query(`SELECT available FROM ${w.table('tf_credit_account')}`)).rows[0].available,
        );
        const groupBefore = (await db.platform.query(`SELECT known FROM ${w.table('tf_knowledge_credit_group')}`))
          .rows[0];
        const flowId = randomUUID();
        const calls = w.calls();
        const found = await w.tools.search(
          w.ws.id,
          w.actor,
          { query: 'payments before delivery' },
          { commandId: randomUUID(), taskFlowId: flowId },
        );
        assert.equal(found.result.mode, 'hybrid');
        assert.equal(w.calls(), calls + 1);
        const attempts = (
          await db.platform.query(
            `SELECT purpose,attribution_kind,attribution_id,task_flow_id,state FROM ${w.table('tf_knowledge_credit_attempts')} WHERE purpose='query'`,
          )
        ).rows;
        assert.deepEqual(attempts, [
          {
            purpose: 'query',
            attribution_kind: 'member',
            attribution_id: w.actor.membershipId,
            task_flow_id: flowId,
            state: 'known',
          },
        ]);
        const observed = (
          await db.platform.query(
            `SELECT o.provider_pico_usd FROM ${w.table('tf_knowledge_credit_observations')} o JOIN ${w.table('tf_knowledge_credit_attempts')} a ON a.id=o.attempt_id WHERE a.task_flow_id=$1`,
            [flowId],
          )
        ).rows[0].provider_pico_usd;
        const spend = await runtime.transaction(w.ws.id, commonCompatibility, tx => knowledgeTaskSpend(tx, flowId));
        assert.equal(spend, BigInt(observed) * creditPricing().unitsPerPicoUsd);
        assert.ok(spend > 0n);
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int AS count FROM ${w.table('tf_credit_usage')} WHERE flow_id=$1`,
              [flowId],
            )
          ).rows[0].count,
          0,
        );
        const after = BigInt(
          (await db.platform.query(`SELECT available FROM ${w.table('tf_credit_account')}`)).rows[0].available,
        );
        const groupAfter = (await db.platform.query(`SELECT known FROM ${w.table('tf_knowledge_credit_group')}`))
          .rows[0];
        const rounded = value => creditPricing().round(BigInt(value));
        assert.equal(
          before - after,
          rounded(groupAfter.known) - rounded(groupBefore.known),
          'wallet debited once, through the knowledge aggregate',
        );
        await w.tools.search(
          w.ws.id,
          w.actor,
          { query: 'advance payment terms for vendors' },
          { commandId: randomUUID() },
        );
        const chat = (
          await db.platform.query(
            `SELECT task_flow_id FROM ${w.table('tf_knowledge_credit_attempts')} WHERE purpose='query' AND task_flow_id IS NULL`,
          )
        ).rows;
        assert.equal(chat.length, 1, 'ordinary chat search is attributed to the member without a task flow');
        assert.equal(
          await runtime.transaction(w.ws.id, commonCompatibility, tx => knowledgeTaskSpend(tx, randomUUID())),
          0n,
        );
      },
    );

    await t.test('a worker-claimed task query embedding keeps the persisted task flow', async () => {
      const w = await setup({ semantic: true });
      await w.note('supplier advance settlement required', 'Vendor policy');
      await w.index();
      const flowId = randomUUID(),
        commandId = randomUUID();
      const query = {
        commandId,
        query: 'worker claimed task query',
        filters: { kinds: ['note', 'file'], sourceIds: [], documentIds: [] },
        deadlineAt: Date.now() + 10_000,
        retrySemantic: false,
      };
      const prepared = await w.embeddings.prepareSearchQuery(w.ws.id, w.ws.userId, { ...query, taskFlowId: flowId });
      const [work] = (await w.embeddings.due(w.ws.id)).filter(item => item.jobId === prepared.jobId);
      assert.deepEqual(Object.keys(work).sort(), ['generation', 'jobId', 'workspaceId']);
      assert.equal((await w.embeddings.process(work)).disposition, 'ready');
      const attempts = (
        await db.platform.query(
          `SELECT task_flow_id FROM ${w.table('tf_knowledge_credit_attempts')} WHERE purpose='query'`,
        )
      ).rows;
      assert.deepEqual(attempts, [{ task_flow_id: flowId }]);
      assert.ok((await runtime.transaction(w.ws.id, commonCompatibility, tx => knowledgeTaskSpend(tx, flowId))) > 0n);
      await assert.rejects(
        w.embeddings.prepareSearchQuery(w.ws.id, w.ws.userId, { ...query, taskFlowId: randomUUID() }),
        error => error.code === 'conflict',
      );
    });
  } finally {
    for (const search of searches) await search.close();
    await runtime.close();
    await db.close();
  }
});

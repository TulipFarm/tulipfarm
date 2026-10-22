import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  initialBundleModels,
  initialModelMapping,
  modelBundleSchema,
  knowledgeEmbeddingProfile,
} from '@tulipfarm/config';
import { createFiles } from '../../files/dist/index.js';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';
import {
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
  withKnowledgeSourceAuthorization,
} from '../../knowledge/dist/index.js';
import { creditPricing } from '@tulipfarm/extensions';

const embedding = {
  dispatch: 'dispatched',
  inputTokensUpperBound: 1,
  requestId: 'task-fixture',
  usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
  result: {
    kind: 'success',
    model: knowledgeEmbeddingProfile.model,
    vectors: [Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))],
  },
};

test(
  'a durable task answers from knowledge, attributes query spend to its budget and fails closed after revocation',
  { timeout: 180000 },
  async t => {
    const db = await fixture();
    let base;
    t.after(async () => {
      await base?.close();
      await db.close();
    });
    await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
    for (const migration of ['0001_baseline.sql'])
      await db.platform.query(
        await readFile(new URL(`../../../apps/database/migrations/${migration}`, import.meta.url), 'utf8'),
      );
    const w = await db.create(await workspaceTableMigrations()),
      table = name => `"${w.names.schema}"."${name}"`;
    base = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const runtime = withKnowledgeSourceAuthorization(base);
    await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, ['100000000000000']);
    const user = randomUUID(),
      member = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member,
      user,
    ]);
    const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['knowledge.search', 'knowledge.read']);
    const tasks = createAgentTasks(runtime);
    await createAgentExecutor({ runtime }).configure(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
    );
    const bytes = new Map();
    const local = createLocalKnowledge({
      runtime: base,
      files: createFiles(base, {
        putIfAbsent: async (key, value) => {
          bytes.set(key, value);
        },
        read: async key => bytes.get(key),
      }),
    });
    let embeddingCalls = 0;
    const embeddings = createKnowledgeEmbeddings({
      runtime: base,
      config: {
        kind: 'enabled',
        endpoint: 'https://example.services.ai.azure.com/',
        apiKey: 'fixture-only',
        profile: knowledgeEmbeddingProfile,
      },
      capacity: async () => true,
      provider: async () => {
        embeddingCalls++;
        return embedding;
      },
    });
    const knowledge = guarded =>
      createKnowledgeAgentTools({ runtime: guarded, search: createKnowledgeSearch({ runtime: guarded, embeddings }) });
    const saved = await local.save(w.id, user, {
      commandId: randomUUID(),
      documentId: randomUUID(),
      expectedRevisionId: null,
      title: 'Supplier policy',
      input: { kind: 'note', text: 'Suppliers are paid within 30 days of delivery.' },
    });
    for (const work of await local.due(w.id)) await local.process(work);
    for (let step = 0; step < 20; step++) for (const work of await embeddings.due(w.id)) await embeddings.process(work);

    const route = {
      id: 'knowledge-task',
      modelId: 'claude-opus-5-5',
      provider: 'anthropic',
      deployment: 'claude-opus-5-5',
      location: 'test',
      adapterVersion: 1,
      qualification: 'local',
      lifecycle: 'current',
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      boundedDecision: true,
    };
    const bundle = modelBundleSchema.parse({
      format: 1,
      id: 'knowledge-task',
      mapping: {
        ...initialModelMapping,
        revision: 'knowledge-task',
        families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
      },
      models: initialBundleModels,
      routes: [route],
    });
    const prompts = [];
    let grouped = false;
    const choose = prompt => {
      prompts.push(prompt);
      if (grouped) {
        const result = prompt.results.find(result => result.call.tool === 'knowledge.retrieve');
        if (!result)
          return {
            kind: 'tool',
            text: 'Reading grouped evidence.',
            call: { tool: 'knowledge.retrieve', action: 'search', query: 'supplier payment terms' },
          };
        const passage = result.result.branches[0]?.documents[0]?.passages[0];
        assert.match(passage.text, /30 days/);
        return { kind: 'answer', text: `Within 30 days [Supplier policy](#knowledge-citation=${passage.citationId}).` };
      }
      const search = prompt.results.find(result => result.call.tool === 'knowledge.search');
      if (!search)
        return {
          kind: 'tool',
          text: 'Searching knowledge.',
          call: { tool: 'knowledge.search', query: 'when are suppliers paid' },
        };
      const citationId = search.result.hits[0]?.citationId;
      assert.ok(citationId, 'the task received a cited hit');
      return { kind: 'answer', text: `Within 30 days [Supplier policy](#knowledge-citation=${citationId}).` };
    };
    const model = {
      activeBundle: () => ({ bundle, activationRevision: 1 }),
      trustedBundle: () => bundle,
      restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
      allowed: () => true,
      actualModelIds: () => [route.modelId],
      legacyFamily: () => 'claude-opus',
      budgetPicoUsd: () => '10000000000000',
      health: createModelRouteHealth(db.platform, () => 'knowledge-task'),
      infer: async (_resolution, input) => ({
        kind: 'success',
        decision: choose(JSON.parse(input.prompt)),
        actualModel: route.modelId,
        requestId: randomUUID(),
        usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      }),
    };
    const engine = createTaskRuntime(runtime, model, undefined, undefined, undefined, undefined, knowledge);

    const task = await tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope: [],
      text: 'When are suppliers paid?',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 120000 },
    });
    for (let n = 0; n < 12 && (await tasks.read(w.id, user, task.id)).status !== 'completed'; n++)
      await engine.process(w.id, task.id);
    const done = await tasks.read(w.id, user, task.id);
    assert.equal(done.status, 'completed');
    const history = await tasks.history(w.id, user, task.id);
    const answer = history.messages.at(-1);
    assert.match(answer.text, /^Within 30 days \[Supplier policy\]\(#knowledge-citation=[0-9a-f-]{36}:0\)\.$/);
    assert.ok(
      answer.sources.some(
        source =>
          source.kind === 'knowledge-document' &&
          source.documentId === saved.documentId &&
          source.revisionId === saved.revisionId,
      ),
      'the answer inherits the knowledge dependency',
    );
    assert.equal(embeddingCalls, 2, 'one document and one task query embedding');

    const attempt = (
      await db.platform.query(
        `SELECT a.task_flow_id,a.attribution_id,o.provider_pico_usd FROM ${table('tf_knowledge_credit_attempts')} a JOIN ${table('tf_knowledge_credit_observations')} o ON o.attempt_id=a.id WHERE a.purpose='query'`,
      )
    ).rows;
    assert.deepEqual(
      attempt.map(row => [row.task_flow_id, row.attribution_id]),
      [[task.id, member]],
    );
    const model_charged = BigInt(
      (
        await db.platform.query(
          `SELECT COALESCE(sum(charged),0)::text AS charged FROM ${table('tf_credit_usage')} WHERE flow_id=$1`,
          [task.id],
        )
      ).rows[0].charged,
    );
    assert.equal(
      BigInt(done.cost.chargedCreditUnits),
      model_charged + BigInt(attempt[0].provider_pico_usd) * creditPricing().unitsPerPicoUsd,
      'task usage presents model and knowledge spend',
    );
    assert.equal(
      (
        await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_credit_usage')} WHERE model_id=$1`, [
          knowledgeEmbeddingProfile.model,
        ])
      ).rows[0].count,
      0,
      'no second wallet charge through model usage',
    );

    const oldRoot = (
      await db.platform.query(`SELECT knowledge_root FROM ${table('tf_agent_tasks')} WHERE id=$1`, [task.id])
    ).rows[0].knowledge_root;
    assert.deepEqual(oldRoot, { kind: 'task', id: task.id, sequence: 0 });
    const originalCall = (
      await db.platform.query(
        `SELECT c.knowledge_root FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} r ON r.run_id=c.run_id WHERE r.task_id=$1`,
        [task.id],
      )
    ).rows[0].knowledge_root;
    assert.deepEqual(originalCall, oldRoot, 'queued calls keep immutable request lineage');
    assert.equal(
      (
        await db.platform.query(
          `SELECT knowledge_budget FROM ${table('tf_agent_task_messages')} WHERE task_id=$1 AND sequence=0`,
          [task.id],
        )
      ).rows[0].knowledge_budget.operations.length,
      1,
    );
    grouped = true;
    const reopened = await tasks.reopen(w.id, user, task.id, {
      requestId: randomUUID(),
      expectedGeneration: done.generation,
      text: 'Read the supplier payment terms again.',
      sources: [],
    });
    const newRoot = (
      await db.platform.query(`SELECT knowledge_root FROM ${table('tf_agent_tasks')} WHERE id=$1`, [task.id])
    ).rows[0].knowledge_root;
    assert.notEqual(newRoot.sequence, oldRoot.sequence, 'only an explicit human continuation starts a fresh budget');
    for (let n = 0; n < 12 && (await tasks.read(w.id, user, task.id)).status !== 'completed'; n++)
      await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, user, task.id)).status, 'completed');
    const budgets = (
      await db.platform.query(
        `SELECT sequence,knowledge_budget FROM ${table('tf_agent_task_messages')} WHERE task_id=$1 AND sequence IN ($2,$3) ORDER BY sequence`,
        [task.id, oldRoot.sequence, newRoot.sequence],
      )
    ).rows;
    assert.deepEqual(
      budgets.map(row => row.knowledge_budget.operations.map(operation => operation.phase)),
      [['initial'], ['initial']],
    );
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT c.knowledge_root FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} r ON r.run_id=c.run_id WHERE r.task_id=$1 AND r.generation=$2`,
          [task.id, done.generation],
        )
      ).rows[0].knowledge_root,
      oldRoot,
      'new human work never rewrites old queued-call roots',
    );

    await local.remove(w.id, user, {
      commandId: randomUUID(),
      documentId: saved.documentId,
      expectedRevisionId: saved.revisionId,
    });
    await assert.rejects(
      tasks.reopen(w.id, user, task.id, {
        requestId: randomUUID(),
        expectedGeneration: reopened.generation,
        text: 'And for contractors?',
        sources: [],
      }),
      /not found/i,
      'continuation rechecks the revoked dependency',
    );
  },
);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { createFiles } from '@tulipfarm/files';
import {
  createKnowledgeEmbeddings,
  createLocalKnowledge,
  withKnowledgeSourceAuthorization,
} from '@tulipfarm/knowledge';
import { createAgentPlans } from '../../../packages/agents/src/plans.ts';
import { createPlanRuntime } from '../../../packages/agents/src/plan-runtime.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createPlanComposition } from '../src/plan-composition.ts';
import { createKnowledgeTools } from '../src/knowledge-tools-composition.ts';
import { anthropicTools, anthropicText, toolResults } from './native-chat-fixture.mjs';

async function setup(t, knowledgeOptions = {}) {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    runtime = withKnowledgeSourceAuthorization(f.runtime);
  await f.db.platform.query(
    `UPDATE ${f.table('tf_credit_account')} SET available=1000000000000000,granted=1000000000000000`,
  );
  const bytes = new Map();
  const local = createLocalKnowledge({
    runtime: f.runtime,
    files: createFiles(f.runtime, {
      putIfAbsent: async (key, value) => {
        bytes.set(key, value);
      },
      read: async key => bytes.get(key),
    }),
  });
  const note = await local.save(w.id, w.userId, {
    commandId: randomUUID(),
    documentId: randomUUID(),
    expectedRevisionId: null,
    title: 'Specialist payment policy',
    input: { kind: 'note', text: 'Specialist suppliers are paid within 37 days.' },
  });
  for (const work of await local.due(w.id)) await local.process(work);
  const chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Research the specialist supplier payment policy.' }],
  });
  const plans = createAgentPlans(runtime);
  const plan = await plans.create(
    w.id,
    w.userId,
    chatId,
    randomUUID(),
    {
      title: 'Research supplier terms',
      specialists: [
        {
          key: 'researcher',
          name: 'Researcher',
          role: 'Finds facts',
          instructions: 'Use current Knowledge evidence.',
          tools: ['knowledge.search', 'knowledge.read'],
        },
      ],
      tasks: [
        { key: 'research', title: 'Find payment terms', assignee: { kind: 'specialist', specialist: 'researcher' } },
      ],
      budget: { toolCalls: 16, activeMilliseconds: 120000, credits: 100 },
    },
    sent.turnId,
  );
  const scheduler = createPlanRuntime(runtime);
  const [attemptId] = (await scheduler.step(w.id, plan.id)).specialists;
  assert.ok(attemptId);
  let retrievalCalls = 0;
  const domain = createKnowledgeTools({ runtime: f.runtime, env: {}, ...knowledgeOptions });
  const knowledge = guarded => {
    const tools = domain(guarded);
    return {
      ...tools,
      retrieve: async (...args) => {
        retrievalCalls++;
        return tools.retrieve(...args);
      },
    };
  };
  const composition = (storage = runtime) =>
    createPlanComposition({
      runtime: { ...f.runtime, transaction: storage.transaction },
      discover: async () => [],
      wakePlan: async () => {},
      wakeTask: async () => {},
      knowledge,
      env: {
        ANTHROPIC_API_KEY: 'synthetic-only',
        MODEL_FAMILIES: 'claude-haiku,claude-sonnet',
        PLAN_SPECIALIST_MODEL_FAMILY: 'claude-sonnet',
      },
    });
  const row = async () =>
    (
      await f.db.platform.query(
        `SELECT status,result,sources,tool_calls,failure_code FROM ${f.table('tf_agent_plan_attempts')} WHERE id=$1`,
        [attemptId],
      )
    ).rows[0];
  const budget = async () =>
    (
      await f.db.platform.query(`SELECT knowledge_budget FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
        sent.turnId,
      ])
    ).rows[0].knowledge_budget;
  const receipts = async () =>
    (
      await f.db.platform.query(
        `SELECT c.id,c.status,s.output FROM ${f.table('tf_conversation_tool_calls')} c JOIN ${f.table('tf_conversation_execution_steps')} s ON s.call_id=c.id WHERE c.plan_attempt_id=$1 ORDER BY c.sequence`,
        [attemptId],
      )
    ).rows;
  return {
    f,
    w,
    runtime,
    local,
    note,
    plan,
    attemptId,
    sent,
    scheduler,
    composition,
    row,
    budget,
    receipts,
    calls: () => retrievalCalls,
  };
}

for (const mode of ['replay', 'revoked', 'missing-output'])
  test(
    `specialist crash restart (${mode}) spends no extra Knowledge slot or query charge`,
    { timeout: 60000 },
    async t => {
      const f = await setup(t);
      let failSettlement = true,
        modelCalls = 0;
      const crashing = {
        transaction: (workspace, range, operation) =>
          f.runtime.transaction(workspace, range, tx =>
            operation({
              ...tx,
              client: {
                ...tx.client,
                query: async (sql, values) => {
                  if (failSettlement && sql.includes('SET status=$2, result=$3'))
                    throw new Error('simulated-worker-crash');
                  if (failSettlement && mode === 'missing-output' && sql.includes('SET output=$2 WHERE call_id='))
                    throw new Error('simulated-loss-before-output-receipt');
                  return tx.client.query(sql, values);
                },
              },
            }),
          ),
      };
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(options.body);
        modelCalls++;
        if (modelCalls === 1)
          return Response.json(
            anthropicTools([{ tool: 'knowledge.retrieve', action: 'search', query: 'specialist suppliers payment' }]),
          );
        if (failSettlement) {
          assert.match(toolResults(body).join('\n'), mode === 'missing-output' ? /tool-failed/ : /37 days/);
          throw new Error('simulated-process-loss-after-tool-receipt');
        }
        if (mode === 'missing-output') {
          assert.match(JSON.stringify(body.messages), /operation-interrupted/);
          assert.doesNotMatch(JSON.stringify(body.messages), /37 days/);
          return Response.json(
            anthropicText('Missing evidence after the interrupted retrieval; the payment term remains unverified.'),
          );
        }
        assert.match(
          JSON.stringify(body.messages),
          /37 days/,
          'restart reconstructs authorized completed tool evidence before making new model work',
        );
        return Response.json(anthropicText('Suppliers are paid within 37 days.'));
      });
      await assert.rejects(
        f.composition(crashing).activities.runPlanSpecialist(f.w.id, f.attemptId),
        /simulated-worker-crash/,
      );
      const before = await f.row(),
        receipts = await f.receipts();
      assert.equal(before.status, 'running');
      assert.equal(before.tool_calls, 1);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].status, mode === 'missing-output' ? 'failed' : 'completed');
      assert.equal(
        before.sources.some(source => source.kind === 'knowledge-document' && source.documentId === f.note.documentId),
        mode !== 'missing-output',
      );
      assert.equal((await f.budget()).operations.length, 1);
      assert.equal((await f.budget()).operations[0].status, 'completed');
      assert.equal(f.calls(), 1);

      failSettlement = false;
      if (mode === 'revoked') {
        await f.local.remove(f.w.id, f.w.userId, {
          commandId: randomUUID(),
          documentId: f.note.documentId,
          expectedRevisionId: f.note.revisionId,
        });
        await f.composition().activities.runPlanSpecialist(f.w.id, f.attemptId);
        const revoked = await f.row();
        assert.equal(revoked.status, 'failed');
        assert.equal(revoked.failure_code, 'access-revoked');
        assert.equal(revoked.tool_calls, 1);
        assert.equal(
          (
            await f.f.db.platform.query(`SELECT tool_calls FROM ${f.f.table('tf_agent_plans')} WHERE id=$1`, [
              f.plan.id,
            ])
          ).rows[0].tool_calls,
          1,
        );
        assert.equal(revoked.result, null);
        assert.equal(modelCalls, 2, 'revoked replay never dispatches another model request');
        assert.equal(f.calls(), 1);
        assert.equal((await f.budget()).operations.length, 1);
        return;
      }
      await f.composition().activities.runPlanSpecialist(f.w.id, f.attemptId);
      const after = await f.row();
      assert.equal(after.status, 'completed');
      assert.match(after.result, mode === 'missing-output' ? /Missing evidence/ : /37 days/);
      assert.equal(after.tool_calls, 1, 'replayed evidence is not charged as another tool call');
      assert.equal((await f.receipts()).length, 1);
      assert.equal((await f.budget()).operations.length, 1);
      assert.equal(f.calls(), 1, 'replay performs no new search, embedding, or grouped branch');
      const charges = (
        await f.f.db.platform.query(`SELECT id FROM ${f.f.table('tf_credit_usage')} WHERE flow_id=$1 ORDER BY id`, [
          f.attemptId,
        ])
      ).rows.map(row => row.id);
      assert.equal(new Set(charges).size, charges.length);
      assert.equal(charges.length, 3, 'two pre-crash model attempts and exactly one newly charged continuation');
    },
  );

test(
  'specialist final publication refuses evidence revoked after the tool receipt but before model completion',
  { timeout: 60000 },
  async t => {
    const f = await setup(t);
    let modelCalls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      modelCalls++;
      if (modelCalls === 1)
        return Response.json(
          anthropicTools([{ tool: 'knowledge.retrieve', action: 'search', query: 'specialist suppliers payment' }]),
        );
      assert.match(toolResults(JSON.parse(options.body)).join('\n'), /37 days/);
      await f.local.remove(f.w.id, f.w.userId, {
        commandId: randomUUID(),
        documentId: f.note.documentId,
        expectedRevisionId: f.note.revisionId,
      });
      return Response.json(anthropicText('Suppliers are paid within 37 days.'));
    });
    await f.composition().activities.runPlanSpecialist(f.w.id, f.attemptId);
    const row = await f.row();
    assert.notEqual(row.status, 'completed');
    assert.equal(row.result, null);
    assert.equal(row.failure_code, 'access-revoked');
    assert.equal(f.calls(), 1);
    assert.equal((await f.budget()).operations.length, 1);
  },
);

test(
  'an expired specialist attempt cannot publish a late result even before the scheduler replaces it',
  { timeout: 60000 },
  async t => {
    const f = await setup(t);
    await f.f.db.platform.query(
      `UPDATE ${f.f.table('tf_agent_plan_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [f.attemptId],
    );
    assert.equal(
      await f.scheduler.settleSpecialist(
        f.w.id,
        f.attemptId,
        { kind: 'completed', result: 'Late result', sources: [] },
        { toolCalls: 1, activeMilliseconds: 100 },
      ),
      false,
    );
    assert.equal((await f.row()).result, null);
    assert.equal((await f.budget()).operations.length, 0);
  },
);

test('specialist publication rechecks its lease at the atomic result write', { timeout: 60000 }, async t => {
  const f = await setup(t);
  const runtime = {
    ...f.runtime,
    transaction: (workspace, range, operation) =>
      f.runtime.transaction(workspace, range, tx =>
        operation({
          ...tx,
          client: {
            ...tx.client,
            query: async (sql, values) => {
              if (sql.includes('SET status=$2, result=$3'))
                await tx.client.query(
                  `UPDATE ${f.f.table('tf_agent_plan_attempts')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
                  [f.attemptId],
                );
              return tx.client.query(sql, values);
            },
          },
        }),
      ),
  };
  assert.equal(
    await createPlanRuntime(runtime).settleSpecialist(
      f.w.id,
      f.attemptId,
      { kind: 'completed', result: 'Too late', sources: [] },
      { toolCalls: 0, activeMilliseconds: 1 },
    ),
    false,
  );
  assert.equal((await f.row()).result, null);
});

test(
  'composed specialist grouped expansion starts all three providers before any branch returns',
  { timeout: 60000 },
  async t => {
    const response = {
      dispatch: 'dispatched',
      inputTokensUpperBound: 1,
      requestId: 'composed-branch-fixture',
      usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
      result: {
        kind: 'success',
        model: knowledgeEmbeddingProfile.model,
        vectors: [Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))],
      },
    };
    let expanding = false,
      starts = 0,
      release;
    const allStarted = new Promise(resolve => {
      release = resolve;
    });
    const provider = async () => {
      if (expanding) {
        starts++;
        if (starts === 3) release();
        await Promise.race([
          allStarted,
          delay(5000, undefined, { ref: false }).then(() => {
            throw new Error('provider-branches-did-not-overlap');
          }),
        ]);
      }
      return response;
    };
    const f = await setup(t, {
      env: {
        KNOWLEDGE_EMBEDDINGS_ENABLED: 'true',
        AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
        AZURE_FOUNDRY_API_KEY: 'synthetic-only',
      },
      provider,
      capacity: async () => true,
    });
    const embeddings = createKnowledgeEmbeddings({
      runtime: f.f.runtime,
      config: {
        kind: 'enabled',
        endpoint: 'https://example.services.ai.azure.com/',
        apiKey: 'synthetic-only',
        profile: knowledgeEmbeddingProfile,
      },
      provider: async () => response,
      capacity: async () => true,
    });
    for (let round = 0; round < 10; round++)
      for (const work of await embeddings.due(f.w.id)) await embeddings.process(work);
    let modelCalls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      modelCalls++;
      if (modelCalls === 1)
        return Response.json(
          anthropicTools([{ tool: 'knowledge.retrieve', action: 'search', query: 'specialist supplier payment' }]),
        );
      if (modelCalls === 2) {
        expanding = true;
        return Response.json(
          anthropicTools([
            {
              tool: 'knowledge.retrieve',
              action: 'expand',
              branches: [
                { query: 'supplier exceptions', reason: 'Check exceptions' },
                { query: 'supplier disputes', reason: 'Check disputes' },
                { query: 'supplier refunds', reason: 'Check refunds' },
              ],
            },
          ]),
        );
      }
      assert.equal(starts, 3);
      assert.match(JSON.stringify(options.body), /index/);
      return Response.json(anthropicText('The payment term is 37 days; the three named gaps remain unverified.'));
    });
    await f.composition().activities.runPlanSpecialist(f.w.id, f.attemptId);
    assert.equal((await f.row()).status, 'completed');
    assert.equal(starts, 3);
    assert.equal(f.calls(), 2);
    assert.deepEqual(
      (await f.budget()).operations.map(operation => [operation.phase, operation.branches]),
      [
        ['initial', 1],
        ['deep', 3],
      ],
    );
  },
);

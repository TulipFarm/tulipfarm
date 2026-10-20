import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  knowledgeCallUsesQuery,
  knowledgeToolCallSchema,
  knowledgeToolResultSchema,
} from '../src/knowledge-tool-contracts.ts';
import { invokeBoundedKnowledge, withKnowledgeRetrieveGrant } from '../src/knowledge-retrieval.ts';

test('new grouped grant is derived only after effective legacy grant intersection', () => {
  assert.deepEqual(withKnowledgeRetrieveGrant(['knowledge.search']), ['knowledge.search']);
  assert.deepEqual(withKnowledgeRetrieveGrant(['knowledge.read']), ['knowledge.read']);
  assert.deepEqual(withKnowledgeRetrieveGrant(['knowledge.search', 'knowledge.read']), [
    'knowledge.search',
    'knowledge.read',
    'knowledge.retrieve',
  ]);
  assert.deepEqual(withKnowledgeRetrieveGrant(['knowledge.retrieve']), ['knowledge.retrieve']);
  const saved = ['knowledge.search', 'knowledge.read'];
  const delegated = ['knowledge.search'];
  assert.deepEqual(withKnowledgeRetrieveGrant(saved.filter(tool => delegated.includes(tool))), delegated);
});

test('grouped model input rejects hidden authority, mixed actions, and more than three branches', () => {
  const branch = { query: 'pricing', reason: 'Need the current price' };
  const input = { tool: 'knowledge.retrieve', action: 'expand', branches: [branch] };
  assert.equal(knowledgeToolCallSchema.safeParse(input).success, true);
  for (const bad of [
    { ...input, branches: Array(4).fill(branch) },
    { ...input, budget: 7 },
    { ...input, rootTurnId: 'caller-controlled' },
    { ...input, query: 'cannot mix actions' },
    { ...input, branches: [{ reason: 'No anchor or question' }] },
    { tool: 'knowledge.retrieve', action: 'search' },
  ])
    assert.equal(knowledgeToolCallSchema.safeParse(bad).success, false);
  assert.equal(
    knowledgeToolCallSchema.safeParse({ tool: 'knowledge.read', citationId: 'retained-old-citation' }).success,
    true,
  );
});

test('query admission distinguishes anchor-only expansion from any query-bearing branch', () => {
  const anchor = { citationIds: [`${randomUUID()}:0`], reason: 'Read a retained citation' };
  assert.equal(knowledgeCallUsesQuery({ tool: 'knowledge.read', citationId: anchor.citationIds[0] }), false);
  assert.equal(knowledgeCallUsesQuery({ tool: 'knowledge.retrieve', action: 'expand', branches: [anchor] }), false);
  assert.equal(
    knowledgeCallUsesQuery({
      tool: 'knowledge.retrieve',
      action: 'expand',
      branches: [anchor, { query: 'a gap', reason: 'Search a gap' }],
    }),
    true,
  );
  assert.equal(
    knowledgeCallUsesQuery({ tool: 'knowledge.retrieve', action: 'search', query: 'supplier policy' }),
    true,
  );
  assert.equal(knowledgeCallUsesQuery({ tool: 'knowledge.search', query: 'supplier policy' }), true);
});

test('history retains legacy results and bounded stop results', () => {
  const unavailable = {
    provider: 'knowledge',
    error: 'knowledge-unavailable',
    instruction: 'Unavailable',
    sources: [],
  };
  assert.deepEqual(knowledgeToolResultSchema.parse(unavailable), unavailable);
  const stopped = {
    ...unavailable,
    error: 'knowledge-budget-exhausted',
    budget: { initialRemaining: 0, deepRemaining: 0, gapRemaining: 0, stop: true },
  };
  assert.deepEqual(knowledgeToolResultSchema.parse(stopped), stopped);
});

test('runtime budget metadata fits the complete 64000-character envelope without retaining omitted passage references', async () => {
  const turnId = randomUUID(),
    fixture = budgetRuntime({ kind: 'chat', id: turnId }),
    publicationId = randomUUID();
  const passages = Array.from({ length: 32 }, (_, index) => ({
    citationId: `${publicationId}:${index}`,
    heading: 'h'.repeat(1350),
    text: 't'.repeat(500),
    truncated: false,
  }));
  const output = {
    result: {
      provider: 'knowledge',
      action: 'search',
      branches: [
        {
          index: 0,
          status: 'evidence',
          mode: 'keyword-only',
          reason: null,
          coverage: 'keyword-only',
          documents: [
            {
              documentId: randomUUID(),
              publicationId,
              title: 'Supplier terms',
              source: 'local',
              completeness: 'complete',
              omitted: false,
              passages,
            },
          ],
        },
      ],
      instruction: '',
    },
    sources: [],
  };
  output.result.instruction = 'i'.repeat(64000 - JSON.stringify(output).length);
  assert.equal(JSON.stringify(output).length, 64000);
  const result = await invokeBoundedKnowledge(
    fixture.runtime,
    () => ({ retrieve: async () => output }),
    randomUUID(),
    actor,
    grouped,
    { commandId: randomUUID(), turnId },
  );
  assert.ok(JSON.stringify(result).length <= 64000);
  assert.equal(result.result.budget.initialRemaining, 0);
  const document = result.result.branches[0].documents[0];
  assert.equal(document.omitted, true);
  assert.equal(document.completeness, 'partial');
  assert.deepEqual(
    fixture.state().completeCitationIds,
    document.passages.map(passage => passage.citationId),
  );
  assert.ok(document.passages.reduce((sum, passage) => sum + passage.text.length, 0) <= 16000);
});

function budgetRuntime(root) {
  let state = { version: 1, operations: [], completeCitationIds: [] };
  const runtime = {
    transaction: async (_workspace, _range, operation) =>
      operation({
        schema: 'fixture',
        commonVersion: 47,
        client: {
          query: async (sql, values) => {
            if (sql.startsWith('SELECT knowledge_root')) return { rows: [{ knowledge_root: root }] };
            if (sql.startsWith('SELECT knowledge_budget'))
              return { rows: [{ knowledge_budget: structuredClone(state) }] };
            if (sql.startsWith('UPDATE') && sql.includes('knowledge_budget')) {
              state = JSON.parse(values[1]);
              return { rows: [], rowCount: 1 };
            }
            if (sql.startsWith('SELECT output') || sql.startsWith('SELECT result')) return { rows: [] };
            throw new Error(`Unexpected SQL: ${sql}`);
          },
        },
      }),
  };
  return { runtime, state: () => state };
}
const noMatch = () => ({
  result: {
    provider: 'knowledge',
    action: 'search',
    branches: [
      { index: 0, status: 'no-match', mode: 'keyword-only', reason: null, coverage: 'keyword-only', documents: [] },
    ],
    instruction: 'No evidence.',
  },
  sources: [],
});
const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
const grouped = { tool: 'knowledge.retrieve', action: 'search', query: 'supplier payment terms' };

test('wrong grouped actions disclose the remaining phase without consuming or resetting allowance', async () => {
  const turnId = randomUUID(),
    fixture = budgetRuntime({ kind: 'chat', id: turnId }),
    workspaceId = randomUUID();
  let providerCalls = 0;
  const tools = () => ({
    retrieve: async (_workspace, _actor, input) => {
      providerCalls++;
      const output = noMatch();
      output.result.action = input.action;
      return output;
    },
  });
  const invoke = call =>
    invokeBoundedKnowledge(fixture.runtime, tools, workspaceId, actor, call, { commandId: randomUUID(), turnId });
  const expansion = query => ({
    tool: 'knowledge.retrieve',
    action: 'expand',
    branches: [{ query, reason: 'Missing fact' }],
  });
  const premature = await invoke(expansion('policy'));
  assert.equal(premature.result.error, 'knowledge-action-required');
  assert.equal(premature.result.budget.initialRemaining, 1);
  assert.equal(fixture.state().operations.length, 0);
  assert.equal(providerCalls, 0);
  await invoke(grouped);
  const wrong = await invoke({ ...grouped, query: 'payment' });
  assert.equal(wrong.result.error, 'knowledge-action-required');
  assert.deepEqual(wrong.result.budget, { initialRemaining: 0, deepRemaining: 3, gapRemaining: 3, stop: false });
  assert.match(wrong.result.instruction, /action="expand" in ONE call with a branches array/);
  assert.equal(fixture.state().operations.length, 1);
  assert.equal(providerCalls, 1);
  knowledgeToolResultSchema.parse({ ...wrong.result, sources: wrong.sources });
  await invoke(expansion('payment'));
  await invoke(expansion('exceptions'));
  const exhausted = await invoke({ ...grouped, query: 'another topic' });
  assert.equal(exhausted.result.error, 'knowledge-budget-exhausted');
  assert.equal(exhausted.result.budget.stop, true);
  assert.equal(fixture.state().operations.length, 3);
  assert.equal(providerCalls, 3);
});

for (const kind of ['chat', 'task'])
  test(`${kind} crash after budget completion but before receipt stays spent, without another provider call`, async () => {
    const id = randomUUID(),
      root = kind === 'chat' ? { kind, id } : { kind, id, sequence: 0 };
    const fixture = budgetRuntime(root);
    const context = { commandId: randomUUID(), ...(kind === 'chat' ? { turnId: id } : { runId: randomUUID() }) };
    let calls = 0;
    const tools = () => ({
      retrieve: async () => {
        calls++;
        return noMatch();
      },
    });
    const first = await invokeBoundedKnowledge(fixture.runtime, tools, randomUUID(), actor, grouped, context);
    assert.equal(first.result.budget.initialRemaining, 0);
    assert.equal(fixture.state().operations[0].status, 'completed');
    // Simulate process loss here: the wrapper returned, but the owning output receipt was never committed.
    const replay = await invokeBoundedKnowledge(fixture.runtime, tools, randomUUID(), actor, grouped, context);
    assert.equal(replay.result.error, 'knowledge-operation-spent');
    assert.deepEqual(replay.sources, []);
    assert.equal(calls, 1);
    assert.equal(fixture.state().operations.length, 1);
  });

test('the watchdog never opens a competing guarded transaction while a retrieval transaction holds its locks', async () => {
  const turnId = randomUUID(),
    fixture = budgetRuntime({ kind: 'chat', id: turnId });
  let active = 0,
    maximum = 0;
  const runtime = {
    transaction: async (...args) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await fixture.runtime.transaction(...args);
      } finally {
        active--;
      }
    },
  };
  const tools = guarded => ({
    retrieve: async () =>
      guarded.transaction(randomUUID(), { ...commonCompatibility, minimum: 1 }, async () => {
        await delay(650);
        return noMatch();
      }),
  });
  await invokeBoundedKnowledge(runtime, tools, randomUUID(), actor, grouped, {
    turnId,
    commandId: randomUUID(),
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(maximum, 1, 'source/turn lock probes must queue behind active guarded reads');
});

test('an absolute deadline aborts provider work and leaves the reserved slot failed and spent', async () => {
  const turnId = randomUUID(),
    fixture = budgetRuntime({ kind: 'chat', id: turnId });
  let cancelled = false;
  const tools = () => ({
    retrieve: async (_workspace, _actor, _input, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(context.signal.reason);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    invokeBoundedKnowledge(fixture.runtime, tools, randomUUID(), actor, grouped, {
      turnId,
      commandId: randomUUID(),
      deadlineAt: Date.now() + 30,
    }),
    /knowledge-deadline/,
  );
  assert.equal(cancelled, true);
  assert.equal(fixture.state().operations[0].status, 'failed');
  assert.equal(fixture.state().operations.length, 1);
});

test('failed cleanup reports its own error without replacing the original provider failure', async t => {
  const turnId = randomUUID(),
    fixture = budgetRuntime({ kind: 'chat', id: turnId });
  const original = new Error('synthetic-provider-failure');
  const cleanup = Object.assign(new Error('cleanup contains private diagnostic text'), { code: '08006' });
  const logs = [];
  const stdout = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.includes('"operation":"knowledge.retrieval.settlement"')) {
      logs.push(JSON.parse(chunk));
      return true;
    }
    return stdout(chunk, ...args);
  });
  await assert.rejects(
    invokeBoundedKnowledge(
      fixture.runtime,
      () => ({
        retrieve: async () => {
          throw original;
        },
      }),
      randomUUID(),
      actor,
      grouped,
      { turnId, commandId: randomUUID() },
      {
        transaction: async () => {
          throw cleanup;
        },
      },
    ),
    error => error === original,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'error');
  assert.equal(JSON.stringify(logs).includes('private diagnostic text'), false);
  assert.equal(
    fixture.state().operations[0].status,
    'running',
    'an unresolved reservation remains spent rather than being silently refunded',
  );
});

test('a domain factory failure still settles the admitted operation as failed and spent', async () => {
  const turnId = randomUUID(),
    fixture = budgetRuntime({ kind: 'chat', id: turnId });
  await assert.rejects(
    invokeBoundedKnowledge(
      fixture.runtime,
      () => {
        throw new Error('invalid-domain-configuration');
      },
      randomUUID(),
      actor,
      grouped,
      { turnId, commandId: randomUUID() },
    ),
    /invalid-domain-configuration/,
  );
  assert.equal(fixture.state().operations[0].status, 'failed');
  assert.equal(fixture.state().operations.length, 1);
});

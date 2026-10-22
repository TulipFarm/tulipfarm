import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createChatTools, discoverTools, isExternalTool, parseToolCall } from '../src/tools.ts';
import { agentDefinitionSchema, toolResultSchema } from '../src/contracts.ts';
import { modelNativeTools, taskReadTools } from '../src/model.ts';
import { knowledgeToolResultSchema } from '../src/knowledge-tool-contracts.ts';

const citationId = `${randomUUID()}:0`;
const actor = { kind: 'human', userId: 'user-1', membershipId: randomUUID() };
const dependency = {
  kind: 'knowledge-document',
  workspaceId: randomUUID(),
  sourceId: randomUUID(),
  documentId: randomUUID(),
  revisionId: randomUUID(),
  publicationId: randomUUID(),
  accessEpoch: 1,
};

test('knowledge tool schemas are strict, bounded and admitted only where granted', () => {
  const chat = discoverTools({ kind: 'chat' });
  for (const name of ['knowledge.search', 'knowledge.retrieve']) {
    assert.match(
      chat.find(tool => tool.name === name).description,
      /short topic query, not a list of all required sections/,
    );
  }
  for (const name of ['knowledge.search', 'knowledge.read']) {
    const tool = chat.find(item => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.external, true, 'runs outside a held chat transaction');
    assert.equal(isExternalTool(name), true);
    assert.equal(taskReadTools.has(name), true);
  }
  assert.deepEqual(parseToolCall({ tool: 'knowledge.search', query: ' supplier ', kind: 'note' }, { kind: 'chat' }), {
    tool: 'knowledge.search',
    query: 'supplier',
    kind: 'note',
  });
  assert.deepEqual(parseToolCall({ tool: 'knowledge.read', citationId }, { kind: 'chat' }), {
    tool: 'knowledge.read',
    citationId,
  });
  for (const invalid of [
    { tool: 'knowledge.search', query: '' },
    { tool: 'knowledge.search', query: 'x'.repeat(513) },
    { tool: 'knowledge.search', query: 'x', kind: 'drive' },
    { tool: 'knowledge.search', query: 'x', kinds: ['note'] },
    { tool: 'knowledge.search', query: 'x', userId: 'someone-else' },
    { tool: 'knowledge.search', query: 'x', membershipId: randomUUID() },
    { tool: 'knowledge.read', citationId, actor: 'admin' },
  ])
    assert.throws(() => parseToolCall(invalid, { kind: 'chat' }), JSON.stringify(invalid));
  assert.throws(() =>
    parseToolCall({ tool: 'knowledge.search', query: 'x' }, { kind: 'agent', tools: ['web.search'] }),
  );
  assert.ok(
    JSON.stringify(chat.filter(tool => tool.name === 'knowledge.search' || tool.name === 'knowledge.read')).length <
      1500,
    'legacy knowledge schemas retain their shared provider schema budget',
  );
  assert.deepEqual(
    discoverTools({ kind: 'agent', tools: ['knowledge.read'] }).map(tool => tool.name),
    ['knowledge.read'],
  );
  assert.deepEqual(
    agentDefinitionSchema.parse({
      name: 'Researcher',
      instructions: 'Answer from knowledge.',
      tools: ['knowledge.search', 'knowledge.read'],
    }).tools,
    ['knowledge.search', 'knowledge.read'],
  );
  assert.match(
    JSON.stringify(
      modelNativeTools({
        prompt: 'Search.',
        definition: { name: 'Researcher', instructions: 'Search.', tools: ['knowledge.search'] },
        scope: [],
        task: true,
      }).tools,
    ),
    /knowledge_search/,
  );
});

test('task results keep their knowledge dependencies and reject oversize passages', () => {
  const search = {
    provider: 'knowledge',
    mode: 'hybrid',
    reason: null,
    coverage: 'complete',
    hits: [{ citationId, title: 'Policy', heading: '', excerpt: 'Paid in 30 days', source: 'note' }],
    instruction: 'Cite it.',
    sources: [dependency],
  };
  assert.deepEqual(
    toolResultSchema.parse(search),
    search,
    'parses as a knowledge result first, without stripping sources',
  );
  assert.equal(
    knowledgeToolResultSchema.safeParse({ ...search, hits: Array.from({ length: 9 }, () => search.hits[0]) }).success,
    false,
  );
  assert.equal(
    knowledgeToolResultSchema.safeParse({
      provider: 'knowledge',
      citationId,
      title: 'Policy',
      heading: '',
      source: 'note',
      text: 'x'.repeat(4001),
      truncated: true,
      instruction: '',
      sources: [],
    }).success,
    false,
  );
});

test('chat dispatch passes the server-resolved actor and call id to the knowledge domain', async () => {
  const calls = [];
  const factory = runtime => ({
    search: async (...args) => {
      calls.push(['search', runtime, ...args]);
      return { result: { provider: 'knowledge', hits: [] }, sources: [dependency] };
    },
    read: async (...args) => {
      calls.push(['read', runtime, ...args]);
      return { result: { provider: 'knowledge', citationId, text: 'Paid in 30 days' }, sources: [dependency] };
    },
  });
  let budget = { version: 1, operations: [] };
  const turnId = randomUUID();
  const runtime = {
    transaction: async (_workspace, _range, operation) =>
      operation({
        schema: 'fixture',
        commonVersion: 47,
        client: {
          query: async (sql, values) => {
            if (sql.startsWith('SELECT c.turn_id')) return { rows: [{ turn_id: turnId }] };
            if (sql.startsWith('SELECT knowledge_budget')) return { rows: [{ knowledge_budget: budget }] };
            if (sql.startsWith('UPDATE') && sql.includes('knowledge_budget')) {
              budget = JSON.parse(values[1]);
              return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          },
        },
      }),
  };
  const tools = createChatTools(runtime, { knowledge: factory });
  const context = { workspaceId: randomUUID(), actor, callId: randomUUID() };
  const searched = await tools.invokeWithSources(context, {
    tool: 'knowledge.search',
    query: 'supplier',
    kind: 'note',
  });
  assert.deepEqual(searched.sources, [dependency]);
  assert.equal(searched.result.budget.initialRemaining, 0);
  const readContext = { ...context, callId: randomUUID() };
  const read = await tools.invokeWithSources(readContext, { tool: 'knowledge.read', citationId });
  assert.equal(read.result.text, 'Paid in 30 days');
  assert.equal(read.result.budget.deepRemaining, 2);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(typeof call[1].transaction, 'function');
    assert.equal(call[2], context.workspaceId);
    assert.deepEqual(call[3], actor);
    assert.equal(call[5].commandId, index === 0 ? context.callId : readContext.callId);
    assert.ok(call[5].signal instanceof AbortSignal);
    assert.ok(Number.isFinite(call[5].deadlineAt));
  }
  const unavailable = await createChatTools(runtime).invokeWithSources(context, {
    tool: 'knowledge.search',
    query: 'supplier',
  });
  assert.equal(unavailable.result.error, 'knowledge-unavailable');
  assert.deepEqual(unavailable.sources, []);
});

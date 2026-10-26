import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import {
  chatCallSchema,
  createChatTools,
  discoverToolNames,
  discoverTools,
  parseToolCall,
  toolObservation,
  toolOutcome,
} from '../src/tools.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { randomUUID } from 'node:crypto';
import { fetchPublicText, publicIPv4 } from '../src/web-fetch.ts';
import { inferWithTools } from '../src/inference.ts';
import { completionReply, formats, nativeReply, nativeRoutes, toolResults, use } from './native-fixture.mjs';

test('catalog restrictions and strict invocation validation agree', () => {
  const access = { kind: 'agent', tools: ['rows.list', 'rows.reverse', 'skills.read'] };
  assert.deepEqual(
    discoverTools(access)
      .map(tool => tool.name)
      .sort(),
    ['rows.list', 'rows.reverse', 'skills.read'],
  );
  assert.deepEqual(parseToolCall({ tool: 'skills.read', skillId: 'table-authoring' }, access), {
    tool: 'skills.read',
    skillId: 'table-authoring',
  });
  assert.throws(() => parseToolCall({ tool: 'skills.list' }, access));
  assert.throws(() => parseToolCall({ tool: 'skills.read', skillId: 'table-authoring', actor: 'admin' }, access));
  for (const name of ['rows.create', 'rows.update', 'rows.delete'])
    assert.equal(
      discoverTools({ kind: 'chat' }).some(tool => tool.name === name),
      true,
    );
  assert.equal(
    discoverTools({ kind: 'chat' }).some(tool => tool.name === 'tables.propose'),
    true,
  );
  assert.equal(
    discoverTools({ kind: 'chat' }).some(tool => tool.name === 'tables.definitions'),
    true,
  );
  assert.equal(
    parseToolCall(
      {
        tool: 'rows.update',
        tableId: '11111111-1111-4111-8111-111111111111',
        recordId: '22222222-2222-4222-8222-222222222222',
        expectedAppliedRevision: 'a'.repeat(40),
        values: {},
      },
      { kind: 'chat' },
    ).tool,
    'rows.update',
  );
  assert.throws(() =>
    parseToolCall(
      { tool: 'schema.save', tableId: '11111111-1111-4111-8111-111111111111' },
      { kind: 'agent', tools: ['schema.status'] },
    ),
  );
  assert.equal(
    discoverTools({ kind: 'chat' }).some(tool => tool.name === 'schema.save'),
    false,
  );
  assert.equal(
    discoverTools({ kind: 'chat' }).some(tool => tool.name === 'tables.list'),
    true,
  );
  assert.deepEqual(parseToolCall({ tool: 'tables.import.attachments' }, { kind: 'chat' }), {
    tool: 'tables.import.attachments',
  });
  assert.throws(() =>
    parseToolCall({ tool: 'tables.import.attachments' }, { kind: 'agent', tools: ['tables.import.attachments'] }),
  );
});

test('name-only discovery preserves ordered catalog admission and rereads changing access', () => {
  const mcp = {
    discovery: true,
    tools: [
      {
        handle: 'catalogued_tool_1',
        name: 'Catalogued tool',
        description: 'A test tool.',
        inputSchema: {},
        revision: 'a'.repeat(64),
      },
    ],
  };
  const tools = chatCallSchema.options.map(schema => schema.shape.tool.value);
  for (const access of [
    { kind: 'chat' },
    { kind: 'chat', earlierMessages: true },
    { kind: 'chat', mcp },
    { kind: 'chat', mcp: { discovery: false, tools: mcp.tools } },
    { kind: 'agent', tools: [] },
    { kind: 'agent', tools: [], selectedSkills: true },
    { kind: 'agent', tools },
    { kind: 'agent', tools, task: true, mcp },
  ]) {
    assert.deepEqual(
      discoverToolNames(access),
      discoverTools(access).map(tool => tool.name),
    );
  }
  const access = { kind: 'agent', tools: [] };
  assert.deepEqual(discoverToolNames(access), []);
  access.tools.push('schema.inspect');
  assert.deepEqual(discoverToolNames(access), ['schema.inspect']);
  access.tools.length = 0;
  assert.deepEqual(discoverToolNames(access), []);
});

test('chat is offered Slack tools only when this deployment enables Slack actions', async t => {
  const slackTools = names => names.filter(name => name.startsWith('slack.'));
  assert.deepEqual(slackTools(discoverToolNames({ kind: 'chat', slack: false })), []);
  assert.deepEqual(slackTools(discoverToolNames({ kind: 'chat', slack: true })).sort(), [
    'slack.message.send',
    'slack.reaction.add',
    'slack.resolve',
    'slack.thread.reply',
  ]);
  const previous = process.env.SLACK_OUTBOUND_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_OUTBOUND_ENABLED;
    else process.env.SLACK_OUTBOUND_ENABLED = previous;
  });
  for (const value of [undefined, 'false']) {
    if (value === undefined) delete process.env.SLACK_OUTBOUND_ENABLED;
    else process.env.SLACK_OUTBOUND_ENABLED = value;
    assert.deepEqual(slackTools(discoverToolNames({ kind: 'chat' })), []);
    assert.equal(
      discoverTools({ kind: 'chat' }).some(tool => tool.name.startsWith('slack.')),
      false,
    );
  }
  process.env.SLACK_OUTBOUND_ENABLED = 'true';
  assert.ok(discoverToolNames({ kind: 'chat' }).includes('slack.resolve'));
  delete process.env.SLACK_OUTBOUND_ENABLED;
  const runtime = {
    transaction: async () => assert.fail('a disabled Slack deployment must not read the workspace'),
  };
  const result = await createChatTools(runtime).invoke(
    {
      workspaceId: randomUUID(),
      actor: { kind: 'human', userId: randomUUID(), membershipId: randomUUID() },
      callId: randomUUID(),
    },
    { tool: 'slack.resolve', kind: 'channel', name: '#general' },
  );
  assert.equal(result.error, 'slack-disabled');
  assert.match(result.instruction, /turned off on this TulipFarm deployment/);
  assert.doesNotMatch(result.instruction, /Ask a workspace admin/);
});

test('every exposed tool has an operational description', () => {
  const mcp = {
    discovery: true,
    tools: [
      {
        handle: 'catalogued_tool_1',
        name: 'Catalogued tool',
        description: 'A test tool.',
        inputSchema: {},
        revision: 'a'.repeat(64),
      },
    ],
  };
  const chatTools = discoverTools({ kind: 'chat', earlierMessages: true, mcp });
  const agentTools = ['tables.list', 'rows.create', 'rows.update', 'rows.delete'].flatMap(name =>
    discoverTools({ kind: 'agent', tools: [name] }),
  );
  for (const tool of [...chatTools, ...agentTools]) {
    assert.ok(tool.description.length >= 100, `${tool.name} needs an operational description`);
    assert.match(tool.description, /\.\s/, `${tool.name} must distinguish operation and result boundaries`);
  }
});

test('chat and saved agents can start bounded saved-agent tasks and read their results', () => {
  const agentId = '11111111-1111-4111-8111-111111111111';
  const taskId = '22222222-2222-4222-8222-222222222222';
  const tools = ['agents.task.start', 'agents.task.read'];
  assert.deepEqual(
    discoverTools({ kind: 'agent', tools }).map(tool => tool.name),
    tools,
  );
  assert.ok(discoverTools({ kind: 'chat' }).some(tool => tool.name === 'agents.task.start'));
  assert.deepEqual(parseToolCall({ tool: 'agents.task.start', agentId, text: 'Do bounded work.' }, { kind: 'chat' }), {
    tool: 'agents.task.start',
    agentId,
    text: 'Do bounded work.',
    limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  });
  assert.deepEqual(parseToolCall({ tool: 'agents.task.read', taskId }, { kind: 'agent', tools }), {
    tool: 'agents.task.read',
    taskId,
  });
  assert.throws(() =>
    parseToolCall(
      { tool: 'agents.task.start', agentId, text: 'Do work.' },
      { kind: 'agent', tools: ['agents.task.read'] },
    ),
  );
  assert.throws(() =>
    parseToolCall({ tool: 'agents.task.start', agentId, text: 'Do work.', ownerId: 'someone-else' }, { kind: 'chat' }),
  );
});

test('chat can plan work, but cannot set the plan budget, and saved agents cannot plan', () => {
  const names = discoverTools({ kind: 'chat' }).map(tool => tool.name);
  for (const tool of ['plans.create', 'plans.read', 'plans.update', 'plans.start', 'plans.claim', 'plans.report'])
    assert.ok(names.includes(tool), tool);
  const create = {
    tool: 'plans.create',
    title: 'Build a waitlist',
    tasks: [{ key: 'frontend', title: 'Build the form' }],
  };
  const parsed = parseToolCall(create, { kind: 'chat' });
  assert.equal(parsed.tasks[0].kind, 'work');
  assert.equal('budget' in parsed, false);
  assert.throws(() =>
    parseToolCall(
      { ...create, budget: { toolCalls: 100000, activeMilliseconds: 1, credits: 100000 } },
      { kind: 'chat' },
    ),
  );
  assert.deepEqual(parseToolCall({ tool: 'plans.read' }, { kind: 'chat' }), { tool: 'plans.read' });
  assert.throws(() =>
    parseToolCall({ tool: 'plans.update', planId: randomUUID(), expectedVersion: 0, mutations: [] }, { kind: 'chat' }),
  );
  assert.doesNotThrow(() =>
    parseToolCall(
      {
        tool: 'plans.update',
        planId: randomUUID(),
        expectedVersion: 0,
        planning: {
          requirements: [{ key: 'form', description: 'A waitlist form', tasks: ['frontend'] }],
          prerequisites: [],
          verificationTask: 'verify',
        },
      },
      { kind: 'chat' },
    ),
  );
  assert.throws(() => parseToolCall({ tool: 'plans.read' }, { kind: 'agent', tools: ['plans.read'] }));
  assert.equal(
    discoverTools({ kind: 'agent', tools: ['agents.list'] }).some(tool => tool.name.startsWith('plans.')),
    false,
  );
});

test('tool outcomes include returned failures and waiting without using payload values as labels', () => {
  assert.deepEqual(toolObservation({ error: 'read-forbidden' }, 'github.personal.read'), {
    outcome: 'result_error',
    errorCode: 'read-forbidden',
  });
  assert.deepEqual(toolObservation({ data: { status: 'failed' } }, 'google.execute'), {
    outcome: 'result_error',
    errorCode: 'failed',
  });
  assert.deepEqual(toolObservation({ code: 'access-denied' }), { outcome: 'success', errorCode: 'access-denied' });
  for (const value of [
    { error: 'PRIVATE ERROR' },
    { data: { status: 'failed', result: 'PRIVATE RESULT' } },
    { kind: 'error' },
  ])
    assert.equal(toolOutcome(value), 'result_error');
  for (const value of [{ kind: 'waiting' }, { status: 'pending' }, { data: { status: 'executing' } }])
    assert.equal(toolOutcome(value), 'waiting');
  assert.equal(toolOutcome({ status: 'blocked' }), 'blocked');
  assert.equal(toolOutcome({ text: 'PRIVATE RESULT' }), 'success');
  assert.equal(
    toolOutcome({ state: 'failed', data: { text: 'PRIVATE RESULT' } }, 'github.personal.read'),
    'result_error',
  );
  assert.equal(toolOutcome({ statuses: ['succeeded', 'unknown'] }, 'github.personal.execute'), 'result_error');
  assert.equal(toolOutcome({ statuses: ['succeeded', 'unattempted'] }, 'github.personal.execute'), 'waiting');
  assert.equal(toolOutcome({ data: { status: 'cancelled' } }, 'google.read'), 'success');
  assert.equal(toolOutcome({ commandId: 'PRIVATE ID', status: 'conflict' }, 'agents.status'), 'result_error');
  for (const [result, expected] of [
    [{ kind: 'waiting', status: 'awaiting-approval' }, 'waiting'],
    [{ kind: 'receipt', status: 'rejected', result: 'PRIVATE RESULT' }, 'blocked'],
    [{ kind: 'receipt', status: 'outcome-unknown', result: 'PRIVATE RESULT' }, 'result_error'],
  ]) {
    const output = { result, sources: ['PRIVATE SOURCE'] };
    assert.equal(toolOutcome(output.result, 'mcp.call'), expected);
  }
});

test('returned tool failures the chat shows as failed are result_error with a bounded code', () => {
  assert.deepEqual(
    toolObservation({ provider: 'knowledge', error: 'knowledge-unavailable', reason: 'PRIVATE' }, 'knowledge.read'),
    { outcome: 'result_error', errorCode: 'knowledge-unavailable' },
  );
  assert.deepEqual(toolObservation({ kind: 'public-web', status: 'failed', url: 'PRIVATE' }, 'web.fetch'), {
    outcome: 'result_error',
    errorCode: 'failed',
  });
  assert.equal(toolOutcome({ kind: 'public-web', status: 'partial' }, 'web.search'), 'success');
  const branch = (status, passages = 0) => ({
    status,
    documents: passages ? [{ title: 'PRIVATE', passages: Array.from({ length: passages }, () => ({})) }] : [],
  });
  const retrieve = (...branches) => ({ provider: 'knowledge', action: 'search', branches });
  assert.deepEqual(toolObservation(retrieve(branch('unavailable'), branch('no-match')), 'knowledge.retrieve'), {
    outcome: 'result_error',
    errorCode: 'knowledge-unavailable',
  });
  assert.deepEqual(toolObservation(retrieve(branch('failed'), branch('unavailable')), 'knowledge.retrieve'), {
    outcome: 'result_error',
    errorCode: 'failed',
  });
  assert.equal(toolOutcome(retrieve(branch('failed'), branch('evidence', 2)), 'knowledge.retrieve'), 'success');
  assert.equal(toolOutcome(retrieve(branch('no-match')), 'knowledge.retrieve'), 'success');
});

test('chat tool dispatch records one payload-free outcome for success, returned failure, and exception', async t => {
  const lines = [];
  t.mock.method(process.stdout, 'write', line => {
    lines.push(line);
    return true;
  });
  const workspaceId = randomUUID(),
    actor = { kind: 'human', userId: 'PRIVATE USER', membershipId: randomUUID() };
  const budgets = new Map(),
    roots = new Map();
  const context = () => {
    const turnId = randomUUID(),
      callId = randomUUID();
    budgets.set(turnId, { version: 1, operations: [], completeCitationIds: [] });
    roots.set(callId, turnId);
    return { workspaceId, actor, callId };
  };
  const runtime = {
    transaction: async (_workspace, _compatibility, operation) =>
      operation({
        schema: 'synthetic',
        commonVersion: 47,
        client: {
          query: async (sql, values) => {
            if (sql.startsWith('SELECT c.turn_id')) {
              assert.deepEqual(
                values.slice(1),
                ['knowledge.search', null, actor.userId, actor.membershipId],
                'root lookup must bind the tool and current owner',
              );
              assert.ok(roots.has(values[0]), 'root lookup must use a server receipt');
              return { rows: [{ turn_id: roots.get(values[0]) }] };
            }
            if (sql.startsWith('SELECT knowledge_budget')) {
              assert.ok(budgets.has(values[0]), 'retrieval must use its server-owned turn');
              return { rows: [{ knowledge_budget: structuredClone(budgets.get(values[0])) }] };
            }
            if (sql.startsWith('UPDATE') && sql.includes('knowledge_budget')) {
              assert.ok(budgets.has(values[0]), 'retrieval must settle the admitted root');
              budgets.set(values[0], JSON.parse(values[1]));
              return { rows: [], rowCount: 1 };
            }
            throw new Error('PRIVATE TRANSACTION');
          },
        },
      }),
  };
  const result = { result: { text: 'PRIVATE RESULT' }, sources: [] };
  const expectedBudget = { initialRemaining: 0, deepRemaining: 3, gapRemaining: 3, stop: false };
  const expected = { result: { text: 'PRIVATE RESULT', budget: expectedBudget }, sources: [] };
  const knowledge = () => ({ search: async () => result });
  const observed = await createChatTools(runtime, { knowledge }).invokeWithSources(context(), {
    tool: 'knowledge.search',
    query: 'PRIVATE PROMPT',
  });
  assert.deepEqual(observed, expected);
  await createChatTools(runtime).invokeWithSources(context(), { tool: 'knowledge.search', query: 'PRIVATE PROMPT' });
  await assert.rejects(
    createChatTools(runtime).invoke(context(), { tool: 'mcp.search', query: 'PRIVATE ARGUMENT' }),
    AccessDenied,
  );
  for (const options of [
    {},
    { telemetryRuntime: undefined },
    { telemetryRuntime: 'slack' },
    { telemetryRuntime: 'task' },
  ]) {
    assert.deepEqual(
      await createChatTools(runtime, { knowledge, ...options }).invokeWithSources(context(), {
        tool: 'knowledge.search',
        query: 'PRIVATE PROMPT',
      }),
      expected,
    );
  }
  assert.deepEqual(
    [...budgets.values()]
      .filter(budget => budget.operations.length)
      .map(budget => budget.operations.map(operation => [operation.phase, operation.status])),
    Array.from({ length: 5 }, () => [['initial', 'completed']]),
  );
  assert.deepEqual(observed.result.budget, expectedBudget);
  const records = lines.map(line => JSON.parse(line)).filter(record => record.category === 'tool');
  assert.deepEqual(
    records.map(record => [record.tool, record.runtime, record.outcome]),
    [
      ['knowledge.search', 'chat', 'success'],
      ['knowledge.search', 'chat', 'result_error'],
      ['mcp.search', 'chat', 'error'],
      ['knowledge.search', 'chat', 'success'],
      ['knowledge.search', 'chat', 'success'],
      ['knowledge.search', 'slack', 'success'],
      ['knowledge.search', 'task', 'success'],
    ],
  );
  const returned = records.find(record => record.outcome === 'result_error');
  assert.equal(returned.event, 'call_failed');
  assert.equal(returned['error.type'], returned['error.code']);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|query|sources|arguments/);
});

test('agent executor records exceptions without leaking stored tool arguments', async t => {
  const lines = [];
  t.mock.method(process.stdout, 'write', line => {
    lines.push(line);
    return true;
  });
  let transactions = 0;
  const error = new Error('PRIVATE EXECUTOR FAILURE');
  const runtime = {
    transaction: async (_workspace, _compatibility, action) => {
      if (transactions++) throw error;
      return action({
        schema: 'synthetic',
        client: {
          query: async () => ({ rows: [{ call: { tool: 'web.fetch', url: 'https://example.com/PRIVATE' } }] }),
        },
      });
    },
  };
  await assert.rejects(
    createAgentExecutor({ runtime, telemetryRuntime: 'task' }).execute({
      workspaceId: randomUUID(),
      runId: randomUUID(),
      callId: randomUUID(),
    }),
    /Agent tool execution unavailable/,
  );
  const records = lines.map(line => JSON.parse(line)).filter(record => record.category === 'tool');
  assert.deepEqual(
    records.map(record => [record.tool, record.runtime, record.outcome]),
    [['web.fetch', 'task', 'error']],
  );
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|url|arguments/);
});

test('summary and linked-name lookup are granted like other reads and visible in chat', () => {
  const tableId = '11111111-1111-4111-8111-111111111111',
    fieldId = '22222222-2222-4222-8222-222222222222',
    expectedAppliedRevision = 'a'.repeat(40);
  const summarize = {
    tool: 'rows.summarize',
    tableId,
    expectedAppliedRevision,
    query: { version: 2, mode: 'summary' },
  };
  const resolve = { tool: 'rows.resolveReference', tableId, expectedAppliedRevision, fieldId, search: 'Acme' };
  assert.throws(() => parseToolCall(summarize, { kind: 'agent', tools: ['rows.list'] }));
  assert.throws(() => parseToolCall(resolve, { kind: 'agent', tools: ['rows.list'] }));
  assert.equal(parseToolCall(summarize, { kind: 'agent', tools: ['rows.summarize'] }).tool, 'rows.summarize');
  assert.equal(parseToolCall(resolve, { kind: 'chat' }).limit, 10);
  const chat = discoverTools({ kind: 'chat' });
  for (const name of ['rows.list', 'rows.summarize', 'rows.resolveReference', 'rows.page', 'schema.inspect'])
    assert.ok(
      chat.some(tool => tool.name === name),
      name,
    );
  const list = chat.find(tool => tool.name === 'rows.list');
  for (const phrase of [
    'schema',
    'rows.resolveReference',
    'never invent ids',
    'unchanged',
    'capped',
    'rows.summarize',
    'stale-revision',
    'denial',
  ])
    assert.match(list.description, new RegExp(phrase, 'i'));
  assert.deepEqual(Object.keys(list.inputSchema.properties).sort(), [
    'expectedAppliedRevision',
    'query',
    'rsql',
    'tableId',
    'tool',
  ]);
  assert.equal(JSON.stringify(list.inputSchema).includes('filters'), false);
  const legacy = { tool: 'rows.list', tableId, expectedAppliedRevision, query: { filters: [] } };
  assert.equal(chatCallSchema.safeParse(legacy).success, false);
  assert.equal(parseToolCall(legacy, { kind: 'agent', tools: ['rows.list'] }).query.limit, 50);
});

test('web boundary rejects local, special, credentialed, and non-HTTPS destinations', async () => {
  for (const ip of [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '168.63.129.16',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('93.184.216.34'), true);
  for (const ip of [
    '192.0.78.9',
    '192.0.78.17',
    '192.2.1.1',
    '198.51.99.255',
    '198.51.101.0',
    '203.0.112.255',
    '203.0.114.0',
    '192.0.1.255',
    '192.0.3.0',
    '172.15.255.255',
    '172.32.0.0',
  ])
    assert.equal(publicIPv4(ip), true, ip);
  for (const ip of [
    '192.0.0.0',
    '192.0.0.255',
    '192.0.2.0',
    '192.0.2.255',
    '192.88.99.1',
    '198.51.100.0',
    '198.51.100.255',
    '203.0.113.0',
    '203.0.113.255',
    '198.19.255.255',
    '100.127.255.255',
  ])
    assert.equal(publicIPv4(ip), false, ip);
  for (const url of [
    'http://example.com',
    'https://127.0.0.1',
    'https://user:pass@example.com',
    'https://example.com:8443',
    'https://[::1]',
  ])
    await assert.rejects(fetchPublicText(url), /web-url-denied/);
});

for (const format of formats)
  test(`${format} chat executes a selected tool and answers from its result`, async t => {
    const received = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      received.push(JSON.parse(options.body));
      return Response.json(
        received.length === 3
          ? completionReply(format)
          : nativeReply(
              format,
              received.length === 1
                ? { calls: [use('tables.definitions', {}, 'Listing your tables')] }
                : { text: 'You have an Invoices resource.' },
            ),
      );
    });
    const calls = [];
    const answer = await inferWithTools(
      nativeRoutes[format],
      [{ role: 'user', text: 'What resources exist?' }],
      async (call, activity) => {
        calls.push({ call, activity });
        return { resources: [{ name: 'Invoices' }] };
      },
    );
    assert.deepEqual(answer, { text: 'You have an Invoices resource.' });
    assert.deepEqual(calls, [
      { call: { tool: 'tables.definitions', archived: false, limit: 25 }, activity: 'Listing your tables' },
    ]);
    const [result] = toolResults(format, received[1]);
    assert.match(result.output, /^Untrusted tool result for tables\.definitions: .*Invoices/);
  });

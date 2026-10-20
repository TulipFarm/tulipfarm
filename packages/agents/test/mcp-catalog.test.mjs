import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createMcpCatalog, validateMcpCall } from '../src/mcp-catalog.ts';
import { agentDefinitionSchema } from '../src/contracts.ts';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { modelNativeTools, parseModelDecision } from '../src/model.ts';
import { inferDecision, inferWithTools } from '../src/inference.ts';
import { nativeChatTools } from '../src/native-tools.ts';
import { completionReply, isCompletionRequest, mcpName, nativeReply, offeredTools, use } from './native-fixture.mjs';

const entry = {
  handle: 'selected_opaque_handle_1',
  name: 'create_ticket',
  description: 'Untrusted tool description.',
  revision: 'a'.repeat(64),
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string', minLength: 3, maxLength: 10 }, count: { type: 'integer', minimum: 1 } },
    required: ['title', 'count'],
    additionalProperties: false,
  },
};
const call = { tool: 'mcp.call', handle: entry.handle, arguments: { title: 'Exact', count: 1 } };
const definition = {
  name: 'Agent',
  instructions: 'Do the requested work.',
  tools: [],
  mcp: [{ id: 'tickets', serverIdentity: 'b'.repeat(64), tools: [{ name: entry.name, revision: entry.revision }] }],
};
const input = { prompt: 'Private request.', definition, scope: [], task: true, mcp: createMcpCatalog([entry]).model() };

test('old agent definitions and Soul serialization retain absent MCP fields', () => {
  const old = { name: 'Agent', instructions: 'Do work.', tools: [] };
  assert.deepEqual(agentDefinitionSchema.parse(old), old);
  assert.equal(Object.hasOwn(agentDefinitionSchema.parse(old), 'mcp'), false);
  const document = { formatVersion: 1, id: '11111111-1111-4111-8111-111111111111', ...old };
  assert.equal(serializeAgentDocument(document), `${JSON.stringify(document, null, 2)}\n`);
});

test('original schema validation rejects coercion, excess keys, unknown handles and unselected calls', () => {
  validateMcpCall(call, input.mcp);
  for (const changed of [
    { ...call, handle: 'unselected_handle_1' },
    { ...call, arguments: { title: 'x', count: 1 } },
    { ...call, arguments: { title: 'Exact', count: '1' } },
    { ...call, arguments: { ...call.arguments, endpoint: 'https://attacker.test' } },
  ])
    assert.throws(() => validateMcpCall(changed, input.mcp));
  assert.throws(() => validateMcpCall(call));
  assert.throws(() => parseModelDecision({ kind: 'tool', text: 'Call', call }, { ...input, task: undefined }));
  assert.throws(() =>
    parseModelDecision(
      { kind: 'tool', text: 'Call', call },
      { ...input, definition: { ...definition, mcp: undefined } },
    ),
  );
});

test('large catalogs require bounded search, exact describe and described-handle admission', () => {
  const entries = Array.from({ length: 35 }, (_, i) => ({
    ...entry,
    handle: createHash('sha256').update(String(i)).digest('hex'),
    name: `ticket_${i}`,
  }));
  const catalog = createMcpCatalog(entries);
  assert.deepEqual(catalog.model(), { discovery: true, tools: [] });
  assert.equal(catalog.search('ticket').tools.length, 10);
  assert.equal(catalog.search('ticket').nextOffset, 10);
  assert.equal(catalog.search('ticket', 30).nextOffset, null);
  assert.throws(() => validateMcpCall({ ...call, handle: entries[0].handle }, catalog.model()));
  const described = catalog.describe(entries[0].handle);
  assert.deepEqual(described.tools[0].inputSchema, entry.inputSchema);
  validateMcpCall({ ...call, handle: entries[0].handle }, catalog.model([entries[0].handle]));
  assert.throws(() => catalog.describe('not_selected_handle'));
});

test('unsupported schemas fail visibly before model exposure', () => {
  for (const inputSchema of [
    { $ref: 'https://attacker.test/schema' },
    { type: 'string', pattern: '(a+)+$' },
    { type: 'object', evilKeyword: true },
  ])
    assert.throws(() => createMcpCatalog([{ ...entry, inputSchema }]));
});

test('property names and example keys are data rather than schema keywords', () => {
  const inputSchema = {
    type: 'object',
    properties: { format: { type: 'string' }, pattern: { type: 'string' }, contains: { type: 'boolean' } },
    examples: [{ format: 'json', pattern: 'plain', contains: true }],
    additionalProperties: false,
  };
  const catalog = createMcpCatalog([{ ...entry, inputSchema }]);
  validateMcpCall({ ...call, arguments: { format: 'json', pattern: 'plain', contains: true } }, catalog.model());
  assert.throws(() =>
    createMcpCatalog([
      { ...entry, inputSchema: { type: 'object', properties: { format: { type: 'string', pattern: '(a+)+$' } } } },
    ]),
  );
});

const routes = [
  { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'claude-opus-5-5', apiKey: 'fixture' },
  ...['gpt-6-astra', 'gpt-6-sol', 'Kimi-K2.6', 'DeepSeek-V4-Pro', 'grok-4'].map(model => ({
    provider: 'azure',
    endpoint: 'https://fixture.openai.azure.com/',
    model,
    auth: { kind: 'api-key', value: 'fixture' },
  })),
  {
    provider: 'google',
    endpoint: 'https://generativelanguage.googleapis.com/',
    model: 'gemini-fixture',
    apiKey: 'fixture',
  },
];
for (const route of routes)
  test(`${route.provider}/${route.model} preserves schema-keyword property names`, async t => {
    const properties = { const: { type: 'string' }, format: { type: 'string' }, pattern: { type: 'string' } };
    const original = {
      type: 'object',
      properties,
      required: ['const', 'format', 'pattern'],
      additionalProperties: false,
    };
    const mcp = createMcpCatalog([{ ...entry, inputSchema: original }]).model();
    let wire;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      wire = JSON.parse(init.body);
      return Response.json(
        response(route, {
          kind: 'tool',
          text: 'Review.',
          call: { ...call, arguments: { const: 'a', format: 'b', pattern: 'c' } },
        }),
      );
    });
    assert.equal((await inferDecision(route, { ...input, mcp })).kind, 'success');
    const found = [];
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.required) && value.required.includes('format') && value.required.includes('pattern'))
        found.push(value);
      for (const child of Object.values(value)) visit(child);
    }
    visit(wire);
    assert.ok(found.length > 0);
    for (const schema of found) assert.deepEqual(schema.properties, properties);
  });
function response(route, decision) {
  if (decision.kind === 'answer') return nativeReply(route, { text: decision.text });
  const selected = decision.call;
  const native =
    selected.tool === 'mcp.call'
      ? { name: mcpName(selected.handle), input: { activity: decision.text, arguments: selected.arguments } }
      : use(
          selected.tool,
          Object.fromEntries(Object.entries(selected).filter(([key]) => key !== 'tool')),
          decision.text,
        );
  return nativeReply(route, { calls: [native] });
}

for (const route of routes)
  test(`${route.provider}/${route.model} admits the same selected schema and rejects invalid original arguments`, async t => {
    const requests = [];
    let selected = { kind: 'tool', text: 'Request review.', call };
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json(response(route, selected));
    });
    const result = await inferDecision(route, input);
    assert.equal(result.kind, 'success');
    assert.deepEqual(result.decision.call, call);
    assert.match(JSON.stringify(requests[0]), new RegExp(mcpName(entry.handle)));
    assert.doesNotMatch(JSON.stringify(requests[0]), /selected_opaque_handle_1/);
    assert.match(JSON.stringify(requests[0]), /create_ticket/);
    selected = { ...selected, call: { ...call, arguments: { title: 'x', count: 1 } } };
    assert.equal((await inferDecision(route, input)).reason, 'invalid-decision');
    selected = { ...selected, call: { ...call, handle: 'unselected_handle_1' } };
    assert.equal((await inferDecision(route, input)).reason, 'invalid-decision');
  });

const mcpUse = (handle, args, activity = 'Creating the ticket') => ({
  name: mcpName(handle),
  input: { activity, arguments: args },
});

test('chat adapters meter actual dynamic schema bytes and execute only selected handles', async t => {
  const wire = [],
    meters = [],
    calls = [];
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    wire.push(init.body);
    return Response.json(
      isCompletionRequest(JSON.parse(init.body))
        ? completionReply(routes[1])
        : nativeReply(
            routes[1],
            step++ ? { text: 'Read complete.' } : { calls: [mcpUse(entry.handle, call.arguments)] },
          ),
    );
  });
  const result = await inferWithTools(
    routes[1],
    [{ role: 'user', text: 'Private request' }],
    async (value, activity) => {
      calls.push({ value, activity });
      return { content: [{ type: 'text', text: 'Provider result' }] };
    },
    async value => {
      meters.push(value);
      return async () => {};
    },
    false,
    null,
    { catalog: async () => input.mcp },
  );
  assert.equal(result.text, 'Read complete.');
  assert.deepEqual(calls, [{ value: call, activity: 'Creating the ticket' }]);
  assert.deepEqual(
    meters.map(meter => meter.inputBytes),
    wire.map(body => Buffer.byteLength(body)),
  );
});

test('unselected MCP functions are absent from both chat and task model schemas', () => {
  const names = nativeChatTools(undefined, false).tools.map(tool => tool.name);
  assert.equal(
    names.some(name => name.startsWith('mcp_')),
    false,
  );
  assert.equal(
    nativeChatTools({ discovery: false, tools: [] }, false).tools.some(tool => tool.name.startsWith('mcp_')),
    false,
  );
  assert.equal(
    modelNativeTools({ ...input, mcp: { discovery: false, tools: [] } }).tools.some(tool =>
      tool.name.startsWith('mcp_'),
    ),
    false,
  );
});

test('each admitted MCP handle becomes its own native tool without exposing the handle', () => {
  const { tools, resolve } = nativeChatTools(input.mcp, false);
  const tool = tools.find(candidate => candidate.name === mcpName(entry.handle));
  assert.ok(tool);
  assert.doesNotMatch(JSON.stringify(tools), /selected_opaque_handle_1/);
  assert.match(tool.description, /^create_ticket\nUntrusted tool description\.\n/);
  assert.match(tool.description, /external MCP server/);
  assert.deepEqual(tool.parameters.properties.arguments, entry.inputSchema);
  assert.deepEqual(tool.parameters.required.toSorted(), ['activity', 'arguments']);
  assert.deepEqual(resolve(mcpUse(entry.handle, call.arguments)), { ok: true, call, activity: 'Creating the ticket' });
  for (const invalid of [
    mcpUse('unselected_handle_1', call.arguments),
    { name: mcpName(entry.handle), input: { arguments: call.arguments } },
    { name: mcpName(entry.handle), input: { activity: 'Go', arguments: call.arguments, handle: 'x' } },
  ])
    assert.equal(resolve(invalid).ok, false, JSON.stringify(invalid));
});

test('chat rejects MCP arguments that fail the original schema before dispatch', async t => {
  const wire = [];
  const replies = [
    { calls: [mcpUse(entry.handle, { title: 'x', count: 1 })] },
    { calls: [mcpUse(entry.handle, { title: 'Exact', count: '1' })] },
    { calls: [mcpUse(entry.handle, call.arguments)] },
    { text: 'Created.' },
  ];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    wire.push(JSON.parse(init.body));
    return Response.json(
      wire.length === 5 ? completionReply('anthropic') : nativeReply('anthropic', replies[wire.length - 1]),
    );
  });
  const calls = [];
  assert.deepEqual(
    await inferWithTools(
      routes[0],
      [{ role: 'user', text: 'Create it.' }],
      async value => {
        calls.push(value);
        return {};
      },
      undefined,
      false,
      null,
      { catalog: async () => input.mcp },
    ),
    { text: 'Created.' },
  );
  assert.deepEqual(calls, [call]);
  for (const body of wire.slice(1, 3)) {
    const [rejected] = body.messages.at(-1).content;
    assert.equal(rejected.is_error, true);
    assert.match(rejected.content, /^The MCP request was not dispatched\./);
  }
});

for (const route of routes)
  test(`${route.provider}/${route.model} native chat preserves schema-keyword property names`, async t => {
    const properties = { const: { type: 'string' }, format: { type: 'string' }, pattern: { type: 'string' } };
    const original = {
      type: 'object',
      properties,
      required: ['const', 'format', 'pattern'],
      additionalProperties: false,
    };
    const mcp = createMcpCatalog([{ ...entry, inputSchema: original }]).model();
    const args = { const: 'a', format: 'b', pattern: 'c' };
    const wire = [],
      calls = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      wire.push(JSON.parse(init.body));
      return Response.json(
        wire.length === 3
          ? completionReply(route)
          : nativeReply(route, wire.length === 1 ? { calls: [mcpUse(entry.handle, args)] } : { text: 'Done.' }),
      );
    });
    assert.deepEqual(
      await inferWithTools(
        route,
        [{ role: 'user', text: 'Create it.' }],
        async value => {
          calls.push(value);
          return {};
        },
        undefined,
        false,
        null,
        { catalog: async () => mcp },
      ),
      { text: 'Done.' },
    );
    assert.deepEqual(calls, [{ ...call, arguments: args }]);
    const tool = offeredTools(route, wire[0]).find(candidate => candidate.name === mcpName(entry.handle));
    assert.deepEqual(tool.parameters.properties.arguments.properties, properties);
  });

test('Kimi chat preserves default fields without mutating the authoritative catalog', async t => {
  const original = {
    type: 'object',
    properties: { default: { type: 'string' }, description: { type: 'string' } },
    required: ['default', 'description'],
    additionalProperties: false,
  };
  const mcp = createMcpCatalog([{ ...entry, inputSchema: original }]).model();
  const before = structuredClone(mcp);
  const args = { default: 'a', description: 'b' };
  let step = 0;
  const selected = { ...call, arguments: args };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const wire = JSON.parse(init.body);
    if (isCompletionRequest(wire)) return Response.json(completionReply(routes[3]));
    assert.match(JSON.stringify(wire), /"default":\{"type":"string"\}/);
    return Response.json(
      nativeReply(routes[3], step++ ? { text: 'Complete.' } : { calls: [mcpUse(entry.handle, args)] }),
    );
  });
  const calls = [];
  assert.deepEqual(
    await inferWithTools(
      routes[3],
      [{ role: 'user', text: 'Read.' }],
      async value => {
        calls.push(value);
        return {};
      },
      undefined,
      false,
      null,
      { catalog: async () => mcp },
    ),
    { text: 'Complete.' },
  );
  assert.deepEqual(calls, [selected]);
  assert.deepEqual(mcp, before);
  validateMcpCall(selected, mcp);
});

for (const route of routes)
  test(`${route.provider}/${route.model} chat discovers large catalogs before exact call admission`, async t => {
    const catalog = createMcpCatalog(
      Array.from({ length: 20 }, (_, i) => ({ ...entry, name: `ticket_${i}`, handle: `opaque_selected_handle_${i}` })),
    );
    const handle = 'opaque_selected_handle_3';
    let described = [],
      index = 0;
    const replies = [
      { calls: [use('mcp.search', { query: 'ticket_3', offset: 0 }, 'Searching connected tools')] },
      { calls: [use('mcp.describe', { handle }, 'Reading the tool details')] },
      { calls: [mcpUse(handle, call.arguments)] },
      { text: 'Received exact result.' },
    ];
    const wire = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      wire.push(JSON.parse(init.body));
      return Response.json(wire.length === 5 ? completionReply(route) : nativeReply(route, replies[index++]));
    });
    const calls = [];
    const answer = await inferWithTools(
      route,
      [{ role: 'user', text: 'Use ticket 3' }],
      async request => {
        calls.push(request.tool);
        if (request.tool === 'mcp.search') return catalog.search(request.query, request.offset);
        if (request.tool === 'mcp.describe') {
          described = [request.handle];
          return catalog.describe(request.handle);
        }
        return { content: [{ type: 'text', text: 'Actual result' }] };
      },
      undefined,
      false,
      null,
      { catalog: async () => catalog.model(described) },
    );
    assert.equal(answer.text, 'Received exact result.');
    assert.deepEqual(calls, ['mcp.search', 'mcp.describe', 'mcp.call']);
    const tools = body => offeredTools(route, body);
    assert.ok(isCompletionRequest(wire[4]));
    for (const body of wire.slice(0, 4))
      assert.ok(['mcp_search', 'mcp_describe'].every(name => tools(body).some(tool => tool.name === name)));
    assert.equal(
      tools(wire[0]).some(tool => tool.name === mcpName(handle)),
      false,
    );
    const admitted = tools(wire[2]).find(tool => tool.name === mcpName(handle));
    assert.ok(admitted);
    assert.match(JSON.stringify(admitted.parameters), /minLength|minimum/);
    for (const body of wire.slice(0, 4)) assert.doesNotMatch(JSON.stringify(tools(body)), /opaque_selected_handle_3/);
  });

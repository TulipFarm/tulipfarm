import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deferredToolIndex, discoveryBytes, nativeChatTools, nativeToolName } from '../src/native-tools.ts';
import { createMcpCatalog } from '../src/mcp-catalog.ts';
import { chatCallSchema, discoverTools, toolDescription } from '../src/tools.ts';
import { mcpName } from './native-fixture.mjs';

const entry = {
  handle: 'selected_opaque_handle_1',
  name: 'create_ticket',
  description: 'Untrusted tool description.',
  revision: 'a'.repeat(64),
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
};

test('present_choice is always offered with validated distinct options and no approval authority', () => {
  const catalog = nativeChatTools(undefined, false, new Set());
  assert.ok(catalog.tools.some(tool => tool.name === 'present_choice'));
  const input = {
    prompt: 'Who sends?',
    choices: [
      { id: 'app', label: 'TulipFarm app (Recommended)' },
      { id: 'personal', label: 'Personal Slack account' },
    ],
  };
  assert.ok(chatCallSchema.safeParse({ tool: 'present.choice', ...input }).success);
  assert.equal(
    chatCallSchema.safeParse({ tool: 'present.choice', ...input, choices: [input.choices[0], input.choices[0]] })
      .success,
    false,
  );
  assert.match(toolDescription('present.choice'), /never permission/);
});
test('the people and teams lookup is always offered and can list everyone', () => {
  const catalog = nativeChatTools(undefined, false, new Set());
  assert.ok(catalog.tools.some(tool => tool.name === 'members_find'));
  assert.ok(chatCallSchema.safeParse({ tool: 'members.find' }).success);
});
const discovery = createMcpCatalog(
  Array.from({ length: 35 }, (_, i) => ({ ...entry, name: `ticket_${i}`, handle: `opaque_selected_handle_${i}` })),
);
const catalogs = {
  none: [undefined, false],
  earlier: [undefined, true],
  admitted: [createMcpCatalog([entry]).model(), false],
  discovery: [discovery.model(['opaque_selected_handle_3']), true],
};

for (const [label, args] of Object.entries(catalogs))
  test(`${label} native tools have provider-safe names and object parameters with a required activity`, () => {
    const { tools } = nativeChatTools(...args);
    const names = tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0, tool.name);
      assert.equal(tool.parameters.type, 'object', tool.name);
      assert.ok(tool.parameters.required.includes('activity'), tool.name);
      assert.equal(tool.parameters.properties.activity.type, 'string');
      assert.equal(tool.parameters.properties.activity.maxLength, 120);
      assert.equal('tool' in tool.parameters.properties, false, tool.name);
      assert.equal('$schema' in tool.parameters, false, tool.name);
      for (const keyword of ['anyOf', 'oneOf', 'allOf'])
        assert.equal(keyword in tool.parameters, false, `${tool.name} ${keyword}`);
    }
  });

test('native tool names and descriptions follow the registered chat tools', t => {
  for (const [name, value] of [
    ['SLACK_OUTBOUND_ENABLED', 'true'],
    ['INTEGRATION_CREDENTIAL_KEY_ID', 'test'],
    ['INTEGRATION_CREDENTIAL_KEY', '33'.repeat(32)],
    ['TULIPFARM_EXECUTION_BACKEND', 'extension'],
  ]) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const { tools } = nativeChatTools(undefined, true, undefined, true);
  const registered = chatCallSchema.options
    .map(option => option.shape.tool.value)
    .filter(tool => !tool.startsWith('mcp.'));
  assert.deepEqual(
    tools.map(tool => tool.name),
    registered.map(nativeToolName),
  );
  for (const tool of registered)
    assert.equal(tools.find(candidate => candidate.name === nativeToolName(tool)).description, toolDescription(tool));
  assert.equal(nativeToolName('google.calendar.read'), 'google_calendar_read');
});

test('optional tools appear only when their context admits them', () => {
  const names = (...args) => nativeChatTools(...args).tools.map(tool => tool.name);
  assert.equal(names().includes('secrets_request'), false);
  assert.equal(names().includes('execution_run'), false);
  assert.equal(names().includes('conversation_messages_read'), false);
  assert.ok(names(undefined, true).includes('conversation_messages_read'));
  assert.equal(names().includes('files_read'), false);
  assert.ok(names(undefined, false, undefined, true).includes('files_read'));
  for (const name of ['mcp_search', 'mcp_describe']) {
    assert.equal(names().includes(name), false);
    assert.equal(names(createMcpCatalog([entry]).model()).includes(name), false);
    assert.ok(names(discovery.model()).includes(name));
  }
  assert.equal(
    names(discovery.model()).some(name => /^mcp_[0-9a-f]{24}$/.test(name)),
    false,
  );
  assert.ok(names(discovery.model(['opaque_selected_handle_3'])).includes(mcpName('opaque_selected_handle_3')));
  assert.ok(names(createMcpCatalog([entry]).model()).includes(mcpName(entry.handle)));
});

test('resolve maps a native name and input to the framework call with defaults and a trimmed activity', () => {
  const { resolve } = nativeChatTools(discovery.model(['opaque_selected_handle_3']), true);
  const resolved = (name, input) => resolve({ id: 'call_0', name, input, providerId: true });
  assert.deepEqual(resolved('tables_definitions', { activity: '  Listing your tables  ' }), {
    ok: true,
    activity: 'Listing your tables',
    call: { tool: 'tables.definitions', archived: false, limit: 25 },
  });
  assert.deepEqual(resolved('web_fetch', { activity: 'Reading the page', url: 'https://example.com/a' }), {
    ok: true,
    activity: 'Reading the page',
    call: { tool: 'web.fetch', url: 'https://example.com/a' },
  });
  assert.deepEqual(resolved('mcp_search', { activity: 'Searching connected tools', query: 'ticket', offset: 0 }), {
    ok: true,
    activity: 'Searching connected tools',
    call: { tool: 'mcp.search', query: 'ticket', offset: 0 },
  });
  assert.deepEqual(
    resolved(mcpName('opaque_selected_handle_3'), { activity: 'Creating a ticket', arguments: { title: 'A' } }),
    {
      ok: true,
      activity: 'Creating a ticket',
      call: { tool: 'mcp.call', handle: 'opaque_selected_handle_3', arguments: { title: 'A' } },
    },
  );
  const messageId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(resolved('conversation_messages_read', { activity: 'Reading earlier messages', messageId }), {
    ok: true,
    activity: 'Reading earlier messages',
    call: { tool: 'conversation.messages.read', messageId, offset: 0 },
  });
  assert.deepEqual(
    resolved('tables_definitions', { activity: 'Listing', tool: 'rows.delete' }).call.tool,
    'tables.definitions',
    'the native name, not an input field, selects the tool',
  );
});

test('resolve rejects unknown names, missing or blank activities, and invalid arguments', () => {
  const { resolve } = nativeChatTools();
  const error = (name, input) => {
    const result = resolve({ id: 'call_0', name, input, providerId: true });
    assert.equal(result.ok, false, `${name} ${JSON.stringify(input)}`);
    return result.error;
  };
  assert.equal(error('rows_purge', { activity: 'Deleting' }), 'Unknown tool "rows_purge". Use only the offered tools.');
  assert.equal(
    error('tables.definitions', { activity: 'Listing' }),
    'Unknown tool "tables.definitions". Use only the offered tools.',
  );
  assert.equal(
    error('conversation_messages_read', { activity: 'Reading' }),
    'Unknown tool "conversation_messages_read". Use only the offered tools.',
  );
  for (const input of [{}, { activity: '   ' }, { activity: 'x'.repeat(121) }, { activity: 7 }, undefined, 'text'])
    assert.match(error('tables_definitions', input), /^Invalid arguments: /);
  assert.match(error('web_fetch', { activity: 'Reading', url: 'not a url' }), /^Invalid arguments: .*"url"/);
  assert.match(error('web_fetch', { activity: 'Reading' }), /^Invalid arguments: /);
  assert.match(error('tables_definitions', { activity: 'Listing', unexpected: true }), /^Invalid arguments: /);
});

test('ordinary row work offers inspection and one bounded batch create without discovery round trips', () => {
  const catalog = nativeChatTools(undefined, false, new Set());
  for (const name of ['schema_inspect', 'rows_create_batch'])
    assert.ok(
      catalog.tools.some(tool => tool.name === name),
      name,
    );
  const input = {
    activity: 'Creating five tickets',
    tableId: '11111111-1111-4111-8111-111111111111',
    expectedAppliedRevision: 'a'.repeat(40),
    rows: Array.from({ length: 5 }, () => ({ values: {} })),
  };
  const resolve = input => catalog.resolve({ id: 'call', name: 'rows_create_batch', input, providerId: true });
  assert.equal(resolve(input).ok, true);
  for (const rows of [[], Array.from({ length: 101 }, () => ({ values: {} }))])
    assert.equal(resolve({ ...input, rows }).ok, false);
});

test('existing rows can be found and patched without discovering a write tool', () => {
  const catalog = nativeChatTools(undefined, false, new Set());
  for (const name of ['rows_list', 'rows_update_batch'])
    assert.ok(
      catalog.tools.some(tool => tool.name === name),
      name,
    );
  const bytes = catalog.tools
    .filter(tool => ['rows_list', 'rows_update_batch'].includes(tool.name))
    .reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)), 0);
  assert.ok(bytes < 4500, `lookup and partial-update definitions must fit their prompt budget: ${bytes} bytes`);
  const row = {
    recordId: '11111111-1111-4111-8111-111111111111',
    expectedToken: '22222222-2222-4222-8222-222222222222',
    values: { '33333333-3333-4333-8333-333333333333': { kind: 'text', value: 'Done' } },
  };
  const input = {
    activity: 'Updating a ticket',
    tableId: '44444444-4444-4444-8444-444444444444',
    expectedAppliedRevision: 'a'.repeat(40),
    rows: [row],
  };
  const resolve = input => catalog.resolve({ id: 'call', name: 'rows_update_batch', input, providerId: true });
  assert.equal(resolve(input).ok, true);
  for (const rows of [
    [],
    [row, row],
    [{ ...row, expectedToken: undefined }],
    [{ ...row, expectedToken: 'not-a-token' }],
    [{ ...row, recordId: 'not-an-id' }],
    [{ ...row, values: {} }],
    [{ ...row, values: { invalid: { kind: 'text', value: 'Done' } } }],
    [{ ...row, values: { '33333333-3333-4333-8333-333333333333': { kind: 'invented', value: 'Done' } } }],
  ])
    assert.equal(resolve({ ...input, rows }).ok, false);
});

test('discovery ranks an exact tool name ahead of description-only matches', () => {
  const catalog = nativeChatTools(undefined, false, new Set());
  assert.equal(catalog.search('rows.create')[0], 'rows_create');
});

test('deferred discovery names are visible outside the search description without loading their schemas', () => {
  const loaded = new Set();
  const catalog = nativeChatTools(undefined, false, loaded);
  for (const name of [
    'agents_draft',
    'workflows_draft',
    'bud_preference_ask',
    'bud_preference_propose',
    'knowledge_add',
    'knowledge_update',
    'knowledge_remove',
    'projects_draft',
    'files_rename',
    'integrations_connect',
  ]) {
    assert.ok(catalog.discovery?.includes(name), name);
    assert.ok(!catalog.tools.some(tool => tool.name === name), `schema stays deferred: ${name}`);
  }
  for (const name of ['memory_read', 'memory_edit', 'memory_forget']) {
    assert.ok(
      catalog.tools.some(tool => tool.name === name),
      name,
    );
    assert.ok(!catalog.discovery.includes(name), `core tool is not duplicated: ${name}`);
  }
  assert.equal(loaded.size, 0);
  catalog.search('agents_draft');
  const next = nativeChatTools(undefined, false, loaded);
  assert.ok(next.tools.some(tool => tool.name === 'agents_draft'));
  assert.ok(!next.discovery.includes('agents_draft'), 'the index follows the current loaded set');
});

test('deferred discovery uses only the current admitted catalog and has a bounded text cost', t => {
  const previous = process.env.SLACK_OUTBOUND_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.SLACK_OUTBOUND_ENABLED;
    else process.env.SLACK_OUTBOUND_ENABLED = previous;
  });
  process.env.SLACK_OUTBOUND_ENABLED = 'false';
  const initial = nativeChatTools(undefined, false, new Set());
  for (const name of ['conversation_messages_read', 'images_generate', 'slack_resolve'])
    assert.ok(!initial.discovery?.includes(name), name);
  process.env.SLACK_OUTBOUND_ENABLED = 'true';
  const admitted = nativeChatTools(undefined, true, new Set(), true);
  for (const name of ['conversation_messages_read', 'images_generate', 'slack_resolve'])
    assert.ok(admitted.discovery?.includes(name), name);
  const offered = new Set(admitted.tools.map(tool => tool.name));
  for (const tool of nativeChatTools(undefined, true, undefined, true).tools)
    if (!offered.has(tool.name)) assert.ok(admitted.discovery.includes(tool.name), tool.name);
  assert.ok(Buffer.byteLength(admitted.discovery) <= 4096);
  assert.ok(
    Buffer.byteLength(admitted.tools.find(tool => tool.name === 'tools_search').description) < 400,
    'do not duplicate an unbounded description catalog inside the search tool',
  );
});

test('without integrations the index and search load exactly the same admitted deferred tools', t => {
  for (const name of ['SLACK_OUTBOUND_ENABLED', 'INTEGRATION_CREDENTIAL_KEY', 'INTEGRATION_CREDENTIAL_KEY_ID']) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  process.env.SLACK_OUTBOUND_ENABLED = 'false';
  const catalog = nativeChatTools(undefined, false, new Set());
  const offered = new Set(catalog.tools.map(tool => tool.name));
  const admitted = discoverTools({ kind: 'chat', earlierMessages: false, chatFiles: false }).map(tool =>
    nativeToolName(tool.name),
  );
  const deferred = admitted.filter(name => !offered.has(name));
  assert.deepEqual(catalog.discovery.split('\n')[2].split(', '), deferred);
  for (const name of ['slack_resolve', 'secrets_request', 'images_generate', 'conversation_messages_read']) {
    assert.ok(!catalog.discovery.includes(name), name);
    assert.ok(!nativeChatTools(undefined, false, new Set()).search(name).includes(name), name);
  }
  for (const name of deferred) {
    const loaded = new Set();
    const current = nativeChatTools(undefined, false, loaded);
    assert.equal(current.search(name)[0], name, name);
    assert.ok(
      [...loaded].every(tool => deferred.includes(tool)),
      name,
    );
    assert.ok(
      nativeChatTools(undefined, false, loaded).tools.some(tool => tool.name === name),
      name,
    );
  }
  const withMcp = nativeChatTools(createMcpCatalog([entry]).model(), false, new Set());
  assert.equal(withMcp.discovery, catalog.discovery, 'external labels and descriptions never enter the system index');
});

test('the discovery cap keeps a deterministic prefix and leaves overflow discoverable', () => {
  const catalog = nativeChatTools(undefined, true, new Set(), true);
  const current = catalog.discovery.split('\n')[2].split(', ');
  const names = [...current, ...Array.from({ length: 500 }, (_, i) => `future_tool_${String(i).padStart(4, '0')}`)];
  const index = deferredToolIndex(names);
  assert.equal(index, deferredToolIndex(names));
  assert.ok(Buffer.byteLength(index) <= 4096);
  const listed = index.split('\n')[2].split(', ');
  assert.deepEqual(listed, names.slice(0, listed.length), 'tools drop from the registration-order tail, not randomly');
  assert.ok(listed.length < names.length);
  assert.ok(listed.includes('agents_draft'));
  assert.ok(listed.includes('workflows_draft'));
  assert.match(index, /More tools are available through tools_search by purpose/);
});

test('declared skill tools load only admitted definitions and do not widen optional access', () => {
  const loaded = new Set();
  const catalog = nativeChatTools(undefined, false, loaded);
  assert.deepEqual(
    catalog.load([
      'agents.context',
      'agents.draft',
      'execution.run',
      'secrets.request',
      'conversation.messages.read',
      'made.up',
    ]),
    ['agents_context', 'agents_draft'],
  );
  assert.deepEqual(catalog.load(['agents.context', 'agents.draft']), []);
  const next = nativeChatTools(undefined, false, loaded);
  assert.ok(next.tools.some(tool => tool.name === 'agents_draft'));
  for (const name of ['execution_run', 'secrets_request', 'conversation_messages_read', 'made_up']) {
    assert.ok(!next.tools.some(tool => tool.name === name));
    assert.equal(next.resolve({ id: 'call', name, input: { activity: 'Reading' }, providerId: true }).ok, false);
  }
});

test('discovery loads a bounded set of definitions and skips large unrelated tools', () => {
  const loaded = new Set();
  const catalog = nativeChatTools(undefined, false, loaded);
  assert.ok(catalog.tools.some(tool => tool.name === 'tables_propose'));
  const names = catalog.search('github issue read');
  assert.equal(names[0], 'github_issue_read');
  for (const name of ['google_propose', 'github_personal_propose', 'atlassian_propose'])
    assert.ok(!names.includes(name), name);
  const bytes = nativeChatTools(undefined, false, new Set(names))
    .tools.filter(tool => names.includes(tool.name))
    .reduce((total, tool) => total + Buffer.byteLength(JSON.stringify(tool)), 0);
  assert.ok(bytes <= discoveryBytes, `${bytes} bytes`);
});

test('discovery still loads a large tool named exactly', () => {
  const names = nativeChatTools(undefined, false, new Set()).search('github personal propose');
  assert.deepEqual(names, ['github_personal_propose']);
});

test('repeated catalogs reuse tool schemas without sharing mutations or going stale', () => {
  const first = nativeChatTools(undefined, false, new Set());
  const snapshot = JSON.stringify(first.tools);
  first.tools[0].parameters.properties.injected = true;
  first.tools[0].name = 'changed';
  const second = nativeChatTools(undefined, false, new Set());
  assert.equal(JSON.stringify(second.tools), snapshot);
  assert.deepEqual(
    discoverTools({ kind: 'chat' }).map(tool => tool.inputSchema),
    discoverTools({ kind: 'chat' }).map(tool => tool.inputSchema),
  );
});

test('the catalog follows MCP content and loaded tools between calls', () => {
  const none = nativeChatTools(undefined, false, new Set());
  const withMcp = nativeChatTools(createMcpCatalog([entry]).model(), false, new Set());
  const changed = nativeChatTools(
    createMcpCatalog([{ ...entry, description: 'Another description.' }]).model(),
    false,
    new Set(),
  );
  assert.ok(withMcp.tools.length > none.tools.length);
  assert.notEqual(JSON.stringify(withMcp.tools), JSON.stringify(changed.tools));
  const loaded = new Set();
  const before = nativeChatTools(undefined, false, loaded).tools.length;
  loaded.add('rows_create');
  assert.notEqual(nativeChatTools(undefined, false, loaded).tools.length, before);
});

test('reply setup steps use their own chat detail spans', () => {
  const worker = readFileSync(new URL('../../../apps/worker/src/conversation-activities.ts', import.meta.url), 'utf8');
  const phases = readFileSync(new URL('../../observability/src/index.ts', import.meta.url), 'utf8');
  for (const phase of ['publisher-open', 'feature-flag', 'subagent-pool']) {
    assert.ok(worker.includes(`'${phase}'`), phase);
    assert.ok(phases.includes(`| '${phase}'`), phase);
  }
});

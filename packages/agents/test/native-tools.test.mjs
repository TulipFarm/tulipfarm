import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeChatTools, nativeToolName } from '../src/native-tools.ts';
import { createMcpCatalog } from '../src/mcp-catalog.ts';
import { chatCallSchema, toolDescription } from '../src/tools.ts';
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

test('native tool names and descriptions follow the registered chat tools', () => {
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

test('discovery ranks an exact tool name ahead of description-only matches', () => {
  const catalog = nativeChatTools(undefined, false, new Set());
  assert.equal(catalog.search('rows.create')[0], 'rows_create');
});

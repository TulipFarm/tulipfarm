import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import type * as ToolLabels from '../src/features/chat/tool-labels.tsx';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const { toolActivityItems } = (await server.ssrLoadModule('/src/features/chat/tool-labels.tsx')) as typeof ToolLabels;

type Tool = Parameters<typeof ToolLabels.toolActivityItems>[0][number];
const tool = (fields: Partial<Tool>) =>
  ({ id: crypto.randomUUID(), tool: 'tables.list', status: 'completed', ...fields }) as Tool;

test('every internal call retains its identity, order and independent status', () => {
  const list = tool({ tool: 'tables.list' });
  const agents = tool({ tool: 'agents.list', status: 'running' });
  assert.deepEqual(
    toolActivityItems([list, agents]).map(item => [item.id, item.status]),
    [
      [list.id, 'completed'],
      [agents.id, 'running'],
    ],
  );
  assert.equal(toolActivityItems([list])[0]?.label, 'Listing business tables');
  const done = toolActivityItems([tool({ tool: 'agents.list' }), list]);
  assert.equal(done.length, 2);
  assert.equal(done[1]?.label, 'Listing business tables');
});

test('interleaved calls and repeated tools keep every outcome without treating waiting as complete', () => {
  const calls = [
    tool({ tool: 'tables.list' }),
    tool({ tool: 'web.fetch', status: 'running' }),
    ...(['waiting', 'blocked', 'failed', 'cancelled', 'unknown'] as const).map(activityStatus =>
      tool({ tool: 'tables.list', activityStatus }),
    ),
  ];
  const items = toolActivityItems(calls);
  assert.deepEqual(
    items.map(item => item.id),
    calls.map(call => call.id),
  );
  assert.deepEqual(
    items.map(item => item.status),
    ['completed', 'running', 'waiting', 'blocked', 'failed', 'cancelled', 'unknown'],
  );
});

test('skill preparation stays hidden while actions and other discovery retain their order', () => {
  const hidden = [
    'skills.list',
    'skills.read',
    'skills.workspace',
    'skills.workspace.read',
    'skills.load',
    'skills.files.read',
    'skills.import.status',
  ].map(name => tool({ tool: name }));
  const visible = [
    'tables.definitions',
    'workflows.list',
    'skills.execute',
    'skills.draft',
    'skills.import',
    'skills.import.select',
  ].map(name => tool({ tool: name }));
  assert.deepEqual(toolActivityItems(hidden), []);
  assert.deepEqual(
    toolActivityItems([...hidden.slice(0, 2), ...visible, ...hidden.slice(2)]).map(item => item.id),
    visible.map(item => item.id),
  );
});

test('web searches and page reads keep distinct state-aware labels despite stored presentation', () => {
  for (const [name, running, completed, failed] of [
    ['web.search', 'Searching the web', 'Searched the web', 'Web search failed'],
    ['web.fetch', 'Reading a web page', 'Read a web page', 'Page read failed'],
  ]) {
    const presentation = { label: 'Searching the web', brand: null };
    assert.equal(toolActivityItems([tool({ tool: name, status: 'running', presentation })])[0]?.label, running);
    assert.equal(toolActivityItems([tool({ tool: name, status: 'completed', presentation })])[0]?.label, completed);
    assert.equal(toolActivityItems([tool({ tool: name, status: 'failed', presentation })])[0]?.label, failed);
    assert.doesNotMatch(
      toolActivityItems([tool({ tool: name, status: 'running', activityStatus: 'cancelled', presentation })])[0]!.label,
      /Searching|Reading|Searched|Read a/,
    );
  }
});

test('web activity carries titles and queries with operation-specific empty and failure states', () => {
  const url = 'https://example.com/article';
  const web = {
    status: 'success' as const,
    urls: [url],
    failedUrls: [],
    widened: false,
    query: 'actual search query',
    sources: [{ url, title: 'Page title' }],
  };
  const [item] = toolActivityItems([tool({ tool: 'web.search', web })]);
  assert.equal(item?.query, web.query);
  assert.deepEqual(item?.sources, web.sources);
  assert.match(
    toolActivityItems([tool({ tool: 'web.search', web: { ...web, status: 'empty' } })])[0]!.detail!,
    /different search/,
  );
  assert.doesNotMatch(
    toolActivityItems([tool({ tool: 'web.fetch', web: { ...web, status: 'empty' } })])[0]!.detail!,
    /search/,
  );
  const [failed] = toolActivityItems([tool({ tool: 'web.fetch', web: { ...web, status: 'failed' } })]);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.label, 'Page read failed');
});

test('grouped knowledge keeps truthful states and does not imply a Slides file exists', () => {
  const sample = (status: NonNullable<Tool['knowledge']>['status'], fields: Partial<Tool> = {}) =>
    tool({
      tool: 'knowledge.retrieve',
      knowledge: { action: 'search', status, branches: [] },
      ...fields,
    });
  assert.equal(toolActivityItems([sample('running', { status: 'running' })])[0]?.label, 'Searching knowledge');
  assert.equal(toolActivityItems([sample('success')])[0]?.label, 'Read knowledge sources');
  for (const status of ['partial', 'empty', 'unavailable', 'failed', 'exhausted', 'waiting'] as const) {
    const item = toolActivityItems([sample(status)])[0]!;
    assert.ok(item.detail, `${status} has explicit feedback and recovery.`);
    assert.doesNotMatch(item.label, /Slides|presentation created/i);
  }
  assert.equal(toolActivityItems([sample('failed')])[0]?.status, 'failed');
  assert.equal(toolActivityItems([sample('unavailable')])[0]?.status, 'failed');
  assert.equal(toolActivityItems([sample('exhausted')])[0]?.label, 'Knowledge search limit reached');
  const cancelled = toolActivityItems([sample('failed', { activityStatus: 'cancelled' })])[0]!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.label, 'Knowledge retrieval cancelled');
});

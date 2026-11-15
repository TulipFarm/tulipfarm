import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAppDefinition } from '../src/index.ts';

const tableId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const workflowId = '33333333-3333-4333-8333-333333333333';
const text = { id: 'root', component: 'Text', text: 'Open deals' };
const page = (fields = {}, components = [text]) => ({
  id: 'home',
  slug: 'home',
  title: 'Home',
  sources: [],
  actions: [],
  ...fields,
  surface: [
    { version: '1.0', createSurface: { surfaceId: fields.id ?? 'home', catalogId: 'tulipfarm/apps@1', components } },
  ],
});
const issues = definition => {
  const result = checkAppDefinition(definition);
  assert.equal(result.ok, false);
  return result.issues;
};
const componentPath = '/pages/0/surface/0/createSurface/components/0';

test('a page with sources, actions and bound buttons passes and keeps query defaults', () => {
  const result = checkAppDefinition({
    pages: [
      page(
        {
          sources: [
            { id: 'deals', kind: 'rows', tableId, query: { version: 2, mode: 'rows' } },
            { id: 'team', kind: 'members' },
          ],
          actions: [
            { id: 'openDeal', label: 'Open', kind: 'open-page', pageId: 'deal', row: { context: 'row' } },
            { id: 'close', label: 'Close', kind: 'run-workflow', workflowId, input: { deal: { context: 'row' } } },
          ],
        },
        [
          { id: 'root', component: 'Column', children: ['open', 'close'] },
          {
            id: 'open',
            component: 'Button',
            label: 'Open',
            action: { event: { name: 'openDeal', context: { row: 'x' } } },
          },
          {
            id: 'close',
            component: 'Button',
            label: 'Close',
            action: { event: { name: 'close', context: { row: { '@path': '/params/row' } } } },
          },
        ],
      ),
      page({ id: 'deal', slug: 'deal', title: 'Deal', row: { tableId }, sources: [{ id: 'deal', kind: 'row' }] }),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.definition.pages[0].sources[0].query, {
    version: 2,
    mode: 'rows',
    where: null,
    sort: [],
    limit: 50,
  });
  assert.equal(result.definition.pages[1].slug, 'deal');
});

test('page, source and action counts are limited', () => {
  const pages = Array.from({ length: 21 }, (_, index) => page({ id: `p${index}`, slug: `p${index}` }));
  assert.deepEqual(issues({ pages }), [{ path: '/pages', message: 'Too big: expected array to have <=20 items' }]);
  assert.equal(checkAppDefinition({ pages: pages.slice(0, 20) }).ok, true);
  assert.deepEqual(issues({ pages: [] }), [{ path: '/pages', message: 'Too small: expected array to have >=1 items' }]);

  const sources = Array.from({ length: 11 }, (_, index) => ({ id: `s${index}`, kind: 'members' }));
  assert.deepEqual(issues({ pages: [page({ sources })] }), [
    { path: '/pages/0/sources', message: 'Too big: expected array to have <=10 items' },
  ]);
  assert.equal(checkAppDefinition({ pages: [page({ sources: sources.slice(0, 10) })] }).ok, true);

  const actions = Array.from({ length: 21 }, (_, index) => ({
    id: `a${index}`,
    label: 'Open',
    kind: 'open-page',
    pageId: 'home',
  }));
  assert.deepEqual(issues({ pages: [page({ actions })] }), [
    { path: '/pages/0/actions', message: 'Too big: expected array to have <=20 items' },
  ]);
  assert.equal(checkAppDefinition({ pages: [page({ actions: actions.slice(0, 20) })] }).ok, true);
});

test('each surface keeps to the layout limits', () => {
  const children = Array.from({ length: 300 }, (_, index) => `t${index}`);
  const components = [
    { id: 'root', component: 'Column', children },
    ...children.map(id => ({ id, component: 'Text', text: 'x' })),
  ];
  assert.deepEqual(issues({ pages: [page({}, components)] }), [
    { path: '/pages/0/surface', message: 'The surface has 301 components; the limit is 300.' },
  ]);
  components[0] = { id: 'root', component: 'Column', children: children.slice(0, 299) };
  assert.equal(checkAppDefinition({ pages: [page({}, components.slice(0, 300))] }).ok, true);
});

test('script and style components and style props are refused', () => {
  assert.deepEqual(issues({ pages: [page({}, [{ id: 'root', component: 'Script', src: 'https://cdn.test/a.js' }])] }), [
    {
      path: `${componentPath}/component`,
      message: 'Unknown component "Script" in "tulipfarm/apps@1". Use one from the catalog.',
    },
  ]);
  assert.deepEqual(issues({ pages: [page({}, [{ id: 'root', component: 'Style', css: 'body { display: none }' }])] }), [
    {
      path: `${componentPath}/component`,
      message: 'Unknown component "Style" in "tulipfarm/apps@1". Use one from the catalog.',
    },
  ]);
  assert.deepEqual(issues({ pages: [page({}, [{ ...text, style: 'color: red' }])] }), [
    { path: componentPath, message: 'Unrecognized key: "style"' },
  ]);
});

test('links, images and URL-opening functions are refused', () => {
  assert.deepEqual(issues({ pages: [page({}, [{ ...text, text: 'See [the deal](https://example.test/deal)' }])] }), [
    { path: `${componentPath}/text`, message: 'Link "https://example.test/deal" is not allowed.' },
  ]);
  assert.deepEqual(issues({ pages: [page({}, [{ ...text, text: '![chart](https://example.test/chart.png)' }])] }), [
    { path: `${componentPath}/text`, message: 'Image "https://example.test/chart.png" is not allowed.' },
  ]);
  const openUrl = {
    id: 'root',
    component: 'Button',
    label: 'Visit',
    action: { functionCall: { '@call': 'openUrl', args: { url: { '@path': '/sources/deals/url' } } } },
  };
  assert.deepEqual(issues({ pages: [page({}, [openUrl])] }), [
    {
      path: `${componentPath}/action/functionCall/@call`,
      message: 'Unknown function "openUrl" in "tulipfarm/apps@1".',
    },
  ]);
  const install = { id: 'root', component: 'Embed', ref: { kind: 'package-install', url: 'https://example.test/p' } };
  assert.deepEqual(issues({ pages: [page({}, [install])] }), [
    {
      path: `${componentPath}/ref/kind`,
      message: "Invalid discriminator value. Expected 'workspace-file' | 'workflow'",
    },
  ]);
  const file = { id: 'root', component: 'Embed', ref: { kind: 'workspace-file', fileId: tableId } };
  assert.equal(checkAppDefinition({ pages: [page({}, [file])] }).ok, true);
});

test('reserved and repeated page slugs are refused', () => {
  for (const slug of ['edit', 'settings', 'versions'])
    assert.deepEqual(issues({ pages: [page({ slug })] }), [{ path: '/pages/0/slug', message: 'Reserved page slug' }]);
  assert.deepEqual(issues({ pages: [page(), page({ id: 'other' })] }), [
    { path: '/pages/1/slug', message: 'Page slugs must be unique' },
  ]);
  assert.equal(checkAppDefinition({ pages: [page({ slug: 'editor' })] }).ok, true);
});

test('buttons name declared actions and send exactly the bound context', () => {
  const ask = {
    id: 'ask',
    label: 'Ask',
    kind: 'ask-agent',
    agentId,
    message: 'Summarize this deal',
    bindings: { deal: { context: 'deal' } },
  };
  const button = context => ({
    id: 'root',
    component: 'Button',
    label: 'Ask',
    action: { event: { name: 'ask', context } },
  });
  assert.deepEqual(issues({ pages: [page({ actions: [ask] }, [button({ extra: 'x' })])] }), [
    { path: `${componentPath}/action/event/context`, message: 'Action ask needs context deal' },
    { path: `${componentPath}/action/event/context/extra`, message: 'Action ask does not bind context extra' },
  ]);
  assert.equal(checkAppDefinition({ pages: [page({ actions: [ask] }, [button({ deal: 'x' })])] }).ok, true);
  const followUp = { id: 'root', component: 'Button', label: 'More', action: { event: { name: 'follow_up' } } };
  assert.deepEqual(issues({ pages: [page({}, [followUp])] }), [
    { path: `${componentPath}/action/event/name`, message: 'The page declares no action follow_up' },
  ]);
});

test('page references and row parameters agree', () => {
  const open = (fields = {}) => ({ id: 'open', label: 'Open', kind: 'open-page', pageId: 'deal', ...fields });
  const deal = page({ id: 'deal', slug: 'deal', row: { tableId } });
  assert.deepEqual(issues({ pages: [page({ actions: [open({ pageId: 'missing' })] })] }), [
    { path: '/pages/0/actions/0/pageId', message: 'No page has ID missing' },
  ]);
  assert.deepEqual(issues({ pages: [page({ actions: [open()] }), deal] }), [
    { path: '/pages/0/actions/0', message: 'Page deal needs a row' },
  ]);
  assert.deepEqual(issues({ pages: [page({ actions: [open({ pageId: 'home', row: { context: 'row' } })] })] }), [
    { path: '/pages/0/actions/0/row', message: 'Page home takes no row' },
  ]);
  assert.deepEqual(issues({ pages: [page({ sources: [{ id: 'deal', kind: 'row' }] })] }), [
    { path: '/pages/0/sources/0', message: 'A row source needs a page row' },
  ]);
});

test('a summary source refuses a rows query and unknown keys', () => {
  const summary = { id: 'totals', kind: 'summary', tableId, query: { version: 2, mode: 'rows' } };
  assert.deepEqual(issues({ pages: [page({ sources: [summary] })] }), [
    { path: '/pages/0/sources/0/query/mode', message: 'Invalid input: expected "summary"' },
  ]);
  assert.deepEqual(issues({ pages: [page({ script: 'alert(1)' })] }), [
    { path: '/pages/0', message: 'Unrecognized key: "script"' },
  ]);
});

test('surfaces define components only, on the page ID and the apps catalog', () => {
  const data = { version: '1.0', updateDataModel: { surfaceId: 'home', path: '/sources', value: {} } };
  assert.deepEqual(issues({ pages: [{ ...page(), surface: [...page().surface, data] }] }), [
    { path: '/pages/0/surface/1', message: 'Later messages must be updateComponents' },
  ]);
  const chat = page();
  chat.surface[0].createSurface.catalogId = 'sprout/basic@2';
  assert.deepEqual(issues({ pages: [chat] }), [
    { path: '/pages/0/surface/0/createSurface/components/0/component', message: 'Unknown catalog "sprout/basic@2".' },
  ]);
  const renamed = page();
  renamed.surface[0].createSurface.surfaceId = 'other';
  assert.deepEqual(issues({ pages: [renamed] }), [
    { path: '/pages/0/surface/0/createSurface', message: 'The surface ID must be home' },
  ]);
});

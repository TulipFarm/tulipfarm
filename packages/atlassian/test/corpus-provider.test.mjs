import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAtlassianCorpusProvider, serializeJiraIssue } from '../src/corpus-provider.ts';
import { adfToMarkdown } from '../src/adf-markdown.ts';
import { AccountError } from '../src/account-contracts.ts';
import {
  AtlassianCorpusError,
  atlassianCorpusSelectionSchema,
  atlassianCorpusLimits,
} from '@tulipfarm/knowledge/atlassian-contracts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const cloudId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const token = 'reader-access-token';
const binding = { accountId, atlassianAccountId: 'reader-aaid', cloudId };
const site = {
  id: cloudId,
  name: 'acme',
  url: 'https://acme.atlassian.net',
  scopes: ['read:page:confluence', 'read:jira-work'],
};
const adf = (...content) => ({ type: 'doc', version: 1, content });
const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });

function account(overrides = {}) {
  return {
    id: accountId,
    protocol: 'atlassian-rest',
    ownership: 'personal',
    state: 'active',
    configured: true,
    identity: { id: 'reader-aaid', label: 'Reader', qualification: 'verified' },
    resources: [site],
    scopes: ['read:me', 'read:page:confluence', 'read:jira-work'],
    generation: 7,
    grantsVersion: 1,
    capabilities: { read: true, manage: true, use: true },
    ...overrides,
  };
}
function fixture(routes, accounts = [account()], tokenError = null) {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.atlassian.com');
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    const path = url.pathname.replace(`/ex/confluence/${cloudId}`, '').replace(`/ex/jira/${cloudId}`, '');
    const call = {
      method: init.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = await routes(call);
    return result instanceof Response ? result : Response.json(result);
  };
  const provider = createAtlassianCorpusProvider({
    fetcher,
    accounts: {
      list: async (actual, userId) => {
        assert.equal(actual, workspaceId);
        assert.equal(userId, 'reader');
        return { accounts, providers: [] };
      },
      withAccessToken: async (_w, _u, id, operation) => {
        assert.equal(id, accountId);
        if (tokenError) throw tokenError;
        return operation({
          protocol: 'atlassian-rest',
          accessToken: token,
          generation: 7,
          grantsVersion: 1,
          membershipId: 'm',
        });
      },
    },
  });
  return { calls, provider };
}
const page = (id, extra = {}) => ({
  id,
  title: `Page ${id}`,
  status: 'current',
  spaceId: '9001',
  authorId: 'author-aaid',
  createdAt: '2026-01-01T00:00:00.000Z',
  version: { number: 3, authorId: 'editor-aaid', createdAt: '2026-02-01T00:00:00.000Z' },
  _links: { webui: `/spaces/SUP/pages/${id}` },
  ...extra,
});
const confluence = call => {
  if (call.path === '/wiki/api/v2/spaces/9001') return { id: '9001', key: 'SUP', name: 'Suppliers' };
  if (call.path === '/wiki/api/v2/spaces/9001/pages')
    return {
      results: [page('101'), page('102', { status: 'trashed' })],
      _links: { next: '/wiki/api/v2/spaces/9001/pages?cursor=abc&limit=25' },
    };
  if (call.path === '/wiki/api/v2/pages')
    return {
      results: call.query.id
        .split(',')
        .filter(id => id !== '666')
        .map(id => page(id)),
    };
  if (call.path === '/wiki/api/v2/pages/201/descendants')
    return {
      results: [
        { id: '202', type: 'page', status: 'current' },
        { id: '203', type: 'whiteboard' },
      ],
      _links: {},
    };
  if (call.path === '/wiki/api/v2/pages/202')
    return page('202', {
      body: {
        atlas_doc_format: {
          value: JSON.stringify(
            adf(
              { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Terms' }] },
              paragraph('# not a heading'),
              { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('orchid')] }] },
            ),
          ),
        },
      },
    });
  if (call.path === '/wiki/api/v2/pages/202/ancestors') return { results: [{ id: '201' }] };
  if (call.path === '/wiki/api/v2/pages/404') return new Response('{}', { status: 404 });
  if (call.path === '/wiki/api/v2/pages/429')
    return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
  return new Response('{}', { status: 404 });
};
const issue = {
  id: '10001',
  key: 'OPS-1',
  fields: {
    summary: 'Orchid shipment',
    updated: '2026-10-01T10:00:00.000+0000',
    created: '2026-09-01T10:00:00.000+0000',
    project: { id: '7001', name: 'Operations' },
    issuetype: { name: 'Task' },
    status: { name: 'Open' },
    reporter: { accountId: 'rep-aaid', displayName: 'Rita' },
    description: adf(paragraph('orchid shipment delayed')),
  },
};
const comments = [
  {
    id: '1',
    author: { accountId: 'a1', displayName: 'Ann' },
    body: adf(paragraph('public update')),
    created: '2026-09-02T00:00:00.000+0000',
    updated: '2026-09-03T00:00:00.000+0000',
  },
  {
    id: '2',
    author: { accountId: 'a2', displayName: 'Ben' },
    body: adf(paragraph('salary detail')),
    created: '2026-09-02T00:00:00.000+0000',
    visibility: { type: 'role', value: 'Administrators' },
  },
  {
    id: '3',
    author: { accountId: 'a3', displayName: 'Cat' },
    body: adf(paragraph('internal agent note')),
    created: '2026-09-02T00:00:00.000+0000',
    jsdPublic: false,
  },
];
const jira = call => {
  if (call.path === '/rest/api/3/project/7001') return { id: '7001', key: 'OPS', name: 'Operations' };
  if (call.path === '/rest/api/3/search/jql')
    return {
      issues: [{ id: '10001', key: 'OPS-1', fields: { summary: 'Orchid shipment', updated: issue.fields.updated } }],
      nextPageToken: 'tok-2',
      isLast: false,
    };
  if (call.path === '/rest/api/3/issue/bulkfetch')
    return { issues: [{ id: '10001' }], issueErrors: [{ issueIdsOrKeys: ['10002'], errorMessages: ['not found'] }] };
  if (call.path === '/rest/api/3/issue/10001') return issue;
  if (call.path === '/rest/api/3/issue/10001/comment') return { comments, total: 3, startAt: 0 };
  if (call.path === '/rest/api/3/issue/10003')
    return { ...issue, id: '10003', fields: { ...issue.fields, project: { id: '7002', name: 'Other' } } };
  return new Response('{}', { status: 404 });
};

test('selection contract bounds targets, requires sorted unique IDs and matching products', () => {
  const ok = {
    product: 'confluence',
    cloudId,
    targets: [
      { kind: 'page', id: '201', descendants: true },
      { kind: 'space', id: '9001', descendants: false },
    ],
  };
  assert.equal(atlassianCorpusSelectionSchema.safeParse(ok).success, true);
  assert.equal(atlassianCorpusSelectionSchema.safeParse({ ...ok, targets: [...ok.targets].reverse() }).success, false);
  assert.equal(
    atlassianCorpusSelectionSchema.safeParse({ ...ok, targets: [ok.targets[1], ok.targets[1]] }).success,
    false,
  );
  assert.equal(atlassianCorpusSelectionSchema.safeParse({ ...ok, product: 'jira' }).success, false);
  assert.equal(
    atlassianCorpusSelectionSchema.safeParse({ ...ok, targets: [{ kind: 'space', id: '9001', descendants: true }] })
      .success,
    false,
  );
  assert.equal(
    atlassianCorpusSelectionSchema.safeParse({
      ...ok,
      targets: Array.from({ length: atlassianCorpusLimits.targets + 1 }, (_, i) => ({
        kind: 'page',
        id: String(1000 + i),
        descendants: false,
      })),
    }).success,
    false,
  );
});

test('only the caller own active personal REST account with a verified identity on the site is used', async () => {
  const shared = account({ ownership: 'business' });
  await assert.rejects(
    fixture(confluence, [shared])
      .provider.sites(workspaceId, 'reader')
      .then(r => assert.deepEqual(r.items, []))
      .then(() => fixture(confluence, [shared]).provider.discover(workspaceId, 'reader', cloudId, 'spaces')),
    error => error.code === 'not-linked',
  );
  await assert.rejects(
    fixture(confluence, [
      account({ identity: { id: 'x', label: 'x', qualification: 'grant-bound-needs-qualification' } }),
    ]).provider.discover(workspaceId, 'reader', cloudId, 'spaces'),
    error => error.code === 'not-linked',
  );
  await assert.rejects(
    fixture(confluence, [account({ resources: [] })]).provider.access(workspaceId, 'reader', binding, 'confluence', [
      '101',
    ]),
    error => error.code === 'stale-integration',
  );
  await assert.rejects(
    fixture(confluence).provider.access(
      workspaceId,
      'reader',
      { ...binding, atlassianAccountId: 'someone-else' },
      'confluence',
      ['101'],
    ),
    error => error.code === 'stale-integration',
  );
  await assert.rejects(
    fixture(confluence, [account({ scopes: ['read:me'], resources: [{ ...site, scopes: [] }] })]).provider.access(
      workspaceId,
      'reader',
      binding,
      'confluence',
      ['101'],
    ),
    error => error.code === 'insufficient-scope',
  );
  await assert.rejects(
    fixture(confluence, [account()], new AccountError('account-reconnect-required')).provider.access(
      workspaceId,
      'reader',
      binding,
      'confluence',
      ['101'],
    ),
    error => error.code === 'reconnect-required',
  );
  assert.deepEqual((await fixture(confluence).provider.sites(workspaceId, 'reader')).items, [
    { cloudId, name: 'acme', url: 'https://acme.atlassian.net' },
  ]);
});

test('a pinned account reads only its own sites and refuses a replaced account', async () => {
  const otherCloud = '44444444-4444-4444-8444-444444444444';
  const other = account({
    id: '55555555-5555-4555-8555-555555555555',
    identity: { id: 'other-aaid', label: 'Other', qualification: 'verified' },
    resources: [{ ...site, id: otherCloud, name: 'beta', url: 'https://beta.atlassian.net' }],
  });
  const { provider } = fixture(confluence, [account(), other]);
  assert.deepEqual(
    (await provider.sites(workspaceId, 'reader')).items.map(item => item.cloudId),
    [cloudId, otherCloud],
  );
  assert.deepEqual(
    (await provider.sites(workspaceId, 'reader', { account: accountId })).items.map(item => item.cloudId),
    [cloudId],
    'another identity never adds its sites',
  );
  await assert.rejects(
    provider.discover(workspaceId, 'reader', otherCloud, 'spaces', undefined, undefined, { account: accountId }),
    error => error.code === 'not-linked',
  );
  await assert.rejects(
    provider.sites(workspaceId, 'reader', { account: '66666666-6666-4666-8666-666666666666' }),
    error => error.code === 'stale-integration',
    'a replaced account is not silently swapped',
  );
  const inspected = await provider.inspectSelection(
    workspaceId,
    'reader',
    { product: 'confluence', cloudId, targets: [{ kind: 'space', id: '9001', descendants: false }] },
    { account: accountId },
  );
  assert.equal(inspected.binding.accountId, accountId);
});

test('Confluence discovery, inspection, batch access and listing use v2 endpoints with the reader token', async () => {
  const { provider, calls } = fixture(confluence);
  const inspected = await provider.inspectSelection(workspaceId, 'reader', {
    product: 'confluence',
    cloudId,
    targets: [{ kind: 'space', id: '9001', descendants: false }],
  });
  assert.deepEqual(inspected, {
    binding,
    title: 'Suppliers',
    targets: [{ kind: 'space', id: '9001', key: 'SUP', title: 'Suppliers' }],
  });
  const access = await provider.access(workspaceId, 'reader', binding, 'confluence', ['101', '666']);
  assert.deepEqual(access.visible, ['101']);
  assert.equal(access.accountGeneration, 7);
  assert.ok(Date.parse(access.accessedAt) <= Date.now());
  assert.deepEqual(calls.at(-1).query, { id: '101,666', limit: '250', status: 'current' });
  const space = await provider.list(
    workspaceId,
    'reader',
    binding,
    { kind: 'space', id: '9001', key: 'SUP', descendants: false },
    null,
  );
  assert.deepEqual(
    space.observations.map(o => [o.nativeId, o.sourceRevision, o.canonicalURL]),
    [['page:101', '3', 'https://acme.atlassian.net/wiki/spaces/SUP/pages/101']],
  );
  assert.equal(space.nextCursor, 'abc');
  const subtree = await provider.list(
    workspaceId,
    'reader',
    binding,
    { kind: 'page', id: '201', key: null, descendants: true },
    null,
  );
  assert.deepEqual(
    subtree.observations.map(o => o.nativeId),
    ['page:201', 'page:202'],
    'the root and child pages; whiteboards are skipped',
  );
  assert.equal(subtree.nextCursor, null);
});

test('Confluence reads verify selection, serialize ADF with provenance, and map provider failures', async () => {
  const { provider } = fixture(confluence);
  const read = await provider.read(
    workspaceId,
    'reader',
    binding,
    { kind: 'page', id: '201', key: null, descendants: true },
    '202',
  );
  assert.equal(read.sourceRevision, '3');
  assert.match(
    read.markdown,
    /^# Page 202\n\nConfluence page 202 in space 9001, version 3\. Created by author-aaid at 2026-01-01T00:00:00\.000Z\. Last edited by editor-aaid at 2026-02-01T00:00:00\.000Z\./,
  );
  assert.match(read.markdown, /\n## Terms\n/);
  assert.match(read.markdown, /\n\\# not a heading\n/);
  assert.match(read.markdown, /\n- orchid\n/);
  await assert.rejects(
    provider.read(
      workspaceId,
      'reader',
      binding,
      { kind: 'space', id: '9002', key: 'OTHER', descendants: false },
      '202',
    ),
    error => error.code === 'outside-selection',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, { kind: 'page', id: '999', key: null, descendants: true }, '202'),
    error => error.code === 'outside-selection',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, { kind: 'space', id: '9001', key: 'SUP', descendants: false }, '404'),
    error => error.code === 'not-found',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, { kind: 'space', id: '9001', key: 'SUP', descendants: false }, '429'),
    error => error instanceof AtlassianCorpusError && error.code === 'rate-limited' && error.retryAfterMs === 30000,
  );
});

test('Jira lists by project, checks visibility in bulk, and publishes only unrestricted comments', async () => {
  const { provider, calls } = fixture(jira);
  const project = { kind: 'project', id: '7001', key: 'OPS', descendants: false };
  const listed = await provider.list(workspaceId, 'reader', binding, project, null);
  assert.deepEqual(calls.at(-1).body, {
    jql: 'project = 7001 ORDER BY id ASC',
    fields: ['summary', 'updated'],
    maxResults: 25,
  });
  assert.deepEqual(listed.observations, [
    {
      nativeId: 'issue:10001',
      itemId: '10001',
      title: 'OPS-1: Orchid shipment',
      canonicalURL: 'https://acme.atlassian.net/browse/OPS-1',
      sourceRevision: '2026-10-01T10:00:00.000+0000',
      coverage: 'supported',
    },
  ]);
  assert.equal(listed.nextCursor, 'tok-2');
  assert.deepEqual(
    (await provider.access(workspaceId, 'reader', binding, 'jira', ['10001', '10002'])).visible,
    ['10001'],
    'issue security and missing issues come back as errors, not issues',
  );
  const read = await provider.read(workspaceId, 'reader', binding, project, '10001');
  assert.match(
    read.markdown,
    /^# OPS-1: Orchid shipment\n\nJira issue OPS-1 \(10001\) in project Operations\. Type: Task\. Status: Open\. Reported by Rita \(rep-aaid\)/,
  );
  assert.match(
    read.markdown,
    /## Comment by Ann \(a1\) at 2026-09-02T00:00:00\.000Z \(edited 2026-09-03T00:00:00\.000Z\)\n\npublic update/,
  );
  assert.doesNotMatch(read.markdown, /salary|internal agent note/);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, project, '10003'),
    error => error.code === 'outside-selection',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, project, '10004'),
    error => error.code === 'not-found',
  );
});

test('serializers bound Markdown size and neutralize structure in text', () => {
  assert.equal(
    adfToMarkdown(
      adf(paragraph('> quoted'), {
        type: 'codeBlock',
        attrs: { language: 'js' },
        content: [{ type: 'text', text: 'x()' }],
      }),
    ),
    '\\> quoted\n\n```js\nx()\n```',
  );
  assert.equal(adfToMarkdown({ type: 'paragraph' }), '');
  assert.throws(
    () =>
      serializeJiraIssue(
        {
          ...issue,
          fields: { ...issue.fields, description: adf(paragraph('x'.repeat(atlassianCorpusLimits.markdownBytes))) },
        },
        [],
      ),
    error => error.code === 'item-too-large',
  );
});

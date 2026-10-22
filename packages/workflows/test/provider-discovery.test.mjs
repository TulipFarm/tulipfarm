import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderDiscovery } from '../src/provider-discovery.ts';
import { ProviderFailure } from '../src/provider-adapters.ts';

const token = 'synthetic-secret-never-returned';
const uuid = '11111111-1111-4111-8111-111111111111';
const sources = [
  { provider: 'sheets', spreadsheetId: 'sheet', range: 'Orders!A2:C100', keyColumn: 1 },
  { provider: 'slack', teamId: 'T123', channelId: 'C123', conversation: 'public' },
  { provider: 'notion', dataSourceId: uuid },
  { provider: 'gmail', emailAddress: 'ops@example.com', labelId: 'INBOX' },
  { provider: 'forms', formId: 'form' },
  { provider: 'jira', cloudId: uuid, projectKey: 'OPS' },
  { provider: 'hubspot', portalId: '123', objectType: 'contacts' },
];
function response(url) {
  const path = url.pathname;
  if (path === '/v4/spreadsheets/sheet')
    return { spreadsheetId: 'sheet', sheets: [{ properties: { title: 'Orders' } }] };
  if (path.endsWith('/auth.test')) return { ok: true, team_id: 'T123', team: 'Operations' };
  if (path.endsWith('/conversations.info'))
    return { ok: true, channel: { id: 'C123', is_channel: true, is_private: false } };
  if (path.endsWith('/conversations.history')) return { ok: true, messages: [] };
  if (path.endsWith(`/data_sources/${uuid}`)) return { object: 'data_source', id: uuid };
  if (path.endsWith('/profile')) return { emailAddress: 'ops@example.com' };
  if (path.endsWith('/labels/INBOX')) return { id: 'INBOX' };
  if (path.endsWith('/messages')) return { resultSizeEstimate: 0 };
  if (path === '/v1/forms/form') return { formId: 'form' };
  if (path.endsWith('/responses')) return {};
  if (path.endsWith('/accessible-resources')) return [{ id: uuid, name: 'Operations' }];
  if (path.endsWith('/project/OPS')) return { key: 'OPS' };
  if (path.endsWith('/details')) return { portalId: 123 };
  if (path.endsWith('/objects/contacts/search')) return { total: 0, results: [] };
  throw Error(`Unmocked ${path}`);
}
function fixture(override) {
  const calls = [];
  const adapter = createProviderDiscovery(async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.href.includes(token), false);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const result = override ? await override(url, init) : response(url);
    return result instanceof Response ? result : Response.json(result);
  });
  return { adapter, calls };
}

for (const source of sources) {
  test(`${source.provider}: test validates identity without returning credentials or provider payloads`, async () => {
    const { adapter, calls } = fixture();
    assert.deepEqual(await adapter.test({ source, token }), { verified: true });
    assert.ok(calls.length);
    assert.ok(
      calls.every(call => !call.url.pathname.includes('/values/')),
      'does not poll sheet business rows',
    );
  });
  for (const [status, code] of [
    [401, 'credentials'],
    [403, 'permission'],
    [404, 'permission'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
  ]) {
    test(`${source.provider}: ${status} is a safe ${code} failure`, async () => {
      const { adapter } = fixture(() => new Response(token, { status }));
      await assert.rejects(
        adapter.test({ source, token }),
        error => error instanceof ProviderFailure && error.code === code && !String(error).includes(token),
      );
    });
  }
}

test('all directory kinds allowlist names and IDs, with fixed hosts and bounded paging', async () => {
  const cases = [
    [
      'sheets',
      'spreadsheetId',
      { files: [{ id: 'sheet', name: 'Orders', token }], nextPageToken: 'next' },
      'sheet',
      'Orders',
      undefined,
    ],
    ['forms', 'formId', { files: [{ id: 'form', name: 'Intake' }] }, 'form', 'Intake', undefined],
    ['slack', 'teamId', { ok: true, team_id: 'T123', team: 'Operations', token }, 'T123', 'Operations', undefined],
    [
      'slack',
      'channelId',
      {
        ok: true,
        channels: [
          { id: 'C123', name: 'ops', is_channel: true, is_private: false },
          { id: 'G123', name: 'private', is_private: true },
        ],
        response_metadata: { next_cursor: 'next' },
      },
      'C123',
      'ops',
      'T123',
    ],
    [
      'notion',
      'dataSourceId',
      {
        results: [{ object: 'data_source', id: uuid, title: [{ plain_text: 'Tasks' }], token }],
        has_more: true,
        next_cursor: 'next',
      },
      uuid,
      'Tasks',
      undefined,
    ],
    [
      'gmail',
      'emailAddress',
      { emailAddress: 'ops@example.com', token },
      'ops@example.com',
      'ops@example.com',
      undefined,
    ],
    ['gmail', 'labelId', { labels: [{ id: 'INBOX', name: 'Inbox' }] }, 'INBOX', 'Inbox', 'ops@example.com'],
    ['jira', 'cloudId', [{ id: uuid, name: 'Operations', token }], uuid, 'Operations', undefined],
    [
      'jira',
      'projectKey',
      { values: [{ key: 'OPS', name: 'Operations', token }], isLast: false },
      'OPS',
      'Operations',
      uuid,
    ],
    ['hubspot', 'portalId', { portalId: 123, token }, '123', 'HubSpot portal 123', undefined],
  ];
  for (const [provider, resource, body, value, label, parentId] of cases) {
    const { adapter, calls } = fixture(url => {
      if (
        (resource === 'channelId' && url.pathname.endsWith('/auth.test')) ||
        (resource === 'labelId' && url.pathname.endsWith('/profile')) ||
        (resource === 'projectKey' && url.pathname.endsWith('/accessible-resources'))
      )
        return response(url);
      return body;
    });
    const result = await adapter.resources({ provider, resource, token, ...(parentId ? { parentId } : {}) });
    assert.deepEqual(result.items, [{ value, label }], resource);
    assert.equal(JSON.stringify(result).includes(token), false);
    for (const call of calls)
      assert.ok(
        [
          'www.googleapis.com',
          'slack.com',
          'api.notion.com',
          'gmail.googleapis.com',
          'api.atlassian.com',
          'api.hubapi.com',
        ].includes(call.url.hostname),
      );
    if (resource === 'channelId') assert.equal(calls.at(-1).url.searchParams.get('types'), 'public_channel');
    if (resource === 'projectKey') assert.equal(result.nextCursor, '1');
  }
});

test('Slack maps HTTP-200 errors and excludes private and group direct conversations', async () => {
  for (const [error, code] of [
    ['invalid_auth', 'credentials'],
    ['token_revoked', 'credentials'],
    ['missing_scope', 'permission'],
    ['ratelimited', 'rate-limited'],
  ]) {
    await assert.rejects(
      fixture(() => ({ ok: false, error, token })).adapter.test({ source: sources[1], token }),
      failure => failure.code === code,
    );
  }
  const { adapter, calls } = fixture(url =>
    url.pathname.endsWith('/auth.test')
      ? response(url)
      : {
          ok: true,
          channels: [
            { id: 'D123', is_im: true, user: 'U123' },
            { id: 'G123', is_mpim: true },
          ],
        },
  );
  assert.deepEqual(
    (
      await adapter.resources({
        provider: 'slack',
        resource: 'channelId',
        parentId: 'T123',
        conversation: 'direct',
        token,
      })
    ).items,
    [{ value: 'D123', label: 'Direct message · U123' }],
  );
  assert.equal(calls.at(-1).url.searchParams.get('types'), 'im');
});

test('identity mismatch fails for every identified provider and Notion databases are not data sources', async () => {
  for (const [index, body] of [
    [0, { spreadsheetId: 'other' }],
    [1, { ok: true, team_id: 'TOTHER' }],
    [2, { object: 'database', id: uuid }],
    [3, { emailAddress: 'other@example.com' }],
    [4, { formId: 'other' }],
    [5, [{ id: '22222222-2222-4222-8222-222222222222', name: 'Other' }]],
    [6, { portalId: 456 }],
  ]) {
    await assert.rejects(
      fixture(() => body).adapter.test({ source: sources[index], token }),
      failure => failure.code === 'source-invalid',
    );
  }
});

test('source and polling scopes are checked separately for Forms, Slack, Gmail and HubSpot', async () => {
  for (const source of [sources[1], sources[3], sources[4], sources[6]]) {
    const { adapter } = fixture(url =>
      /history|messages|responses|\/search$/.test(url.pathname) ? new Response('{}', { status: 403 }) : response(url),
    );
    await assert.rejects(adapter.test({ source, token }), error => error.code === 'permission');
  }
});

test('invalid range bounds and key-column offsets are rejected without reading sheet cells', async () => {
  for (const patch of [
    { keyColumn: 3 },
    { range: 'NamedRange' },
    { range: 'A0:B10' },
    { range: 'C2:A1' },
    { range: 'A1:B1001' },
  ]) {
    await assert.rejects(
      fixture().adapter.test({ source: { ...sources[0], ...patch }, token }),
      failure => failure.code === 'source-invalid',
    );
  }
  const named = fixture(() => ({
    spreadsheetId: 'sheet',
    namedRanges: [
      { name: 'Orders', range: { startRowIndex: 1, endRowIndex: 100, startColumnIndex: 2, endColumnIndex: 5 } },
    ],
  }));
  assert.deepEqual(await named.adapter.test({ source: { ...sources[0], range: 'Orders', keyColumn: 2 }, token }), {
    verified: true,
  });
  await assert.rejects(
    named.adapter.test({ source: { ...sources[0], range: 'Orders', keyColumn: 3 }, token }),
    failure => failure.code === 'source-invalid',
  );
});

test('malformed, oversized, reflected and repeated-cursor responses never reach clients', async () => {
  const request = { provider: 'sheets', resource: 'spreadsheetId', token };
  for (const body of [
    new Response('not json'),
    new Response('x'.repeat(1048577)),
    {},
    { files: [{ id: 'sheet', name: token }] },
    { files: [], nextPageToken: 'repeat' },
  ]) {
    await assert.rejects(
      fixture(() => body).adapter.resources({ ...request, cursor: 'repeat' }),
      failure => failure.code === 'invalid-response',
    );
  }
  await assert.rejects(
    fixture(() => {
      throw new DOMException(token, 'TimeoutError');
    }).adapter.resources(request),
    failure => failure.code === 'unavailable' && !String(failure).includes(token),
  );
  const longToken = 'long-token-'.repeat(40);
  const reflected = createProviderDiscovery(async () =>
    Response.json({ files: [{ id: 'sheet', name: `prefix ${longToken}` }] }),
  );
  await assert.rejects(
    reflected.resources({ ...request, token: longToken }),
    failure => failure.code === 'invalid-response',
  );
});

test('pagination preserves an empty Slack page cursor and encodes opaque Google cursors', async () => {
  const slack = fixture(url =>
    url.pathname.endsWith('/auth.test')
      ? response(url)
      : { ok: true, channels: [], response_metadata: { next_cursor: 'next' } },
  );
  assert.deepEqual(
    await slack.adapter.resources({ provider: 'slack', resource: 'channelId', parentId: 'T123', token }),
    { items: [], nextCursor: 'next' },
  );
  const google = fixture(() => ({ files: [] }));
  await google.adapter.resources({
    provider: 'sheets',
    resource: 'spreadsheetId',
    token,
    cursor: 'https://attacker.example/?x=1&secret=2',
  });
  assert.equal(google.calls[0].url.hostname, 'www.googleapis.com');
  assert.equal(google.calls[0].url.searchParams.get('pageToken'), 'https://attacker.example/?x=1&secret=2');
});

test('invalid resource/provider pairs and arbitrary Jira parents make no upstream calls', async () => {
  const { adapter, calls } = fixture();
  for (const input of [
    { provider: 'slack', resource: 'spreadsheetId' },
    { provider: 'jira', resource: 'projectKey', parentId: 'https://attacker.example' },
  ]) {
    await assert.rejects(adapter.resources({ ...input, token }));
  }
  assert.equal(calls.length, 0);
});

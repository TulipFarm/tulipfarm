import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderAdapters, ProviderFailure } from '../src/provider-adapters.ts';
import { providerCursorSchema } from '../src/provider-contracts.ts';
import { providerServer } from './provider-fixture.mjs';

const since = '2026-09-29T00:00:00.000Z',
  now = new Date('2026-09-29T01:00:00.000Z');
const cursor = () => providerCursorSchema.parse({ since, until: null, page: null });
test('Sheets HTTP keyed baseline detects creation, update, and reversion without row-position identity', async () => {
  let rows = [
    ['a', 'first'],
    ['b', 'second'],
  ];
  const server = await providerServer(() => ({ body: { values: rows } }));
  try {
    const adapter = createProviderAdapters(server.fetch),
      source = { provider: 'sheets', spreadsheetId: 'sheet1', range: "'Orders'!A2:C1000", keyColumn: 0 };
    const baseline = await adapter.poll(source, 'fixture-secret', cursor(), now);
    assert.deepEqual(baseline.events, []);
    rows = [
      ['b', 'second'],
      ['a', 'first'],
    ];
    const reordered = await adapter.poll(source, 'fixture-secret', baseline.cursor, now);
    assert.deepEqual(reordered.events, []);
    rows = [
      ['a', 'changed'],
      ['b', 'second'],
      ['c', 'new'],
    ];
    const next = await adapter.poll(source, 'fixture-secret', reordered.cursor, now);
    assert.deepEqual(
      next.events.map(item => [item.kind, item.payload.rowKey]),
      [
        ['updated', 'a'],
        ['created', 'c'],
      ],
    );
    rows[0][1] = 'first';
    const reverted = await adapter.poll(source, 'fixture-secret', next.cursor, now);
    assert.equal(reverted.events[0].kind, 'updated');
    assert.notEqual(reverted.events[0].key, next.events[0].key);
    rows.push(['a', 'duplicate']);
    await assert.rejects(adapter.poll(source, 'fixture-secret', next.cursor, now), /source-invalid/);
    assert.equal(server.requests[0].headers.authorization, 'Bearer fixture-secret');
    assert.equal(server.requests[0].headers['x-provider-host'], 'sheets.googleapis.com');
    assert.equal(server.requests[0].url.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
  } finally {
    await server.close();
  }
});

const cases = [
  {
    source: { provider: 'slack', channelId: 'C123', conversation: 'public' },
    path: '/api/conversations.history',
    first: {
      ok: true,
      messages: [{ type: 'message', ts: '1790640010.000001', text: 'hello' }],
      has_more: true,
      response_metadata: { next_cursor: 'page2' },
    },
    last: { ok: true, messages: [], has_more: false },
    id: '1790640010.000001',
    pageField: 'cursor',
  },
  {
    source: { provider: 'notion', dataSourceId: '12345678-1234-4234-8234-123456789012' },
    path: '/v1/data_sources/12345678-1234-4234-8234-123456789012/query',
    first: {
      results: [{ object: 'page', id: 'page1', created_time: since, properties: {} }],
      has_more: true,
      next_cursor: 'page2',
    },
    last: { results: [], has_more: false, next_cursor: null },
    id: 'page1',
    pageField: 'start_cursor',
  },
  {
    source: { provider: 'gmail', labelId: 'INBOX' },
    path: '/gmail/v1/users/me/messages',
    first: { messages: [{ id: 'mail1' }], nextPageToken: 'page2' },
    last: { messages: [] },
    id: 'mail1',
    pageField: 'pageToken',
  },
  {
    source: { provider: 'forms', formId: 'form1' },
    path: '/v1/forms/form1/responses',
    first: {
      responses: [{ responseId: 'response1', createTime: since, lastSubmittedTime: since, answers: {} }],
      nextPageToken: 'page2',
    },
    last: { responses: [] },
    id: 'response1',
    pageField: 'pageToken',
  },
  {
    source: { provider: 'jira', cloudId: '12345678-1234-4234-8234-123456789012', projectKey: 'OPS' },
    path: '/ex/jira/12345678-1234-4234-8234-123456789012/rest/api/3/search/jql',
    first: {
      issues: [{ id: '10001', key: 'OPS-1', fields: { summary: 'New issue' } }],
      isLast: false,
      nextPageToken: 'page2',
    },
    last: { issues: [], isLast: true },
    id: '10001',
    pageField: 'nextPageToken',
  },
  {
    source: { provider: 'hubspot', objectType: 'contacts' },
    path: '/crm/v3/objects/contacts/search',
    first: {
      total: 1,
      results: [{ id: 'contact1', createdAt: since, properties: { email: 'fixture@example.com' } }],
      paging: { next: { after: 'page2' } },
    },
    last: { total: 1, results: [] },
    id: 'contact1',
    pageField: 'after',
  },
  {
    source: { provider: 'hubspot', objectType: 'tickets' },
    path: '/crm/v3/objects/tickets/search',
    first: {
      total: 1,
      results: [{ id: 'ticket1', createdAt: since, properties: { subject: 'Help' } }],
      paging: { next: { after: 'page2' } },
    },
    last: { total: 1, results: [] },
    id: 'ticket1',
    pageField: 'after',
  },
];
for (const example of cases)
  test(`${example.source.provider} actual HTTP transport normalizes events and resumes the exact paginated query`, async () => {
    const server = await providerServer(call => {
      if (call.url.pathname === '/api/auth.test') return { body: { ok: true, team_id: 'T123' } };
      if (call.url.pathname.endsWith('/profile')) return { body: { emailAddress: 'fixture@example.com' } };
      if (call.url.pathname === '/account-info/v3/details') return { body: { portalId: 123 } };
      if (call.url.pathname === '/api/conversations.info')
        return { body: { ok: true, channel: { id: 'C123', is_channel: true, is_private: false } } };
      if (call.url.pathname.endsWith('/messages/mail1'))
        return {
          body: {
            id: 'mail1',
            threadId: 'thread1',
            internalDate: String(Date.parse(since) + 1000),
            snippet: 'new mail',
            labelIds: ['INBOX'],
          },
        };
      assert.equal(call.url.pathname, example.path);
      if (example.source.provider === 'hubspot') {
        assert.deepEqual(
          call.body.filterGroups[0].filters.map(filter => filter.propertyName),
          ['createdate', 'createdate'],
        );
        assert.deepEqual(call.body.sorts, ['createdate']);
      }
      const page = call.body?.[example.pageField] ?? call.url.searchParams.get(example.pageField);
      return { body: page ? example.last : example.first };
    });
    try {
      const adapter = createProviderAdapters(server.fetch);
      const source = { ...example.source, teamId: 'T123', emailAddress: 'fixture@example.com', portalId: '123' };
      const first = await adapter.poll(source, 'fixture-secret', cursor(), now);
      assert.equal(first.events[0].key, example.id);
      assert.equal(first.cursor.page, 'page2');
      assert.equal(first.cursor.since, since);
      assert.equal(first.cursor.until, now.toISOString());
      const restarted = createProviderAdapters(server.fetch);
      const last = await restarted.poll(
        source,
        'fixture-secret',
        JSON.parse(JSON.stringify(first.cursor)),
        new Date('2026-09-29T02:00:00.000Z'),
      );
      assert.equal(last.cursor.page, null);
      assert.equal(last.cursor.since, '2026-09-29T00:55:00.000Z');
      const calls = server.requests.filter(call => call.url.pathname === example.path);
      assert.equal(calls[1].body?.[example.pageField] ?? calls[1].url.searchParams.get(example.pageField), 'page2');
      assert.ok(server.requests.every(call => call.headers.authorization === 'Bearer fixture-secret'));
      if (example.source.provider === 'notion') assert.equal(calls[0].headers['notion-version'], '2025-09-03');
      if (example.source.provider === 'gmail') assert.equal(calls[0].url.searchParams.get('labelIds'), 'INBOX');
      if (example.source.provider === 'jira') assert.match(calls[0].body.jql, /project = "OPS"/);
      if (example.source.provider === 'gmail')
        await assert.rejects(
          adapter.poll({ ...source, emailAddress: 'other@example.com' }, 'fixture-secret', cursor(), now),
          /source-invalid/,
        );
      if (example.source.provider === 'hubspot')
        await assert.rejects(
          adapter.poll({ ...source, portalId: '456' }, 'fixture-secret', cursor(), now),
          /source-invalid/,
        );
    } finally {
      await server.close();
    }
  });

test('Forms creation uses the persisted activation floor across overlap, pages and response edits', async () => {
  const server = await providerServer(() => ({
    body: {
      responses: [
        { responseId: 'historical', createTime: '2020-01-01T00:00:00Z', lastSubmittedTime: now.toISOString() },
        { responseId: 'new-edited', createTime: since, lastSubmittedTime: now.toISOString() },
      ],
    },
  }));
  try {
    const adapter = createProviderAdapters(server.fetch),
      source = { provider: 'forms', formId: 'form1' };
    const first = await adapter.poll(source, 'fixture', cursor(), now);
    assert.deepEqual(
      first.events.map(event => event.key),
      ['new-edited'],
    );
    assert.equal(first.cursor.activationFloor, since);
    assert.equal(first.cursor.since, '2026-09-29T00:55:00.000Z');
    const next = await adapter.poll(
      source,
      'fixture',
      JSON.parse(JSON.stringify(first.cursor)),
      new Date('2026-09-29T02:00:00Z'),
    );
    assert.deepEqual(
      next.events.map(event => event.key),
      ['new-edited'],
    );
    assert.equal(next.cursor.activationFloor, since);
  } finally {
    await server.close();
  }
});

for (const example of cases.filter(value => value.source.provider !== 'gmail'))
  test(`${example.source.provider} projects oversized events with an explicit overflow marker`, async () => {
    const server = await providerServer(call => {
      if (call.url.pathname === '/api/auth.test') return { body: { ok: true, team_id: 'T123' } };
      if (call.url.pathname === '/api/conversations.info')
        return { body: { ok: true, channel: { id: 'C123', is_channel: true } } };
      if (call.url.pathname === '/account-info/v3/details') return { body: { portalId: 123 } };
      const body = structuredClone(example.first);
      const items = body.messages ?? body.results ?? body.responses ?? body.issues;
      if (example.source.provider === 'jira') items[0].fields.description = '\u0000'.repeat(40000);
      else items[0].large = '\u0000'.repeat(40000);
      return { body };
    });
    try {
      const page = await createProviderAdapters(server.fetch).poll(
        { ...example.source, teamId: 'T123', portalId: '123' },
        'fixture',
        cursor(),
        now,
      );
      assert.equal(page.events[0].key, example.id);
      assert.equal(page.events[0].payload.overflow.reason, 'provider-payload-too-large');
      assert.ok(page.events[0].payload.overflow.originalBytes > 32768);
      assert.ok(Buffer.byteLength(JSON.stringify(page.events[0].payload)) <= 32768);
      assert.equal(page.cursor.page, 'page2');
    } finally {
      await server.close();
    }
  });

test('Slack direct messages require the configured direct conversation, and transport failures are sanitized', async () => {
  let mode = 'direct';
  const server = await providerServer(call => {
    if (mode === 'rate')
      return { status: 429, headers: { 'retry-after': '120' }, body: { secret: 'never expose this' } };
    if (mode === 'redirect') return { status: 302, headers: { location: 'https://example.com/steal' }, body: {} };
    if (call.url.pathname === '/api/auth.test') return { body: { ok: true, team_id: 'T123' } };
    if (call.url.pathname.endsWith('info'))
      return { body: { ok: true, channel: { id: 'D123', is_im: mode === 'direct', is_private: true } } };
    return { body: { ok: true, messages: [{ ts: '1790640010.000001', type: 'message', text: 'private message' }] } };
  });
  try {
    const adapter = createProviderAdapters(server.fetch),
      source = { provider: 'slack', teamId: 'T123', channelId: 'D123', conversation: 'direct' };
    await assert.rejects(adapter.poll({ ...source, teamId: 'TOTHER' }, 'secret', cursor(), now), /source-invalid/);
    assert.equal((await adapter.poll(source, 'secret', cursor(), now)).events[0].payload.text, 'private message');
    mode = 'wrong';
    await assert.rejects(adapter.poll(source, 'secret', cursor(), now), /source-invalid/);
    mode = 'rate';
    await assert.rejects(
      adapter.poll(source, 'secret', cursor(), now),
      error => error instanceof ProviderFailure && error.retrySeconds === 120 && error.message === 'rate-limited',
    );
    mode = 'redirect';
    await assert.rejects(adapter.poll(source, 'secret', cursor(), now), /unavailable/);
  } finally {
    await server.close();
  }
});

test('Sheets and Gmail oversized values share the bounded projection without losing other events', async () => {
  let rows = [['initial', 'value']];
  const server = await providerServer(call => {
    if (call.headers['x-provider-host'] === 'sheets.googleapis.com') return { body: { values: rows } };
    if (call.url.pathname.endsWith('/profile')) return { body: { emailAddress: 'fixture@example.com' } };
    if (call.url.pathname.endsWith('/messages')) return { body: { messages: [{ id: 'big' }, { id: 'small' }] } };
    const id = call.url.pathname.split('/').at(-1);
    return {
      body: {
        id,
        threadId: 'thread',
        internalDate: String(Date.parse(since)),
        labelIds: ['INBOX'],
        snippet: id === 'big' ? '界'.repeat(20000) : 'valid',
      },
    };
  });
  try {
    const adapter = createProviderAdapters(server.fetch),
      sheets = { provider: 'sheets', spreadsheetId: 'sheet', range: 'A:B', keyColumn: 0 };
    const baseline = await adapter.poll(sheets, 'fixture', cursor(), now);
    rows = [
      ['big', '界'.repeat(20000)],
      ['small', 'valid'],
    ];
    const page = await adapter.poll(sheets, 'fixture', baseline.cursor, now);
    assert.equal(page.events[0].payload.overflow.reason, 'provider-payload-too-large');
    assert.deepEqual(page.events[1].payload.values, ['small', 'valid']);
    assert.deepEqual((await adapter.poll(sheets, 'fixture', page.cursor, now)).events, []);
    const mail = await adapter.poll(
      { provider: 'gmail', emailAddress: 'fixture@example.com', labelId: 'INBOX' },
      'fixture',
      cursor(),
      now,
    );
    assert.equal(mail.events[0].payload.overflow.reason, 'provider-payload-too-large');
    assert.equal(mail.events[1].payload.snippet, 'valid');
    assert.equal(mail.cursor.since, '2026-09-29T00:55:00.000Z');
  } finally {
    await server.close();
  }
});

test('provider overflow sample text does not split emoji pairs at the boundary', async () => {
  const emoji = '🌷';
  const item = value => ({ object: 'page', id: 'page1', created_time: since, properties: { value } });
  const offset = Array.from(JSON.stringify(item(''))).findIndex(
    (character, index, serialized) =>
      character === '"' && serialized[index + 1] === '}' && serialized[index + 2] === '}',
  );
  const filler = 'a'.repeat(4095 - offset);
  const server = await providerServer(() => ({
    body: {
      results: [
        { object: 'page', id: 'page1', created_time: since, properties: { value: filler + emoji + 'b'.repeat(40000) } },
      ],
    },
  }));
  try {
    const page = await createProviderAdapters(server.fetch).poll(
      { provider: 'notion', dataSourceId: '12345678-1234-4234-8234-123456789012' },
      'fixture',
      cursor(),
      now,
    );
    assert.equal(page.events[0].payload.overflow.reason, 'provider-payload-too-large');
    assert.equal(page.events[0].payload.preview.endsWith(emoji), true);
  } finally {
    await server.close();
  }
});

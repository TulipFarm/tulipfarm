import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSlackCorpusProvider, serializeSlackThread, slackThreadRevision } from '../src/corpus-provider.ts';
import { SlackCorpusError, slackCorpusSelectionSchema, slackCorpusLimits } from '@tulipfarm/knowledge/slack-contracts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const binding = {
  installationId: '22222222-2222-4222-8222-222222222222',
  installationGeneration: 3,
  identityId: '33333333-3333-4333-8333-333333333333',
  slackUserId: 'UREADER',
  teamId: 'TTEAM',
};
const allScopes = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
];
const token = 'xoxp-reader-private';
const general = { id: 'CGENERAL', name: 'general', is_private: false, is_member: true, is_archived: false };
const root = {
  ts: '1767225600.000100',
  user: 'UALICE',
  text: 'Orchid supplier kickoff',
  reply_count: 2,
  thread_ts: '1767225600.000100',
};
const replies = [
  root,
  {
    ts: '1767225601.000200',
    thread_ts: root.ts,
    user: 'UBOB',
    text: '# not a heading\nconfirmed &amp; signed',
    edited: { ts: '1767225700.000000' },
  },
  { ts: '1767225602.000300', thread_ts: root.ts, user: 'UALICE', text: 'thanks' },
];
const single = { ts: '1767225700.000100', user: 'UBOB', text: 'standalone update' };

function fixture(routes, scopes = allScopes) {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://slack.com');
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    const method = url.pathname.replace('/api/', '');
    calls.push({ method, query: Object.fromEntries(url.searchParams) });
    const result = await routes(method, Object.fromEntries(url.searchParams));
    if (result instanceof Response) return result;
    return Response.json(result);
  };
  const provider = createSlackCorpusProvider({
    credentials: async (actual, userId) => {
      assert.equal(actual, workspaceId);
      assert.equal(userId, 'reader');
      return { binding, token, scopes };
    },
    fetcher,
  });
  return { calls, provider };
}
const standard = (method, query) => {
  if (method === 'conversations.info')
    return query.channel === 'CGENERAL' ? { ok: true, channel: general } : { ok: false, error: 'channel_not_found' };
  if (method === 'conversations.history')
    return {
      ok: true,
      messages: [
        single,
        root,
        { ts: '1767225500.000000', subtype: 'channel_join', user: 'UBOB', text: 'joined' },
        replies[1],
      ],
      has_more: false,
    };
  if (method === 'conversations.replies')
    return query.ts === root.ts
      ? { ok: true, messages: replies, has_more: false }
      : query.ts === single.ts
        ? { ok: true, messages: [single], has_more: false }
        : { ok: false, error: 'thread_not_found' };
  if (method === 'users.conversations')
    return {
      ok: true,
      channels: [
        general,
        { id: 'CARCHIVED', name: 'old', is_archived: true },
        { id: 'GSECRET', name: 'secret', is_private: true, is_member: true },
      ],
      response_metadata: { next_cursor: 'next-page' },
    };
  return { ok: false, error: 'unknown_method' };
};

test('selection contract bounds conversations and requires sorted unique IDs', () => {
  assert.equal(
    slackCorpusSelectionSchema.safeParse({ kind: 'channels', conversationIds: ['CB', 'CA'], after: '2026-01-01' })
      .success,
    false,
  );
  assert.equal(
    slackCorpusSelectionSchema.safeParse({ kind: 'channels', conversationIds: ['CAA', 'CAA'], after: '2026-01-01' })
      .success,
    false,
  );
  assert.equal(
    slackCorpusSelectionSchema.safeParse({ kind: 'channels', conversationIds: [], after: '2026-01-01' }).success,
    false,
  );
  assert.equal(
    slackCorpusSelectionSchema.safeParse({ kind: 'personal', conversationIds: ['DAA', 'GBB'], after: '2026-01-01' })
      .success,
    true,
  );
  assert.equal(
    slackCorpusSelectionSchema.safeParse({
      kind: 'channels',
      conversationIds: Array.from(
        { length: slackCorpusLimits.conversations + 1 },
        (_, i) => `C${String(i).padStart(4, '0')}`,
      ),
      after: '2026-01-01',
    }).success,
    false,
  );
});

test('discovery lists only member conversations with permitted scopes and hides archived channels', async () => {
  const { provider, calls } = fixture(standard, ['channels:history', 'channels:read']);
  const result = await provider.discover(workspaceId, 'reader', 'channels');
  assert.deepEqual(calls[0].query, { types: 'public_channel', exclude_archived: 'true', limit: '200' });
  assert.deepEqual(
    result.items.map(item => item.conversationId),
    ['CGENERAL'],
  );
  assert.equal(result.nextCursor, 'next-page');
  await assert.rejects(
    provider.discover(workspaceId, 'reader', 'personal'),
    error => error instanceof SlackCorpusError && error.code === 'insufficient-scope',
  );
});

test('inspect rejects archived, non-member, wrong-kind, and unverifiable conversations', async () => {
  const cases = [
    [{ ...general, is_archived: true }, 'archived'],
    [{ ...general, is_member: false }, 'not-member'],
    [{ id: 'CGENERAL', is_im: true, user: 'UBOB' }, 'wrong-kind'],
  ];
  for (const [channel, code] of cases) {
    const { provider } = fixture(method =>
      method === 'conversations.info' ? { ok: true, channel } : standard(method, {}),
    );
    await assert.rejects(
      provider.inspectSelection(workspaceId, 'reader', {
        kind: 'channels',
        conversationIds: ['CGENERAL'],
        after: '2026-01-01',
      }),
      error => error.code === code,
    );
  }
  const { provider } = fixture(standard, ['channels:history']);
  await assert.rejects(
    provider.inspectSelection(workspaceId, 'reader', {
      kind: 'channels',
      conversationIds: ['CGENERAL'],
      after: '2026-01-01',
    }),
    error => error.code === 'insufficient-scope',
  );
  const ok = fixture(standard).provider;
  assert.deepEqual(
    await ok.inspectSelection(workspaceId, 'reader', {
      kind: 'channels',
      conversationIds: ['CGENERAL'],
      after: '2026-01-01',
    }),
    { binding, title: '#general', conversations: [{ conversationId: 'CGENERAL', kind: 'public', title: '#general' }] },
  );
});

test('access reports current membership with a pre-request observation time and maps denials', async () => {
  const before = Date.now();
  const { provider } = fixture(standard);
  const access = await provider.access(workspaceId, 'reader', binding, 'CGENERAL');
  assert.equal(access.member, true);
  assert.equal(access.archived, false);
  assert.ok(Date.parse(access.accessedAt) >= before && Date.parse(access.accessedAt) <= Date.now());
  await assert.rejects(
    provider.access(workspaceId, 'reader', binding, 'CPRIVATE'),
    error => error.code === 'forbidden',
  );
  await assert.rejects(
    provider.access(
      workspaceId,
      'reader',
      { ...binding, identityId: '44444444-4444-4444-8444-444444444444' },
      'CGENERAL',
    ),
    error => error.code === 'stale-integration',
  );
  const left = fixture(method =>
    method === 'conversations.info' ? { ok: true, channel: { ...general, is_member: false } } : {},
  ).provider;
  assert.equal((await left.access(workspaceId, 'reader', binding, 'CGENERAL')).member, false);
  for (const [response, code] of [
    [{ ok: false, error: 'invalid_auth' }, 'unauthenticated'],
    [{ ok: false, error: 'missing_scope' }, 'insufficient-scope'],
    [new Response('busy', { status: 429, headers: { 'retry-after': '7' } }), 'rate-limited'],
    [new Response('down', { status: 503 }), 'transient'],
  ]) {
    const { provider: failing } = fixture(() => response);
    await assert.rejects(
      failing.access(workspaceId, 'reader', binding, 'CGENERAL'),
      error => error.code === code && (code !== 'rate-limited' || error.retryAfterMs === 7000),
    );
  }
});

test('history page yields bounded thread units with revisions that match exact reads', async () => {
  const { provider, calls } = fixture(standard);
  const page = await provider.list(workspaceId, 'reader', binding, 'CGENERAL', '2026-01-01', null);
  assert.deepEqual(
    page.observations.map(item => item.nativeId),
    [`CGENERAL:${single.ts}`, `CGENERAL:${root.ts}`],
  );
  assert.equal(page.nextCursor, null);
  assert.equal(
    calls.find(call => call.method === 'conversations.history').query.oldest,
    `${Date.parse('2026-01-01') / 1000}.000000`,
  );
  assert.equal(calls.filter(call => call.method === 'conversations.replies').length, 1);
  const read = await provider.read(workspaceId, 'reader', binding, 'CGENERAL', root.ts, '2026-01-01');
  assert.equal(read.sourceRevision, page.observations[1].sourceRevision);
  assert.equal(
    (await provider.read(workspaceId, 'reader', binding, 'CGENERAL', single.ts, '2026-01-01')).sourceRevision,
    page.observations[0].sourceRevision,
  );
  assert.match(read.markdown, /^# #general · 2026-01-01 · Orchid supplier kickoff$/m);
  assert.match(read.markdown, /^## Message by UALICE at 2026-01-01T00:00:00\.000Z$/m);
  assert.match(read.markdown, /^## Reply by UBOB at 2026-01-01T00:00:01\.000Z \(edited 2026-01-01T00:01:40\.000Z\)$/m);
  assert.match(read.markdown, /^\\# not a heading$/m);
  assert.match(read.markdown, /confirmed & signed/);
  assert.equal(read.canonicalURL, `https://app.slack.com/client/TTEAM/CGENERAL/thread/CGENERAL-${root.ts}`);
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, 'CGENERAL', '1767225999.000000', '2026-01-01'),
    error => error.code === 'not-found',
  );
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, 'CGENERAL', root.ts, '2026-06-01'),
    error => error.code === 'outside-selection',
  );
});

test('edits and deletions change the revision; oversized threads are excluded rather than truncated', async () => {
  const edited = slackThreadRevision([
    root,
    { ...replies[1], text: 'changed', edited: { ts: '1767225800.000000' } },
    replies[2],
  ]);
  assert.notEqual(edited, slackThreadRevision(replies));
  assert.notEqual(slackThreadRevision([root, replies[1]]), slackThreadRevision(replies));
  assert.match(
    serializeSlackThread(general, [{ ...root, subtype: 'tombstone', text: 'This message was deleted.' }, replies[1]]),
    /_This message was deleted\._/,
  );
  const many = Array.from({ length: 200 }, (_, index) => ({
    ts: `1767225600.${String(100 + index).padStart(6, '0')}`,
    thread_ts: root.ts,
    user: 'UBOB',
    text: 'x',
  }));
  let pages = 0;
  const { provider } = fixture(method => {
    if (method === 'conversations.info') return { ok: true, channel: general };
    pages++;
    return {
      ok: true,
      messages:
        pages === 1
          ? [root, ...many.slice(1)]
          : many.map(m => ({ ...m, ts: `${1767226000 + pages}.${m.ts.split('.')[1]}` })),
      has_more: true,
      response_metadata: { next_cursor: `c${pages}` },
    };
  });
  await assert.rejects(
    provider.read(workspaceId, 'reader', binding, 'CGENERAL', root.ts, '2026-01-01'),
    error => error.code === 'thread-too-large',
  );
  assert.ok(pages <= slackCorpusLimits.threadPages);
  assert.throws(
    () =>
      serializeSlackThread(general, [
        { ...root, text: 'y'.repeat(40000) },
        ...Array.from({ length: 30 }, (_, i) => ({
          ...replies[1],
          ts: `1767225601.${String(i).padStart(6, '0')}`,
          text: 'z'.repeat(40000),
        })),
      ]),
    error => error.code === 'thread-too-large',
  );
});

test('a replies page that advertises more without a cursor is rejected instead of published as the whole thread', async () => {
  for (const response_metadata of [undefined, {}, { next_cursor: '' }]) {
    const { provider, calls } = fixture(method => {
      if (method === 'conversations.info') return { ok: true, channel: general };
      if (method === 'conversations.history') return { ok: true, messages: [root], has_more: false };
      return {
        ok: true,
        messages: [root, replies[1]],
        has_more: true,
        ...(response_metadata ? { response_metadata } : {}),
      };
    });
    await assert.rejects(
      provider.list(workspaceId, 'reader', binding, 'CGENERAL', '2026-01-01', null),
      error => error instanceof SlackCorpusError && error.code === 'invalid-response',
    );
    await assert.rejects(
      provider.read(workspaceId, 'reader', binding, 'CGENERAL', root.ts, '2026-01-01'),
      error => error instanceof SlackCorpusError && error.code === 'invalid-response',
    );
    assert.deepEqual(
      calls.filter(call => call.method === 'conversations.replies').map(call => call.query.cursor ?? null),
      [null, null],
    );
  }
});

test('replies split across cursor pages produce one complete thread', async () => {
  const { provider, calls } = fixture((method, query) => {
    if (method === 'conversations.info') return { ok: true, channel: general };
    if (method === 'conversations.history') return { ok: true, messages: [root], has_more: false };
    return query.cursor === 'page-2'
      ? { ok: true, messages: [replies[2]], has_more: false, response_metadata: { next_cursor: '' } }
      : { ok: true, messages: [root, replies[1]], has_more: true, response_metadata: { next_cursor: 'page-2' } };
  });
  const page = await provider.list(workspaceId, 'reader', binding, 'CGENERAL', '2026-01-01', null);
  assert.deepEqual(
    page.observations.map(item => [item.nativeId, item.coverage, item.sourceRevision]),
    [[`CGENERAL:${root.ts}`, 'supported', slackThreadRevision(replies)]],
  );
  const read = await provider.read(workspaceId, 'reader', binding, 'CGENERAL', root.ts, '2026-01-01');
  assert.equal(read.sourceRevision, slackThreadRevision(replies));
  assert.equal(read.coverage, 'supported');
  assert.match(read.markdown, /^Slack conversation #general \(CGENERAL\), thread 1767225600\.000100\. 2 replies\.$/m);
  assert.deepEqual(
    [...read.markdown.matchAll(/^## (.+)$/gm)].map(match => match[1]),
    [
      'Message by UALICE at 2026-01-01T00:00:00.000Z',
      'Reply by UBOB at 2026-01-01T00:00:01.000Z (edited 2026-01-01T00:01:40.000Z)',
      'Reply by UALICE at 2026-01-01T00:00:02.000Z',
    ],
  );
  assert.deepEqual(
    calls.filter(call => call.method === 'conversations.replies').map(call => call.query.cursor ?? null),
    [null, 'page-2', null, 'page-2'],
  );
});

test('bot-authored messages are withheld from Knowledge Markdown and their text leaves the thread revision', async () => {
  const answer = {
    ts: '1767225603.000400',
    thread_ts: root.ts,
    user: 'UTULIPBOT',
    bot_id: 'BTULIPFARM',
    text: 'Renewal price for Orchid Imports is 48250 per crate.',
  };
  const alert = {
    ts: '1767225604.000500',
    thread_ts: root.ts,
    subtype: 'bot_message',
    bot_id: 'BALERTS',
    text: 'Orchid shipment escalated to legal.',
  };
  const top = {
    ts: '1767225800.000100',
    user: 'UTULIPBOT',
    bot_id: 'BTULIPFARM',
    text: 'Q3 orchid margin is 31 percent.',
  };
  const { provider } = fixture((method, query) => {
    if (method === 'conversations.replies' && query.ts === root.ts)
      return { ok: true, messages: [...replies, answer, alert], has_more: false };
    if (method === 'conversations.replies' && query.ts === top.ts)
      return { ok: true, messages: [top], has_more: false };
    return standard(method, query);
  });
  const read = await provider.read(workspaceId, 'reader', binding, 'CGENERAL', root.ts, '2026-01-01');
  assert.doesNotMatch(read.markdown, /48250|escalated/);
  assert.match(
    read.markdown,
    /^## Reply by UTULIPBOT at 2026-01-01T00:00:03\.000Z\n\n_Bot message withheld from Knowledge\._$/m,
  );
  assert.match(
    read.markdown,
    /^## Reply by bot BALERTS at 2026-01-01T00:00:04\.000Z\n\n_Bot message withheld from Knowledge\._$/m,
  );
  assert.match(read.markdown, /^confirmed & signed$/m);
  assert.equal(read.sourceRevision, '618992cf163ea592dd7ec49757564f0feb383ba77cf3e508');
  assert.equal(
    slackThreadRevision(replies),
    '1c791cc574ddf6cca16319c48b1550a1c1005d50f48b52d8',
    'threads without bot messages keep their revision',
  );
  assert.equal(
    slackThreadRevision([...replies, answer]),
    'f96b1b1e19bcd5610a4186be6102ab9d79ae5d7aa5131872',
    'a unit stored with bot text under revision 4183126f… is re-imported',
  );
  assert.equal(
    slackThreadRevision([...replies, { ...answer, text: 'Renewal price is 1 per crate.' }, alert]),
    read.sourceRevision,
    'bot text does not enter the revision',
  );
  const alone = await provider.read(workspaceId, 'reader', binding, 'CGENERAL', top.ts, '2026-01-01');
  assert.equal(alone.title, '#general · 2026-01-01 · Bot message');
  assert.equal(
    alone.markdown,
    `# #general · 2026-01-01 · Bot message\n\nSlack conversation #general (CGENERAL), thread ${top.ts}. Single message.\n\n## Message by UTULIPBOT at 2026-01-01T00:03:20.000Z\n\n_Bot message withheld from Knowledge._\n`,
  );
});

test('a repeated cursor and malformed responses fail closed', async () => {
  const { provider } = fixture(method =>
    method === 'conversations.info'
      ? { ok: true, channel: general }
      : { ok: true, messages: [], has_more: true, response_metadata: {} },
  );
  await assert.rejects(
    provider.list(workspaceId, 'reader', binding, 'CGENERAL', '2026-01-01', null),
    error => error.code === 'invalid-response',
  );
  const bad = fixture(() => new Response('{not json', { status: 200 })).provider;
  await assert.rejects(
    bad.access(workspaceId, 'reader', binding, 'CGENERAL'),
    error => error.code === 'invalid-response',
  );
  const big = fixture(
    () =>
      new Response('x', { status: 200, headers: { 'content-length': String(slackCorpusLimits.responseBytes + 1) } }),
  ).provider;
  await assert.rejects(
    big.access(workspaceId, 'reader', binding, 'CGENERAL'),
    error => error.code === 'response-too-large',
  );
  const cursor = fixture(method =>
    method === 'conversations.info' ? { ok: false, error: 'invalid_cursor' } : {},
  ).provider;
  await assert.rejects(
    cursor.list(workspaceId, 'reader', binding, 'CGENERAL', '2026-01-01', 'stale'),
    error => error.code === 'invalid-cursor',
  );
});

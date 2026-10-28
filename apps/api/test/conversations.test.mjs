import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerConversations } from '../src/conversations.ts';
import { registerAbuseHooks } from '../src/abuse.ts';
import { AccessDenied } from '@tulipfarm/access';
import { useModelCatalog } from '../../worker/test/model-catalog-fixture.mjs';

// Messages without a model use the shipped catalog's default, served with this key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

test('private chat mutation budgets apply to verified users before persistence', async t => {
  const app = Fastify();
  const calls = [];
  const auth = { api: { getSession: async () => ({ user: { id: 'verified-user' } }) } };
  registerAbuseHooks(
    app,
    async (policy, userId) => {
      calls.push([policy.name, userId]);
      return 30;
    },
    auth,
  );
  registerConversations(app, { auth, service: {} });
  t.after(() => app.close());
  const base = `/workspaces/${randomUUID()}/conversations/${randomUUID()}`;
  for (const [method, url, payload] of [
    ['PUT', base, { commandId: randomUUID() }],
    [
      'PUT',
      `${base}/messages/${randomUUID()}`,
      { commandId: randomUUID(), parts: [{ kind: 'text', text: 'private' }] },
    ],
    ['POST', `${base}/turns/${randomUUID()}/retry`, { commandId: randomUUID(), expectedGeneration: 0 }],
    ['POST', `${base}/turns/${randomUUID()}/cancel`, { commandId: randomUUID(), expectedGeneration: 0 }],
    ['DELETE', base, { commandId: randomUUID() }],
  ]) {
    const response = await app.inject({ method, url, payload, headers: { origin: 'http://localhost:5173' } });
    assert.equal(response.statusCode, 429);
    assert.deepEqual(response.json(), { error: 'rate-limit-exceeded' });
    assert.equal(response.headers['retry-after'], '30');
  }
  assert.deepEqual(calls, [
    ['conversation-create', 'verified-user'],
    ['conversation-send', 'verified-user'],
    ['conversation-control', 'verified-user'],
    ['conversation-control', 'verified-user'],
    ['conversation-control', 'verified-user'],
  ]);
});

test('API_USER_RATE_LIMIT_MULTIPLIER scales the per-user chat budgets', async t => {
  const previous = process.env.API_USER_RATE_LIMIT_MULTIPLIER;
  t.after(() => {
    if (previous === undefined) delete process.env.API_USER_RATE_LIMIT_MULTIPLIER;
    else process.env.API_USER_RATE_LIMIT_MULTIPLIER = previous;
  });
  const auth = { api: { getSession: async () => ({ user: { id: 'verified-user' } }) } };
  const budgets = [];
  process.env.API_USER_RATE_LIMIT_MULTIPLIER = '50';
  const app = Fastify();
  registerAbuseHooks(
    app,
    async policy => {
      budgets.push([policy.name, policy.max]);
      return 30;
    },
    auth,
  );
  registerConversations(app, { auth, service: {} });
  t.after(() => app.close());
  const base = `/workspaces/${randomUUID()}/conversations/${randomUUID()}`;
  const headers = { origin: 'http://localhost:5173' };
  await app.inject({ method: 'PUT', url: base, payload: { commandId: randomUUID() }, headers });
  await app.inject({
    method: 'PUT',
    url: `${base}/messages/${randomUUID()}`,
    payload: { commandId: randomUUID(), parts: [{ kind: 'text', text: 'load' }] },
    headers,
  });
  assert.deepEqual(budgets, [
    ['conversation-create', 1000],
    ['conversation-send', 3000],
  ]);
  process.env.API_USER_RATE_LIMIT_MULTIPLIER = '0';
  assert.throws(() => registerAbuseHooks(Fastify(), async () => null, auth));
});

test('a message without a model replies on the model catalog default', async t => {
  t.after(useModelCatalog(['claude-sonnet', 'claude-haiku'], 'claude-haiku'));
  const app = Fastify();
  const sent = [];
  const auth = { api: { getSession: async () => ({ user: { id: 'verified-user' } }) } };
  const service = {
    send: async (_workspaceId, _userId, _chatId, input) => {
      sent.push(input.model);
      return { messageId: input.messageId, turnId: randomUUID(), sequence: 1 };
    },
  };
  registerConversations(app, { auth, service });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'PUT',
    url: `/workspaces/${randomUUID()}/conversations/${randomUUID()}/messages/${randomUUID()}`,
    payload: { commandId: randomUUID(), parts: [{ kind: 'text', text: 'Hello' }] },
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(sent, ['claude-haiku']);
});

test('bounded history reads reauthorize every page before validating reuse, redaction, deletion and errors', async t => {
  const app = Fastify();
  const workspaceId = randomUUID(),
    chatId = randomUUID();
  const base = `/workspaces/${workspaceId}/conversations/${chatId}`;
  const chat = {
    id: chatId,
    title: 'History',
    titleRevision: 1,
    archived: false,
    activityAt: '2026-10-12T00:00:00Z',
    createdAt: '2026-10-12T00:00:00Z',
  };
  let messages = Array.from({ length: 250 }, (_, index) => ({
    id: randomUUID(),
    sequence: index + 1,
    author: 'assistant',
    createdAt: chat.createdAt,
    parts: [{ kind: 'text', text: `Message ${index + 1}` }],
    turn: null,
    tools: [],
    calendarResults: [],
  }));
  let reads = [],
    denied = false,
    failed = false,
    metadataReads = 0;
  registerConversations(app, {
    auth: { api: { getSession: async () => ({ user: { id: 'reader' } }) } },
    service: {
      read: async () => {
        metadataReads++;
        if (denied) throw new AccessDenied();
        return chat;
      },
      history: async (workspace, user, id, { before }) => {
        assert.deepEqual([workspace, user, id], [workspaceId, 'reader', chatId]);
        reads.push(before ?? null);
        if (denied) throw new AccessDenied();
        if (failed && before) throw new Error('read failed');
        const remaining = messages.filter(row => before === undefined || row.sequence < before);
        const rows = remaining.slice(-50);
        return {
          messages: rows,
          nextBefore: remaining.length > 50 ? rows[0].sequence : null,
          hasGitHubProposals: false,
        };
      },
    },
  });
  t.after(() => app.close());
  const read = (payload = {}) =>
    app.inject({
      method: 'POST',
      url: `${base}/messages/pages`,
      headers: { origin: 'http://localhost:5173' },
      payload: { count: 5, before: null, known: [], ...payload },
    });
  const first = await read();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(metadataReads, 1);
  assert.deepEqual(reads, [null, 201, 151, 101, 51]);
  const known = first.json().pages.map(page => page.digest);
  const single = await app.inject({ method: 'GET', url: `${base}/messages` });
  assert.equal(single.json().digest, known[0], 'a first-page read can seed incremental validation');
  const continuation = await read({ before: 201, count: 1 });
  assert.equal(continuation.statusCode, 200);
  assert.equal(continuation.json().chat, undefined);
  assert.equal(metadataReads, 1, 'continuation chunks do not duplicate the metadata read');
  assert.equal(
    first.json().pages.reduce((sum, page) => sum + page.value.messages.length, 0),
    250,
  );
  reads = [];
  const unchanged = await read({ known });
  assert.equal(unchanged.statusCode, 200);
  assert.deepEqual(
    unchanged.json().pages,
    known.map(digest => ({ digest })),
  );
  assert.equal(reads.length, 5, 'unchanged digests never skip authorization');
  messages[0].parts = [{ kind: 'text', text: 'Source unavailable' }];
  const revoked = (await read({ known })).json();
  assert.equal(revoked.pages[4].value.messages[0].parts[0].text, 'Source unavailable');
  assert.equal(revoked.pages[0].value, undefined);
  messages = messages.slice(150);
  const deleted = (await read({ known })).json();
  assert.equal(deleted.pages.length, 2);
  assert.equal(deleted.pages[1].value.nextBefore, null);
  failed = true;
  assert.equal((await read({ known })).statusCode, 500, 'no partial success on a later-page failure');
  denied = true;
  assert.equal((await read({ known })).statusCode, 404, 'matching digests cannot bypass lost chat access');
  reads = [];
  for (const input of [
    { count: 6 },
    { count: 0 },
    { known: Array(6).fill(null) },
    { known: ['invalid'] },
    { before: -1 },
  ]) {
    assert.equal((await read(input)).statusCode, 400);
  }
  assert.equal(reads.length, 0, 'invalid bounds fail before service reads');
});

test('list windows follow fresh scanned cursors even through an empty authorized page', async t => {
  const app = Fastify();
  const workspaceId = randomUUID();
  const cursor = { activityAt: '2026-10-12T00:00:00.000000Z', id: randomUUID() };
  const chat = {
    id: randomUUID(),
    title: 'Visible',
    titleRevision: 1,
    archived: false,
    activityAt: cursor.activityAt,
    createdAt: cursor.activityAt,
  };
  const calls = [];
  registerConversations(app, {
    auth: { api: { getSession: async () => ({ user: { id: 'reader' } }) } },
    service: {
      list: async (workspace, user, input) => {
        calls.push({ workspace, user, input });
        return input.cursor ? { chats: [chat], nextCursor: null } : { chats: [], nextCursor: cursor };
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: `/workspaces/${workspaceId}/conversations/pages`,
    headers: { origin: 'http://localhost:5173' },
    payload: { count: 5, cursor: null, archived: false, query: '', known: [] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().pages.length, 2);
  assert.deepEqual(response.json().pages[0].value.chats, []);
  assert.equal(response.json().pages[1].value.chats[0].id, chat.id);
  assert.deepEqual(
    calls.map(call => call.input.cursor),
    [undefined, cursor],
  );
  assert.ok(calls.every(call => call.workspace === workspaceId && call.user === 'reader'));
});

test('a committed send starts its reply in the background and a failed send starts nothing', async t => {
  const app = Fastify();
  const workspaceId = randomUUID(),
    chatId = randomUUID();
  const sent = [];
  let fail = false;
  registerConversations(app, {
    auth: { api: { getSession: async () => ({ user: { id: 'sender' } }) } },
    service: {
      send: async (_workspaceId, _userId, _chatId, input, recorded) => {
        if (fail) throw new AccessDenied();
        recorded();
        return { messageId: input.messageId, turnId: randomUUID(), sequence: 1 };
      },
    },
    replies: { sent: (...args) => sent.push(args) },
  });
  t.after(() => app.close());
  const send = () =>
    app.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/conversations/${chatId}/messages/${randomUUID()}`,
      payload: { commandId: randomUUID(), parts: [{ kind: 'text', text: 'hey' }] },
      headers: { origin: 'http://localhost:5173' },
    });
  assert.equal((await send()).statusCode, 200);
  assert.deepEqual(sent, [[workspaceId, chatId]]);
  fail = true;
  assert.notEqual((await send()).statusCode, 200);
  assert.deepEqual(sent, [[workspaceId, chatId]], 'an uncommitted send must not start a reply');
});

test('a send records the time before its handler and passes its arrival to the saved turn', async t => {
  const app = Fastify();
  const details = [];
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', (line, ...rest) => {
    if (typeof line === 'string' && line.includes('"chat.detail.')) {
      details.push(JSON.parse(line));
      return true;
    }
    return write.call(process.stdout, line, ...rest);
  });
  // Authentication takes a simulated second, so the send-request phase is slow enough to be logged.
  const now = performance.now.bind(performance);
  let authenticationMs = 0;
  t.mock.method(performance, 'now', () => now() + authenticationMs);
  let arrival;
  registerConversations(app, {
    auth: {
      api: {
        getSession: async () => {
          authenticationMs = 1000;
          return { user: { id: 'sender' } };
        },
      },
    },
    service: {
      send: async (_workspaceId, _userId, _chatId, input, recorded, arrivedAt) => {
        arrival = arrivedAt;
        recorded();
        return { messageId: input.messageId, turnId: randomUUID(), sequence: 1 };
      },
    },
  });
  t.after(() => app.close());
  await app.ready();
  const before = performance.now();
  const response = await app.inject({
    method: 'PUT',
    url: `/workspaces/${randomUUID()}/conversations/${randomUUID()}/messages/${randomUUID()}`,
    payload: { commandId: randomUUID(), parts: [{ kind: 'text', text: 'hey' }] },
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(arrival >= before && arrival <= before + 25, `arrival ${arrival - before}ms after inject`);
  const request = details.find(line => line.operation === 'chat.detail.send-request');
  assert.ok(request, 'send-request phase recorded');
  assert.equal(request['chat.purpose'], 'send');
  assert.ok(request.duration_ms >= 1000, `send-request ${request.duration_ms}ms covers authentication`);
});

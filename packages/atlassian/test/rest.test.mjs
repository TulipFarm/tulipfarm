import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConfluenceTrashClient, createTrelloClient } from '../src/rest.ts';

const boardId = '111111111111111111111111';
const listId = '222222222222222222222222';
const cardId = '333333333333333333333333';
const foreignId = 'ffffffffffffffffffffffff';
const cloudId = '12345678-1234-4234-8234-123456789abc';
const spaceId = '41';
const pageId = '42';
const token = 'syntheticPrivateToken0123456789abcdef';
const apiKey = '0123456789abcdef0123456789abcdef';
const card = {
  id: cardId,
  idBoard: boardId,
  idList: listId,
  name: 'Prepare release',
  desc: 'Review the checklist',
  closed: false,
  url: 'https://trello.com/c/release',
  due: null,
  dueComplete: false,
};
const page = { id: pageId, spaceId, status: 'current' };
const changes = { name: 'Ready to release', desc: '', closed: true, due: '2026-10-01T12:00:00Z', dueComplete: true };
const operations = [
  {
    operation: { kind: 'card.search', query: 'release', page: 2 },
    responses: [{ cards: [card] }],
    methods: ['GET'],
    paths: ['/1/search'],
    result: { kind: 'cards', cards: [card], page: 2, mayHaveMore: false },
  },
  {
    operation: { kind: 'card.read', cardId },
    responses: [card],
    methods: ['GET'],
    paths: [`/1/cards/${cardId}`],
    result: { kind: 'card', card },
  },
  {
    operation: { kind: 'card.create', listId, name: card.name, desc: card.desc },
    responses: [{ id: listId, idBoard: boardId }, card],
    methods: ['GET', 'POST'],
    paths: [`/1/lists/${listId}`, '/1/cards'],
    body: { idList: listId, name: card.name, desc: card.desc },
    result: { kind: 'card', card },
  },
  {
    operation: { kind: 'card.update', cardId, changes },
    responses: [card, { ...card, ...changes }],
    methods: ['GET', 'PUT'],
    paths: [`/1/cards/${cardId}`, `/1/cards/${cardId}`],
    body: changes,
    result: { kind: 'card', card: { ...card, ...changes } },
  },
  {
    operation: { kind: 'card.delete', cardId },
    responses: [card, null],
    methods: ['GET', 'DELETE'],
    paths: [`/1/cards/${cardId}`, `/1/cards/${cardId}`],
    result: { kind: 'deleted', cardId },
  },
];
const credentials = [
  { kind: 'oauth2', accessToken: token },
  { kind: 'token', apiKey, token },
];

test('JSON escaped credential echoes are rejected after decoding', async () => {
  const encoded = JSON.stringify({ ...card, desc: token }).replace(
    token,
    [...token].map(value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  );
  const client = createTrelloClient({
    boardId,
    credential: credentials[0],
    authorize: async () => true,
    fetcher: async () => new Response(encoded),
  });
  await assert.rejects(client.execute({ kind: 'card.read', cardId }), { code: 'invalid-response' });
});

test('OAuth bearer credentials reject quote and backslash before dispatch', () => {
  for (const accessToken of ['invalid"token', 'invalid\\token']) {
    assert.throws(
      () => createTrelloClient({ boardId, credential: { kind: 'oauth2', accessToken }, authorize: async () => true }),
      { code: 'configuration' },
    );
  }
});

async function fixture(t, responses = []) {
  const requests = [];
  const dispatches = [];
  const pending = [...responses];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    if (pending.length === 0) {
      res.writeHead(500).end('Unexpected fixture request');
      return;
    }
    const response = pending.shift();
    if (typeof response === 'function') {
      response(req, res);
      return;
    }
    if (response === null) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const fetcher = (value, init) => {
    const url = new URL(value);
    assert.ok(['https://api.trello.com', 'https://api.atlassian.com'].includes(url.origin));
    assert.equal(init.redirect, 'error');
    assert.equal(url.href.includes(token), false);
    assert.equal(url.href.includes(apiKey), false);
    dispatches.push({ url: url.href, method: init.method });
    return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, init);
  };
  return {
    requests,
    dispatches,
    trello: (overrides = {}) =>
      createTrelloClient({
        boardId,
        credential: credentials[0],
        authorize: async () => true,
        fetcher,
        timeoutMs: 1000,
        ...overrides,
      }),
    confluence: (overrides = {}) =>
      createConfluenceTrashClient({
        cloudId,
        spaceId,
        accessToken: token,
        authorize: async () => true,
        fetcher,
        timeoutMs: 1000,
        ...overrides,
      }),
  };
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, `atlassian-provider-${code}`);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(token), false);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(apiKey), false);
    return true;
  });
}

for (const credential of credentials) {
  for (const entry of operations) {
    test(`${entry.operation.kind} returns its result with ${credential.kind} authorization`, async t => {
      const f = await fixture(t, entry.responses);
      const approved = [];
      const client = f.trello({
        credential,
        authorize: async operation => {
          approved.push(operation);
          return true;
        },
      });
      const result = await client.execute(structuredClone(entry.operation));
      assert.deepEqual(result, entry.result);
      assert.equal(JSON.stringify(result).includes(token), false);
      assert.deepEqual(approved, [entry.operation, entry.operation]);
      assert.equal(approved[0], approved[1]);
      assert.equal(Object.isFrozen(approved[0]), true);
      if (entry.operation.kind === 'card.update') assert.equal(Object.isFrozen(approved[0].changes), true);
      assert.deepEqual(
        f.requests.map(r => r.method),
        entry.methods,
      );
      assert.deepEqual(
        f.requests.map(r => new URL(r.url, 'http://fixture').pathname),
        entry.paths,
      );
      for (const request of f.requests) {
        assert.equal(
          request.headers.authorization,
          credential.kind === 'oauth2'
            ? `Bearer ${token}`
            : `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"`,
        );
        assert.equal(request.headers.accept, 'application/json');
      }
      if (entry.body) assert.deepEqual(f.requests.at(-1).body, entry.body);
      if (entry.operation.kind === 'card.search') {
        assert.deepEqual(Object.fromEntries(new URL(f.dispatches[0].url).searchParams), {
          query: 'release',
          idBoards: boardId,
          modelTypes: 'cards',
          card_fields: 'id,idBoard,idList,name,desc,closed,url,due,dueComplete',
          cards_limit: '50',
          cards_page: '2',
          partial: 'false',
        });
      }
    });
  }
}

test('Confluence trashes only the approved current page in the bound cloud and space', async t => {
  const f = await fixture(t, [page, null]);
  const approved = [];
  const client = f.confluence({
    authorize: async action => {
      approved.push(action);
      return true;
    },
  });
  assert.deepEqual(await client.trash(pageId), { kind: 'trashed', pageId });
  const action = { kind: 'page.trash', pageId, spaceId, cloudId };
  assert.deepEqual(approved, [action, action]);
  assert.equal(approved[0], approved[1]);
  assert.equal(Object.isFrozen(approved[0]), true);
  assert.deepEqual(
    f.dispatches,
    ['GET', 'DELETE'].map(method => ({
      method,
      url: `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages/${pageId}`,
    })),
  );
  assert.deepEqual(
    f.requests.map(r => [r.headers.authorization, r.body]),
    [
      [`Bearer ${token}`, undefined],
      [`Bearer ${token}`, undefined],
    ],
  );
});

test('normalized defaults and trimmed input are exactly what approval receives and the provider executes', async t => {
  const f = await fixture(t, [{ cards: [] }, { id: listId, idBoard: boardId }, card]);
  const approved = [];
  const client = f.trello({
    authorize: async operation => {
      approved.push(operation);
      return true;
    },
  });
  assert.deepEqual(await client.execute({ kind: 'card.search', query: '  release  ' }), {
    kind: 'cards',
    cards: [],
    page: 0,
    mayHaveMore: false,
  });
  assert.deepEqual(await client.execute({ kind: 'card.create', listId, name: '  Prepare release  ' }), {
    kind: 'card',
    card,
  });
  assert.deepEqual(approved, [
    { kind: 'card.search', query: 'release', page: 0 },
    { kind: 'card.search', query: 'release', page: 0 },
    { kind: 'card.create', listId, name: 'Prepare release', desc: '' },
    { kind: 'card.create', listId, name: 'Prepare release', desc: '' },
  ]);
  assert.deepEqual(f.requests.at(-1).body, { idList: listId, name: 'Prepare release', desc: '' });
});

test('caller mutation during approval cannot change the approved update', async t => {
  const f = await fixture(t, [card, { ...card, name: 'Approved' }]);
  const input = { kind: 'card.update', cardId, changes: { name: 'Approved' } };
  const client = f.trello({
    authorize: async operation => {
      input.cardId = foreignId;
      input.changes.name = 'Unapproved';
      assert.throws(() => {
        operation.cardId = foreignId;
      }, TypeError);
      assert.throws(() => {
        operation.changes.name = 'Unapproved';
      }, TypeError);
      return true;
    },
  });
  assert.deepEqual(await client.execute(input), { kind: 'card', card: { ...card, name: 'Approved' } });
  assert.deepEqual(f.requests.at(-1).body, { name: 'Approved' });
});

for (const entry of operations) {
  test(`${entry.operation.kind} denies absent or failed approval before dispatch`, async t => {
    const f = await fixture(t);
    for (const authorize of [
      async () => false,
      async () => undefined,
      async () => 'true',
      async () => {
        throw new Error(token);
      },
    ]) {
      await rejects(f.trello({ authorize }).execute(entry.operation), 'denied');
    }
    assert.deepEqual(f.dispatches, []);
  });

  test(`${entry.operation.kind} rechecks approval after the scope read`, async t => {
    const f = await fixture(t, [entry.responses[0]]);
    let approvals = 0;
    const client = f.trello({ authorize: async () => ++approvals === 1 });
    await rejects(client.execute(entry.operation), 'denied');
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET'],
    );
    assert.equal(approvals, 2);
  });
}

test('Confluence denies failed approval before reads and revoked approval before deletion', async t => {
  const f = await fixture(t, [page]);
  for (const authorize of [
    async () => false,
    async () => undefined,
    async () => {
      throw new Error(token);
    },
  ]) {
    await rejects(f.confluence({ authorize }).trash(pageId), 'denied');
  }
  assert.deepEqual(f.dispatches, []);
  let approvals = 0;
  await rejects(f.confluence({ authorize: async () => ++approvals === 1 }).trash(pageId), 'denied');
  assert.deepEqual(
    f.requests.map(r => r.method),
    ['GET'],
  );
  assert.equal(approvals, 2);
});

for (const entry of operations) {
  test(`${entry.operation.kind} denies a foreign board before returning data or writing`, async t => {
    const foreign = { ...card, idBoard: foreignId };
    const response =
      entry.operation.kind === 'card.search'
        ? { cards: [card, foreign] }
        : entry.operation.kind === 'card.create'
          ? { id: listId, idBoard: foreignId }
          : foreign;
    const f = await fixture(t, [response]);
    await rejects(f.trello().execute(entry.operation), 'denied');
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET'],
    );
  });
}

test('a substituted list or card is denied even on the bound board', async t => {
  for (const entry of operations.filter(entry => entry.operation.kind !== 'card.search')) {
    const response =
      entry.operation.kind === 'card.create' ? { id: foreignId, idBoard: boardId } : { ...card, id: foreignId };
    const f = await fixture(t, [response]);
    await rejects(f.trello().execute(entry.operation), 'denied');
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET'],
    );
  }
});

test('Confluence denies foreign spaces, substituted pages, and non-current pages before deletion', async t => {
  for (const response of [
    { ...page, spaceId: '99' },
    { ...page, id: '99' },
    { ...page, status: 'trashed' },
    { ...page, status: 'draft' },
  ]) {
    const f = await fixture(t, [response]);
    await rejects(f.confluence().trash(pageId), 'denied');
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET'],
    );
  }
});

test('search exposes bounded pagination and strips unknown provider fields', async t => {
  const f = await fixture(t, [
    { cards: Array.from({ length: 50 }, () => ({ ...card, extra: 'unused' })), extra: 'unused' },
    { cards: [] },
  ]);
  const client = f.trello();
  const result = await client.execute({ kind: 'card.search', query: 'release' });
  assert.deepEqual(result, {
    kind: 'cards',
    cards: Array.from({ length: 50 }, () => card),
    page: 0,
    mayHaveMore: true,
  });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(await client.execute({ kind: 'card.search', query: 'release', page: 1 }), {
    kind: 'cards',
    cards: [],
    page: 1,
    mayHaveMore: false,
  });
});

test('unsupported Trello inputs fail before approval or provider dispatch', async t => {
  const f = await fixture(t);
  let approvals = 0;
  const client = f.trello({
    authorize: async () => {
      approvals++;
      return true;
    },
  });
  for (const input of [
    null,
    {},
    { kind: 'board.delete', boardId },
    { kind: 'card.read', cardId: '../other' },
    { kind: 'card.read', cardId, boardId: foreignId },
    { kind: 'card.search', query: '' },
    { kind: 'card.search', query: 'x', page: -1 },
    { kind: 'card.search', query: 'x', page: 101 },
    { kind: 'card.search', query: 'x', page: 0.5 },
    { kind: 'card.search', query: 'x'.repeat(513) },
    { kind: 'card.create', listId, name: ' ' },
    { kind: 'card.create', listId, name: 'x', idBoard: foreignId },
    { kind: 'card.update', cardId, changes: {} },
    { kind: 'card.update', cardId, changes: { idList: foreignId } },
    { kind: 'card.update', cardId, changes: { due: 'tomorrow' } },
    { kind: 'card.delete', cardId, permanent: true },
  ])
    await rejects(client.execute(input), 'invalid-arguments');
  assert.equal(approvals, 0);
  assert.deepEqual(f.dispatches, []);
});

test('unsupported Confluence page identifiers fail before approval or dispatch', async t => {
  const f = await fixture(t);
  let approvals = 0;
  const client = f.confluence({
    authorize: async () => {
      approvals++;
      return true;
    },
  });
  for (const input of ['', '0', '-1', '01', '../42', '42?purge=true', '1'.repeat(32), null, undefined]) {
    await rejects(client.trash(input), 'invalid-arguments');
  }
  assert.equal(approvals, 0);
  assert.deepEqual(f.dispatches, []);
});

test('Confluence rejects non-string page identifiers rather than coercing them into provider paths', async t => {
  const f = await fixture(t, [page]);
  let approvals = 0;
  const client = f.confluence({
    authorize: async () => {
      approvals++;
      return true;
    },
  });
  await rejects(client.trash(42), 'invalid-arguments');
  assert.equal(approvals, 0);
  assert.deepEqual(f.dispatches, []);
});

for (const credential of credentials) {
  test(`provider-reflected ${credential.kind} credentials do not escape through allowed card fields`, async t => {
    const f = await fixture(t, [{ ...card, desc: `Provider diagnostic ${token}` }]);
    const client = f.trello({ credential });
    const outcome = await client.execute({ kind: 'card.read', cardId }).then(
      result => ({ kind: 'result', result }),
      error => ({ kind: 'error', error }),
    );
    if (outcome.kind === 'result') {
      assert.equal(outcome.result.kind, 'card');
      assert.equal(JSON.stringify(outcome.result).includes(token), false);
    } else {
      assert.equal(outcome.error.code, 'invalid-response');
      assert.equal(`${outcome.error.stack}${JSON.stringify(outcome.error)}`.includes(token), false);
    }
  });
}

test('missing credentials, approval callback, and invalid configuration never dispatch', async t => {
  const f = await fixture(t);
  for (const overrides of [
    { credential: undefined },
    { credential: { kind: 'oauth2', accessToken: '' } },
    { credential: { kind: 'oauth2', accessToken: 'bad\r\nheader' } },
    { credential: { kind: 'token', apiKey, token: '' } },
    { credential: { kind: 'token', apiKey: 'bad', token } },
    { boardId: '../board' },
    { authorize: undefined },
    { timeoutMs: 0 },
    { timeoutMs: 60001 },
  ])
    assert.throws(() => f.trello(overrides), { code: 'configuration' });
  for (const overrides of [
    { accessToken: '' },
    { accessToken: undefined },
    { accessToken: 'bad\nheader' },
    { authorize: undefined },
    { cloudId: 'bad' },
    { spaceId: '0' },
    { timeoutMs: 0 },
  ]) {
    assert.throws(() => f.confluence(overrides), { code: 'configuration' });
  }
  assert.deepEqual(f.dispatches, []);
});

for (const [status, code] of [
  [401, 'auth-rejected'],
  [403, 'auth-rejected'],
  [429, 'rate-limited'],
  [500, 'unavailable'],
]) {
  test(`read HTTP ${status} is sanitized and never retried`, async t => {
    for (const service of ['trello', 'confluence']) {
      const f = await fixture(t, [(_req, res) => res.writeHead(status).end(token)]);
      const client = f[service]();
      await rejects(service === 'trello' ? client.execute({ kind: 'card.read', cardId }) : client.trash(pageId), code);
      assert.equal(f.dispatches.length, 1);
    }
  });
}

test('read timeouts abort local fetch and do not retry', async t => {
  for (const service of ['trello', 'confluence']) {
    const f = await fixture(t, [() => undefined]);
    const client = f[service]({ timeoutMs: 30 });
    await rejects(
      service === 'trello' ? client.execute({ kind: 'card.read', cardId }) : client.trash(pageId),
      'unavailable',
    );
    assert.equal(f.dispatches.length, 1);
  }
});

test('malformed and oversized read bodies fail safely and leave the session usable', async t => {
  for (const response of [
    (_req, res) => res.writeHead(200).end(`invalid-json-${token}`),
    (_req, res) => res.writeHead(200).end('x'.repeat(1048577)),
    { ...card, url: 'https://evil.invalid/card' },
    { ...card, id: 'not-a-card-id' },
  ]) {
    const f = await fixture(t, [response, card]);
    const client = f.trello();
    await rejects(client.execute({ kind: 'card.read', cardId }), 'invalid-response');
    assert.equal(f.dispatches.length, 1);
    assert.deepEqual(await client.execute({ kind: 'card.read', cardId }), { kind: 'card', card });
  }
  const f = await fixture(t, [{ cards: Array.from({ length: 51 }, () => card) }]);
  await rejects(f.trello().execute({ kind: 'card.search', query: 'release' }), 'invalid-response');
});

test('Confluence rejects malformed and oversized page reads without fencing the session', async t => {
  for (const response of [
    (_req, res) => res.writeHead(200).end(`invalid-json-${token}`),
    (_req, res) => res.writeHead(200).end('x'.repeat(1048577)),
    { id: pageId, spaceId },
  ]) {
    const f = await fixture(t, [response, page, null]);
    const client = f.confluence();
    await rejects(client.trash(pageId), 'invalid-response');
    assert.equal(f.dispatches.length, 1);
    assert.deepEqual(await client.trash(pageId), { kind: 'trashed', pageId });
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET', 'GET', 'DELETE'],
    );
  }
});

for (const entry of operations.filter(entry =>
  ['card.create', 'card.update', 'card.delete'].includes(entry.operation.kind),
)) {
  test(`${entry.operation.kind} fences its session after uncertain writes and never retries`, async t => {
    for (const response of [
      (_req, res) => res.writeHead(503).end(token),
      (_req, res) => res.writeHead(200).end('x'.repeat(1048577)),
      (_req, res) => res.destroy(new Error(token)),
    ]) {
      const f = await fixture(t, [entry.responses[0], response]);
      const client = f.trello();
      await rejects(client.execute(entry.operation), 'outcome-unknown');
      await rejects(client.execute({ kind: 'card.read', cardId }), 'blocked');
      await rejects(client.execute(entry.operation), 'blocked');
      assert.deepEqual(
        f.requests.map(r => r.method),
        entry.methods,
      );
      assert.equal(f.dispatches.length, 2);
    }
  });
}

for (const kind of ['card.create', 'card.update']) {
  test(`${kind} fences its session on malformed or substituted write output`, async t => {
    const entry = operations.find(entry => entry.operation.kind === kind);
    for (const response of [
      (_req, res) => res.writeHead(200).end(`invalid-json-${token}`),
      { unexpected: token },
      { ...card, idBoard: foreignId },
      ...(kind === 'card.update' ? [{ ...card, id: foreignId }] : []),
    ]) {
      const f = await fixture(t, [entry.responses[0], response]);
      const client = f.trello();
      await rejects(client.execute(entry.operation), 'outcome-unknown');
      await rejects(client.execute({ kind: 'card.read', cardId }), 'blocked');
      assert.deepEqual(
        f.requests.map(r => r.method),
        entry.methods,
      );
    }
  });
}

test('Confluence fences its session after uncertain deletion and never retries', async t => {
  for (const response of [
    (_req, res) => res.writeHead(429).end(token),
    (_req, res) => res.writeHead(200).end('x'.repeat(1048577)),
    (_req, res) => res.destroy(new Error(token)),
  ]) {
    const f = await fixture(t, [page, response]);
    const client = f.confluence();
    await rejects(client.trash(pageId), 'outcome-unknown');
    await rejects(client.trash(pageId), 'blocked');
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET', 'DELETE'],
    );
    assert.equal(f.dispatches.length, 2);
  }
});

test('timed-out writes fence Trello and Confluence sessions', async t => {
  for (const service of ['trello', 'confluence']) {
    const f = await fixture(t, [service === 'trello' ? card : page, () => undefined]);
    const client = f[service]({ timeoutMs: 100 });
    const execute = () =>
      service === 'trello' ? client.execute({ kind: 'card.delete', cardId }) : client.trash(pageId);
    await rejects(execute(), 'outcome-unknown');
    await rejects(execute(), 'blocked');
    assert.deepEqual(
      f.requests.map(r => r.method),
      ['GET', 'DELETE'],
    );
  }
});

test('concurrent calls are rejected while approval is pending and the session recovers', async t => {
  for (const service of ['trello', 'confluence']) {
    const f = await fixture(t, service === 'trello' ? [card] : [page, null]);
    const approval = Promise.withResolvers();
    const client = f[service]({ authorize: () => approval.promise });
    const execute = () => (service === 'trello' ? client.execute({ kind: 'card.read', cardId }) : client.trash(pageId));
    const first = execute();
    await rejects(execute(), 'busy');
    assert.deepEqual(f.dispatches, []);
    approval.resolve(true);
    assert.deepEqual(await first, service === 'trello' ? { kind: 'card', card } : { kind: 'trashed', pageId });
  }
});

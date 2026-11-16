import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { closeRequestHandle, mintRequestHandle, requestHandleKey } from '@tulipfarm/apps/store';
import { createAbuseLimiter } from '../src/abuse.ts';
import { registerAppData } from '../src/app-data.ts';
import { authConfig } from '../src/auth.ts';
import { registerSecurity } from '../src/security.ts';
import { appDataFixture } from './app-data-fixture.mjs';

test('an app server reaches an approved view only while a visitor request is open', { timeout: 60000 }, async t => {
  const {
    cleanup,
    pool,
    service,
    workspace,
    members: { admin, lead, editor },
    http,
    fields,
    definition,
    helloId,
    appId,
    live,
    publishApp,
  } = await appDataFixture(t);
  const handles = requestHandleKey({ WORKSPACE_RUNTIME_KEY_ID: 'app-data', WORKSPACE_RUNTIME_KEY: 'cd'.repeat(32) });
  let queries = 0;
  let limiterQueries = 0;
  const counted = { query: (...args) => (queries++, pool.query(...args)) };
  const limiterPool = { query: (...args) => (limiterQueries++, pool.query(...args)) };
  const serve = async (limits, platform = counted) => {
    const app = Fastify({ trustProxy: true });
    const perAddress = process.env.API_RATE_LIMIT_PER_MINUTE;
    process.env.API_RATE_LIMIT_PER_MINUTE = '5';
    try {
      registerSecurity(app, authConfig().webOrigin);
    } finally {
      if (perAddress === undefined) delete process.env.API_RATE_LIMIT_PER_MINUTE;
      else process.env.API_RATE_LIMIT_PER_MINUTE = perAddress;
    }
    app.get('/v1/ordinary', async () => ({}));
    app.register(
      async routes =>
        registerAppData(routes, {
          platform,
          handles,
          tables: service,
          limit: createAbuseLimiter(limiterPool, randomUUID()),
          limits,
        }),
      { prefix: '/v1' },
    );
    cleanup.push(() => app.close());
    return app.listen({ host: '127.0.0.1', port: 0 });
  };
  const address = await serve();

  const approvedView = async app => {
    const created = await http(lead, 'POST', `/${app}/data-views`, {
      requestId: randomUUID(),
      tableId: definition.id,
      fieldIds: [fields.title.id, fields.owner.id],
      predicate: { all: [{ fieldId: fields.owner.id, op: 'eq', operand: { kind: 'parameter', name: 'owner' } }] },
      actions: ['read', 'create', 'update'],
    });
    assert.equal(created.status, 201);
    const share = `/${app}/data-views/${created.body.id}/share`;
    const approve = async () => {
      assert.equal((await http(lead, 'PUT', share)).status, 200);
      assert.equal((await http(admin, 'PUT', `/${app}/data-views/${created.body.id}/approval`)).status, 200);
    };
    await approve();
    return { viewId: created.body.id, share, approve };
  };
  const { viewId, share, approve } = await approvedView(appId);

  const call = async (handle, operation, body, headers = {}, view = viewId, server = address) => {
    const response = await fetch(`${server}/v1/app-data/views/${view}/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(handle ? { 'tulipfarm-request': handle } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const open = async (releaseId = live, app = appId) =>
    (await mintRequestHandle(pool, handles, { workspaceId: workspace.id, appId: app, releaseId })).handle;
  const text = value => ({ kind: 'text', value });
  const ada = { parameters: { owner: 'ada' } };
  const list = { ...ada, query: { limit: 10 } };
  const denied = { status: 403, body: { error: 'denied' } };
  const closed = { status: 401, body: { error: 'request-closed' } };
  const tooMany = { status: 429, body: { error: 'rate-limit-exceeded' } };
  // Every app sandbox reaches the API from its stack's NAT address.
  const nat = { 'x-forwarded-for': '198.51.100.20' };
  const flagOff = async request => {
    process.env.FEATURE_FLAG_APP_HOSTING = 'false';
    try {
      return await request();
    } finally {
      process.env.FEATURE_FLAG_APP_HOSTING = 'true';
    }
  };
  const outcome = ({ status, body }) => ({ status, body });
  const rows = response => response.body.records.map(({ id, values }) => ({ id, values }));

  const handle = await open();

  await t.test('a live request lists, reads and writes the rows the view allows', async () => {
    const listed = await call(handle, 'list', list, { origin: authConfig().webOrigin });
    assert.equal(listed.status, 200);
    assert.deepEqual(rows(listed), [
      { id: helloId, values: { [fields.title.id]: text('Hello'), [fields.owner.id]: text('ada') } },
    ]);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.equal(listed.headers.get('access-control-allow-origin'), null);

    const read = await call(handle, 'read', { ...ada, recordId: helloId });
    assert.deepEqual(read.body.record.values, { [fields.title.id]: text('Hello'), [fields.owner.id]: text('ada') });

    const recordId = randomUUID();
    const written = await call(handle, 'mutate', {
      ...ada,
      kind: 'create',
      recordId,
      values: { [fields.title.id]: text('From the app'), [fields.owner.id]: text('ada') },
    });
    assert.equal(written.status, 200);
    assert.deepEqual(
      { id: written.body.record.id, values: written.body.record.values },
      { id: recordId, values: { [fields.title.id]: text('From the app'), [fields.owner.id]: text('ada') } },
    );
    assert.deepEqual(
      outcome(
        await call(handle, 'mutate', {
          ...ada,
          kind: 'create',
          recordId: randomUUID(),
          values: { [fields.title.id]: text('Elsewhere'), [fields.owner.id]: text('bob') },
        }),
      ),
      denied,
      'a row outside the predicate is refused',
    );
    assert.deepEqual(
      rows(await call(handle, 'list', list))
        .map(row => row.values[fields.title.id].value)
        .sort(),
      ['From the app', 'Hello'],
    );
  });

  await t.test('browsers get no CORS grant', async () => {
    const response = await fetch(`${address}/v1/app-data/views/${viewId}/list`, {
      method: 'OPTIONS',
      headers: { origin: authConfig().webOrigin, 'access-control-request-method': 'POST' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  await t.test('authority comes only from the request header', async () => {
    assert.deepEqual(outcome(await call(null, 'list', list)), closed);
    assert.deepEqual(outcome(await call(`tfr_${'A'.repeat(43)}`, 'list', list)), closed);
    for (const extra of [{ appId }, { workspaceId: workspace.id }, { releaseId: live }, { viewId }, { viewer: {} }])
      assert.deepEqual(
        outcome(await call(handle, 'list', { ...list, ...extra })),
        { status: 400, body: { error: 'invalid-request' } },
        Object.keys(extra)[0],
      );
  });

  await t.test('a forged handle is refused before any database work', async () => {
    const server = await serve();
    const naming = app => Buffer.from(app.replaceAll('-', ''), 'hex');
    const forged = [
      `tfr_${randomBytes(32).toString('base64url')}`,
      `tfr_${Buffer.concat([naming(appId), randomBytes(32)]).toString('base64url')}`,
    ];
    const before = queries;
    for (let index = 0; index < 1000; index++)
      assert.deepEqual(
        outcome(await call(forged[index % 2], 'list', list, {}, viewId, server)),
        closed,
        `call ${index}`,
      );
    assert.equal(queries - before, 0, 'forged handles cost no database work');
    assert.equal((await call(handle, 'list', list, {}, viewId, server)).status, 200, 'the live request still works');
  });

  await t.test('a view the app has no approval for is denied without saying why', async () => {
    assert.deepEqual(outcome(await call(handle, 'list', list, {}, randomUUID())), denied);
    assert.deepEqual(
      outcome(await call(handle, 'list', { parameters: { owner: 'ada', team: 'x' }, query: { limit: 10 } })),
      denied,
    );
  });

  await t.test('a request served by a release that is not live is denied', async () => {
    assert.deepEqual(outcome(await call(await open(randomUUID()), 'list', list)), denied);
  });

  await t.test('an editor pause denies the app until it resumes', async () => {
    assert.equal((await http(editor, 'POST', `/${appId}/pause`, { requestId: randomUUID() })).status, 200);
    assert.deepEqual(outcome(await call(handle, 'list', list)), denied);
    assert.equal((await http(editor, 'POST', `/${appId}/resume`, { requestId: randomUUID() })).status, 200);
    assert.equal((await call(handle, 'list', list)).status, 200);
  });

  await t.test('the app-hosting flag gates the routes', async () => {
    process.env.FEATURE_FLAG_APP_HOSTING = 'false';
    try {
      assert.deepEqual(outcome(await call(handle, 'list', list)), denied);
    } finally {
      process.env.FEATURE_FLAG_APP_HOSTING = 'true';
    }
  });

  await t.test('one request may make 200 calls a minute', async () => {
    const busy = await open();
    const read = () => call(busy, 'read', { ...ada, recordId: helloId });
    for (let index = 0; index < 200; index++) assert.equal((await read()).status, 200, `call ${index + 1}`);
    const refused = await read();
    assert.deepEqual(outcome(refused), tooMany);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    const before = queries;
    for (let index = 0; index < 20; index++) assert.deepEqual(outcome(await read()), tooMany);
    assert.equal(queries - before, 0, 'a refused request is answered from memory');
    assert.equal((await call(handle, 'list', list)).status, 200, 'other requests keep their own budget');
    const ordinary = [];
    for (let index = 0; index < 6; index++) ordinary.push((await fetch(`${address}/v1/ordinary`)).status);
    assert.deepEqual([ordinary[0], ordinary[5]], [200, 429], 'the per-address budget still covers other routes');
  });

  await t.test('a replayed closed request costs one lookup and leaves its app served', async () => {
    const server = await serve({ app: 5, refusals: 5 });
    const ended = await open();
    await closeRequestHandle(pool, ended);
    const before = queries;
    for (let index = 0; index < 50; index++)
      assert.deepEqual(outcome(await call(ended, 'list', list, nat, viewId, server)), closed, `replay ${index + 1}`);
    assert.equal(queries - before, 1, 'one lookup for the whole window');
    assert.equal((await call(handle, 'list', list, nat, viewId, server)).status, 200, 'a live request of the same app');
  });

  await t.test("a request spends its own call limit before its app's", async () => {
    const server = await serve({ request: 3, app: 5 });
    const first = await open();
    const statuses = [];
    for (let index = 0; index < 6; index++)
      statuses.push((await call(first, 'list', list, nat, viewId, server)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429], 'the request stops at its own limit');
    const second = await open();
    statuses.length = 0;
    for (let index = 0; index < 2; index++)
      statuses.push((await call(second, 'list', list, nat, viewId, server)).status);
    assert.deepEqual(statuses, [200, 200], 'the app has spent only the calls it was served');
    const before = queries;
    const refused = await call(second, 'list', list, nat, viewId, server);
    assert.deepEqual(outcome(refused), tooMany, 'the app is over its limit');
    assert.ok(Number(refused.headers.get('retry-after')) > 0 && Number(refused.headers.get('retry-after')) <= 60);
    assert.equal((await call(await open(), 'list', list, nat, viewId, server)).status, 429, 'a fresh request too');
    assert.equal(queries - before, 0, 'an app at its limit is refused from memory');
  });

  await t.test('app data calls never touch the abuse limiter', async () => {
    const server = await serve({ request: 1 });
    const ended = await open();
    await closeRequestHandle(pool, ended);
    const busy = await open();
    const before = limiterQueries;
    const statuses = [];
    for (const attempt of [
      () => call(busy, 'list', list, nat, viewId, server),
      () => call(busy, 'list', list, nat, viewId, server),
      () => call(ended, 'list', list, nat, viewId, server),
      () => call(handle, 'list', list, nat, randomUUID(), server),
    ])
      statuses.push((await attempt()).status);
    assert.deepEqual(statuses, [200, 429, 401, 403]);
    assert.equal(limiterQueries - before, 0);
  });

  await t.test('a flood of valid calls holds at most four platform connections', async () => {
    let waiting = 0;
    let most = 0;
    let release;
    const gate = new Promise(resolve => (release = resolve));
    const gated = {
      query: async (...args) => {
        most = Math.max(most, ++waiting);
        await gate;
        waiting--;
        return pool.query(...args);
      },
    };
    const server = await serve(undefined, gated);
    let answered = 0;
    const calls = Array.from({ length: 10 }, () =>
      call(handle, 'list', list, nat, viewId, server).finally(() => answered++),
    );
    while (waiting + answered < 10) await new Promise(resolve => setTimeout(resolve, 5));
    release();
    const responses = await Promise.all(calls);
    assert.equal(most, 4);
    assert.deepEqual(
      responses.map(response => response.status).sort(),
      [200, 200, 200, 200, 503, 503, 503, 503, 503, 503],
    );
    for (const refused of responses.filter(response => response.status === 503)) {
      assert.deepEqual(refused.body, { error: 'temporarily-unavailable' });
      assert.equal(refused.headers.get('retry-after'), '1');
    }
  });

  await t.test("an app's refused calls spend only that app's budget", async () => {
    const server = await serve({ refusals: 5 });
    const other = await publishApp('Shop');
    const otherView = (await approvedView(other.appId)).viewId;
    const otherHandle = await open(other.live, other.appId);
    const ended = await open();
    await closeRequestHandle(pool, ended);
    const statuses = [];
    for (const attempt of [
      () => call(ended, 'list', list, nat, viewId, server),
      () => call(ended, 'list', list, nat, viewId, server),
      () => call(handle, 'list', list, nat, randomUUID(), server),
      () => flagOff(() => call(handle, 'list', list, nat, viewId, server)),
      () => call(handle, 'list', list, nat, randomUUID(), server),
      () => call(handle, 'list', list, nat, randomUUID(), server),
      () => call(handle, 'list', list, nat, randomUUID(), server),
      () => call(handle, 'list', list, nat, viewId, server),
    ])
      statuses.push((await attempt()).status);
    assert.deepEqual(statuses, [401, 401, 403, 403, 403, 403, 403, 429], 'closed requests are not charged');

    const before = queries;
    for (let index = 0; index < 30; index++)
      for (const [label, attempt, expected] of [
        ['closed', () => call(ended, 'list', list, nat, viewId, server), closed],
        ['denied', () => call(handle, 'list', list, nat, randomUUID(), server), tooMany],
        ['valid', () => call(handle, 'list', list, nat, viewId, server), tooMany],
      ]) {
        const refused = await attempt();
        assert.deepEqual(outcome(refused), expected, label);
        if (expected === tooMany) assert.ok(Number(refused.headers.get('retry-after')) > 0, label);
      }
    assert.equal(queries - before, 0, 'a spent app costs no database work');

    assert.equal(
      (await call(otherHandle, 'list', list, nat, otherView, server)).status,
      200,
      'another app behind the same address',
    );
  });

  await t.test('valid calls spend no refusal budget', async () => {
    const server = await serve({ refusals: 2 });
    for (let index = 0; index < 20; index++)
      assert.equal((await call(handle, 'list', list, nat, viewId, server)).status, 200, `valid call ${index + 1}`);
    assert.deepEqual(outcome(await call(handle, 'list', list, nat, randomUUID(), server)), denied);
    assert.equal((await call(handle, 'list', list, nat, viewId, server)).status, 200);
  });

  await t.test('revoking the view denies the next call of an open request', async () => {
    assert.equal((await http(editor, 'DELETE', share)).status, 204);
    assert.deepEqual(outcome(await call(handle, 'list', list)), denied);
    await approve();
    assert.equal((await call(handle, 'list', list)).status, 200);
  });

  await t.test('a closed request has no authority', async () => {
    await closeRequestHandle(pool, handle);
    assert.deepEqual(outcome(await call(handle, 'list', list)), closed);
    assert.deepEqual(outcome(await call(handle, 'read', { ...ada, recordId: helloId })), closed);
  });
});

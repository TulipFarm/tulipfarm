import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import {
  closeRequestHandle,
  mintRequestHandle,
  renewRequestHandle,
  requestHandleKey,
  signRequestHandle,
} from '@tulipfarm/apps/store';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { createAbuseLimiter } from '../src/abuse.ts';
import { registerAppData } from '../src/app-data.ts';
import { authConfig } from '../src/auth.ts';
import { registerSecurity } from '../src/security.ts';
import { appDataFixture } from './app-data-fixture.mjs';

test('an app server reaches an approved view only while a visitor request is open', { timeout: 180000 }, async t => {
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
  const build = async (limits, platform = counted) => {
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
    await app.ready();
    return app;
  };
  const serve = async (limits, platform) => (await build(limits, platform)).listen({ host: '127.0.0.1', port: 0 });
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

  const until = async ready => {
    while (!ready()) await new Promise(resolve => setTimeout(resolve, 5));
  };
  const otherApp = async name => {
    const other = await publishApp(name);
    const view = (await approvedView(other.appId)).viewId;
    return { view, open: () => open(other.live, other.appId) };
  };
  const inject = async (server, handle, view = viewId) => {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/app-data/views/${view}/list`,
      headers: { 'content-type': 'application/json', 'tulipfarm-request': handle },
      payload: list,
    });
    return { status: response.statusCode, body: response.json(), headers: response.headers };
  };
  const lookupsByApp = () => {
    const looked = new Map();
    const platform = {
      query: (sql, values) => {
        if (/FROM app\.app_live_requests/.test(sql)) looked.set(values[1], (looked.get(values[1]) ?? 0) + 1);
        return pool.query(sql, values);
      },
    };
    return { platform, of: app => looked.get(app) ?? 0 };
  };

  await t.test('one app holds at most two of the four lookup slots, so another app still gets one', async () => {
    const other = await otherApp('Counter');
    const otherHandle = await other.open();
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
    const flood = await Promise.all(Array.from({ length: 10 }, () => open()));
    let answered = 0;
    const calls = flood.map(request => call(request, 'list', list, nat, viewId, server).finally(() => answered++));
    await until(() => waiting + answered === 10);
    let settled = false;
    const theirs = call(otherHandle, 'list', list, nat, other.view, server).finally(() => (settled = true));
    await until(() => waiting === 3 || settled);
    release();
    const responses = await Promise.all(calls);
    assert.equal(most, 3, 'two lookups for the flooding app and one for the other');
    assert.deepEqual(
      responses.map(response => response.status).sort(),
      [200, 200, 503, 503, 503, 503, 503, 503, 503, 503],
    );
    for (const refused of responses.filter(response => response.status === 503)) {
      assert.deepEqual(refused.body, { error: 'temporarily-unavailable' });
      assert.equal(refused.headers.get('retry-after'), '1');
    }
    assert.equal((await theirs).status, 200, 'the other app is served');
  });

  await t.test("one request's parallel calls share one lookup", async () => {
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
    const server = await build(undefined, gated);
    const parallel = await open();
    let answered = 0;
    const calls = Array.from({ length: 5 }, () => inject(server, parallel).finally(() => answered++));
    await until(() => waiting + answered >= 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    assert.deepEqual(
      (await Promise.all(calls)).map(response => response.status),
      [200, 200, 200, 200, 200],
    );
    assert.equal(most, 1);
  });

  await t.test('a stockpile of closed handles larger than the memo cannot exhaust lookups', async t => {
    const other = await otherApp('Ledger');
    const otherHandle = await other.open();
    const lookups = lookupsByApp();
    const server = await build(undefined, lookups.platform);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const stockpile = Array.from({ length: 10_001 }, () => signRequestHandle(handles, appId));
    const replay = async () => {
      const before = lookups.of(appId);
      const statuses = new Set();
      for (const replayed of stockpile) statuses.add((await inject(server, replayed)).status);
      return { lookups: lookups.of(appId) - before, statuses: [...statuses] };
    };
    assert.deepEqual(await replay(), { lookups: 10_001, statuses: [401] }, 'each new handle is looked up once');
    assert.deepEqual(await replay(), { lookups: 0, statuses: [401] }, 'and then refused from memory');

    t.mock.timers.tick(71_000);
    const before = lookups.of(appId);
    const theirs = new Set();
    const ours = [];
    for (let start = 0; start < stockpile.length; start += 100) {
      const batch = stockpile.slice(start, start + 100).map(stale => inject(server, stale));
      const mine = start % 1000 === 0 ? [inject(server, otherHandle, other.view)] : [];
      for (const response of await Promise.all(batch)) theirs.add(response.status);
      for (const response of await Promise.all(mine)) ours.push(response.status);
    }
    assert.ok(
      lookups.of(appId) - before <= 122,
      `${lookups.of(appId) - before} lookups once the handles are old: the budget and two in flight`,
    );
    assert.deepEqual([...theirs].sort(), [401, 429, 503]);
    assert.deepEqual(ours, Array(11).fill(200), 'the other app is never refused');
    const after = lookups.of(appId);
    assert.deepEqual(outcome(await inject(server, stockpile[0])), tooMany);
    assert.equal(lookups.of(appId), after, 'refused from memory');
  });

  await t.test('a long stream keeps its data access after its handle is older than a minute', async t => {
    const lookups = lookupsByApp();
    const server = await build({ oldLookups: 3 }, lookups.platform);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const stream = await open();
    const statuses = [];
    for (let step = 0; step < 30; step++) {
      t.mock.timers.tick(20_000);
      assert.equal(await renewRequestHandle(pool, stream), true);
      statuses.push((await inject(server, stream)).status);
    }
    assert.deepEqual(statuses, Array(30).fill(200), 'ten minutes of calls');
    assert.equal(lookups.of(appId), 30);
  });

  await t.test("a flood of old closed handles spends only its app's old lookup budget", async t => {
    const other = await otherApp('Board');
    const lookups = lookupsByApp();
    const server = await build({ oldLookups: 5 }, lookups.platform);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const stream = await open();
    const otherStream = await other.open();
    const stale = Array.from({ length: 20 }, () => signRequestHandle(handles, appId));
    t.mock.timers.tick(71_000);
    const statuses = [];
    for (const replayed of stale) {
      const refused = await inject(server, replayed);
      statuses.push(refused.status);
      if (refused.status === 429) assert.ok(Number(refused.headers['retry-after']) > 0);
    }
    assert.deepEqual(statuses, [...Array(5).fill(401), ...Array(15).fill(429)]);
    assert.equal(lookups.of(appId), 5, 'refused from memory once the budget is spent');
    assert.deepEqual(outcome(await inject(server, stream)), tooMany, "the app's own long streams wait");
    assert.equal((await inject(server, await open())).status, 200, 'its new requests are still served');
    assert.equal((await inject(server, otherStream, other.view)).status, 200, "another app's long stream is served");
  });

  const flagProvider = async (t, isEnabled) => {
    let evaluations = 0;
    t.after(resetExtensions);
    await registerExtension(
      {
        name: 'app-data-flags',
        register(slots) {
          slots.flagProvider({
            isEnabled: async (flag, subject) => {
              assert.deepEqual([flag, subject.distinctId], ['app-hosting', `workspace:${workspace.id}`]);
              evaluations++;
              return isEnabled();
            },
          });
        },
      },
      { app: 'api', env: {} },
    );
    return () => evaluations;
  };

  await t.test('a slow flag provider holds no platform lookup slot', async t => {
    const other = await publishApp('Kiosk');
    const otherView = (await approvedView(other.appId)).viewId;
    const otherHandle = await open(other.live, other.appId);
    const flood = await open();
    let release;
    const gate = new Promise(resolve => (release = resolve));
    const evaluations = await flagProvider(t, () => gate.then(() => true));
    let looked = 0;
    const counting = { query: (...args) => pool.query(...args).finally(() => looked++) };
    const server = await serve(undefined, counting);
    let answered = 0;
    const calls = [];
    const start = async request => {
      const before = looked + answered;
      calls.push(request().finally(() => answered++));
      await until(() => looked + answered > before);
    };
    for (let index = 0; index < 10; index++) await start(() => call(flood, 'list', list, nat, viewId, server));
    await start(() => call(otherHandle, 'list', list, nat, otherView, server));
    release();
    assert.deepEqual(
      (await Promise.all(calls)).map(response => response.status),
      [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
      'every call waits for the flag without holding a lookup slot',
    );
    assert.equal(evaluations(), 1, 'one evaluation for the workspace');
  });

  await t.test('the flag is evaluated once per workspace every 30 seconds', async t => {
    let enabled = false;
    const evaluations = await flagProvider(t, () => enabled);
    const server = await serve();
    const busy = await open();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const statuses = [];
    const three = async () => {
      for (let index = 0; index < 3; index++)
        statuses.push((await call(busy, 'list', list, nat, viewId, server)).status);
    };
    await three();
    enabled = true;
    await three();
    t.mock.timers.tick(30_000);
    await three();
    assert.deepEqual(statuses, [403, 403, 403, 403, 403, 403, 200, 200, 200], 'turning the flag on takes 30 s');
    assert.equal(evaluations(), 2);
  });

  await t.test('a failing flag provider denies the call and is asked again on the next', async t => {
    let failing = true;
    const evaluations = await flagProvider(t, () => {
      if (failing) throw new Error('flag provider unavailable');
      return true;
    });
    delete process.env.FEATURE_FLAG_APP_HOSTING;
    t.after(() => (process.env.FEATURE_FLAG_APP_HOSTING = 'true'));
    const server = await serve();
    const busy = await open();
    const statuses = [];
    for (let index = 0; index < 2; index++) statuses.push((await call(busy, 'list', list, nat, viewId, server)).status);
    failing = false;
    statuses.push((await call(busy, 'list', list, nat, viewId, server)).status);
    assert.deepEqual(statuses, [403, 403, 200]);
    assert.equal(evaluations(), 3, 'a failed evaluation is not remembered');
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

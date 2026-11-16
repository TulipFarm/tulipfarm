import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { connect, createServer } from 'node:net';
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
import { appDataLookupPool, registerAppData } from '../src/app-data.ts';
import { authConfig } from '../src/auth.ts';
import { createIdentityPool } from '../src/identity-pool.ts';
import { registerSecurity } from '../src/security.ts';
import { appDataFixture } from './app-data-fixture.mjs';

test('an app server reaches an approved view only while a visitor request is open', { timeout: 180000 }, async t => {
  const {
    cleanup,
    db,
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
  const counted = { query: (...args) => (queries++, pool.query(...args)) };
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
          lookups: platform,
          handles,
          tables: service,
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

  await t.test('each refusal names its reason', async () => {
    const server = await serve({ request: 1 });
    const ended = await open();
    await closeRequestHandle(pool, ended);
    const busy = await open();
    const statuses = [];
    for (const attempt of [
      () => call(busy, 'list', list, nat, viewId, server),
      () => call(busy, 'list', list, nat, viewId, server),
      () => call(ended, 'list', list, nat, viewId, server),
      () => call(handle, 'list', list, nat, randomUUID(), server),
    ])
      statuses.push((await attempt()).status);
    assert.deepEqual(statuses, [200, 429, 401, 403]);
  });

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async ready => {
    while (!ready()) await sleep(1);
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

  const gatedPool = () => {
    let release;
    const gate = new Promise(resolve => (release = resolve));
    const state = { waiting: 0, most: 0, release };
    state.platform = {
      query: async (...args) => {
        state.most = Math.max(state.most, ++state.waiting);
        await gate;
        state.waiting--;
        return pool.query(...args);
      },
    };
    return state;
  };

  await t.test('a lookup that waits longer than 100 ms is refused, and another app still gets a slot', async () => {
    const other = await otherApp('Counter');
    const otherHandle = await other.open();
    const gated = gatedPool();
    const server = await serve(undefined, gated.platform);
    const flood = await Promise.all(Array.from({ length: 10 }, () => open()));
    let answered = 0;
    const calls = flood.map(request => call(request, 'list', list, nat, viewId, server).finally(() => answered++));
    await until(() => gated.waiting === 2);
    const theirs = call(otherHandle, 'list', list, nat, other.view, server);
    await until(() => gated.waiting === 3);
    await until(() => answered === 8);
    gated.release();
    const responses = await Promise.all(calls);
    assert.equal(gated.most, 3, 'two lookups for the flooding app and one for the other');
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

  await t.test('a busy app whose lookups wait briefly on a slow pool gets no 503', async () => {
    const gated = gatedPool();
    const server = await build(undefined, gated.platform);
    const visitors = await Promise.all(Array.from({ length: 20 }, () => open()));
    const calls = visitors.map(visitor => inject(server, visitor));
    await until(() => gated.waiting === 2);
    await sleep(30);
    gated.release();
    assert.deepEqual(
      (await Promise.all(calls)).map(response => response.status),
      Array(20).fill(200),
    );
  });

  await t.test("a tenant flooding from many apps cannot fail another app's call", async () => {
    const other = await otherApp('Market');
    const otherHandle = await other.open();
    const slow = { query: async (...args) => (await sleep(3), pool.query(...args)) };
    const server = await build(undefined, slow);
    let flooding = true;
    const flooded = new Set();
    const flood = Array.from({ length: 20 }, () => randomUUID()).flatMap(app =>
      Array.from({ length: 10 }, async () => {
        while (flooding) {
          flooded.add((await inject(server, signRequestHandle(handles, app))).status);
          await sleep(1);
        }
      }),
    );
    await sleep(50);
    const theirs = [];
    for (let index = 0; index < 5; index++) {
      theirs.push((await inject(server, otherHandle, other.view)).status);
      await sleep(10);
    }
    flooding = false;
    await Promise.all(flood);
    assert.deepEqual([...flooded].sort(), [401, 503], 'the flood outran its lookups');
    assert.deepEqual(theirs, [200, 200, 200, 200, 200], 'the other app is served within the wait');
  });

  await t.test("one request's parallel calls share one lookup", async () => {
    const gated = gatedPool();
    const server = await build(undefined, gated.platform);
    const parallel = await open();
    const calls = Array.from({ length: 5 }, () => inject(server, parallel));
    await until(() => gated.waiting === 1);
    await sleep(50);
    gated.release();
    assert.deepEqual(
      (await Promise.all(calls)).map(response => response.status),
      [200, 200, 200, 200, 200],
    );
    assert.equal(gated.most, 1);
  });

  await t.test("a live request's calls share one lookup every five seconds", async t => {
    const lookups = lookupsByApp();
    const server = await build({ request: 1_000 }, lookups.platform);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const busy = await open();
    const statuses = new Set();
    for (let index = 0; index < 500; index++) {
      t.mock.timers.tick(10);
      statuses.add((await inject(server, busy)).status);
    }
    assert.deepEqual([...statuses], [200]);
    assert.ok(lookups.of(appId) <= 2, `${lookups.of(appId)} lookups for 500 calls in 5 s`);
  });

  await t.test(
    "a leaked old handle replayed 1000 times costs one lookup a window and leaves its app's long streams served",
    async t => {
      const lookups = lookupsByApp();
      const server = await build(undefined, lookups.platform);
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const streams = [await open(), await open()];
      for (const stream of streams) assert.equal((await inject(server, stream)).status, 200);
      const leaked = await open();
      await closeRequestHandle(pool, leaked);
      for (let window = 0; window < 2; window++) {
        t.mock.timers.tick(window === 0 ? 71_000 : 121_000);
        for (const stream of streams) assert.equal(await renewRequestHandle(pool, stream), true);
        const before = lookups.of(appId);
        const statuses = new Set();
        for (let index = 0; index < 1000; index++) statuses.add((await inject(server, leaked)).status);
        assert.deepEqual([...statuses], [401], `window ${window + 1}`);
        assert.ok(lookups.of(appId) - before <= 1, `${lookups.of(appId) - before} lookups in window ${window + 1}`);
        for (const stream of streams)
          assert.equal((await inject(server, stream)).status, 200, `a long stream in window ${window + 1}`);
      }
    },
  );

  await t.test("an app's cleanup calls after its visitors leave do not cut off its long streams", async t => {
    const server = await build();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const streams = [await open(), await open()];
    const visitors = await Promise.all(Array.from({ length: 300 }, () => open()));
    for (const request of [...streams, ...visitors]) assert.equal((await inject(server, request)).status, 200);
    t.mock.timers.tick(71_000);
    for (const stream of streams) assert.equal(await renewRequestHandle(pool, stream), true);
    for (const visitor of visitors) await closeRequestHandle(pool, visitor);
    const cleanup = new Set();
    for (const visitor of visitors) cleanup.add((await inject(server, visitor)).status);
    assert.deepEqual([...cleanup], [401], 'every cleanup call within one minute is refused as closed');
    for (const stream of streams) assert.equal((await inject(server, stream)).status, 200);
  });

  await t.test('a stockpile of closed handles larger than the memo cannot exhaust lookups', async t => {
    const other = await otherApp('Ledger');
    const otherHandle = await other.open();
    const lookups = lookupsByApp();
    const server = await build(undefined, lookups.platform);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const stockpile = Array.from({ length: 10_001 }, () => signRequestHandle(handles, appId));
    const replay = async (replayed = stockpile) => {
      const before = lookups.of(appId);
      const statuses = new Set();
      for (const handle of replayed) statuses.add((await inject(server, handle)).status);
      return { lookups: lookups.of(appId) - before, statuses: [...statuses] };
    };
    assert.deepEqual(await replay(), { lookups: 10_001, statuses: [401] }, 'each new handle is looked up once');
    assert.deepEqual(
      await replay(stockpile.slice(-500)),
      { lookups: 0, statuses: [401] },
      "and the app's newest 500 are then refused from memory",
    );

    t.mock.timers.tick(121_000);
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
    assert.ok(theirs.has(401) && theirs.has(429), [...theirs].join());
    assert.ok(
      [...theirs].every(status => [401, 429, 503].includes(status)),
      [...theirs].join(),
    );
    assert.deepEqual(ours, Array(11).fill(200), 'the other app is never refused');
    const after = lookups.of(appId);
    assert.deepEqual(outcome(await inject(server, stockpile[0])), closed, 'a handle found closed stays closed');
    assert.deepEqual(outcome(await inject(server, stockpile.at(-1))), tooMany, 'a handle not looked up waits');
    assert.equal(lookups.of(appId), after, 'both answered from memory');
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
    const unseen = await open();
    const otherStream = await other.open();
    assert.equal((await inject(server, stream)).status, 200);
    const stale = Array.from({ length: 20 }, () => signRequestHandle(handles, appId));
    t.mock.timers.tick(71_000);
    const before = lookups.of(appId);
    const statuses = [];
    for (const replayed of stale) {
      const refused = await inject(server, replayed);
      statuses.push(refused.status);
      if (refused.status === 429) assert.ok(Number(refused.headers['retry-after']) > 0);
    }
    assert.deepEqual(statuses, [...Array(5).fill(401), ...Array(15).fill(429)]);
    assert.equal(lookups.of(appId) - before, 5, 'refused from memory once the budget is spent');
    assert.equal((await inject(server, stream)).status, 200, 'a long stream this process has seen live is served');
    assert.deepEqual(outcome(await inject(server, unseen)), tooMany, 'a long stream it has not seen waits');
    assert.equal((await inject(server, await open())).status, 200, 'its new requests are still served');
    assert.equal((await inject(server, otherStream, other.view)).status, 200, "another app's long stream is served");
  });

  await t.test(
    "an app flooding distinct handles cannot cut off another app's long stream or cleanup calls",
    async t => {
      const flooder = randomUUID();
      const platform = { query: (sql, values) => (values[1] === flooder ? { rows: [] } : pool.query(sql, values)) };
      const server = await build(undefined, platform);
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const stream = await open();
      const visitors = await Promise.all(Array.from({ length: 300 }, () => open()));
      for (const request of [stream, ...visitors]) assert.equal((await inject(server, request)).status, 200);
      t.mock.timers.tick(71_000);
      assert.equal(await renewRequestHandle(pool, stream), true);
      for (const visitor of visitors) await closeRequestHandle(pool, visitor);
      const flooded = new Set();
      for (let start = 0; start < 100_001; start += 2) {
        const pair = [signRequestHandle(handles, flooder), signRequestHandle(handles, flooder)];
        for (const response of await Promise.all(pair.map(flood => inject(server, flood))))
          flooded.add(response.status);
      }
      assert.deepEqual([...flooded], [401], 'every flood call was looked up and found closed');
      const ended = new Set();
      for (const visitor of visitors) ended.add((await inject(server, visitor)).status);
      assert.deepEqual(
        { cleanup: [...ended], stream: (await inject(server, stream)).status },
        { cleanup: [401], stream: 200 },
      );
    },
  );

  const stallingProxy = async target => {
    const sockets = new Set();
    const server = createServer(client => {
      const upstream = connect(Number(target.port), target.hostname);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = new URL(target);
    url.hostname = '127.0.0.1';
    url.port = String(server.address().port);
    return {
      url: url.toString(),
      // The connections open now stop passing bytes but stay open, as half-dead connections do. New ones work.
      stall: () => {
        for (const socket of sockets) socket.unpipe().pause();
      },
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      },
    };
  };

  await t.test('a lookup stuck on a half-dead connection frees its slot after two seconds', async () => {
    const proxy = await stallingProxy(new URL(db.connectionString));
    const owner = Fastify();
    const url = process.env.DATABASE_URL;
    process.env.DATABASE_URL = proxy.url;
    let lookups;
    try {
      lookups = createIdentityPool(owner, appDataLookupPool);
    } finally {
      if (url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = url;
    }
    const server = await build(undefined, lookups);
    cleanup.push(() => owner.close(), proxy.close);
    const warm = await Promise.all([inject(server, await open()), inject(server, await open())]);
    assert.deepEqual(
      warm.map(response => response.status),
      [200, 200],
      'two connections through the proxy',
    );
    proxy.stall();
    const stuck = [inject(server, await open()), inject(server, await open())];
    await sleep(2_500);
    assert.equal((await inject(server, await open())).status, 200, 'a new lookup gets a freed slot');
    assert.deepEqual(
      (await Promise.all(stuck)).map(response => response.status),
      [503, 503],
    );
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
    const flood = await Promise.all(Array.from({ length: 10 }, () => open()));
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
    for (const visitor of flood) await start(() => call(visitor, 'list', list, nat, viewId, server));
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

  await t.test('a closed request loses its authority within five seconds', async t => {
    const server = await build();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.equal((await inject(server, handle)).status, 200);
    await closeRequestHandle(pool, handle);
    assert.equal((await inject(server, handle)).status, 200, 'the verdict is kept for five seconds');
    t.mock.timers.tick(5_000);
    assert.deepEqual(outcome(await inject(server, handle)), closed);
    assert.deepEqual(outcome(await call(handle, 'read', { ...ada, recordId: helloId })), closed);
  });
});

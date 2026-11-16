import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { closeRequestHandle, mintRequestHandle } from '@tulipfarm/apps/store';
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
  } = await appDataFixture(t);
  const app = Fastify();
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
      registerAppData(routes, { platform: pool, tables: service, limit: createAbuseLimiter(pool, 'test-secret') }),
    { prefix: '/v1' },
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());

  const created = await http(lead, 'POST', `/${appId}/data-views`, {
    requestId: randomUUID(),
    tableId: definition.id,
    fieldIds: [fields.title.id, fields.owner.id],
    predicate: { all: [{ fieldId: fields.owner.id, op: 'eq', operand: { kind: 'parameter', name: 'owner' } }] },
    actions: ['read', 'create', 'update'],
  });
  assert.equal(created.status, 201);
  const viewId = created.body.id;
  const share = `/${appId}/data-views/${viewId}/share`;
  const approve = async () => {
    assert.equal((await http(lead, 'PUT', share)).status, 200);
    assert.equal((await http(admin, 'PUT', `/${appId}/data-views/${viewId}/approval`)).status, 200);
  };
  await approve();

  const call = async (handle, operation, body, headers = {}, view = viewId) => {
    const response = await fetch(`${address}/v1/app-data/views/${view}/${operation}`, {
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
  const open = async (releaseId = live) =>
    (await mintRequestHandle(pool, { workspaceId: workspace.id, appId, releaseId })).handle;
  const text = value => ({ kind: 'text', value });
  const ada = { parameters: { owner: 'ada' } };
  const list = { ...ada, query: { limit: 10 } };
  const denied = { status: 403, body: { error: 'denied' } };
  const closed = { status: 401, body: { error: 'request-closed' } };
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
    for (let index = 0; index < 200; index++)
      assert.equal((await call(busy, 'read', { ...ada, recordId: helloId })).status, 200, `call ${index + 1}`);
    const refused = await call(busy, 'read', { ...ada, recordId: helloId });
    assert.deepEqual(outcome(refused), { status: 429, body: { error: 'rate-limit-exceeded' } });
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.equal((await call(handle, 'list', list)).status, 200, 'other requests keep their own budget');
    const ordinary = [];
    for (let index = 0; index < 6; index++) ordinary.push((await fetch(`${address}/v1/ordinary`)).status);
    assert.deepEqual([ordinary[0], ordinary[5]], [200, 429], 'the per-address budget still covers other routes');
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

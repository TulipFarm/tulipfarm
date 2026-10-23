import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildApp } from '../src/app.ts';
import { registerSecurity, securityServerOptions } from '../src/security.ts';
import { registerAbuseHooks } from '../src/abuse.ts';
import { registerAgents } from '../src/agents.ts';
import { registerIntegrations } from '../src/integrations.ts';
import { registerGovernance } from '../src/governance.ts';
import { registerModelCatalog } from '../src/model-catalog.ts';
import { registerConversations } from '../src/conversations.ts';
import { registerWorkspaceSettings } from '../src/workspace-settings.ts';
import { StorageUnavailableError, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

// The app serves the shipped model catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

test('disabled workspace errors are concealed across business routes without concealing transient failures', async t => {
  const id = '22222222-2222-4222-8222-222222222222';
  const auth = { api: { getSession: async () => ({ user: { id } }) } };
  let code = 'disabled';
  const unavailable = async () => {
    throw new StorageUnavailableError(code);
  };
  const runtime = { transaction: unavailable };
  const app = Fastify();
  t.after(() => app.close());
  registerGovernance(app, { auth, runtime, identity: {} });
  registerAgents(app, { auth, runtime, pool: {}, agentModel: null });
  registerModelCatalog(app, { auth, runtime, compatibility: commonCompatibility });
  registerConversations(app, { auth, service: { list: unavailable } });
  registerIntegrations(app, { auth, service: { list: unavailable } });
  registerWorkspaceSettings(app, { auth, runtime, pool: {} });
  for (const path of ['governance/me', 'agents', 'model-catalog', 'conversations', 'integrations', 'settings']) {
    const response = await app.inject(`/workspaces/${id}/${path}`);
    assert.equal(response.statusCode, 404, `${path}: ${response.body}`);
    assert.deepEqual(response.json(), { error: path === 'settings' ? 'workspace-settings-not-found' : 'not-found' });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  code = 'wait_timeout';
  for (const path of ['governance/me', 'agents', 'model-catalog', 'conversations', 'integrations', 'settings']) {
    const response = await app.inject(`/workspaces/${id}/${path}`);
    assert.equal(response.statusCode, 503, `${path}: ${response.body}`);
  }
});

function fixture() {
  const app = Fastify(securityServerOptions());
  registerSecurity(app, 'http://localhost:5173');
  app.register(async routes => {
    routes.get('/ok', request => ({ ip: request.ip, id: request.id }));
    routes.get('/failure', () => {
      throw new Error('postgresql://secret@internal/table');
    });
    routes.post('/body', request => request.body);
    routes.get('/live', { schema: { operationId: 'getLivenessV1' } }, () => ({ status: 'ok' }));
    routes.get('/diagnostics', { schema: { operationId: 'getHealthV1' } }, () => ({ status: 'ok' }));
  });
  return app;
}

test('security headers cover successes, errors, missing routes, and Swagger remains usable', async t => {
  const app = fixture();
  const real = buildApp({ agentModel: null });
  t.after(() => Promise.all([app.close(), real.close()]));
  for (const [url, status] of [
    ['/ok', 200],
    ['/failure', 500],
    ['/missing?token=secret', 404],
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, status);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-security-policy'], /default-src 'none'/);
    assert.ok(!response.body.includes('secret'));
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.equal(response.headers['strict-transport-security'], undefined);
  }
  const docs = await real.inject('/v1/docs/');
  assert.equal(docs.statusCode, 200);
  assert.match(docs.headers['content-security-policy'], /script-src 'self'/);
  assert.ok(!docs.headers['content-security-policy'].includes("'unsafe-inline'"));
  assert.match(docs.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.ok(!docs.headers['content-security-policy'].includes('upgrade-insecure-requests'));
  assert.equal((await real.inject('/v1/docs/static/swagger-ui-bundle.js')).statusCode, 200);
});

test('request parser rejects malformed, oversized, unsupported, and poisoned bodies', async t => {
  const app = fixture();
  t.after(() => app.close());
  for (const [payload, type, status, error] of [
    ['{"secret":', 'application/json', 400, 'invalid-request'],
    ['{"__proto__":{"admin":true}}', 'application/json', 400, 'invalid-request'],
    ['{"constructor":{"prototype":{"admin":true}}}', 'application/json', 400, 'invalid-request'],
    ['x'.repeat(1_048_577), 'text/plain', 413, 'request-too-large'],
    ['<xml/>', 'application/xml', 415, 'unsupported-media-type'],
  ]) {
    const response = await app.inject({ method: 'POST', url: '/body', headers: { 'content-type': type }, payload });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), { error });
  }
  await app.listen({ port: 0, host: '127.0.0.1' });
  const response = await fetch(`${app.listeningOrigin}/body`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"private":',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid-request' });
  assert.equal(app.server.requestTimeout, 30_000);
  assert.equal(app.server.timeout, 60_000);
  assert.equal(app.server.keepAliveTimeout, 5_000);
  assert.equal(app.server.maxRequestsPerSocket, 1_000);
});

test('global throttle covers changing paths and spoofed headers, but leaves liveness available', async t => {
  const app = fixture();
  t.after(() => app.close());
  for (let index = 0; index < 300; index++) {
    const response = await app.inject({
      url: `/missing-${index}`,
      headers: { 'x-forwarded-for': `192.0.2.${index % 255}` },
    });
    assert.equal(response.statusCode, 404);
  }
  const blocked = await app.inject({ url: '/ok', headers: { origin: 'http://localhost:5173' } });
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.json(), { error: 'rate-limit-exceeded' });
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal(blocked.headers['x-content-type-options'], 'nosniff');
  assert.equal(blocked.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(blocked.headers['access-control-expose-headers'], 'Retry-After');
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/body',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.statusCode, 429);
  assert.equal((await app.inject('/live')).statusCode, 200);
  assert.equal((await app.inject({ url: '/ok', remoteAddress: '192.0.2.100' })).statusCode, 200);
});

test('IPv6 address rotation within one subnet shares the general limit', async t => {
  const app = fixture();
  t.after(() => app.close());
  for (let index = 1; index <= 300; index++)
    assert.equal(
      (await app.inject({ url: '/ok', remoteAddress: `2001:db8:1:2::${index.toString(16)}` })).statusCode,
      200,
    );
  assert.equal((await app.inject({ url: '/ok', remoteAddress: '2001:db8:1:2::ffff' })).statusCode, 429);
  assert.equal((await app.inject({ url: '/ok', remoteAddress: '2001:db8:1:3::1' })).statusCode, 200);
});

test('diagnostics have a separate small budget that cannot consume liveness', async t => {
  const app = fixture();
  t.after(() => app.close());
  for (let index = 0; index < 6; index++) assert.equal((await app.inject('/diagnostics')).statusCode, 200);
  assert.equal((await app.inject('/diagnostics')).statusCode, 429);
  assert.equal((await app.inject('/live')).statusCode, 200);
  assert.equal((await app.inject('/ok')).statusCode, 200);
});

test('proxy modes trust only the proxy-appended rightmost hop and ignores caller request IDs', async t => {
  const old = process.env.API_PROXY_MODE;
  t.after(() => {
    if (old === undefined) delete process.env.API_PROXY_MODE;
    else process.env.API_PROXY_MODE = old;
  });
  for (const [mode, expected] of [
    ['direct', '127.0.0.1'],
    ['reverse-proxy', '198.51.100.2'],
    ['azure-container-apps', '198.51.100.2'],
  ]) {
    process.env.API_PROXY_MODE = mode;
    const app = fixture();
    t.after(() => app.close());
    const response = await app.inject({
      url: '/ok',
      headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.2', 'request-id': 'untrusted' },
    });
    assert.equal(response.json().ip, expected);
    assert.notEqual(response.json().id, 'untrusted');
  }
  process.env.API_PROXY_MODE = 'true';
  assert.throws(securityServerOptions);
});

test('shared protection fails closed and rejects bad auth origins before database access', async t => {
  const app = Fastify();
  let calls = 0;
  registerAbuseHooks(
    app,
    async () => {
      calls++;
      throw new Error('database secret');
    },
    {},
  );
  app.post('/v1/auth/*', () => assert.fail('Handler must not run'));
  t.after(() => app.close());
  for (const origin of [undefined, 'null', 'https://evil.example']) {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/v1/auth/sign-out', headers: origin ? { origin } : {} })).statusCode,
      403,
    );
  }
  assert.equal(calls, 0);
  const result = await app.inject({
    method: 'POST',
    url: '/v1/auth/sign-out',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.json(), { error: 'abuse-protection-unavailable' });
  assert.equal(result.headers['retry-after'], '5');
});

test('auth session reads stay available when abuse protection storage fails', async t => {
  const app = Fastify();
  registerAbuseHooks(
    app,
    async () => {
      throw new Error('database unavailable');
    },
    {},
  );
  app.get('/v1/auth/*', () => ({ session: null }));
  t.after(() => app.close());
  const result = await app.inject({ method: 'GET', url: '/v1/auth/get-session' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { session: null });
});

test('only deliveries that pass the webhook key spend the workflow and workspace budgets', async t => {
  const hits = new Map();
  const app = Fastify();
  registerAbuseHooks(
    app,
    async (policy, identity, mode = 'spend') => {
      const key = `${policy.name}:${identity}`,
        current = hits.get(key) ?? 0;
      if (mode === 'check') return current >= policy.max ? 60 : null;
      hits.set(key, mode === 'refund' ? current - 1 : current + 1);
      return mode === 'spend' && current + 1 > policy.max ? 60 : null;
    },
    {},
  );
  app.post(
    '/workspaces/:workspaceId/workflows/:workflowId/webhook',
    { schema: { operationId: 'receiveWorkflowWebhookV1' } },
    (request, reply) =>
      request.headers.authorization === 'Bearer good'
        ? { runId: 'run' }
        : reply.code(404).send({ error: 'workflow-not-found' }),
  );
  t.after(() => app.close());
  const workspace = '11111111-1111-4111-8111-111111111111',
    workflows = Array.from({ length: 6 }, (_, n) => `22222222-2222-4222-8222-22222222222${n}`);
  let source = 0;
  const deliver = (workflow, authorization, payload = { requestId: 'r' }) =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspace}/workflows/${workflow}/webhook`,
      remoteAddress: `10.0.${Math.floor(source / 250)}.${source++ % 250}`,
      headers: { authorization, 'content-type': 'application/json' },
      payload,
    });
  const statuses = async (count, send) => {
    const seen = [];
    for (let n = 0; n < count; n++) seen.push((await send(n)).statusCode);
    return [...new Set(seen)];
  };

  assert.deepEqual(await statuses(700, () => deliver(workflows[0], 'Bearer guess')), [404]);
  assert.deepEqual(await statuses(700, () => deliver(workflows[0], 'Bearer guess', '{')), [400]);
  assert.deepEqual(await statuses(700, () => deliver(workflows[0], 'Bearer good', '{')), [400]);
  assert.deepEqual(
    await statuses(120, () => deliver(workflows[0], 'Bearer good')),
    [200],
    'Rejected requests leave the whole workflow budget',
  );
  assert.equal((await deliver(workflows[0], 'Bearer good')).statusCode, 429);
  assert.deepEqual(await statuses(480, n => deliver(workflows[1 + (n % 4)], 'Bearer good')), [200]);
  assert.equal(
    (await deliver(workflows[5], 'Bearer good')).statusCode,
    429,
    'Accepted deliveries spend the workspace budget',
  );
});

test('expired or replayed signed webhooks spend only the sender budget', async t => {
  const hits = new Map();
  const app = Fastify();
  registerAbuseHooks(
    app,
    async (policy, identity, mode = 'spend') => {
      const key = `${policy.name}:${identity}`,
        current = hits.get(key) ?? 0;
      if (mode === 'check') return current >= policy.max ? 60 : null;
      hits.set(key, mode === 'refund' ? current - 1 : current + 1);
      return mode === 'spend' && current + 1 > policy.max ? 60 : null;
    },
    {},
  );
  const answers = {
    'Signature expired': 'webhook-signature-expired',
    'Signature replayed': 'webhook-signature-replayed',
    'Bearer duplicate': 'request-conflict',
  };
  app.post(
    '/workspaces/:workspaceId/workflows/:workflowId/webhook',
    { schema: { operationId: 'receiveWorkflowWebhookV1' } },
    (request, reply) =>
      request.headers.authorization === 'Bearer good'
        ? { runId: 'run' }
        : reply.code(409).send({ error: answers[request.headers.authorization] }),
  );
  t.after(() => app.close());
  const workspace = '11111111-1111-4111-8111-111111111111',
    workflow = '22222222-2222-4222-8222-222222222220';
  let source = 0;
  const deliver = (authorization, remoteAddress = `10.0.${Math.floor(source / 250)}.${source++ % 250}`) =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspace}/workflows/${workflow}/webhook`,
      remoteAddress,
      headers: { authorization, 'content-type': 'application/json' },
      payload: { requestId: 'r' },
    });
  const statuses = async (count, send) => {
    const seen = [];
    for (let n = 0; n < count; n++) seen.push((await send(n)).statusCode);
    return [...new Set(seen)];
  };

  assert.deepEqual(await statuses(700, n => deliver(n % 2 ? 'Signature expired' : 'Signature replayed')), [409]);
  assert.equal(
    (await deliver('Bearer good')).statusCode,
    200,
    'A fresh delivery still succeeds after old signed requests pass the workspace limit',
  );
  assert.deepEqual(await statuses(60, () => deliver('Signature replayed', '10.9.0.1')), [409]);
  assert.equal(
    (await deliver('Signature replayed', '10.9.0.1')).statusCode,
    429,
    'A replaying sender keeps spending its own budget',
  );
  assert.deepEqual(await statuses(119, () => deliver('Bearer duplicate')), [409]);
  assert.equal(
    (await deliver('Bearer good')).statusCode,
    429,
    'Other conflicts after an accepted key still spend the workflow budget',
  );
});

test('business limits use verified user identity across workspaces and sessions', async t => {
  const app = Fastify();
  const calls = [];
  registerAbuseHooks(
    app,
    async (policy, identity) => {
      calls.push([policy.name, identity]);
      return 30;
    },
    { api: { getSession: async () => ({ user: { id: 'verified-user' } }) } },
  );
  app.put('/workspaces/:workspace/agents/:agent/chat', { schema: { operationId: 'submitAgentChatV1' } }, () =>
    assert.fail('Handler must not run'),
  );
  t.after(() => app.close());
  const response = await app.inject({ method: 'PUT', url: '/workspaces/untrusted/agents/untrusted/chat' });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(calls, [['agent-chat', 'verified-user']]);
});

test('email protection cannot be skipped through a different email validation rule', async t => {
  const app = Fastify();
  const recipients = [];
  registerAbuseHooks(
    app,
    async (policy, identity) => {
      if (policy.name !== 'email-recipient') return null;
      recipients.push(identity);
      return 60;
    },
    {},
  );
  app.post('/v1/auth/*', () => assert.fail('Handler must not run'));
  t.after(() => app.close());
  for (const email of [' Person@Example.com ', 'not-an-email', `${'a'.repeat(255)}@example.com`]) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in/magic-link',
      headers: { origin: 'http://localhost:5173' },
      payload: { email },
    });
    assert.equal(response.statusCode, 429);
  }
  assert.deepEqual(recipients, ['person@example.com', 'not-an-email', `${'a'.repeat(255)}@example.com`]);
});

test('nested business error handlers preserve parser status codes', async t => {
  const auth = { api: { getSession: async () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }) } };
  const id = '22222222-2222-4222-8222-222222222222';
  for (const [register, path] of [
    [app => registerAgents(app, { auth, runtime: {}, pool: {}, agentModel: null }), `/workspaces/${id}/agents/${id}`],
    [app => registerIntegrations(app, { auth, service: {} }), `/workspaces/${id}/integrations/creation-grants`],
    [app => registerGovernance(app, { auth, runtime: {}, pool: {} }), `/workspaces/${id}/governance/teams/${id}`],
  ]) {
    const app = Fastify({ bodyLimit: 100 });
    register(app);
    t.after(() => app.close());
    for (const [payload, type, status] of [
      ['{', 'application/json', 400],
      ['x'.repeat(101), 'text/plain', 413],
      ['<xml/>', 'application/xml', 415],
    ]) {
      const result = await app.inject({
        method: 'PUT',
        url: path,
        payload,
        headers: { origin: 'http://localhost:5173', 'content-type': type },
      });
      assert.equal(result.statusCode, status, `${path}: ${result.body}`);
    }
  }
});

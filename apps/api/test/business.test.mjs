import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { protectBusinessRequests, protectWorkspaceRequests } from '../src/business.ts';
import { buildApp } from '../src/app.ts';
import { AccessDenied, resolveHuman, WorkspaceMembershipDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { workflowWebhookOperations } from '../src/abuse.ts';
import { registerWorkflows } from '../src/workflows.ts';
import { registerCredits } from '../src/credits.ts';
import { registerRecommendations } from '../src/recommendations.ts';
import { registerRecommendationEvents } from '../src/recommendation-events.ts';
import {
  authenticateRoutes,
  protectExpectedSession,
  sessionIndependentOperations,
} from '../src/authenticated-routes.ts';
import { registerSecrets } from '../src/secrets.ts';
import { registerGitHubAccounts } from '../src/github-accounts.ts';
import { registerWorkspaces } from '../src/workspaces.ts';
import { authConfig } from '../src/auth.ts';
import { createSecretBody } from '../src/secrets-contracts.ts';

// The app serves the shipped model catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

test('expected-session admission stops legacy reads and writes before validation or services', async t => {
  const id = '22222222-2222-4222-8222-222222222222';
  const session = { user: { id }, session: { id: 'current-session' } };
  let sessionReads = 0;
  const auth = {
    api: {
      getSession: async () => {
        sessionReads++;
        return session;
      },
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  protectExpectedSession(app, auth);
  protectBusinessRequests(app);
  registerWorkspaces(app, { auth, pool: {} }, {});
  registerGitHubAccounts(app, auth, null);
  let writes = 0;
  registerSecrets(app, auth, {
    secrets: {
      list: async () => [],
      create: async () => {
        writes++;
        assert.fail('A stale request must not create a secret');
      },
    },
    requests: {},
  });
  const secret = createSecretBody.parse({
    requestId: id,
    name: 'Example token',
    variableName: 'EXAMPLE_TOKEN',
    kind: 'token',
    value: 'synthetic-value',
    placement: { kind: 'bearer' },
    destinations: [{ kind: 'host', host: 'example.com' }],
    grants: [],
  });
  for (const request of [
    { url: '/workspaces' },
    { url: '/workspaces/example' },
    { url: `/workspaces/${id}/github/accounts` },
    { url: `/workspaces/${id}/secrets` },
    { method: 'POST', url: `/workspaces/${id}/secrets`, payload: secret },
    { method: 'POST', url: '/workspaces/invalid/secrets', payload: {} },
    {
      method: 'POST',
      url: `/workspaces/${id}/secrets`,
      payload: '{"',
      headers: { 'content-type': 'application/json' },
    },
  ]) {
    const before = sessionReads;
    const response = await app.inject({
      ...request,
      headers: {
        origin: authConfig().webOrigin,
        ...request.headers,
        'x-tulipfarm-expected-session': 'old-session',
      },
    });
    assert.equal(response.statusCode, 401, `${request.url}: ${response.body}`);
    assert.deepEqual(response.json(), { error: 'session-changed' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(sessionReads, before + 1);
  }
  assert.equal(writes, 0);
  for (const headers of [{}, { 'x-tulipfarm-expected-session': 'current-session' }]) {
    const before = sessionReads;
    const response = await app.inject({ url: `/workspaces/${id}/secrets`, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { secrets: [] });
    assert.equal(sessionReads, before + (Object.keys(headers).length ? 2 : 1));
  }
});

test('expected-session admission wins before workspace admission and fails closed on session errors', async t => {
  const id = '22222222-2222-4222-8222-222222222222';
  const app = Fastify();
  t.after(() => app.close());
  let reads = 0;
  let session = { user: { id }, session: { id: 'current-session' } };
  let failure;
  const auth = {
    api: {
      getSession: async () => {
        reads++;
        if (failure) throw failure;
        return session;
      },
    },
  };
  protectExpectedSession(app, auth);
  protectWorkspaceRequests(app, auth, {
    hasCurrentMember: async () => assert.fail('A stale request must not read workspace membership'),
    transaction: async () => assert.fail('A stale request must not access workspace storage'),
  });
  app.register(async routes => {
    authenticateRoutes(routes, auth);
    routes.post('/workspaces/:workspaceId/resource', () => assert.fail('A refused request must not run'));
  });
  const request = () =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${id}/resource`,
      headers: { 'x-tulipfarm-expected-session': 'old-session' },
      payload: {},
    });
  assert.deepEqual((await request()).json(), { error: 'session-changed' });
  assert.equal(reads, 1, 'the outer boundary stops the request before either inner auth hook');
  session = null;
  const guest = await request();
  assert.equal(guest.statusCode, 401);
  assert.deepEqual(guest.json(), { error: 'sign-in-required' });
  failure = new Error('Session store unavailable');
  assert.equal((await request()).statusCode, 500);
  assert.equal(reads, 3);
});

test('expected-session admission leaves public operations and hidden entry routes untouched', async t => {
  const app = Fastify();
  t.after(() => app.close());
  protectExpectedSession(app, {
    api: { getSession: async () => assert.fail('Public requests must not look up browser sessions') },
  });
  for (const [index, operationId] of [...sessionIndependentOperations].entries())
    app.get(`/public/${index}`, { schema: { operationId } }, () => ({ public: true }));
  for (const url of ['/v1/auth/*', '/v1/auth/options', '/v1/dev/sign-in-link', '/v1/dev/session', '/v1/viewer'])
    app.get(url, { schema: { hide: true } }, () => ({ public: true }));
  for (const url of [
    ...[...sessionIndependentOperations].map((_, index) => `/public/${index}`),
    '/v1/auth/get-session',
    '/v1/auth/options',
    '/v1/dev/sign-in-link',
    '/v1/dev/session',
    '/v1/viewer',
  ]) {
    const response = await app.inject({ url, headers: { 'x-tulipfarm-expected-session': 'old-session' } });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert.deepEqual(response.json(), { public: true });
  }
});

for (const path of ['credits', 'recommendations', 'recommendations/events']) {
  test(`workspace admission conceals removal caught inline by ${path}`, async t => {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const userId = '33333333-3333-4333-8333-333333333333';
    const app = Fastify();
    t.after(() => app.close());
    const auth = { api: { getSession: async () => ({ user: { id: userId } }) } };
    let admitted = false;
    let transactionError;
    let transactions = 0;
    const runtime = {
      hasCurrentMember: async () => admitted,
      transaction: async (_id, _compatibility, operation) => {
        transactions++;
        if (transactionError) throw transactionError;
        return operation({
          schema: 'workspace',
          client: {
            query: async sql => {
              if (sql.includes('tf_authorization_lock')) return { rows: [{ id: 1 }], rowCount: 1 };
              assert.match(sql, /tf_memberships.*WHERE user_id = \$1 AND removed_at IS NULL/);
              return { rows: [], rowCount: 0 };
            },
          },
        });
      },
    };
    protectWorkspaceRequests(app, auth, runtime);
    registerCredits(app, { runtime, auth });
    registerRecommendations(app, { runtime, auth });
    registerRecommendationEvents(app, {
      runtime,
      auth,
      eligible: async () => assert.fail('Removed members cannot reach stream eligibility'),
      events: { healthy: () => assert.fail('Removed members cannot open a stream') },
    });
    const url = `/workspaces/${workspaceId}/${path}`;
    const denied = await app.inject(url);
    assert.equal(denied.statusCode, 404);
    assert.equal(denied.body, '{"error":"not-found"}');
    assert.equal(transactions, 0);
    admitted = true;
    const removed = await app.inject(url);
    assert.equal(transactions, 1, 'membership is rechecked after admission');
    assert.equal(removed.statusCode, denied.statusCode);
    assert.equal(removed.body, denied.body);
    assert.equal(removed.headers['cache-control'], 'no-store');
    for (const error of [new AccessDenied(), new WorkspaceMembershipDenied('44444444-4444-4444-8444-444444444444')]) {
      transactionError = error;
      const resourceDenied = await app.inject(url);
      assert.equal(resourceDenied.statusCode, 404);
      assert.equal(resourceDenied.body, '{"error":"workspace-not-found"}');
    }
  });
}

test('workspace admission hides membership before parsing and preserves public receivers', async t => {
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  const app = Fastify();
  t.after(() => app.close());
  let membership = false;
  let storage = true;
  let revoked = false;
  let revokedUser = userId;
  let reads = 0;
  let fallbacks = 0;
  let fastFailure;
  let fallbackFailure;
  let session = { user: { id: userId }, session: { id: 'session' } };
  const auth = { api: { getSession: async () => session } };
  protectWorkspaceRequests(app, auth, {
    hasCurrentMember: async (id, user) => {
      reads++;
      assert.equal(id, workspaceId);
      assert.equal(user, userId);
      if (fastFailure) throw fastFailure;
      if (!storage) throw new StorageUnavailableError('disabled');
      return membership;
    },
    transaction: async (id, _compatibility, operation) => {
      fallbacks++;
      assert.equal(id, workspaceId);
      if (fallbackFailure) throw fallbackFailure;
      if (!storage) throw new StorageUnavailableError('disabled');
      return operation({
        schema: 'workspace',
        client: {
          query: async (sql, values) => {
            assert.match(sql, /WHERE user_id = \$1 AND removed_at IS NULL/);
            assert.doesNotMatch(sql, /FOR (SHARE|UPDATE)|advisory/);
            assert.deepEqual(values, [userId]);
            return { rows: membership ? [{ allowed: 1 }] : [], rowCount: membership ? 1 : 0 };
          },
        },
      });
    },
  });
  app.register(async routes => {
    routes.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: 'feature-error' }));
    routes.post(
      '/workspaces/:workspaceId/resource/:id',
      {
        schema: {
          params: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        },
      },
      async () => {
        if (revoked)
          await resolveHuman({ schema: 'workspace', client: { query: async () => ({ rows: [] }) } }, revokedUser);
        return { ok: true };
      },
    );
    for (const [index, operationId] of [...workflowWebhookOperations].entries())
      routes.post(`/workspaces/:workspaceId/receiver/${index}`, { schema: { operationId } }, async () => ({
        accepted: true,
      }));
    routes.post('/invitations/redeem', async () => ({ joined: true }));
  });
  const request = (id, payload, headers = {}) =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/resource/${id}`,
      headers,
      payload,
    });
  for (const available of [true, false]) {
    storage = available;
    for (const [id, payload] of [
      [workspaceId, { name: 'Valid' }],
      ['invalid', {}],
      ['invalid', '{"'],
    ]) {
      const response = await request(id, payload, { 'content-type': 'application/json' });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.body, '{"error":"not-found"}');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
  storage = true;
  membership = true;
  assert.deepEqual((await request(workspaceId, { name: 'Valid' })).json(), { ok: true });
  const previousFallbacks = fallbacks;
  fastFailure = new Error('Pool read failed');
  assert.deepEqual((await request(workspaceId, { name: 'Valid' })).json(), { ok: true });
  assert.equal(fallbacks, previousFallbacks + 1);
  membership = false;
  assert.equal((await request(workspaceId, { name: 'Valid' })).statusCode, 404);
  fallbackFailure = new StorageUnavailableError('updating');
  const updating = await request(workspaceId, { name: 'Valid' });
  assert.equal(updating.statusCode, 503);
  assert.deepEqual(updating.json(), { error: 'workspace-updating' });
  membership = true;
  fastFailure = undefined;
  fallbackFailure = undefined;
  revoked = true;
  const removed = await request(workspaceId, { name: 'Valid' });
  assert.equal(removed.statusCode, 404);
  assert.equal(removed.body, '{"error":"not-found"}');
  revokedUser = '44444444-4444-4444-8444-444444444444';
  const otherMember = await request(workspaceId, { name: 'Valid' });
  assert.equal(otherMember.statusCode, 503);
  assert.deepEqual(otherMember.json(), { error: 'feature-error' });
  const previousReads = reads;
  const changed = await request(workspaceId, { name: 'Valid' }, { 'x-tulipfarm-expected-session': 'old-session' });
  assert.equal(changed.statusCode, 401);
  assert.deepEqual(changed.json(), { error: 'session-changed' });
  session = null;
  assert.equal((await request(workspaceId, { name: 'Valid' })).statusCode, 401);
  for (const index of [0, 1]) {
    const response = await app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/receiver/${index}` });
    assert.deepEqual(response.json(), { accepted: true });
  }
  assert.deepEqual((await app.inject({ method: 'POST', url: '/invitations/redeem' })).json(), { joined: true });
  assert.equal(reads, previousReads);
});

test('workspace admission leaves signed webhook authentication with the workflow receiver', async t => {
  const id = '22222222-2222-4222-8222-222222222222';
  const auth = { api: { getSession: async () => assert.fail('Public receivers do not need a browser session') } };
  const app = Fastify();
  t.after(() => app.close());
  protectBusinessRequests(app);
  protectWorkspaceRequests(app, auth, {
    hasCurrentMember: async () => assert.fail('Public receivers must not run membership admission'),
    transaction: async () => assert.fail('Public receivers must not run membership admission'),
  });
  const deliveries = [];
  registerWorkflows(app, {
    auth,
    service: {
      webhook: async (workspaceId, workflowId, request, triggerId) => {
        assert.equal(workspaceId, id);
        assert.equal(workflowId, id);
        assert.equal(request.headers.authorization, 'Bearer fixture-signature');
        assert.deepEqual(request.body, { event: 'created' });
        deliveries.push(triggerId);
        return { runId: id, replayed: false };
      },
      recordWebhookDelivery: async () => {},
    },
  });
  for (const suffix of ['webhook', 'triggers/incoming/webhook']) {
    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${id}/workflows/${id}/${suffix}`,
      headers: { authorization: 'Bearer fixture-signature' },
      payload: { event: 'created' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { runId: id });
  }
  assert.deepEqual(deliveries, [undefined, 'incoming']);
});

test('Turbo dev passes Soul read and integration credentials to the API in strict mode', () => {
  const credentials = {
    R2_SOUL_READ_ACCESS_KEY_ID: 'regression-read-id',
    R2_SOUL_READ_SECRET_ACCESS_KEY: 'regression-read-secret',
    INTEGRATION_CREDENTIAL_KEY_ID: 'regression-integration',
    INTEGRATION_CREDENTIAL_KEY: 'ab'.repeat(32),
    INTEGRATION_CREDENTIAL_PREVIOUS_KEYS: '{}',
  };
  const output = execFileSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'dev', '--filter=@tulipfarm/api', '--env-mode=strict', '--dry=json'],
    {
      cwd: new URL('../../../', import.meta.url),
      env: { ...process.env, ...credentials },
      encoding: 'utf8',
    },
  );
  const result = JSON.parse(output);
  const task = result.tasks.find(task => task.taskId === '@tulipfarm/api#dev');
  assert.equal(task.envMode, 'strict');
  for (const [key, value] of Object.entries(credentials)) {
    assert.ok(task.environmentVariables.specified.passThroughEnv.includes(key), `${key} must be configured`);
    const hash = createHash('sha256').update(value).digest('hex');
    assert.ok(task.environmentVariables.passthrough.includes(`${key}=${hash}`), `${key} must reach the task`);
  }
});

test('every unsafe business method rejects absent and foreign origins before its handler', async () => {
  const app = Fastify();
  protectBusinessRequests(app);
  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/operation',
    handler: async () => ({ ok: true }),
  });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const headers of [{}, { origin: 'https://evil.example' }]) {
        const response = await app.inject({ method, url: '/operation', headers });
        assert.equal(response.statusCode, 403);
        assert.deepEqual(response.json(), { error: 'Untrusted request origin' });
      }
      assert.equal(
        (await app.inject({ method, url: '/operation', headers: { origin: 'http://localhost:5173' } })).statusCode,
        200,
      );
    }
    assert.equal((await app.inject({ url: '/operation' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('browser preflight permits supported mutations only for the configured web origin', async () => {
  const app = buildApp({ agentModel: null });
  try {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/v1/workspaces/example/tables/example/rows/example',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(response.statusCode, 204);
      assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
      assert.equal(response.headers['access-control-allow-credentials'], 'true');
      assert.ok(
        response.headers['access-control-allow-methods']
          .split(',')
          .map(value => value.trim())
          .includes(method),
      );
    }
    const foreign = await app.inject({
      method: 'OPTIONS',
      url: '/v1/workspaces',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'PUT',
      },
    });
    assert.notEqual(foreign.headers['access-control-allow-origin'], 'https://evil.example');
  } finally {
    await app.close();
  }
});

for (const failingWorkflow of ['executeTableProposal', 'prepareAgentSave']) {
  test(`independent dispatch paths run when ${failingWorkflow} fails and retry stable IDs`, async context => {
    const { registerTableDispatch } = await import('../src/table-dispatch.ts');
    const { setImmediate } = await import('node:timers/promises');
    context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_800_000_000_000 });
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const agentId = '44444444-4444-4444-8444-444444444444';
    const proposalId = '55555555-5555-4555-8555-555555555555';
    const starts = [],
      logs = [];
    let failing = true;
    let agentDispatchedAt = null;
    const app = Fastify({
      logger: {
        stream: {
          write(line) {
            logs.push(JSON.parse(line));
          },
        },
      },
    });
    const client = {
      async query(sql, values) {
        if (sql.startsWith('SELECT p.id FROM') && sql.includes('tf_table_proposals'))
          return { rows: [{ id: proposalId }] };
        if (sql.startsWith('SELECT id FROM') && sql.includes('"tf_agent_commands"')) return { rows: [{ id: agentId }] };
        if (sql.startsWith('UPDATE') && sql.includes('"tf_agent_commands"')) {
          assert.match(sql, /SET dispatched_at = now\(\) WHERE id = \$1/);
          assert.deepEqual(values, [agentId]);
          agentDispatchedAt = Date.now();
          return { rows: [], rowCount: 1 };
        }
        return {
          rows: sql.includes('tf_authorization_lock') ? [{ id: 1 }] : [],
          rowCount: sql.includes('tf_authorization_lock') ? 1 : 0,
        };
      },
    };
    registerTableDispatch(app, {
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM app\.workspace_storage WHERE stage = 'ready'/);
          assert.deepEqual(values, [null]);
          return { rows: [{ workspace_id: workspaceId }] };
        },
      },
      runtime: {
        async transaction(id, _compatibility, operation) {
          assert.equal(id, workspaceId);
          return operation({ schema: 'dispatch_test', client });
        },
      },
      temporal: {
        connection: { withDeadline: (_deadline, operation) => operation() },
        client: {
          workflow: {
            async start(workflow, options) {
              starts.push({ workflow, ...options });
              if (failing && workflow === failingWorkflow) throw new Error('Controlled resource start failure');
            },
          },
        },
      },
    });
    try {
      await app.ready();
      await setImmediate();
      const expectedStarts = [
        {
          workflow: 'executeTableProposal',
          workflowId: `table-proposal-v2-${workspaceId}-${proposalId}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [workspaceId, proposalId, process.env.TEMPORAL_STORAGE_TASK_QUEUE ?? 'tulipfarm-storage-v1'],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
        {
          workflow: 'prepareAgentSave',
          workflowId: `agent-save-v1-${workspaceId}-${agentId}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [workspaceId, agentId],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
      ];
      assert.deepEqual(starts, expectedStarts);
      assert.equal(agentDispatchedAt, failingWorkflow === 'prepareAgentSave' ? null : 1_800_000_000_000);
      assert.deepEqual(
        logs.map(({ msg, workspaceId }) => ({ msg, workspaceId })),
        [
          {
            msg:
              failingWorkflow === 'prepareAgentSave'
                ? 'Agent dispatch will retry'
                : 'Table proposal dispatch will retry',
            workspaceId,
          },
        ],
      );

      failing = false;
      context.mock.timers.tick(2000);
      await setImmediate();
      assert.deepEqual(starts, [...expectedStarts, ...expectedStarts]);
      assert.equal(agentDispatchedAt, 1_800_000_002_000);
      assert.equal(logs.length, 1);
    } finally {
      await app.close();
    }
    context.mock.timers.tick(2000);
    await setImmediate();
    assert.equal(starts.length, 4);
  });
}

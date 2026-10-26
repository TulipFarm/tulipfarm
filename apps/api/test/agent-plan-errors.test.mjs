import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { registerAgentPlans } from '../src/agent-plans.ts';

test('plan routes tell a source that cannot be checked now apart from a plan the reader cannot see', async () => {
  let failure;
  const app = Fastify();
  registerAgentPlans(app, {
    auth: { api: { getSession: async ({ headers }) => (headers.get('cookie') ? { user: { id: 'reader' } } : null) } },
    runtime: {
      transaction: async () => {
        throw failure;
      },
    },
  });
  const read = () =>
    app.inject({ url: `/workspaces/${randomUUID()}/agent-plans/${randomUUID()}`, headers: { cookie: 'reader' } });
  try {
    failure = new SourceAuthorizationUnavailable();
    let response = await read();
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { error: 'plan-source-unavailable' });

    failure = new AccessDenied();
    response = await read();
    assert.equal(response.statusCode, 404, response.body);
    assert.deepEqual(response.json(), { error: 'plan-not-found' });

    failure = new Error('connection reset');
    response = await read();
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), { error: 'plan-operation-unavailable' });
  } finally {
    await app.close();
  }
});

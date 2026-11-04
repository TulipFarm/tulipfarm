import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { AgentPlanError } from '@tulipfarm/agents/plan-contracts';
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

test('a plan document page is sandboxed HTML for readers who may open it, and only the starter retries it', async t => {
  const previous = process.env.FEATURE_FLAG_PLAN_DOCUMENTS;
  process.env.FEATURE_FLAG_PLAN_DOCUMENTS = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.FEATURE_FLAG_PLAN_DOCUMENTS;
    else process.env.FEATURE_FLAG_PLAN_DOCUMENTS = previous;
  });
  const html = Buffer.from('<!doctype html><title>Plan</title><p>Plan</p>');
  const stored = { key: randomUUID(), size: html.length, sha256: createHash('sha256').update(html).digest('hex') };
  let outcome;
  let body = html;
  const reads = [],
    starts = [];
  const app = Fastify();
  registerAgentPlans(app, {
    auth: { api: { getSession: async ({ headers }) => (headers.get('cookie') ? { user: { id: 'reader' } } : null) } },
    runtime: { transaction: async () => outcome() },
    documents: {
      objects: {
        read: async (key, maximumBytes) => {
          reads.push({ key, maximumBytes });
          return body;
        },
      },
      start: async (...args) => {
        starts.push(args);
      },
    },
  });
  t.after(() => app.close());
  const workspaceId = randomUUID(),
    planId = randomUUID();
  const page = () =>
    app.inject({
      url: `/workspaces/${workspaceId}/agent-plans/${planId}/document/2`,
      headers: { cookie: 'reader' },
    });
  const retry = () =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agent-plans/${planId}/document/retry`,
      headers: { cookie: 'reader', origin: 'http://localhost:5173' },
    });

  outcome = () => stored;
  let response = await page();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.body, html.toString());
  assert.match(response.headers['content-type'], /^text\/html/);
  const policy = response.headers['content-security-policy'];
  for (const directive of ["default-src 'none'", 'img-src data:', "style-src 'unsafe-inline'", 'sandbox'])
    assert.ok(
      policy.split(';').some(part => part.trim() === directive),
      `${directive} in ${policy}`,
    );
  assert.doesNotMatch(policy, /script-src|connect-src/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(reads.length, 1);
  assert.ok(reads[0].key.endsWith(stored.key));
  assert.equal(reads[0].maximumBytes, stored.size);

  body = Buffer.from('<p>Changed in storage</p>');
  response = await page();
  assert.equal(response.statusCode, 503, 'a page whose bytes changed in storage is never served');
  body = html;

  outcome = () => {
    throw new AccessDenied();
  };
  response = await page();
  assert.equal(response.statusCode, 404, 'a reader who cannot open the PDF gets no page');
  assert.equal(reads.length, 2);

  outcome = () => {
    throw new AgentPlanError('not-starter');
  };
  response = await retry();
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(starts, []);

  outcome = () => null;
  response = await retry();
  assert.equal(response.statusCode, 409, 'a rendering that has not failed is not retried');
  assert.deepEqual(starts, []);

  outcome = () => 'retry';
  response = await retry();
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(starts, [[workspaceId, planId, 'retry']]);

  process.env.FEATURE_FLAG_PLAN_DOCUMENTS = 'false';
  response = await page();
  assert.equal(response.statusCode, 404, 'with the flag off there is no document');
});

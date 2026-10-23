import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { GitHubWebhookError } from '@tulipfarm/github/event-signature';
import { GitHubKnowledgeEventConflict } from '@tulipfarm/github/knowledge-events';
import { githubKnowledgeEventsFromEnvironment, registerGitHubKnowledgeEvents } from '../src/knowledge-github-events.ts';
import { registerGitHubKnowledgeDispatch } from '../src/knowledge-github-dispatch.ts';

test('webhooks are on only with an App ID and a strong secret', () => {
  const pool = { connect: async () => assert.fail('not connected at startup') };
  assert.equal(githubKnowledgeEventsFromEnvironment(pool, {}), null);
  assert.equal(githubKnowledgeEventsFromEnvironment(undefined, { GITHUB_WEBHOOK_APP_ID: '100' }), null);
  assert.throws(() => githubKnowledgeEventsFromEnvironment(pool, { GITHUB_WEBHOOK_APP_ID: '100' }), /required/);
  assert.throws(
    () => githubKnowledgeEventsFromEnvironment(pool, { GITHUB_WEBHOOK_APP_ID: '100', GITHUB_WEBHOOK_SECRET: 'short' }),
    /32 to 4096/,
  );
  assert.equal(
    typeof githubKnowledgeEventsFromEnvironment(pool, {
      GITHUB_WEBHOOK_APP_ID: '100',
      GITHUB_WEBHOOK_SECRET: 'x'.repeat(32),
    }).accept,
    'function',
  );
});

test('the webhook route maps receipts and failures to GitHub-visible statuses', async () => {
  const deliveryId = randomUUID();
  const outcomes = {
    accepted: async () => ({ deliveryId, status: 'pending', reason: null, duplicate: false }),
    unsigned: async () => {
      throw new GitHubWebhookError('signature-invalid');
    },
    headers: async () => {
      throw new GitHubWebhookError('headers-invalid');
    },
    conflict: async () => {
      throw new GitHubKnowledgeEventConflict();
    },
    broken: async () => {
      throw new Error('database unavailable');
    },
  };
  const received = [];
  const events = {
    accept: async (raw, headers) => {
      received.push(raw);
      return outcomes[headers['x-outcome']]();
    },
  };
  const app = Fastify();
  app.log.error = () => {};
  registerGitHubKnowledgeEvents(app, events);
  const disabled = Fastify();
  registerGitHubKnowledgeEvents(disabled, null);
  const send = (target, outcome, payload = '{"zen":"hi"}', type = 'application/json') =>
    target.inject({
      method: 'POST',
      url: '/github/knowledge/events',
      headers: { 'content-type': type, 'x-outcome': outcome },
      payload,
    });
  try {
    const accepted = await send(app, 'accepted');
    assert.equal(accepted.statusCode, 202);
    assert.deepEqual(accepted.json(), { deliveryId, status: 'pending', reason: null, duplicate: false });
    assert.ok(Buffer.isBuffer(received[0]), 'the signature is checked over the exact raw body');
    assert.equal(received[0].toString(), '{"zen":"hi"}');
    assert.equal((await send(app, 'unsigned')).statusCode, 401);
    assert.equal((await send(app, 'headers')).statusCode, 400);
    assert.equal((await send(app, 'conflict')).statusCode, 409);
    assert.equal((await send(app, 'broken')).statusCode, 503);
    assert.equal((await send(app, 'accepted', 'payload=%7B%7D', 'application/x-www-form-urlencoded')).statusCode, 415);
    assert.equal((await send(disabled, 'accepted')).statusCode, 503);
  } finally {
    await app.close();
    await disabled.close();
  }
});

test('the dispatch sweep applies pending deliveries to every workspace, then closes them', async () => {
  const workspaces = [randomUUID(), randomUUID()];
  const changes = [];
  const settled = [];
  const deliveries = [
    { deliveryId: randomUUID(), repositories: ['7001'], all: false },
    { deliveryId: randomUUID(), repositories: ['7002', '7001'], all: false },
  ];
  let done;
  const finished = new Promise(resolve => {
    done = resolve;
  });
  const app = Fastify();
  registerGitHubKnowledgeDispatch(app, {
    pool: {
      query: async (_sql, [after]) => ({
        rows: after === null ? workspaces.map(workspace_id => ({ workspace_id })) : [],
      }),
    },
    service: {
      health: async () => ({ failedItems: 0, failedSources: 0, stalledSources: 0 }),
      due: async (workspaceId, change) => {
        if (workspaceId === workspaces[1]) throw new Error('workspace unavailable');
        changes.push(change);
        return [];
      },
    },
    temporal: { connection: {}, client: {} },
    events: {
      pending: async () => (settled.length ? [] : deliveries),
      settle: async ids => {
        settled.push(...ids);
        done();
      },
    },
  });
  app.log.error = () => {};
  try {
    await app.ready();
    await finished;
    assert.deepEqual(changes[0], { repositories: ['7001', '7002'], all: false });
    assert.deepEqual(
      settled,
      deliveries.map(delivery => delivery.deliveryId),
      'a failed workspace falls back to polling instead of re-applying the deliveries',
    );
  } finally {
    await app.close();
  }
});

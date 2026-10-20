import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { registerKnowledge } from '../dist/knowledge.js';

test('embedding routes process the prepared command and omit vector and query from every HTTP response', async () => {
  const app = Fastify();
  const workspaceId = randomUUID(),
    commandId = randomUUID(),
    jobId = randomUUID();
  const base = `/workspaces/${workspaceId}/knowledge/query-embeddings`;
  const calls = [];
  const status = {
    jobId,
    commandId,
    generation: 1,
    profileId: 'fixture-profile',
    state: 'ready',
    canRetry: false,
    vector: Array(1536).fill(0.125),
    query: 'private query',
  };
  registerKnowledge(app, {
    auth: {
      api: {
        getSession: async ({ headers }) => (headers.get('cookie') ? { user: { id: headers.get('cookie') } } : null),
      },
    },
    service: {},
    embeddings: {
      prepareQuery: async (workspace, actor, input) => {
        calls.push(['prepare', workspace, actor, input]);
        return { ...status, state: 'queued' };
      },
      process: async work => {
        calls.push(['process', work]);
        return { disposition: 'ready' };
      },
      queryStatus: async (workspace, actor, command) => {
        if (actor !== 'owner') throw new AccessDenied();
        calls.push(['status', workspace, actor, command]);
        return status;
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: base,
      headers: { cookie: 'owner', origin: 'http://localhost:5173' },
      payload: { commandId, query: 'private query' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      jobId,
      commandId,
      generation: 1,
      profileId: 'fixture-profile',
      state: 'ready',
      canRetry: false,
    });
    assert.deepEqual(calls, [
      ['prepare', workspaceId, 'owner', { commandId, query: 'private query' }],
      ['process', { workspaceId, jobId, generation: 1 }],
      ['status', workspaceId, 'owner', commandId],
    ]);
    const read = await app.inject({ url: `${base}/${commandId}`, headers: { cookie: 'owner' } });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), response.json());
    const denied = await app.inject({ url: `${base}/${commandId}`, headers: { cookie: 'other-member' } });
    assert.equal(denied.statusCode, 404);
    assert.deepEqual(denied.json(), { error: 'knowledge-not-found' });
    assert.equal((await app.inject({ url: `${base}/${commandId}` })).statusCode, 401);
    const invalid = await app.inject({
      method: 'POST',
      url: base,
      headers: { cookie: 'owner', origin: 'http://localhost:5173' },
      payload: { commandId, query: 'private query', vector: [1] },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

test('API close drains interactive processing after its HTTP client disconnects', async () => {
  const app = Fastify();
  const workspaceId = randomUUID(),
    commandId = randomUUID(),
    jobId = randomUUID();
  let release, entered;
  const processing = new Promise(resolve => {
    release = resolve;
  });
  const started = new Promise(resolve => {
    entered = resolve;
  });
  let persisted = false;
  const status = {
    jobId,
    commandId,
    generation: 1,
    profileId: 'fixture-profile',
    state: 'ready',
    canRetry: false,
    vector: null,
  };
  registerKnowledge(app, {
    auth: { api: { getSession: async () => ({ user: { id: 'owner' } }) } },
    service: {},
    embeddings: {
      prepareQuery: async () => ({ ...status, state: 'queued' }),
      process: async () => {
        entered();
        await processing;
        persisted = true;
        return { disposition: 'ready' };
      },
      queryStatus: async () => status,
    },
  });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = request(`${origin}/workspaces/${workspaceId}/knowledge/query-embeddings`, {
      method: 'POST',
      headers: { cookie: 'owner', origin: 'http://localhost:5173', 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify({ commandId, query: 'private' }));
    await started;
    const disconnected = new Promise(resolve => client.once('close', resolve));
    client.destroy();
    await disconnected;
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await delay(20);
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(persisted, true);
    assert.equal(closed, true);
  } finally {
    release();
    await app.close();
  }
});

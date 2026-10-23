import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { registerKnowledge } from '../dist/knowledge.js';

test('source failures route lists failed and raw-text items for the source owner only', async () => {
  const workspaceId = randomUUID(),
    sourceId = randomUUID(),
    documentId = randomUUID();
  const body = {
    sourceId,
    syncedAt: '2026-10-16T09:00:00.000Z',
    items: [
      {
        documentId,
        title: 'Quarterly scan.pdf',
        canonicalUrl: 'https://drive.example.test/file',
        status: 'ocr-unavailable',
        reason: 'ocr-required',
        attempts: 1,
        observedAt: '2026-10-16T08:59:00.000Z',
      },
    ],
    truncated: false,
  };
  const calls = [];
  const auth = {
    api: {
      getSession: async ({ headers }) => (headers.get('cookie') ? { user: { id: headers.get('cookie') } } : null),
    },
  };
  const app = Fastify();
  registerKnowledge(app, {
    auth,
    service: {},
    sourceFailures: {
      list: async (workspace, actor, source) => {
        calls.push([workspace, actor, source]);
        if (actor !== 'owner') throw new AccessDenied();
        return body;
      },
    },
  });
  const url = `/workspaces/${workspaceId}/knowledge/sources/${sourceId}/failures`;
  try {
    const response = await app.inject({ url, headers: { cookie: 'owner' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), body);
    assert.deepEqual(calls, [[workspaceId, 'owner', sourceId]]);
    const denied = await app.inject({ url, headers: { cookie: 'member' } });
    assert.equal(denied.statusCode, 404);
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: `/workspaces/${workspaceId}/knowledge/sources/not-a-uuid/failures`,
          headers: { cookie: 'owner' },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
  const disabled = Fastify();
  registerKnowledge(disabled, { auth, service: {} });
  try {
    assert.equal((await disabled.inject({ url, headers: { cookie: 'owner' } })).statusCode, 404);
  } finally {
    await disabled.close();
  }
});

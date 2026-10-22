import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerKnowledgeComposition } from '../dist/knowledge-composition.js';

test('API knowledge startup with empty embedding config installs routes without starting embedding discovery', async () => {
  const app = Fastify();
  const forbidden = () => {
    throw new Error('Disabled embeddings touched a dependency');
  };
  registerKnowledgeComposition(app, {
    env: {},
    runtime: { transaction: forbidden },
    auth: { api: { getSession: async () => null } },
    pool: { query: forbidden, connect: forbidden },
    provider: forbidden,
    temporal: { connection: { withDeadline: forbidden }, client: { workflow: { start: forbidden } } },
  });
  try {
    await app.ready();
    assert.equal(app.hasRoute({ method: 'POST', url: '/workspaces/:workspaceId/knowledge/query-embeddings' }), true);
    const response = await app.inject({ url: '/workspaces/00000000-0000-4000-8000-000000000001/knowledge/documents' });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'sign-in-required' });
  } finally {
    await app.close();
  }
});

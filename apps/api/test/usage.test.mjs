import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { canonicalModels, registerUsage } from '../src/usage.ts';

test('one model groups under one id however it was paid and whichever route served it', () => {
  for (const env of [
    { OPENAI_API_KEY: 'synthetic' },
    { AZURE_FOUNDRY_API_KEY: 'synthetic', AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/' },
  ]) {
    const canonical = canonicalModels(env);
    for (const id of ['gpt-6-sol', 'gpt-6-sol-openai', 'gpt-6-sol-azure', 'chatgpt-gpt-6-sol'])
      assert.equal(canonical(id), canonical('gpt-sol'), id);
    assert.equal(canonical('claude-plan-sonnet'), canonical('claude-sonnet'));
    assert.equal(canonical('copilot-claude-haiku-4--5'), canonical('claude-haiku'));
    assert.notEqual(canonical('claude-haiku'), canonical('claude-sonnet'));
    assert.equal(canonical('a-model-no-catalog-knows'), 'a-model-no-catalog-knows');
  }
});

test('the usage route signs in, validates its query and hides workspaces', async t => {
  let failure;
  const transactions = [];
  const app = Fastify();
  registerUsage(app, {
    auth: { api: { getSession: async ({ headers }) => (headers.get('cookie') ? { user: { id: 'reader' } } : null) } },
    runtime: {
      transaction: async workspaceId => {
        transactions.push(workspaceId);
        throw failure;
      },
    },
    planUsage: { premiumRequests: async () => null },
  });
  t.after(() => app.close());
  const workspaceId = randomUUID();
  const from = '2026-01-01T00:00:00Z';
  const read = (query, cookie = 'reader') =>
    app.inject({
      url: `/workspaces/${workspaceId}/usage?${new URLSearchParams({ from, to: '2026-01-31T00:00:00Z', group: 'model', ...query })}`,
      headers: cookie ? { cookie } : {},
    });

  assert.equal((await read({}, null)).statusCode, 401);
  for (const query of [
    { group: 'model,paidBy,member' },
    { group: 'model,model' },
    { group: 'cost' },
    { filters: '{"model":' },
    { filters: JSON.stringify({ day: ['2026-01-01'] }) },
    { to: from },
    { to: '2027-06-01T00:00:00Z' },
  ]) {
    const response = await read(query);
    assert.equal(response.statusCode, 400, JSON.stringify(query));
    assert.deepEqual(response.json(), { error: 'invalid-usage-query' });
  }
  assert.deepEqual(transactions, [], 'nothing invalid reaches the workspace');

  failure = new AccessDenied();
  const response = await read({ group: 'model,paidBy', filters: JSON.stringify({ paidBy: ['plan'] }) });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  failure = new StorageUnavailableError('queue_full');
  assert.equal((await read({})).statusCode, 503);
  assert.deepEqual(transactions, [workspaceId, workspaceId]);
});

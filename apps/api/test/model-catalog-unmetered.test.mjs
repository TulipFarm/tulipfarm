import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MODEL_CATALOG_FILE = fileURLToPath(
  new URL('../../../packages/config/test/fixtures/model-catalog-unmetered.json', import.meta.url),
);
delete process.env.MODEL_CATALOG;

const Fastify = (await import('fastify')).default;
const { createMemoryRouteHealth } = await import('@tulipfarm/agents/chat');
const { calculateModelCost, usageTokenCounts } = await import('@tulipfarm/config');
const { creditGate, unlimitedCredits } = await import('@tulipfarm/extensions');
const { reserveCredits, settleCredits } = await import('@tulipfarm/workspace-storage/credits');
const { commonCompatibility } = await import('@tulipfarm/workspace-storage/runtime');
const { modelCatalogSchema } = await import('../../../packages/config/src/model-catalog.ts');
const { registerModelCatalog } = await import('../src/model-catalog.ts');
const { createModelConfiguration } = await import('../src/model-configuration.ts');
const { modelEnvironment } = await import('../src/model-environment.ts');

const workspaceId = '11111111-1111-4111-8111-111111111111';
const env = {
  MODEL_CATALOG_FILE: process.env.MODEL_CATALOG_FILE,
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
  AZURE_FOUNDRY_API_KEY: 'synthetic-private-credential',
};

test('the workspace catalog lists an unmetered family as available with no credit rates', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const pool = {
    query: async () => {
      throw new Error('configuration must not query the database');
    },
  };
  const runtime = {
    async transaction(_id, _compatibility, operation) {
      return operation({
        schema: 'catalog_test',
        client: {
          async query(sql) {
            if (sql.includes('tf_model_availability')) return { rows: [], rowCount: 0 };
            if (sql.includes('tf_authorization_lock')) return { rows: [{ id: 1 }], rowCount: 1 };
            return {
              rows: [{ id: '33333333-3333-4333-8333-333333333333', user_id: 'user', role: 'member' }],
              rowCount: 1,
            };
          },
        },
      });
    },
  };
  app.register(
    async routes =>
      registerModelCatalog(routes, {
        auth: { api: { getSession: async () => ({ user: { id: 'user' } }) } },
        runtime,
        compatibility: commonCompatibility,
        modelCatalogSnapshot: createModelConfiguration({ pool, env }).modelCatalogSnapshot,
      }),
    { prefix: '/v1' },
  );
  const response = await app.inject({
    url: `/v1/workspaces/${workspaceId}/model-catalog`,
    headers: { cookie: 'session=test' },
  });
  assert.equal(response.statusCode, 200);
  const families = modelCatalogSchema.parse(response.json()).families;
  const local = families.find(family => family.id === 'local-chat');
  assert.equal(local.available, true);
  assert.equal(local.currentVersion, 'local-chat-1');
  assert.equal(local.inputCreditsPerMillionTokens, null);
  assert.equal(local.outputCreditsPerMillionTokens, null);
  const metered = families.find(family => family.id === 'metered-chat');
  assert.equal(typeof metered.inputCreditsPerMillionTokens, 'number', 'metered families keep their rates');
  assert.equal(typeof metered.outputCreditsPerMillionTokens, 'number');
});

// The credit meter tables of one workspace, enough for reserveCredits and settleCredits.
function meter() {
  const usage = new Map();
  const client = {
    async query(sql, values = []) {
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM')) return { rows: [], rowCount: usage.has(values[0]) ? 1 : 0 };
      if (sql.startsWith('INSERT INTO')) {
        const [id, flow_id, model_id, agent_id, activity, reserved] = values;
        usage.set(id, { flow_id, model_id, agent_id, activity, reserved, charged: null, provider_pico_usd: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT flow_id')) return { rows: [usage.get(values[0])], rowCount: 1 };
      if (sql.includes('COALESCE(sum(provider_pico_usd)')) return { rows: [{ cost: '0', charged: '0' }], rowCount: 1 };
      if (sql.startsWith('UPDATE')) {
        Object.assign(usage.get(values[0]), { charged: values[1], provider_pico_usd: values[2] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { tx: { client, schema: 'workspace' }, usage };
}

test('an unmetered task turn runs under the default unlimited credits and records its tokens at zero cost', async t => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'Local-Chat-1',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Local answer.' } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) =>
    originalFetch(
      `http://127.0.0.1:${server.address().port}/${String(url).slice(env.AZURE_FOUNDRY_ENDPOINT.length)}`,
      options,
    ),
  );
  assert.equal(creditGate(), unlimitedCredits);
  const environment = modelEnvironment(env);
  const continuity = environment.continuity(createMemoryRouteHealth);
  const resolution = environment.resolve('local-chat');
  assert.equal(resolution.modelId, 'local-chat-1');
  assert.equal(continuity.allowed(workspaceId, resolution), true);
  const result = await continuity.infer(
    resolution,
    {
      prompt: 'Local proof',
      definition: { name: 'Local agent', instructions: 'Return an answer.', tools: [] },
      scope: [],
    },
    10_000,
  );
  assert.equal(result.kind, 'success');
  assert.equal(result.usage.kind, 'known');
  const { kind, ...tokens } = result.usage;
  const cost = calculateModelCost({
    resolution,
    usage: { kind, tokens },
    date: '2026-10-19',
    trustedBundle: continuity.trustedBundle(environment.bundle.id),
  });
  assert.equal(cost.providerPicoUsd, '0');
  assert.deepEqual(usageTokenCounts(tokens), { inputTokens: 1200, outputTokens: 300 });
  const { tx, usage } = meter();
  const attempt = {
    id: 'attempt',
    flowId: 'flow',
    modelId: resolution.modelId,
    agentId: null,
    activity: 'agent',
    providerPicoUsd: '0',
    pricingRevision: resolution.pricingRevision,
  };
  assert.equal(await reserveCredits(tx, attempt), true);
  const settled = await settleCredits(tx, attempt.id, cost.providerPicoUsd);
  assert.equal(settled.providerPicoUsd, '0');
  assert.deepEqual(usage.get(attempt.id), {
    flow_id: 'flow',
    model_id: 'local-chat-1',
    agent_id: null,
    activity: 'agent',
    reserved: '0',
    charged: '0',
    provider_pico_usd: '0',
  });
});

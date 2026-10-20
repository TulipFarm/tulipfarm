import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = name => fileURLToPath(new URL(`../../../packages/config/test/fixtures/${name}`, import.meta.url));
process.env.MODEL_CATALOG_FILE = fixture(process.env.TEST_MODEL_CATALOG_FIXTURE ?? 'model-catalog-extend.json');
process.env.MODEL_CATALOG_MODE = process.env.TEST_MODEL_CATALOG_MODE ?? 'extend';

const Fastify = (await import('fastify')).default;
const { createMemoryRouteHealth } = await import('@tulipfarm/agents/chat');
const { commonCompatibility } = await import('@tulipfarm/workspace-storage/runtime');
const { modelCatalogSchema } = await import('../../../packages/config/src/model-catalog.ts');
const { registerModelCatalog } = await import('../src/model-catalog.ts');
const { createModelConfiguration } = await import('../src/model-configuration.ts');
const { modelEnvironment } = await import('../src/model-environment.ts');

const workspaceId = '11111111-1111-4111-8111-111111111111';
const credential = 'synthetic-private-credential';
const env = {
  MODEL_FAMILIES: 'acme-chat, gpt-luna',
  MODEL_DEFAULT_FAMILY: 'acme-chat',
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
  AZURE_FOUNDRY_API_KEY: credential,
};
const pool = {
  query: async () => {
    throw new Error('configuration must not query the database');
  },
};

async function catalog(t, configuration) {
  const app = Fastify();
  t.after(() => app.close());
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
        modelCatalogSnapshot: configuration.modelCatalogSnapshot,
      }),
    { prefix: '/v1' },
  );
  const response = await app.inject({
    url: `/v1/workspaces/${workspaceId}/model-catalog`,
    headers: { cookie: 'session=test' },
  });
  assert.equal(response.statusCode, 200);
  return modelCatalogSchema.parse(response.json()).families;
}

test('a family added by MODEL_CATALOG_FILE is listed and available in the workspace model catalog', async t => {
  const families = await catalog(t, createModelConfiguration({ pool, env }));
  const acme = families.find(family => family.id === 'acme-chat');
  assert.deepEqual(
    { ...acme, mappingRevision: undefined, pricingRevision: undefined },
    {
      id: 'acme-chat',
      displayName: 'Acme Chat',
      vendor: 'acme',
      currentVersion: 'acme-chat-1',
      provider: 'azure',
      available: true,
      unavailableReason: null,
      inputCreditsPerMillionTokens: 50,
      outputCreditsPerMillionTokens: 150,
      fallbackFor: ['gpt-luna'],
      mappingRevision: undefined,
      pricingRevision: undefined,
    },
  );
  assert.match(acme.pricingRevision, /^prices-[0-9a-f]{32}$/);
  assert.equal(families.find(family => family.id === 'claude-haiku').displayName, 'Claude Haiku (operator)');
  assert.equal(families.find(family => family.id === 'claude-haiku').available, false);
  assert.equal(families.length, 16);
});

test('a task turn on the operator family uses its declared capabilities and is priced from the file', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'Acme-Chat-1-2026-10-01',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Acme answer.' }] }],
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          total_tokens: 2000,
          input_tokens_details: { cached_tokens: 0 },
        },
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
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(String(url).startsWith(env.AZURE_FOUNDRY_ENDPOINT), true);
    return originalFetch(
      `http://127.0.0.1:${server.address().port}/${String(url).slice(env.AZURE_FOUNDRY_ENDPOINT.length)}`,
      options,
    );
  });
  const { calculateModelCost } = await import('@tulipfarm/config');
  const environment = modelEnvironment(env);
  const continuity = environment.continuity(createMemoryRouteHealth);
  assert.equal(continuity.legacyFamily(), 'acme-chat');
  const resolution = environment.resolve(continuity.legacyFamily());
  assert.equal(resolution.modelId, 'acme-chat-1');
  assert.equal(continuity.allowed(workspaceId, resolution), true);
  const result = await continuity.infer(
    resolution,
    {
      prompt: 'Local proof',
      definition: { name: 'Acme agent', instructions: 'Return an answer.', tools: [] },
      scope: [],
    },
    10_000,
  );
  assert.equal(result.kind, 'success');
  assert.ok(continuity.actualModelIds(resolution).includes(result.actualModel));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/openai/v1/responses', 'the file family declares the Responses API');
  assert.equal(requests[0].body.model, 'Acme-Chat-1');
  assert.equal(result.actualModel, 'Acme-Chat-1-2026-10-01', 'the declared response alias is accepted');
  assert.equal(requests[0].headers['api-key'], credential);
  const cost = calculateModelCost({
    resolution,
    date: '2026-10-19',
    usage: {
      kind: 'known',
      tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
  });
  assert.equal(cost.providerPicoUsd, '2000000000');
});

test(
  'in replace mode only the file families exist',
  { skip: process.env.TEST_MODEL_CATALOG_MODE === 'replace' },
  () => {
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern=replace mode lists', fileURLToPath(import.meta.url)],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          TEST_MODEL_CATALOG_FIXTURE: 'model-catalog-replace.json',
          TEST_MODEL_CATALOG_MODE: 'replace',
        },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 1\b/);
  },
);

test(
  'replace mode lists only the operator families',
  { skip: process.env.TEST_MODEL_CATALOG_MODE !== 'replace' },
  async t => {
    const families = await catalog(t, createModelConfiguration({ pool, env: { ...env, MODEL_FAMILIES: 'acme-chat' } }));
    assert.deepEqual(
      families.map(family => [family.id, family.available]),
      [['acme-chat', true]],
    );
    assert.throws(
      () => modelEnvironment(env),
      { message: 'Invalid server model configuration' },
      'shipped families are gone',
    );
  },
);

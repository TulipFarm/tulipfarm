import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = name => fileURLToPath(new URL(`../../../packages/config/test/fixtures/${name}`, import.meta.url));
process.env.MODEL_CATALOG_FILE = fixture('model-catalog-acme.json');

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
  MODEL_CATALOG_FILE: process.env.MODEL_CATALOG_FILE,
  ANTHROPIC_API_KEY: credential,
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
  return modelCatalogSchema.parse(response.json());
}

test('MODEL_CATALOG_FILE replaces the shipped catalog in the workspace model catalog', async t => {
  const { families, defaultChatFamilyId } = await catalog(t, createModelConfiguration({ pool, env }));
  assert.equal(defaultChatFamilyId, 'acme-chat');
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
      imageInput: false,
      imageModelId: null,
      fallbackFor: ['claude-haiku'],
      mappingRevision: undefined,
      pricingRevision: undefined,
    },
  );
  assert.match(acme.pricingRevision, /^prices-[0-9a-f]{32}$/);
  assert.equal(families.find(family => family.id === 'claude-haiku').displayName, 'Claude Haiku (operator)');
  assert.deepEqual(
    families.map(family => [family.id, family.available]),
    [
      ['acme-chat', true],
      ['claude-haiku', true],
    ],
    'shipped models are gone',
  );
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
  assert.equal(continuity.defaultFamily(), 'acme-chat');
  const resolution = environment.resolve(continuity.defaultFamily());
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
    trustedBundle: environment.bundle,
    date: '2026-10-19',
    usage: {
      kind: 'known',
      tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
  });
  assert.equal(cost.providerPicoUsd, '2000000000');
});

test('models without a key are left out, and the catalog never offers non-selectable models', async t => {
  const { AZURE_FOUNDRY_API_KEY: _, ...anthropicOnly } = env;
  const skipped = await catalog(t, createModelConfiguration({ pool, env: anthropicOnly }));
  assert.deepEqual(
    skipped.families.map(family => family.id),
    ['claude-haiku'],
  );
  assert.equal(skipped.defaultChatFamilyId, 'claude-haiku', 'the skipped default passes to the next model');

  const file = JSON.parse(readFileSync(env.MODEL_CATALOG_FILE, 'utf8'));
  file.models[1] = { ...file.models[1], selectable: false, roles: ['title'] };
  const inline = { ...env, MODEL_CATALOG_FILE: undefined, MODEL_CATALOG: JSON.stringify(file) };
  const configuration = createModelConfiguration({ pool, env: inline });
  const hidden = await catalog(t, configuration);
  assert.deepEqual(
    hidden.families.map(family => family.id),
    ['acme-chat'],
  );
  assert.deepEqual(hidden.families[0].fallbackFor, []);
  const snapshot = await configuration.modelCatalogSnapshot(workspaceId);
  const haiku = { workspaceId, modelFamilyId: 'claude-haiku' };
  assert.equal(snapshot.modelFamilyEligibility(haiku), false, 'not choosable for new chats or agents');
  assert.equal(snapshot.modelFamilyEligibility({ ...haiku, existing: true }), true, 'existing chats keep it');
  assert.equal(modelEnvironment(inline).catalog.role('title').id, 'claude-haiku');
});

test('the catalog lists image models with availability and credits, and pairs models that read images', async t => {
  const file = JSON.parse(readFileSync(env.MODEL_CATALOG_FILE, 'utf8'));
  const aspects = { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' };
  file.models[0] = {
    ...file.models[0],
    capabilities: { ...file.models[0].capabilities, imageInput: true },
    imageModel: 'acme-image',
  };
  file.imageModels = [
    {
      id: 'acme-image',
      name: 'Acme Image',
      vendor: 'acme',
      default: true,
      edits: true,
      maxSources: 4,
      routes: [{ provider: 'azure', model: 'acme-image-1', api: 'openai-images' }],
      aspects,
      pricing: {
        usdPerImage: {
          standard: { square: 0.04, portrait: 0.06, landscape: 0.06 },
          high: { square: 0.17, portrait: 0.25, landscape: 0.25 },
        },
      },
    },
    {
      id: 'acme-sketch',
      name: 'Acme Sketch',
      vendor: 'acme',
      paused: true,
      routes: [{ provider: 'azure', model: 'acme-sketch-1', api: 'openai-images' }],
      aspects,
      pricing: [{ usdPerMillionTokens: { input: 5, output: 40 } }],
    },
    {
      id: 'grok-image',
      name: 'Grok Image',
      vendor: 'xai',
      routes: [{ provider: 'xai', model: 'grok-2-image', api: 'xai-images' }],
      aspects,
      pricing: 'unmetered',
    },
  ];
  const inline = { ...env, MODEL_CATALOG_FILE: undefined, MODEL_CATALOG: JSON.stringify(file) };
  const { families, imageModels } = await catalog(t, createModelConfiguration({ pool, env: inline }));
  const acme = families.find(family => family.id === 'acme-chat');
  assert.deepEqual([acme.imageInput, acme.imageModelId], [true, 'acme-image']);
  const haiku = families.find(family => family.id === 'claude-haiku');
  assert.deepEqual([haiku.imageInput, haiku.imageModelId], [false, null], 'only a declared capability reads images');
  assert.deepEqual(imageModels, [
    {
      id: 'acme-image',
      displayName: 'Acme Image',
      vendor: 'acme',
      provider: 'azure',
      edits: true,
      available: true,
      unavailableReason: null,
      creditsPerImage: {
        standard: { square: 4, portrait: 6, landscape: 6 },
        high: { square: 17, portrait: 25, landscape: 25 },
      },
      outputCreditsPerMillionTokens: null,
    },
    {
      id: 'acme-sketch',
      displayName: 'Acme Sketch',
      vendor: 'acme',
      provider: 'azure',
      edits: false,
      available: false,
      unavailableReason: 'image-model-paused',
      creditsPerImage: null,
      outputCreditsPerMillionTokens: 4000,
    },
    {
      id: 'grok-image',
      displayName: 'Grok Image',
      vendor: 'xai',
      provider: 'xai',
      edits: false,
      available: false,
      unavailableReason: 'image-model-unavailable',
      creditsPerImage: null,
      outputCreditsPerMillionTokens: null,
    },
  ]);
});

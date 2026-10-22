import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// An operator catalog of only OpenAI-model families on the Azure route, replacing the shipped catalog. Its models
// declare every role except compaction.
const catalogFile = fileURLToPath(
  new URL('../../../packages/config/test/fixtures/model-catalog-openai-only.json', import.meta.url),
);
const env = {
  MODEL_CATALOG_FILE: catalogFile,
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
  AZURE_FOUNDRY_API_KEY: 'synthetic-key',
};
Object.assign(process.env, env);
delete process.env.MODEL_CATALOG;

const Fastify = (await import('fastify')).default;
const { loadModelCatalog } = await import('@tulipfarm/config');
const { commonCompatibility } = await import('@tulipfarm/workspace-storage/runtime');
const { modelCatalogSchema } = await import('../../../packages/config/src/model-catalog.ts');
const { registerModelCatalog } = await import('../src/model-catalog.ts');
const { createModelConfiguration } = await import('../src/model-configuration.ts');
const { registerConversations } = await import('../src/conversations.ts');
const { guideBudget, guideLimits } = await import('../src/public-guide-config.ts');
const { publicGuideModel, publicGuideWarnings } = await import('../src/public-guide-model.ts');

test('the workspace catalog reports the default model the web picks first', async t => {
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
            return { rows: [{ id: randomUUID(), user_id: 'user', role: 'member' }], rowCount: 1 };
          },
        },
      });
    },
  };
  const pool = { query: async () => assert.fail('configuration must not query the database') };
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
    url: `/v1/workspaces/${randomUUID()}/model-catalog`,
    headers: { cookie: 'session=test' },
  });
  assert.equal(response.statusCode, 200);
  const catalog = modelCatalogSchema.parse(response.json());
  assert.equal(catalog.defaultChatFamilyId, 'openai-main');
  assert.deepEqual(
    catalog.families.map(family => [family.id, family.available]),
    [
      ['openai-mini', true],
      ['openai-main', true],
    ],
  );
});

test('a message without a model uses the default model', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const sent = [];
  registerConversations(app, {
    auth: { api: { getSession: async () => ({ user: { id: 'user', emailVerified: true } }) } },
    service: {
      send: async (_workspace, _user, _chat, input) => {
        sent.push(input);
        return { messageId: input.messageId, turnId: randomUUID(), sequence: 1 };
      },
    },
  });
  const response = await app.inject({
    method: 'PUT',
    url: `/workspaces/${randomUUID()}/conversations/${randomUUID()}/messages/${randomUUID()}`,
    payload: { commandId: randomUUID(), parts: [{ kind: 'text', text: 'Hello' }] },
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(sent[0].model, 'openai-main');
});

test('the public guide answers with the public-guide role, priced from the effective catalog', async () => {
  const requests = [];
  const model = publicGuideModel(env, async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    return body.stream
      ? new Response(
          `data: ${JSON.stringify({ model: 'gpt-6-luna', choices: [{ index: 0, delta: { content: 'TulipFarm organizes work.' } }] })}\n\n` +
            `data: ${JSON.stringify({ model: 'gpt-6-luna', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
            'data: [DONE]\n\n',
        )
      : Response.json({
          model: 'gpt-6-luna-2026-09-22',
          choices: [{ finish_reason: 'stop', message: { content: '{"topic":"overview"}' } }],
        });
  });
  const parts = [];
  assert.deepEqual(await model([], 'What is TulipFarm?', text => parts.push(text), new AbortController().signal), {
    signup: false,
  });
  assert.equal(parts.join(''), 'TulipFarm organizes work.');
  assert.deepEqual(
    requests.map(request => [request.url, request.body.model]),
    [
      [`${env.AZURE_FOUNDRY_ENDPOINT}openai/v1/chat/completions`, 'gpt-6-luna'],
      [`${env.AZURE_FOUNDRY_ENDPOINT}openai/v1/chat/completions`, 'gpt-6-luna'],
    ],
  );
  const { rates } = loadModelCatalog(env).model('openai-mini');
  const { turnMicroUsd, dailyTurns } = guideBudget(env);
  assert.equal(
    turnMicroUsd,
    Math.ceil(
      2 * (guideLimits.modelInputBytes + 1024) * Math.max(...rates.map(rate => rate.usdPerMillionTokens.input)) +
        (guideLimits.outputTokens + guideLimits.classifierTokens) *
          Math.max(...rates.map(rate => rate.usdPerMillionTokens.output)),
    ),
  );
  assert.ok(dailyTurns > 0);
  assert.deepEqual(publicGuideWarnings(env), []);
});

test('api startup warns about models left out for missing keys and a moved default', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      AZURE_FOUNDRY_ENDPOINT: env.AZURE_FOUNDRY_ENDPOINT,
      AZURE_FOUNDRY_API_KEY: env.AZURE_FOUNDRY_API_KEY,
      PORT: '0',
    },
  });
  const warnings = result.stderr
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .filter(entry => entry.level === 'warn');
  assert.deepEqual(warnings, [
    {
      level: 'warn',
      msg: 'Models without a provider key are not served: claude-haiku, claude-sonnet, claude-opus, claude-fable, gemini-flash, gemini-pro.',
    },
    { level: 'warn', msg: 'The default model claude-sonnet is not served; gpt-luna is the default.' },
  ]);
});

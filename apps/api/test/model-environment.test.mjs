import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMemoryRouteHealth } from '@tulipfarm/agents/chat';
import { inferDecision } from '@tulipfarm/agents/inference';
import { modelBundleStore } from '@tulipfarm/agents/model-bundles';
import { modelEnvironment } from '../src/model-environment.ts';

const credential = 'synthetic-private-credential';
const azure = {
  MODEL_FAMILIES: 'gpt-luna, gpt-sol',
  MODEL_DEFAULT_FAMILY: 'gpt-luna',
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
  AZURE_FOUNDRY_API_KEY: credential,
};
const invalid = { message: 'Invalid server model configuration' };
const input = {
  prompt: 'Local proof',
  definition: { name: 'Local agent', instructions: 'Return an answer.', tools: [] },
  scope: [],
};

test('empty configuration disables models', () => {
  assert.equal(modelEnvironment({}), null);
  assert.equal(modelEnvironment({ MODEL_FAMILIES: ' , ' }), null);
});

test('listed families resolve to their pricing deployment and nothing else', () => {
  const environment = modelEnvironment(azure);
  const luna = environment.resolve('gpt-luna');
  assert.equal(luna.modelId, 'gpt-6-luna');
  assert.equal(luna.route.deployment, 'gpt-6-luna');
  assert.equal(luna.pricingRevision, environment.bundle.mapping.pricingRevision);
  assert.equal(environment.resolve('gpt-astra'), null);
  assert.equal(environment.resolve('claude-opus'), null);
  assert.equal(environment.route('gpt-sol').model, 'gpt-6-sol');
  assert.equal(environment.route('gpt-astra'), null);
  assert.equal(environment.inference({ ...luna, route: { ...luna.route, deployment: 'other' } }), null);
  assert.equal(modelEnvironment(azure).bundle.id, environment.bundle.id);
  assert.notEqual(modelEnvironment({ ...azure, MODEL_FAMILIES: 'gpt-luna' }).bundle.id, environment.bundle.id);
  assert.equal(JSON.stringify(environment.bundle).includes(credential), false);
  const binding = environment.inference(luna);
  assert.throws(() => {
    binding.endpoint = 'https://evil.example/';
  }, TypeError);
  assert.throws(() => {
    binding.auth.value = 'other';
  }, TypeError);
});

test('continuity binds the configured default, budget and dated identities', () => {
  const environment = modelEnvironment(azure);
  const continuity = environment.continuity(createMemoryRouteHealth);
  const luna = environment.resolve('gpt-luna');
  assert.equal(continuity.activeBundle().bundle.id, environment.bundle.id);
  assert.equal(continuity.trustedBundle(environment.bundle.id), environment.bundle);
  assert.throws(() => continuity.trustedBundle('other'), { message: 'Model configuration changed' });
  assert.equal(continuity.legacyFamily(), 'gpt-luna');
  assert.equal(continuity.allowed('any-workspace', luna), true);
  assert.deepEqual(continuity.actualModelIds(luna), ['gpt-6-luna']);
  assert.equal(
    modelEnvironment({ ...azure, MODEL_DEFAULT_FAMILY: '' })
      .continuity(createMemoryRouteHealth)
      .legacyFamily(),
    undefined,
  );
});

test('continuity finishes runs bound to an earlier configuration only through verified stored bundles', async () => {
  const earlier = modelEnvironment({ ...azure, MODEL_FAMILIES: 'gpt-luna' });
  const environment = modelEnvironment(azure);
  const rows = new Map();
  const queries = [];
  const db = {
    query: async (sql, params) => {
      queries.push(sql);
      if (sql.includes('register_model_bundle')) {
        if (!rows.has(params[0])) rows.set(params[0], JSON.parse(params[1]));
        return { rows: [] };
      }
      return { rows: [{ payload: rows.get(params[0]) ?? null }] };
    },
  };
  const store = modelBundleStore(db);
  await store.register(earlier.bundle);
  const continuity = environment.continuity(createMemoryRouteHealth, store);
  assert.equal(continuity.trustedBundle(environment.bundle.id), environment.bundle);
  assert.equal(queries.length, 1);
  assert.deepEqual(await continuity.trustedBundle(earlier.bundle.id), earlier.bundle);
  await continuity.trustedBundle(earlier.bundle.id);
  assert.equal(queries.length, 2);
  await assert.rejects(async () => continuity.trustedBundle(`server-${'0'.repeat(64)}`), {
    message: 'Model configuration changed',
  });
  const forged = structuredClone(earlier.bundle);
  forged.models[0].rates[0].usdPerMillionTokens.input = 0;
  rows.set(earlier.bundle.id, forged);
  await assert.rejects(
    async () => modelBundleStore(db).read(earlier.bundle.id),
    /Untrusted model bundle|Initial pricing is immutable/,
  );
  const rerouted = structuredClone(earlier.bundle);
  rerouted.routes[0].maxOutputTokens -= 1;
  rows.set(earlier.bundle.id, rerouted);
  await assert.rejects(async () => modelBundleStore(db).read(earlier.bundle.id), { message: 'Untrusted model bundle' });
});

test('Haiku accepts the exact dated identity returned by Anthropic', () => {
  const environment = modelEnvironment({ MODEL_FAMILIES: 'claude-haiku', ANTHROPIC_API_KEY: credential });
  assert.deepEqual(
    environment.continuity(createMemoryRouteHealth).actualModelIds(environment.resolve('claude-haiku')),
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  );
});

test('invalid configuration fails at startup without leaking values', () => {
  for (const env of [
    { ...azure, MODEL_FAMILIES: 'gpt-luna,unknown' },
    { ...azure, MODEL_FAMILIES: 'gpt-luna,gpt-luna' },
    { ...azure, AZURE_FOUNDRY_API_KEY: '' },
    { ...azure, AZURE_FOUNDRY_API_KEY: 'bad\nvalue' },
    { ...azure, AZURE_FOUNDRY_ENDPOINT: undefined },
    { ...azure, AZURE_FOUNDRY_ENDPOINT: 'https://evil.example/' },
    { ...azure, MODEL_DEFAULT_FAMILY: 'gpt-astra' },
    { MODEL_FAMILIES: 'claude-opus' },
    { MODEL_FAMILIES: 'gemini-flash' },
    { MODEL_FAMILIES: 'gpt-luna', OPENAI_API_KEY: 'bad\nvalue' },
    { MODEL_FAMILIES: 'grok', XAI_API_KEY: '' },
    { PUBLIC_OPENAI_API_KEY: credential, OPENAI_API_KEY: credential },
    { NEXT_PUBLIC_XAI_API_KEY: credential, XAI_API_KEY: credential },
    { ...azure, VITE_AZURE_FOUNDRY_API_KEY: credential },
  ]) {
    assert.throws(
      () => modelEnvironment(env),
      error => error.message === invalid.message && !String(error.stack).includes(credential),
    );
  }
});

test('memory route health cools down one deployment per process', async () => {
  const health = createMemoryRouteHealth(() => 'deployment');
  const luna = modelEnvironment(azure).resolve('gpt-luna');
  const lease = new Date(Date.now() + 60_000);
  assert.equal(await health.claim(luna, 'attempt-1', lease), true);
  await health.finish(luna, 'attempt-1', 'overload', 60_000);
  assert.equal(await health.claim(luna, 'attempt-2', lease), false);
  assert.equal(await createMemoryRouteHealth(() => 'deployment').claim(luna, 'attempt-3', lease), true);
  await health.finish(luna, 'attempt-4', null, null);
  assert.equal(await health.claim(luna, 'attempt-5', lease), true);
});

test('Azure binding sends the API key to the real adapter over local HTTP', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'gpt-6-luna-2026-09-22',
        choices: [{ finish_reason: 'stop', message: { content: 'Local answer.' } }],
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
  const path = 'openai/v1/chat/completions';
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(String(url), `${azure.AZURE_FOUNDRY_ENDPOINT}${path}`);
    return originalFetch(`http://127.0.0.1:${server.address().port}/${path}`, options);
  });
  const environment = modelEnvironment(azure);
  const result = await inferDecision(environment.inference(environment.resolve('gpt-luna')), input);
  assert.equal(result.kind, 'success');
  assert.equal(result.actualModel, 'gpt-6-luna-2026-09-22');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['api-key'], credential);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].body.model, 'gpt-6-luna');
});

function endpointHosts(t, hosts, nodeEnv = process.env.NODE_ENV) {
  const saved = { MODEL_ENDPOINT_HOSTS: process.env.MODEL_ENDPOINT_HOSTS, NODE_ENV: process.env.NODE_ENV };
  process.env.MODEL_ENDPOINT_HOSTS = hosts;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}

test('unset base URLs keep the built-in provider endpoints', () => {
  const environment = modelEnvironment({
    MODEL_FAMILIES: 'claude-haiku,gpt-luna,grok,gemini-flash',
    ANTHROPIC_API_KEY: credential,
    OPENAI_API_KEY: credential,
    XAI_API_KEY: credential,
    GEMINI_API_KEY: credential,
    ANTHROPIC_BASE_URL: ' ',
  });
  assert.deepEqual(
    ['claude-haiku', 'gpt-luna', 'grok', 'gemini-flash'].map(
      family => environment.inference(environment.resolve(family)).endpoint,
    ),
    [
      'https://api.anthropic.com/',
      'https://api.openai.com/',
      'https://api.x.ai/',
      'https://generativelanguage.googleapis.com/',
    ],
  );
});

test('provider base URLs replace the built-in endpoints in requests', async t => {
  endpointHosts(t, 'gateway.example.com');
  const environment = modelEnvironment({
    MODEL_FAMILIES: 'claude-haiku,gpt-luna,grok,gemini-flash',
    MODEL_ENDPOINT_HOSTS: 'gateway.example.com',
    ANTHROPIC_API_KEY: credential,
    OPENAI_API_KEY: credential,
    XAI_API_KEY: credential,
    GEMINI_API_KEY: credential,
    ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic',
    OPENAI_BASE_URL: 'https://gateway.example.com/openai/v1',
    XAI_BASE_URL: 'https://gateway.example.com',
    GEMINI_BASE_URL: 'https://gateway.example.com/google/',
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requested.push(String(url));
    return new Response('{}', { status: 400 });
  });
  for (const family of ['claude-haiku', 'gpt-luna', 'grok', 'gemini-flash'])
    await inferDecision(environment.inference(environment.resolve(family)), input).catch(() => null);
  const [anthropic, openai, xai, google] = ['anthropic/', 'openai/v1/', 'v1/', 'google/'].map(
    prefix => `https://gateway.example.com/${prefix}`,
  );
  assert.ok(
    requested.some(url => url === `${anthropic}v1/messages`),
    JSON.stringify(requested),
  );
  assert.ok(
    requested.some(url => /^https:\/\/gateway\.example\.com\/openai\/v1\/(chat\/completions|responses)$/.test(url)),
  );
  assert.ok(requested.some(url => url.startsWith(xai) && /\/(chat\/completions|responses)$/.test(url)));
  assert.ok(
    requested.some(url => url.startsWith(`${google}v1beta/models/`)),
    JSON.stringify(requested),
  );
  assert.equal(requested.filter(url => !url.startsWith('https://gateway.example.com/')).length, 0);
  assert.equal(environment.inference(environment.resolve('grok')).endpoint, 'https://gateway.example.com/');
  assert.equal(environment.inference(environment.resolve('gpt-luna')).endpoint, openai);
});

test('unsafe base URLs fail at startup naming the variable, never the credential', t => {
  endpointHosts(t, 'gateway.example.com,localhost');
  const haiku = { MODEL_FAMILIES: 'claude-haiku', ANTHROPIC_API_KEY: credential };
  for (const [env, message] of [
    [
      { ANTHROPIC_BASE_URL: 'https://evil.example.com/' },
      'ANTHROPIC_BASE_URL host evil.example.com is not in MODEL_ENDPOINT_HOSTS',
    ],
    [
      { ANTHROPIC_BASE_URL: 'https://gateway.example.com.evil.test/', MODEL_ENDPOINT_HOSTS: 'gateway.example.com' },
      'ANTHROPIC_BASE_URL host gateway.example.com.evil.test is not in MODEL_ENDPOINT_HOSTS',
    ],
    [
      {
        ANTHROPIC_BASE_URL: `https://user:${credential}@gateway.example.com/`,
        MODEL_ENDPOINT_HOSTS: 'gateway.example.com',
      },
      'ANTHROPIC_BASE_URL must not contain credentials',
    ],
    [
      { ANTHROPIC_BASE_URL: 'http://gateway.example.com/', MODEL_ENDPOINT_HOSTS: 'gateway.example.com' },
      'ANTHROPIC_BASE_URL must use https (http is allowed only for localhost)',
    ],
    [
      { ANTHROPIC_BASE_URL: 'http://localhost:4000/', MODEL_ENDPOINT_HOSTS: 'localhost', NODE_ENV: 'production' },
      'ANTHROPIC_BASE_URL must use https in production',
    ],
    [
      { ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1', MODEL_ENDPOINT_HOSTS: 'gateway.example.com' },
      'ANTHROPIC_BASE_URL must not end in /v1/; it is appended',
    ],
    [
      { GEMINI_BASE_URL: 'https://gateway.example.com/v1beta/', MODEL_ENDPOINT_HOSTS: 'gateway.example.com' },
      'GEMINI_BASE_URL must not end in /v1beta/; it is appended',
    ],
    [{ OPENAI_BASE_URL: 'https://gateway.example.com/?key=x' }, 'OPENAI_BASE_URL must not have a query or fragment'],
    [{ XAI_BASE_URL: 'gateway.example.com' }, 'XAI_BASE_URL is not a URL'],
    [
      { MODEL_ENDPOINT_HOSTS: 'https://gateway.example.com' },
      'MODEL_ENDPOINT_HOSTS: "https://gateway.example.com" is not a host name (no scheme, port or path)',
    ],
  ])
    assert.throws(
      () => modelEnvironment({ ...haiku, ...env }),
      error => {
        assert.equal(error.message, `${invalid.message}: ${message}`);
        assert.equal(String(error.stack).includes(credential), false);
        return true;
      },
    );
});

test('an allowlisted localhost base URL works over http outside production', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    requests.push({ path: req.url, headers: req.headers });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  endpointHosts(t, '127.0.0.1', 'development');
  const environment = modelEnvironment({
    MODEL_FAMILIES: 'claude-haiku',
    MODEL_ENDPOINT_HOSTS: '127.0.0.1',
    NODE_ENV: 'development',
    ANTHROPIC_API_KEY: credential,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/proxy`,
  });
  await inferDecision(environment.inference(environment.resolve('claude-haiku')), input).catch(() => null);
  assert.ok(requests.length >= 1);
  assert.equal(requests[0].path, '/proxy/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], credential);
});

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModelCatalog, readModelCatalog, removedModelSettings } from '../src/model-catalog-loader.ts';
import { servedModelBundle, verifyServerModelBundle } from '../src/model-bundle.ts';
import { initialBundleModels } from '../src/model-bundle.ts';

const fixture = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const scratch = fileURLToPath(new URL('../.test-model-catalogs/', import.meta.url));
let written = 0;
const file = catalog => {
  mkdirSync(scratch, { recursive: true });
  const path = `${scratch}catalog-${++written}.json`;
  writeFileSync(path, typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
  return path;
};
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// ChatGPT plan models need no key; these provider-key cases turn them off, and the ChatGPT plan test covers them.
const anthropic = { CHATGPT_PLAN: 'off', ANTHROPIC_API_KEY: 'test-key' };
const azure = {
  CHATGPT_PLAN: 'off',
  AZURE_FOUNDRY_API_KEY: 'test-key',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com',
};
const rate = {
  validFrom: null,
  validUntilExclusive: null,
  promptTokensAbove: null,
  usdPerMillionTokens: { input: 1, output: 2 },
};
const model = (id, extra = {}) => ({
  id,
  name: id,
  vendor: 'acme',
  routes: [{ provider: 'anthropic', model: `${id}-1` }],
  limits: { maxInputTokens: 1000, maxOutputTokens: 100 },
  pricing: [rate],
  ...extra,
});
const catalog = (models, extra = {}) => ({ version: 1, models, ...extra });

test('the shipped catalog is the default source and serves the models whose keys are set', () => {
  const served = loadModelCatalog(anthropic);
  assert.equal(served.source, 'shipped catalog');
  assert.equal(served.catalog.missingKeys, 'skip');
  assert.deepEqual(
    served.models.map(item => item.id),
    ['claude-haiku', 'claude-sonnet', 'claude-opus', 'claude-fable'],
  );
  assert.equal(served.defaultModel.id, 'claude-sonnet');
  assert.equal(served.role('title').id, 'claude-haiku');
  assert.equal(served.role('review').id, 'claude-sonnet');
  assert.equal(served.role('public-guide'), null, 'gpt-luna is skipped without an Azure or OpenAI key');
  assert.equal(served.role('table-search'), null);
  assert.equal(served.role('recommendation'), null);
  assert.match(served.warnings.join(' '), /not served: gpt-luna/);
  assert.equal(served.model('gpt-luna'), undefined);
});

test('ChatGPT plan models are served unless CHATGPT_PLAN is off, and never become the default', () => {
  const plans = ['chatgpt-sol', 'chatgpt-astra', 'chatgpt-luna'];
  const served = loadModelCatalog({ ANTHROPIC_API_KEY: 'test-key' });
  assert.deepEqual(
    served.models.filter(item => item.route.type === 'chatgpt').map(item => item.id),
    plans,
  );
  assert.equal(served.defaultModel.id, 'claude-sonnet');
  assert.equal(
    loadModelCatalog({ ...anthropic }).models.some(item => item.route.type === 'chatgpt'),
    false,
  );
  assert.throws(() => loadModelCatalog({}), /no model has a route with its key set/);
});

test('the first route with its key serves a model', () => {
  const openai = loadModelCatalog({ OPENAI_API_KEY: 'test-key' }).model('gpt-luna').route;
  assert.deepEqual([openai.type, openai.model, openai.apiKeyEnv], ['openai', 'gpt-6-luna', 'OPENAI_API_KEY']);
  const both = loadModelCatalog({ OPENAI_API_KEY: 'test-key', ...azure }).model('gpt-luna').route;
  assert.deepEqual([both.type, both.endpoint], ['azure', 'https://example.services.ai.azure.com/']);
  assert.equal(
    loadModelCatalog({
      AZURE_FOUNDRY_API_KEY: 'test-key',
      OPENAI_API_KEY: 'test-key',
    }).model('gpt-luna').route.type,
    'openai',
    'an Azure route without its endpoint is not usable',
  );
});

test('shipped bundles keep the ids and contents the previous configuration produced', () => {
  const ids = {
    'server-df252f852c308e4b4cbf30d9bfcd9493d6ba5d96aea8b3ab0fe8dbdf7ceff75c': anthropic,
    'server-32997cfa52952018391f4bbce8fd0aad1cb3e6dcdcd4d5b285abbad585fe8773': azure,
    'server-213b84957e410b090951a6a1cd90e3c74c835b327acf7b7c4a1c428fb6c32ab5': {
      CHATGPT_PLAN: 'off',
      OPENAI_API_KEY: 'test-key',
      XAI_API_KEY: 'test-key',
    },
    'server-925e080139216a2494f888c320debd4d52ed4564087b78210ae038b7be9292a6': {
      ...anthropic,
      ...azure,
      OPENAI_API_KEY: 'test-key',
      XAI_API_KEY: 'test-key',
      GEMINI_API_KEY: 'test-key',
    },
  };
  for (const [id, env] of Object.entries(ids)) {
    const { bundle } = servedModelBundle(loadModelCatalog(env));
    assert.equal(bundle.id, id);
    for (const item of bundle.models)
      assert.deepEqual(
        item.rates,
        initialBundleModels.find(original => original.id === item.id).rates,
        `${item.id} keeps its recorded price`,
      );
  }
  const stored = JSON.parse(readFileSync(fixture('legacy-server-bundles.json'), 'utf8'));
  assert.equal(stored.length, 3);
  for (const bundle of stored) assert.equal(verifyServerModelBundle(bundle.id, bundle).id, bundle.id);
});

test('MODEL_CATALOG_FILE and MODEL_CATALOG replace the shipped catalog entirely', () => {
  const path = fixture('model-catalog-acme.json');
  const fromFile = loadModelCatalog({
    ...azure,
    ...anthropic,
    MODEL_CATALOG_FILE: path,
  });
  assert.equal(fromFile.source, `MODEL_CATALOG_FILE=${path}`);
  assert.deepEqual(
    fromFile.models.map(item => item.id),
    ['acme-chat', 'claude-haiku'],
  );
  assert.equal(fromFile.defaultModel.id, 'acme-chat');
  assert.equal(fromFile.role('title'), null, 'roles come only from the catalog in use');
  const inline = loadModelCatalog({
    ...azure,
    MODEL_CATALOG: readFileSync(path, 'utf8'),
  });
  assert.equal(inline.source, 'MODEL_CATALOG');
  assert.deepEqual(
    inline.models.map(item => item.id),
    ['acme-chat'],
  );
  assert.throws(
    () => readModelCatalog({ MODEL_CATALOG_FILE: path, MODEL_CATALOG: '{}' }),
    /Invalid model catalog \(MODEL_CATALOG_FILE, MODEL_CATALOG\): set only one of them/,
  );
});

test('an invalid catalog fails with its source and the path of each problem', () => {
  const invalid = fixture('model-catalog-invalid.json');
  assert.throws(
    () => readModelCatalog({ MODEL_CATALOG_FILE: invalid }),
    new RegExp(`Invalid model catalog \\(MODEL_CATALOG_FILE=${invalid}\\): models\\.0\\.limits\\.maxOutputTokens`),
  );
  assert.throws(
    () => readModelCatalog({ MODEL_CATALOG_FILE: `${scratch}missing.json` }),
    /MODEL_CATALOG_FILE=.*missing\.json\): cannot read the file \(ENOENT\)/,
  );
  assert.throws(() => readModelCatalog({ MODEL_CATALOG: '{' }), /\(MODEL_CATALOG\): not valid JSON/);
  assert.throws(
    () =>
      readModelCatalog({
        MODEL_CATALOG: JSON.stringify(catalog([model('a', { default: true }), model('b', { default: true })])),
      }),
    /\(MODEL_CATALOG\): .*default/i,
  );
});

test('missingKeys "fail" stops startup when a model has no route with its key', () => {
  const env = {
    ...anthropic,
    MODEL_CATALOG_FILE: file(
      catalog([model('a', { default: true }), model('b', { routes: [{ provider: 'azure', model: 'b-1' }] })]),
    ),
  };
  assert.throws(
    () => loadModelCatalog(env),
    /models\.1 "b" has no route with its key set; set AZURE_FOUNDRY_API_KEY and AZURE_FOUNDRY_ENDPOINT, remove the model, or set "missingKeys": "skip"/,
  );
  assert.equal(loadModelCatalog({ ...env, ...azure }).models.length, 2);
});

test('missingKeys "skip" leaves models out, moves the default and drops skipped roles', () => {
  const env = {
    ...anthropic,
    MODEL_CATALOG_FILE: file(
      catalog(
        [
          model('hidden', { selectable: false, roles: ['title'] }),
          model('paused', { paused: true }),
          model('chat', { roles: ['compaction'] }),
          model('main', {
            default: true,
            routes: [{ provider: 'azure', model: 'main-1' }],
            roles: ['table-search'],
          }),
        ],
        { missingKeys: 'skip' },
      ),
    ),
  };
  const served = loadModelCatalog(env);
  assert.deepEqual(served.skipped, ['main']);
  assert.equal(served.defaultModel.id, 'chat', 'the first remaining selectable, unpaused model');
  assert.match(served.warnings.join(' '), /default model main is not served; chat is the default/);
  assert.equal(served.role('table-search'), null);
  assert.equal(served.role('title').id, 'hidden');
  assert.equal(loadModelCatalog({ ...env, ...azure }).defaultModel.id, 'main');
  assert.throws(
    () => loadModelCatalog({ MODEL_CATALOG_FILE: env.MODEL_CATALOG_FILE }),
    /no model has a route with its key set; set a provider key such as ANTHROPIC_API_KEY, AZURE_FOUNDRY_API_KEY/,
  );
  const onlyHidden = {
    ...anthropic,
    MODEL_CATALOG_FILE: file(
      catalog(
        [
          model('hidden', { selectable: false }),
          model('main', {
            default: true,
            routes: [{ provider: 'xai', model: 'x' }],
          }),
        ],
        { missingKeys: 'skip' },
      ),
    ),
  };
  assert.throws(
    () => loadModelCatalog(onlyHidden),
    /default model "main" is not served and no other model can replace it/,
  );
});

const imageModel = (id, extra = {}) => ({
  id,
  name: id,
  vendor: 'acme',
  routes: [{ provider: 'openai', model: `${id}-1`, api: 'openai-images' }],
  aspects: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
  pricing: 'unmetered',
  ...extra,
});

test('a model falls back along its served, unpaused fallback chain and then to the fallback role', () => {
  const served = loadModelCatalog({
    ...anthropic,
    MODEL_CATALOG_FILE: file(
      catalog(
        [
          model('main', { default: true, roles: ['fallback'] }),
          model('kimi', { fallback: 'paused' }),
          model('paused', { paused: true, fallback: 'unserved' }),
          model('unserved', { routes: [{ provider: 'azure', model: 'unserved-1' }], fallback: 'grok' }),
          model('grok'),
        ],
        { missingKeys: 'skip' },
      ),
    ),
  });
  const ids = id => served.fallbacks(id).map(item => item.id);
  assert.deepEqual(ids('kimi'), ['grok', 'main']);
  assert.deepEqual(ids('grok'), ['main']);
  assert.deepEqual(ids('main'), [], 'the role model has no fallback of its own');
});

test('image models are served from their first keyed route, and the default is never replaced', () => {
  const env = {
    ...anthropic,
    MODEL_CATALOG_FILE: file(
      catalog([model('chat', { default: true })], {
        missingKeys: 'skip',
        imageModels: [
          imageModel('main-image', { default: true }),
          imageModel('azure-image', {
            routes: [
              { provider: 'openai', model: 'a', api: 'openai-images' },
              { provider: 'azure', model: 'b', api: 'openai-images' },
            ],
          }),
        ],
      }),
    ),
  };
  const served = loadModelCatalog({ ...env, ...azure });
  assert.deepEqual(
    served.imageModels.map(image => [image.id, image.route.provider, image.route.model, image.route.api]),
    [['azure-image', 'azure', 'b', 'openai-images']],
  );
  assert.deepEqual(served.skipped, ['main-image']);
  assert.equal(served.defaultImageModel, null, 'another image model never replaces a skipped default');
  assert.equal(served.imageModel('azure-image').id, 'azure-image');
  assert.equal(served.imageModel('main-image'), undefined);
  const all = loadModelCatalog({ ...env, ...azure, OPENAI_API_KEY: 'test-key' });
  assert.equal(all.defaultImageModel.id, 'main-image');
  assert.equal(all.imageModel('azure-image').route.provider, 'openai');
  assert.throws(
    () =>
      loadModelCatalog({
        ...anthropic,
        MODEL_CATALOG_FILE: file(
          catalog([model('chat', { default: true })], { imageModels: [imageModel('main-image')] }),
        ),
      }),
    /imageModels\.0 "main-image" has no route with its key set; set OPENAI_API_KEY/,
  );
  assert.deepEqual(loadModelCatalog(anthropic).imageModels, []);
});

test('removed model settings fail startup and name what replaces them', () => {
  for (const name of Object.keys(removedModelSettings)) {
    assert.throws(() => readModelCatalog({ [name]: 'claude-sonnet' }), new RegExp(`Remove ${name} \\(`));
  }
  assert.throws(
    () =>
      readModelCatalog({
        MODEL_DEFAULT_FAMILY: 'gpt-sol',
        MODEL_CATALOG_MODE: 'replace',
      }),
    /Remove MODEL_DEFAULT_FAMILY \(set "default": true on the model\), MODEL_CATALOG_MODE \(/,
  );
  assert.deepEqual(Object.keys(removedModelSettings).sort(), [
    'CHAT_TITLE_MODEL_FAMILY',
    'GMAIL_HEARTBEAT_MODEL_FAMILY',
    'MODEL_CATALOG_MODE',
    'MODEL_DEFAULT_FAMILY',
    'MODEL_FAMILIES',
    'MODEL_PAUSED_FAMILIES',
    'PLAN_SPECIALIST_MODEL_FAMILY',
    'PUBLIC_GUIDE_MODEL_FAMILY',
    'RECOMMENDATION_MODEL_FAMILY',
    'SKILL_REVIEW_MODEL_FAMILY',
    'TABLE_SEARCH_MODEL_FAMILY',
  ]);
  assert.equal(readModelCatalog({ MODEL_FAMILIES: ' ' }).source, 'shipped catalog', 'blank values are unset');
});

test('custom provider endpoints must pass MODEL_ENDPOINT_HOSTS', () => {
  const gateway = catalog([
    model('local', {
      default: true,
      routes: [{ provider: 'gateway', model: 'llama' }],
    }),
  ]);
  gateway.providers = {
    gateway: {
      type: 'openai-compatible',
      apiKeyEnv: 'GATEWAY_API_KEY',
      endpointEnv: 'GATEWAY_URL',
    },
  };
  const env = {
    MODEL_CATALOG: JSON.stringify(gateway),
    GATEWAY_API_KEY: 'test-key',
    GATEWAY_URL: 'https://llm.internal.example/v1',
  };
  assert.throws(
    () => loadModelCatalog(env),
    /\(MODEL_CATALOG\): models\.0\.routes\.0: GATEWAY_URL .*MODEL_ENDPOINT_HOSTS/,
  );
  const served = loadModelCatalog({
    ...env,
    MODEL_ENDPOINT_HOSTS: 'llm.internal.example',
  });
  assert.deepEqual(
    [served.defaultModel.route.endpoint, served.defaultModel.route.apiKeyEnv],
    ['https://llm.internal.example/v1/', 'GATEWAY_API_KEY'],
  );
  assert.throws(
    () =>
      loadModelCatalog({
        ...env,
        GATEWAY_URL: 'https://user:secret@llm.internal.example/v1',
      }),
    /GATEWAY_URL/,
  );
});

test('model keys and endpoints never use a public prefix', () => {
  const gateway = catalog([
    model('local', {
      default: true,
      routes: [{ provider: 'gateway', model: 'llama' }],
    }),
  ]);
  gateway.providers = {
    gateway: {
      type: 'openai-compatible',
      apiKeyEnv: 'GATEWAY_API_KEY',
      endpointEnv: 'GATEWAY_URL',
    },
  };
  const env = {
    MODEL_CATALOG: JSON.stringify(gateway),
    GATEWAY_API_KEY: 'test-key',
    GATEWAY_URL: 'https://llm.internal.example/v1',
    MODEL_ENDPOINT_HOSTS: 'llm.internal.example',
  };
  for (const exposed of [
    'VITE_GATEWAY_API_KEY',
    'NEXT_PUBLIC_GATEWAY_URL',
    'PUBLIC_GATEWAY_API_KEY',
    'VITE_ANTHROPIC_API_KEY',
  ])
    assert.throws(() => loadModelCatalog({ ...env, [exposed]: 'x' }), new RegExp(`${exposed} would reach the browser`));
  assert.equal(loadModelCatalog({ ...env, VITE_UNRELATED: 'x' }).defaultModel.id, 'local');
});

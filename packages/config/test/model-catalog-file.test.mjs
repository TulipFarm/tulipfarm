import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { modelCatalogFileSchema, modelCatalogJsonSchema, modelCatalogSchemaUrl } from '../src/model-catalog-file.ts';

const read = name => JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), 'utf8'));
const example = read('model-catalog.example.json');

const model = (overrides = {}) => ({
  id: 'claude-sonnet',
  name: 'Claude Sonnet',
  vendor: 'anthropic',
  routes: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
  default: true,
  limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
  pricing: [{ usdPerMillionTokens: { input: 3, output: 15 } }],
  ...overrides,
});
const catalog = (models, rest = {}) => ({ version: 1, models, ...rest });
const problems = value => {
  const result = modelCatalogFileSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
};
const rejects = (value, pattern) =>
  assert.ok(
    problems(value).some(problem => pattern.test(problem)),
    problems(value).join('\n') || 'parsed',
  );

test('the example catalog is valid and names the published schema', () => {
  assert.equal(example.$schema, modelCatalogSchemaUrl);
  assert.deepEqual(problems(example), []);
});

test('omitted fields take their defaults', () => {
  const parsed = modelCatalogFileSchema.parse(catalog([model(), model({ id: 'claude-opus', default: undefined })]));
  assert.deepEqual(parsed.providers, {});
  assert.equal(parsed.missingKeys, 'fail');
  assert.deepEqual(
    parsed.models.map(entry => [entry.default, entry.paused, entry.selectable, entry.roles]),
    [
      [true, false, true, []],
      [false, false, true, []],
    ],
  );
  assert.deepEqual(parsed.models[0].pricing[0], {
    validFrom: null,
    validUntilExclusive: null,
    promptTokensAbove: null,
    usdPerMillionTokens: { input: 3, output: 15 },
  });
});

test('exactly one model is the default, and it is not paused', () => {
  rejects(catalog([model({ default: false })]), /^models: .*found 0/);
  rejects(catalog([model(), model({ id: 'claude-opus' })]), /^models: .*found 2/);
  rejects(catalog([model({ paused: true })]), /^models\.0\.paused: The default model cannot be paused/);
  rejects(catalog([model({ selectable: false })]), /^models\.0\.selectable: The default model must be selectable/);
  assert.deepEqual(problems(catalog([model(), model({ id: 'claude-haiku', default: false, selectable: false })])), []);
});

test('ids are unique and each role is on one model', () => {
  rejects(catalog([model(), model({ default: false })]), /^models\.1\.id: Duplicate model id/);
  rejects(catalog([model({ roles: ['title', 'title'] })]), /^models\.0\.roles\.1: Duplicate role/);
  rejects(
    catalog([model({ roles: ['title'] }), model({ id: 'claude-haiku', default: false, roles: ['title'] })]),
    /^models\.1\.roles\.0: Role "title" is already on models\[0\]/,
  );
  rejects(catalog([model({ roles: ['default-chat'] })]), /^models\.0\.roles\.0:/);
});

test('the optional completion-check role is provider-neutral and has a single owner', () => {
  assert.deepEqual(problems(catalog([model({ roles: ['completion-check'] })])), []);
  rejects(
    catalog([
      model({ roles: ['completion-check'] }),
      model({ id: 'claude-haiku', default: false, roles: ['completion-check'] }),
    ]),
    /^models\.1\.roles\.0: Role "completion-check" is already on models\[0\]/,
  );
});

test('the document-vision model accepts image input and has a single owner', () => {
  const vision = overrides => catalog([model({ roles: ['document-vision'], ...overrides })]);
  assert.deepEqual(problems(vision({ capabilities: { imageInput: true } })), []);
  rejects(vision(), /^models\.0\.roles: The document-vision model needs "capabilities": \{ "imageInput": true \}/);
  rejects(vision({ capabilities: { imageInput: false } }), /^models\.0\.roles: The document-vision model/);
  rejects(
    catalog([
      model({ roles: ['document-vision'], capabilities: { imageInput: true } }),
      model({ id: 'claude-haiku', default: false, roles: ['document-vision'], capabilities: { imageInput: true } }),
    ]),
    /^models\.1\.roles\.0: Role "document-vision" is already on models\[0\]/,
  );
});

const imageModel = (overrides = {}) => ({
  id: 'gpt-image',
  name: 'GPT Image',
  vendor: 'openai',
  routes: [{ provider: 'openai', model: 'gpt-image-2', api: 'openai-images' }],
  aspects: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
  pricing: {
    usdPerImage: {
      standard: { square: 0.04, portrait: 0.06, landscape: 0.06 },
      high: { square: 0.17, portrait: 0.25, landscape: 0.25 },
    },
  },
  ...overrides,
});

test('image models take defaults, and a model pairs with one by id', () => {
  const parsed = modelCatalogFileSchema.parse(
    catalog([model({ imageModel: 'gpt-image', capabilities: { imageInput: true } })], {
      imageModels: [imageModel()],
    }),
  );
  assert.equal(parsed.models[0].imageModel, 'gpt-image');
  assert.deepEqual(
    [parsed.imageModels[0].default, parsed.imageModels[0].paused, parsed.imageModels[0].edits],
    [false, false, false],
  );
  assert.equal(parsed.imageModels[0].maxSources, 1);
  assert.deepEqual(modelCatalogFileSchema.parse(catalog([model()])).imageModels, []);
  assert.equal(modelCatalogFileSchema.parse(catalog([model()])).models[0].imageModel, null);
  rejects(
    catalog([model({ imageModel: 'missing' })]),
    /^models\.0\.imageModel: No entry in imageModels has id "missing"/,
  );
});

test('image input limits need image input', () => {
  const limits = { maxInputTokens: 200000, maxOutputTokens: 64000, imageInputTokens: 2000, maxImageBytes: 1048576 };
  assert.deepEqual(problems(catalog([model({ limits, capabilities: { imageInput: true } })])), []);
  rejects(
    catalog([model({ limits })]),
    /^models\.0\.limits\.imageInputTokens: Only for a model with "imageInput": true/,
  );
  rejects(catalog([model({ limits })]), /^models\.0\.limits\.maxImageBytes: Only for a model with "imageInput": true/);
  rejects(
    catalog([model({ limits: { ...limits, maxImageBytes: 1024 }, capabilities: { imageInput: true } })]),
    /^models\.0\.limits\.maxImageBytes:/,
  );
});

test('image models have unique ids, served routes and at most one unpaused default', () => {
  const images = (...entries) => catalog([model()], { imageModels: entries });
  assert.deepEqual(
    problems(
      images(
        imageModel({ default: true }),
        imageModel({ id: 'grok-image', routes: [{ provider: 'xai', model: 'grok-2-image', api: 'xai-images' }] }),
      ),
    ),
    [],
  );
  rejects(images(imageModel(), imageModel()), /^imageModels\.1\.id: Duplicate model id "gpt-image"/);
  rejects(images(imageModel({ id: 'claude-sonnet' })), /^imageModels\.0\.id: Duplicate model id "claude-sonnet"/);
  rejects(
    images(imageModel({ default: true }), imageModel({ id: 'other', default: true })),
    /^imageModels: At most one image model can be the default; found 2/,
  );
  rejects(
    images(imageModel({ default: true, paused: true })),
    /^imageModels\.0\.paused: The default image model cannot be paused/,
  );
  rejects(
    images(imageModel({ routes: [{ provider: 'anthropic', model: 'm', api: 'openai-images' }] })),
    /^imageModels\.0\.routes\.0\.api: Provider type anthropic does not serve openai-images/,
  );
  rejects(
    images(imageModel({ routes: [{ provider: 'nowhere', model: 'm', api: 'openai-images' }] })),
    /^imageModels\.0\.routes\.0\.provider: Unknown provider "nowhere"/,
  );
  rejects(
    images(
      imageModel({
        routes: [
          { provider: 'openai', model: 'a', api: 'openai-images' },
          { provider: 'openai', model: 'b', api: 'openai-images' },
        ],
      }),
    ),
    /^imageModels\.0\.routes\.1\.provider: Duplicate route provider "openai"/,
  );
  assert.deepEqual(
    problems(images(imageModel({ routes: [{ provider: 'azure', model: 'm', api: 'openai-images' }] }))),
    [],
  );
});

test('only editing image models take more than one source, and prices are exact', () => {
  const images = entry => catalog([model()], { imageModels: [entry] });
  assert.deepEqual(problems(images(imageModel({ edits: true, maxSources: 4 }))), []);
  rejects(
    images(imageModel({ maxSources: 4 })),
    /^imageModels\.0\.maxSources: Only a model with "edits": true takes source images/,
  );
  rejects(
    images(
      imageModel({
        pricing: {
          usdPerImage: {
            standard: { square: 0.0400001, portrait: 0.06, landscape: 0.06 },
            high: { square: 0.17, portrait: 0.25, landscape: 0.25 },
          },
        },
      }),
    ),
    /^imageModels\.0\.pricing\.usdPerImage\.standard\.square: At most 6 decimal places/,
  );
  assert.deepEqual(problems(images(imageModel({ pricing: 'unmetered' }))), []);
  assert.deepEqual(problems(images(imageModel({ pricing: [{ usdPerMillionTokens: { input: 5, output: 40 } }] }))), []);
});

const routes = (...providers) => ({
  routes: providers.map(provider => ({ provider, model: 'm' })),
});

test('model routes name built-in or declared providers, in order of preference', () => {
  rejects(catalog([model(routes('foundry'))]), /^models\.0\.routes\.0\.provider: Unknown provider "foundry"/);
  assert.deepEqual(
    problems(
      catalog([model(routes('foundry', 'anthropic'))], {
        providers: { foundry: { type: 'azure' } },
      }),
    ),
    [],
  );
  rejects(
    catalog([model(routes('anthropic', 'anthropic'))]),
    /^models\.0\.routes\.1\.provider: Duplicate route provider/,
  );
  rejects(catalog([model({ routes: [] })]), /^models\.0\.routes: /);
  rejects(
    catalog([model()], { providers: { azure: { type: 'openai' } } }),
    /^providers\.azure\.type: Provider "azure" must have type "azure"/,
  );
  rejects(
    catalog([model(routes('gateway'))], {
      providers: { gateway: { type: 'openai-compatible' } },
    }),
    /^providers\.gateway\.apiKeyEnv: Required/,
  );
  rejects(
    catalog([model({ capabilities: { api: 'responses' } })]),
    /^models\.0\.capabilities\.api: Provider type anthropic does not support this API/,
  );
  rejects(
    catalog([
      model({
        ...routes('openai', 'anthropic'),
        capabilities: { api: 'responses' },
      }),
    ]),
    /^models\.0\.capabilities\.api: Provider type anthropic/,
  );
});

test('the public-guide model has an Azure chat-completions route', () => {
  const guide = overrides => catalog([model({ roles: ['public-guide'], ...overrides })]);
  assert.deepEqual(problems(guide(routes('azure'))), []);
  // Served by another route, the guide is unavailable; the model still serves chats.
  assert.deepEqual(problems(guide(routes('azure', 'openai'))), []);
  rejects(guide(routes('anthropic')), /^models\.0\.roles: The public-guide model needs an Azure route/);
  rejects(guide(routes('openai')), /^models\.0\.roles: The public-guide model/);
  rejects(
    guide({ ...routes('azure'), capabilities: { api: 'responses' } }),
    /^models\.0\.roles: The public-guide model/,
  );
});

test('providers name environment variables, never secrets', () => {
  const provider = apiKeyEnv => ({
    providers: { foundry: { type: 'azure', apiKeyEnv } },
  });
  rejects(
    catalog([model()], provider('sk-live-123')),
    /^providers\.foundry\.apiKeyEnv: Must be an environment variable name/,
  );
  rejects(catalog([model()], provider('VITE_AZURE_KEY')), /^providers\.foundry\.apiKeyEnv: Must not be a public/);
  rejects(
    catalog([model()], {
      providers: { foundry: { type: 'azure', apiKey: 'x' } },
    }),
    /^providers\.foundry: /,
  );
});

test('pricing needs a base rate and unambiguous tiers', () => {
  rejects(
    catalog([
      model({
        pricing: [
          {
            promptTokensAbove: 1000,
            usdPerMillionTokens: { input: 1, output: 1 },
          },
        ],
      }),
    ]),
    /^models\.0\.pricing: Needs a base rate/,
  );
  const rate = { usdPerMillionTokens: { input: 1, output: 1 } };
  rejects(catalog([model({ pricing: [rate, rate] })]), /^models\.0\.pricing\.0: Overlaps/);
  assert.deepEqual(
    problems(
      catalog([
        model({
          pricing: [
            { ...rate, validUntilExclusive: '2026-11-01' },
            { ...rate, validFrom: '2026-11-01' },
          ],
        }),
      ]),
    ),
    [],
  );
  rejects(
    catalog([
      model({
        pricing: [
          {
            ...rate,
            validFrom: '2026-11-01',
            validUntilExclusive: '2026-10-01',
          },
        ],
      }),
    ]),
    /^models\.0\.pricing\.0: validFrom must be before/,
  );
  rejects(
    catalog([
      model({
        pricing: [{ usdPerMillionTokens: { input: 0.0000001, output: 1 } }],
      }),
    ]),
    /^models\.0\.pricing\.0\.usdPerMillionTokens\.input: At most 6 decimal places/,
  );
  assert.deepEqual(problems(catalog([model({ pricing: 'unmetered' })])), []);
});

test('unknown fields and versions are rejected', () => {
  rejects({ ...catalog([model()]), families: [] }, /Unrecognized key/);
  rejects(catalog([model({ enabled: true })]), /^models\.0: Unrecognized key/);
  rejects({ ...catalog([model()]), version: 2 }, /^version: /);
  rejects({ ...catalog([model()]), missingKeys: 'ignore' }, /^missingKeys: /);
  assert.deepEqual(problems({ ...catalog([model()]), missingKeys: 'skip' }), []);
  rejects(catalog([]), /^models: /);
});

test('the published JSON Schema is generated from the validator', () => {
  assert.deepEqual(read('model-catalog.v1.json'), modelCatalogJsonSchema());
  assert.equal(read('model-catalog.v1.json').$id, modelCatalogSchemaUrl);
});

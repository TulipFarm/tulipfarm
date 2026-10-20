import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pricing from '../src/model-pricing.json' with { type: 'json' };
import families from '../src/model-families.json' with { type: 'json' };

const fixture = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const unmetered = JSON.parse(readFileSync(fixture('model-catalog-unmetered.json'), 'utf8'));
const haiku = pricing.models.find(model => model.id === 'claude-haiku-4-5');
const tokens = { input: 1000, output: 1000, cacheRead: 100, cacheWrite: 0, cacheWrite5m: 10, cacheWrite1h: 0 };

function load(env, script) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const config = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
    ${script}`,
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    output: result.status === 0 ? JSON.parse(result.stdout) : null,
  };
}

// Resolves a family on a synthetic route, bundles the effective catalog and meters `tokens`. `extra` adds output fields.
const meter = (familyId, extra = '') => `
  const model = config.modelPricing.models.find(item => item.id === config.modelFamilies.find(family => family.id === ${JSON.stringify(familyId)}).currentModelId);
  const route = { id: 'route', modelId: model.id, provider: model.provider, deployment: model.providerModelId, location: 'test', adapterVersion: 1,
    qualification: 'fixture', lifecycle: 'current', maxInputTokens: 2000, maxOutputTokens: 2000, boundedDecision: true };
  const resolution = config.resolveModelFamily({ familyId: ${JSON.stringify(familyId)}, mapping: config.initialModelMapping, routes: [route],
    allowedProviders: [model.provider], allowedLocations: ['test'] });
  const bundle = config.modelBundleSchema.parse({ format: 1, id: 'bundle', mapping: { ...config.initialModelMapping, revision: 'bundle',
    families: config.initialModelMapping.families.filter(family => family.id === ${JSON.stringify(familyId)}) }, models: config.initialBundleModels, routes: [route] });
  const usage = { kind: 'known', tokens: ${JSON.stringify(tokens)} };
  const cost = config.calculateModelCost({ resolution, usage, date: '2026-10-19' });
  const bundled = config.calculateModelCost({ resolution: config.resolveModelBundle({ bundle, familyId: ${JSON.stringify(familyId)}, allowedProviders: [model.provider], allowedLocations: ['test'] }), usage, date: '2026-10-19', trustedBundle: bundle });
  const quote = { modelId: model.id, pricingRevision: resolution.pricingRevision, rates: model.rates, maxInputTokens: 2000, maxOutputTokens: 2000, date: '2026-10-19' };
  console.log(JSON.stringify({ ${extra} cost: cost.providerPicoUsd, bundled: bundled.providerPicoUsd, reserved: config.reserveModelCost(quote),
    usage: config.calculateUsageCost({ ...quote, usage }).providerPicoUsd, rates: model.rates,
    revision: config.initialModelMapping.revision, pricingRevision: config.initialModelMapping.pricingRevision }));`;

test('the shipped catalog keeps its prices, revisions and costs', () => {
  const { status, stderr, output } = load(
    {},
    meter('claude-haiku', 'all: config.modelPricing.models.map(({ id, rates }) => ({ id, rates })),'),
  );
  assert.equal(status, 0, stderr);
  assert.deepEqual(
    output.all,
    pricing.models.map(({ id, rates }) => ({ id, rates })),
  );
  // 1000 input at $1, 1000 output at $5, 100 cache reads at $0.10 and 10 five-minute cache writes at $1.25 per million.
  assert.equal(output.cost, '6022500000');
  assert.equal(output.bundled, output.cost);
  assert.equal(output.usage, output.cost);
  assert.equal(output.revision, 'families-2026-10-19.1');
  assert.equal(output.pricingRevision, 'prices-2026-10-19.1');
  assert.equal(
    families.some(family => 'pricing' in family),
    false,
  );
});

test('an operator price override for a shipped family changes its metered cost', () => {
  const contract = {
    ...haiku,
    rates: [
      {
        validFrom: null,
        validUntilExclusive: null,
        promptTokensAbove: null,
        usdPerMillionTokens: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
      },
    ],
  };
  const shipped = load({}, meter('claude-haiku'));
  const { status, stderr, output } = load(
    { MODEL_CATALOG: JSON.stringify({ models: [contract] }) },
    meter('claude-haiku'),
  );
  assert.equal(status, 0, stderr);
  assert.equal(output.cost, '3011250000', 'the contract halves every rate');
  assert.notEqual(output.cost, shipped.output.cost);
  assert.equal(output.bundled, output.cost);
  assert.equal(output.usage, output.cost, 'shared metering reads the effective catalog');
  assert.deepEqual(output.rates, contract.rates);
  assert.match(output.pricingRevision, /^prices-[0-9a-f]{32}$/);
  assert.equal(output.revision, 'families-2026-10-19.1', 'a price-only override keeps the family revision');
});

test('an unmetered family records usage at zero cost and exposes no rates', () => {
  const { status, stderr, output } = load(
    { MODEL_CATALOG: JSON.stringify(unmetered) },
    meter('local-chat', "pricing: config.modelFamilies.find(family => family.id === 'local-chat').pricing,"),
  );
  assert.equal(status, 0, stderr);
  assert.equal(output.pricing, 'unmetered');
  assert.equal(output.cost, '0');
  assert.equal(output.bundled, '0');
  assert.equal(output.usage, '0');
  assert.equal(output.reserved, '0');
  assert.deepEqual(output.rates, [
    {
      validFrom: null,
      validUntilExclusive: null,
      promptTokensAbove: null,
      usdPerMillionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
  ]);
  assert.match(output.revision, /^families-[0-9a-f]{32}$/);
  assert.match(output.pricingRevision, /^prices-[0-9a-f]{32}$/);
});

test('pricing must be declared: rates, or an unmetered family, never both or neither', () => {
  const [family] = unmetered.families;
  const [model] = unmetered.models;
  const metered = { ...family, pricing: undefined };
  const rates = haiku.rates;
  for (const [catalog, message] of [
    [
      { families: [metered], models: [model] },
      /MODEL_CATALOG\): family "local-chat": model "local-chat-1" has no rates; add rates or set "pricing": "unmetered" on the family/,
    ],
    [
      { families: [family], models: [{ ...model, rates }] },
      /MODEL_CATALOG\): family "local-chat": model "local-chat-1" has rates but the family is unmetered/,
    ],
    [
      { families: [{ ...families.find(item => item.id === 'claude-haiku'), pricing: 'unmetered' }] },
      /family "claude-haiku": model "claude-haiku-4-5" has rates but the family is unmetered/,
    ],
    [{ families: [{ ...family, pricing: 'free' }], models: [model] }, /families\[0\] "local-chat": pricing/],
    [{ families: [family], models: [{ ...model, rates: [] }] }, /models\[0\] "local-chat-1": rates/],
    [
      {
        families: [metered],
        models: [{ ...model, rates: [{ ...rates[0], validFrom: '2026-10-01', validUntilExclusive: '2026-10-01' }] }],
      },
      /models\[0\] "local-chat-1": rates\.0: Invalid price interval/,
    ],
  ]) {
    const { status, stderr } = load({ MODEL_CATALOG: JSON.stringify(catalog) }, 'console.log("{}");');
    assert.notEqual(status, 0, JSON.stringify(catalog));
    assert.match(stderr, /ModelCatalogError/);
    assert.match(stderr.replaceAll('\\"', '"'), message);
  }
});

test('a stored server bundle keeps its override and unmetered prices after the catalog changes', () => {
  const contract = {
    ...haiku,
    rates: [
      { ...haiku.rates[0], usdPerMillionTokens: { ...haiku.rates[0].usdPerMillionTokens, input: 0.5, output: 2.5 } },
    ],
  };
  const [local] = unmetered.models;
  const started = { families: unmetered.families, models: [contract, local] };
  const changed = {
    families: [{ ...unmetered.families[0], pricing: undefined }],
    models: [{ ...local, rates: haiku.rates }],
  };
  // Builds the server bundle the way modelEnvironment does, then charges both families through it.
  const charge = `
    const charge = (bundle, familyId) => {
      const resolution = config.resolveModelBundle({ bundle, familyId, allowedProviders: ['anthropic', 'azure'], allowedLocations: ['server'] });
      return config.calculateModelCost({ resolution, usage: { kind: 'known', tokens: ${JSON.stringify(tokens)} }, date: '2026-10-19', trustedBundle: bundle }).providerPicoUsd;
    };`;
  const build = load(
    { MODEL_CATALOG: JSON.stringify(started) },
    `${charge}
    const models = config.initialBundleModels.filter(model => ['claude-haiku-4-5', 'local-chat-1'].includes(model.id));
    const bundle = config.serverModelBundle({
      models,
      routes: models.map(model => ({ id: 'server-' + model.id, modelId: model.id, provider: model.provider, deployment: model.id, location: 'server',
        adapterVersion: 1, qualification: 'server-configuration', lifecycle: 'current', maxInputTokens: 2000, maxOutputTokens: 2000, boundedDecision: true })),
      pricingRevision: config.initialModelMapping.pricingRevision,
      families: models.map(model => ({ id: model.familyId, modelId: model.id })),
    });
    console.log(JSON.stringify({ bundle, haiku: charge(bundle, 'claude-haiku'), local: charge(bundle, 'local-chat') }));`,
  );
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.output.haiku, '3022500000', 'override input and output rates, shipped cache rates');
  assert.equal(build.output.local, '0');
  for (const catalog of [started, changed]) {
    const { status, stderr, output } = load(
      { MODEL_CATALOG: JSON.stringify(catalog) },
      `${charge}
      const stored = ${JSON.stringify(build.output.bundle)};
      const bundle = config.verifyServerModelBundle(stored.id, stored);
      console.log(JSON.stringify({ current: config.initialModelMapping.pricingRevision, haiku: charge(bundle, 'claude-haiku'), local: charge(bundle, 'local-chat') }));`,
    );
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      { haiku: output.haiku, local: output.local },
      { haiku: build.output.haiku, local: '0' },
      'runs settle at the prices they started with',
    );
    if (catalog === changed) assert.notEqual(output.current, build.output.bundle.mapping.pricingRevision);
  }
});

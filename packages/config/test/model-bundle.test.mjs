import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initialBundleModels,
  modelBundleSchema,
  resolveModelBundle,
  parseModelResolution,
  serverModelBundle,
  verifyServerModelBundle,
} from '../src/model-bundle.ts';
import { calculateModelCost } from '../src/model-cost.ts';

function fixtureBundle(id = 'successor') {
  const old = initialBundleModels.find(model => model.familyId === 'claude-opus');
  const model = {
    ...old,
    id: `opus-${id}`,
    rates: [
      {
        validFrom: null,
        validUntilExclusive: null,
        promptTokensAbove: null,
        usdPerMillionTokens: { input: 7, output: 30 },
      },
    ],
  };
  return {
    format: 1,
    id,
    mapping: {
      format: 1,
      revision: `mapping-${id}`,
      pricingRevision: `prices-${id}`,
      families: [{ id: 'claude-opus', modelId: model.id }],
    },
    models: [model],
    routes: [
      {
        id: `route-${id}`,
        modelId: model.id,
        provider: 'anthropic',
        deployment: model.id,
        location: 'us',
        adapterVersion: 1,
        qualification: 'synthetic-reviewed-fixture',
        lifecycle: 'current',
        maxInputTokens: 1000000,
        maxOutputTokens: 128000,
        boundedDecision: true,
      },
    ],
  };
}

test('trusted bundle admits a reviewed successor and authenticates historical prices', () => {
  const trustedBundle = modelBundleSchema.parse(fixtureBundle());
  const resolution = resolveModelBundle({
    bundle: trustedBundle,
    familyId: 'claude-opus',
    allowedProviders: ['anthropic'],
    allowedLocations: ['us'],
  });
  assert.equal(resolution.modelId, 'opus-successor');
  assert.deepEqual(parseModelResolution(JSON.parse(JSON.stringify(resolution)), trustedBundle), resolution);
  const usage = {
    kind: 'known',
    tokens: {
      input: 1000000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
  };
  assert.equal(
    calculateModelCost({ resolution, trustedBundle, usage, date: '2026-09-28' }).providerPicoUsd,
    '7000000000000',
  );
  assert.throws(() => calculateModelCost({ resolution, usage, date: '2026-09-28' }));
  assert.throws(() =>
    parseModelResolution(
      {
        ...resolution,
        rates: [
          {
            ...resolution.rates[0],
            usdPerMillionTokens: { input: 1, output: 1 },
          },
        ],
      },
      trustedBundle,
    ),
  );
  for (const override of [
    { mappingRevision: 'forged' },
    { pricingRevision: 'forged' },
    { route: { ...resolution.route, deployment: 'forged' } },
    { route: { ...resolution.route, qualification: 'forged' } },
  ])
    assert.throws(() => parseModelResolution({ ...resolution, ...override }, trustedBundle), /identity mismatch/);
  assert.throws(() => {
    trustedBundle.models[0].rates[0].usdPerMillionTokens.input = 1;
  });
});

test('bundle rejects unsupported formats, adapters, frozen identity redefinitions, and forged initial prices', () => {
  for (const mutate of [
    b => {
      b.format = 2;
    },
    b => {
      b.routes[0].adapterVersion = 2;
    },
    b => {
      b.models[0].familyId = 'gpt-astra';
    },
    b => {
      b.models[0].id = 'gpt-6-astra';
    },
    b => {
      b.mapping.pricingRevision = 'prices-2026-10-19.1';
    },
    b => {
      b.mapping.revision = 'families-2026-10-19.1';
    },
    b => {
      b.routes[0].lifecycle = 'candidate';
    },
    b => {
      b.models[0].rates[0].usdPerMillionTokens.input = 0.0000001;
    },
    b => {
      b.routes[0].qualification = '';
    },
    b => {
      b.routes[0].boundedDecision = false;
    },
    b => {
      b.routes[0].maxInputTokens = 1000001;
    },
    b => {
      b.routes = [];
    },
    b => {
      b.models.push(b.models[0]);
    },
    b => {
      b.routes.push(b.routes[0]);
    },
    b => {
      b.models[0].rates.push(b.models[0].rates[0]);
    },
  ]) {
    const bundle = fixtureBundle();
    mutate(bundle);
    assert.throws(() => modelBundleSchema.parse(bundle));
  }
});

test('unknown usage and old prices survive successor resolution and rollback', () => {
  const before = fixtureBundle('before');
  const after = fixtureBundle('after');
  after.models[0].rates[0].usdPerMillionTokens.input = 9;
  const resolve = bundle =>
    resolveModelBundle({
      bundle,
      familyId: 'claude-opus',
      allowedProviders: ['anthropic'],
      allowedLocations: ['us'],
    });
  const historical = JSON.parse(JSON.stringify(resolve(before)));
  assert.equal(resolve(after).rates[0].usdPerMillionTokens.input, 9);
  assert.deepEqual(resolve(before), historical);
  assert.throws(() => parseModelResolution(historical, after), /identity mismatch/);
  for (const reason of ['missing', 'abandoned', 'invalid']) {
    assert.deepEqual(
      calculateModelCost({
        resolution: historical,
        trustedBundle: before,
        date: '2026-09-28',
        usage: { kind: 'unknown', reason },
      }),
      { kind: 'unknown', reason },
    );
  }
  const usage = {
    kind: 'known',
    tokens: {
      input: 1000000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
  };
  assert.equal(
    calculateModelCost({
      resolution: historical,
      trustedBundle: before,
      usage,
      date: '2026-09-28',
    }).providerPicoUsd,
    '7000000000000',
  );
  assert.equal(
    calculateModelCost({
      resolution: resolve(after),
      trustedBundle: after,
      usage,
      date: '2026-09-28',
    }).providerPicoUsd,
    '9000000000000',
  );
  assert.equal(historical.rates[0].usdPerMillionTokens.input, 7);
});

test('bundle resolution preserves location and provider restrictions without catalog fallback', () => {
  const input = {
    bundle: fixtureBundle(),
    familyId: 'claude-opus',
    allowedProviders: ['anthropic'],
    allowedLocations: ['us'],
  };
  assert.throws(() => resolveModelBundle({ ...input, allowedProviders: ['azure'] }), /route-unavailable/);
  assert.throws(() => resolveModelBundle({ ...input, allowedLocations: ['eu'] }), /route-unavailable/);
  assert.throws(() => resolveModelBundle({ ...input, familyId: 'gpt-astra' }), /unknown-family/);
  input.bundle.routes.push({ ...input.bundle.routes[0], id: 'second-route' });
  assert.throws(() => resolveModelBundle(input), /ambiguous-route/);
});

test('adjacent dated prices are accepted but overlapping prices are not', () => {
  const bundle = fixtureBundle();
  bundle.models[0].rates[0].validUntilExclusive = '2027-01-01';
  bundle.models[0].rates.push({
    ...bundle.models[0].rates[0],
    validFrom: '2027-01-01',
    validUntilExclusive: null,
  });
  assert.equal(modelBundleSchema.parse(bundle).models[0].rates.length, 2);
  bundle.models[0].rates[1].validFrom = '2026-12-31';
  assert.throws(() => modelBundleSchema.parse(bundle), /Ambiguous price schedule/);
});

test('server bundle id is the hash of its content and stored copies verify against it', () => {
  const {
    models,
    routes,
    mapping: { pricingRevision, families },
  } = fixtureBundle();
  const bundle = serverModelBundle({
    models,
    routes,
    pricingRevision,
    families,
  });
  assert.match(bundle.id, /^server-[0-9a-f]{64}$/);
  assert.equal(bundle.mapping.revision, bundle.id);
  const reordered = JSON.parse(JSON.stringify(models[0]), (key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  assert.equal(
    serverModelBundle({
      families,
      pricingRevision,
      routes,
      models: [reordered],
    }).id,
    bundle.id,
  );
  const stored = JSON.parse(JSON.stringify(bundle), (key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  assert.deepEqual(verifyServerModelBundle(bundle.id, stored), bundle);

  const repriced = structuredClone(stored);
  repriced.models[0].rates[0].usdPerMillionTokens.input = 1;
  assert.throws(() => verifyServerModelBundle(bundle.id, repriced), /Untrusted model bundle/);
  const rehashed = serverModelBundle({
    models: repriced.models,
    routes,
    pricingRevision,
    families,
  });
  assert.notEqual(rehashed.id, bundle.id);
  assert.throws(() => verifyServerModelBundle(bundle.id, rehashed), /Untrusted model bundle/);
  assert.throws(() => verifyServerModelBundle(rehashed.id, { ...repriced, id: rehashed.id }), /Untrusted model bundle/);
  assert.throws(() => verifyServerModelBundle('successor', fixtureBundle()), /Untrusted model bundle/);
  assert.throws(() => verifyServerModelBundle(bundle.id, { ...stored, extra: true }));
});

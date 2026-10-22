import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyModels, resolveModelFamily, initialModelMapping, modelFamilyIdSchema } from '../src/model-continuity.ts';
import { modelFamilyIdSchema as identifier, modelIdentifierSchema } from '../src/model-identifier.ts';
import { modelCatalogFamilySchema } from '../src/model-catalog.ts';
import { parseModelResolution } from '../src/model-bundle.ts';
import { calculateModelCost } from '../src/model-cost.ts';

const route = {
  id: 'opus-us',
  modelId: 'claude-opus-5-5',
  provider: 'anthropic',
  deployment: 'claude-opus-5-5',
  location: 'us',
  adapterVersion: 1,
  qualification: 'test-fixture',
  lifecycle: 'current',
  maxInputTokens: 1000000,
  maxOutputTokens: 128000,
  boundedDecision: true,
};
const input = {
  familyId: 'claude-opus',
  mapping: initialModelMapping,
  routes: [route],
  allowedProviders: ['anthropic', 'openai', 'xai', 'google', 'azure'],
  allowedLocations: ['us'],
};
const usage = tokens => ({
  kind: 'known',
  tokens: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    ...tokens,
  },
});

test('catalog identities use the same lightweight schema without changing accepted identifiers', () => {
  assert.equal(identifier, modelFamilyIdSchema);
  const family = {
    displayName: 'Model',
    vendor: 'acme',
    currentVersion: null,
    provider: 'azure',
    inputCreditsPerMillionTokens: null,
    outputCreditsPerMillionTokens: null,
    available: false,
    unavailableReason: 'model-family-unavailable',
    mappingRevision: null,
    pricingRevision: null,
    fallbackFor: [],
  };
  for (const id of ['gpt-sol', 'a'.repeat(100)]) {
    assert.equal(identifier.parse(id), id);
    assert.equal(modelCatalogFamilySchema.parse({ ...family, id }).id, id);
  }
  // Family IDs match the workspace table CHECK constraints; model IDs and revisions keep the wider pattern.
  assert.equal(modelIdentifierSchema.parse('0model.v_1'), '0model.v_1');
  for (const id of ['', 'UPPER', '-model', '0model.v_1', 'a'.repeat(101), 'has space']) {
    assert.equal(identifier.safeParse(id).success, false);
    assert.equal(modelCatalogFamilySchema.safeParse({ ...family, id }).success, false);
  }
});

test('the frozen record maps every initial family to one of its own models and cannot change', () => {
  for (const family of initialModelMapping.families) {
    const model = legacyModels.find(candidate => candidate.id === family.modelId);
    assert.equal(model?.familyId, family.id, family.id);
  }
  assert.equal(legacyModels.find(model => model.id === 'grok-4-6').vendor, 'xai');
  assert.throws(() => {
    legacyModels[0].rates[0].usdPerMillionTokens.input = 99;
  }, TypeError);
  assert.throws(() => {
    legacyModels.push(legacyModels[0]);
  }, TypeError);
});

test('initial price receipts reject forged families and contradictory initial mappings', () => {
  const receipt = JSON.parse(JSON.stringify(resolveModelFamily(input)));
  assert.equal(parseModelResolution(receipt).familyId, 'claude-opus');
  for (const familyId of ['claude-sonnet', 'gpt-astra', 'unknown']) {
    assert.throws(() => parseModelResolution({ ...receipt, familyId }), /family identity mismatch/);
    assert.throws(
      () =>
        calculateModelCost({
          resolution: { ...receipt, familyId },
          date: '2026-09-28',
          usage: usage({ input: 1 }),
        }),
      /family identity mismatch/,
    );
  }
  const old = resolveModelFamily({
    ...input,
    familyId: 'gemini-flash',
    mapping: {
      ...initialModelMapping,
      revision: 'historical',
      families: [{ id: 'gemini-flash', modelId: 'gemini-3-5-flash' }],
    },
    routes: [
      {
        ...route,
        modelId: 'gemini-3-5-flash',
        provider: 'google',
        maxOutputTokens: 64000,
      },
    ],
  });
  assert.equal(parseModelResolution(JSON.parse(JSON.stringify(old))).modelId, 'gemini-3-5-flash');
  assert.throws(
    () =>
      parseModelResolution({
        ...old,
        mappingRevision: initialModelMapping.revision,
      }),
    /mapping identity mismatch/,
  );
});

test('all recorded versions resolve only through explicitly supplied routes', () => {
  for (const { familyId, id: modelId, provider } of legacyModels) {
    const candidate = {
      ...input,
      familyId,
      mapping: {
        ...initialModelMapping,
        revision: 'catalog-fixture',
        families: [{ id: familyId, modelId }],
      },
      routes: [{ ...route, modelId, provider, maxInputTokens: 1, maxOutputTokens: 1 }],
    };
    const resolved = resolveModelFamily(candidate);
    assert.deepEqual([resolved.familyId, resolved.modelId, resolved.route.provider], [familyId, modelId, provider]);
    assert.throws(() => resolveModelFamily({ ...candidate, routes: [] }), /route-unavailable/);
  }
  assert.throws(
    () =>
      resolveModelFamily({
        ...input,
        familyId: 'grok-fast',
        mapping: {
          ...initialModelMapping,
          revision: 'wrong-family',
          families: [{ id: 'grok-fast', modelId: 'grok-4' }],
        },
      }),
    /unknown-model/,
  );
});

test('resolution requires a qualified configured current route under location and provider restrictions', () => {
  const resolved = resolveModelFamily(input);
  assert.equal(resolved.modelId, 'claude-opus-5-5');
  assert.equal(resolved.route.deployment, 'claude-opus-5-5');
  for (const overrides of [
    { routes: [] },
    { routes: [{ ...route, lifecycle: 'retired' }] },
    { allowedProviders: [] },
    { allowedLocations: [] },
  ])
    assert.throws(() => resolveModelFamily({ ...input, ...overrides }), /route-unavailable/);
  assert.throws(
    () =>
      resolveModelFamily({
        ...input,
        routes: [route, { ...route, id: 'second' }],
      }),
    /ambiguous-route/,
  );
  assert.throws(() =>
    resolveModelFamily({
      ...input,
      routes: [{ ...route, boundedDecision: undefined }],
    }),
  );
  assert.throws(
    () =>
      resolveModelFamily({
        ...input,
        routes: [{ ...route, maxInputTokens: 2000000 }],
      }),
    /route-unavailable/,
  );
});

test('Grok exposes two Azure models and prices the Fast deployment as 4.3', () => {
  assert.deepEqual(
    initialModelMapping.families
      .filter(family => family.id.startsWith('grok'))
      .map(family => [family.id, family.modelId]),
    [
      ['grok', 'grok-4-6'],
      ['grok-fast', 'grok-4.3'],
    ],
  );
  const resolved = resolveModelFamily({
    ...input,
    familyId: 'grok-fast',
    routes: [
      {
        ...route,
        id: 'grok-fast-azure',
        modelId: 'grok-4.3',
        provider: 'azure',
        deployment: 'grok-4.3',
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
      },
    ],
  });
  assert.equal(resolved.route.deployment, 'grok-4.3');
  assert.equal(
    calculateModelCost({
      resolution: resolved,
      date: '2026-09-29',
      usage: usage({ input: 1000, output: 1000, cacheRead: 1000 }),
    }).providerPicoUsd,
    '3950000000',
  );
  assert.throws(() => resolveModelFamily({ ...input, familyId: 'grok-fast-reasoning' }), /unknown-family/);
});

test('unknown formats, prices, families and cross-family replacements fail closed', () => {
  assert.throws(() =>
    resolveModelFamily({
      ...input,
      mapping: { ...initialModelMapping, format: 2 },
    }),
  );
  assert.throws(
    () =>
      resolveModelFamily({
        ...input,
        mapping: { ...initialModelMapping, pricingRevision: 'future' },
      }),
    /unsupported-pricing/,
  );
  assert.throws(() => resolveModelFamily({ ...input, familyId: 'unknown' }), /unknown-family/);
  assert.throws(
    () =>
      resolveModelFamily({
        ...input,
        mapping: {
          ...initialModelMapping,
          families: [{ id: 'claude-opus', modelId: 'gpt-6-astra' }],
        },
      }),
    /unknown-model/,
  );
});

test('Kimi resolves to the deployed Azure model while removed GLM families are rejected', () => {
  const resolved = resolveModelFamily({
    ...input,
    familyId: 'kimi',
    routes: [
      {
        ...route,
        id: 'kimi-azure',
        modelId: 'kimi-k2-6',
        provider: 'azure',
        deployment: 'Kimi-K2.6',
        maxInputTokens: 262144,
        maxOutputTokens: 262144,
      },
    ],
  });
  assert.equal(resolved.modelId, 'kimi-k2-6');
  assert.equal(resolved.route.deployment, 'Kimi-K2.6');
  assert.equal(
    calculateModelCost({
      resolution: resolved,
      date: '2026-09-29',
      usage: usage({ input: 1000, output: 1000, cacheRead: 1000 }),
    }).providerPicoUsd,
    '5110000000',
  );
  for (const familyId of ['glm', 'glm-fast']) {
    assert.equal(
      initialModelMapping.families.some(family => family.id === familyId),
      false,
    );
    assert.throws(() => resolveModelFamily({ ...input, familyId }), /unknown-family/);
  }
});

test('promotion and rollback produce new snapshots without changing earlier resolution', () => {
  const gemini = {
    ...route,
    id: 'gemini-us',
    provider: 'google',
    modelId: 'gemini-3-5-flash',
    maxOutputTokens: 64000,
  };
  const oldMapping = {
    ...initialModelMapping,
    revision: 'old',
    families: [{ id: 'gemini-flash', modelId: 'gemini-3-5-flash' }],
  };
  const before = resolveModelFamily({
    ...input,
    familyId: 'gemini-flash',
    mapping: oldMapping,
    routes: [gemini],
  });
  const after = resolveModelFamily({
    ...input,
    familyId: 'gemini-flash',
    routes: [{ ...gemini, modelId: 'gemini-3-8-flash' }],
  });
  const rolledBack = resolveModelFamily({
    ...input,
    familyId: 'gemini-flash',
    mapping: { ...oldMapping, revision: 'rollback' },
    routes: [gemini],
  });
  assert.deepEqual(
    [before.modelId, after.modelId, rolledBack.modelId],
    ['gemini-3-5-flash', 'gemini-3-8-flash', 'gemini-3-5-flash'],
  );
  assert.equal(before.mappingRevision, 'old');
  assert.throws(() => {
    after.rates[0].usdPerMillionTokens.input = 999;
  }, TypeError);
  assert.throws(() => {
    initialModelMapping.families[0].modelId = 'different';
  }, TypeError);
  assert.equal(before.rates[0].usdPerMillionTokens.input, 1.5);
});

test('exact cost accounts for disjoint cache buckets and keeps missing usage unknown', () => {
  const resolution = resolveModelFamily(input);
  assert.equal(
    calculateModelCost({
      resolution,
      date: '2026-09-28',
      usage: usage({
        input: 100,
        output: 10,
        cacheRead: 50,
        cacheWrite5m: 20,
        cacheWrite1h: 10,
      }),
    }).providerPicoUsd,
    '790000000',
  );
  assert.deepEqual(
    calculateModelCost({
      resolution,
      date: '2026-09-28',
      usage: { kind: 'unknown', reason: 'missing' },
    }),
    { kind: 'unknown', reason: 'missing' },
  );
  assert.equal(calculateModelCost({ resolution, date: '2026-09-28', usage: usage({}) }).providerPicoUsd, '0');
  assert.throws(
    () =>
      calculateModelCost({
        resolution,
        date: '2026-09-28',
        usage: usage({ cacheWrite: 1 }),
      }),
    /Unpriced usage/,
  );
  const tampered = JSON.parse(JSON.stringify(resolution));
  tampered.rates[0].usdPerMillionTokens.input = 99;
  assert.throws(
    () =>
      calculateModelCost({
        resolution: tampered,
        date: '2026-09-28',
        usage: usage({ input: 1 }),
      }),
    /price identity mismatch/,
  );
});

test('context tiers use cached prompt tokens and apply the selected rate to the whole request', () => {
  const resolution = resolveModelFamily({
    ...input,
    familyId: 'gpt-astra',
    routes: [
      {
        ...route,
        provider: 'azure',
        modelId: 'gpt-6-astra',
        maxInputTokens: 922000,
      },
    ],
  });
  assert.equal(
    calculateModelCost({
      resolution,
      date: '2026-09-28',
      usage: usage({ input: 272000, output: 1 }),
    }).providerPicoUsd,
    '2720050000000',
  );
  assert.equal(
    calculateModelCost({
      resolution,
      date: '2026-09-28',
      usage: usage({ input: 272000, cacheRead: 1, output: 1 }),
    }).providerPicoUsd,
    '5440077000000',
  );
});

test('dated price schedules retain both sides of the effective-date boundary', () => {
  const resolution = resolveModelFamily({
    ...input,
    familyId: 'gemini-flash',
    routes: [
      {
        ...route,
        provider: 'google',
        modelId: 'gemini-3-8-flash',
        maxOutputTokens: 64000,
      },
    ],
  });
  assert.equal(
    calculateModelCost({
      resolution,
      date: '2026-12-31',
      usage: usage({ input: 1000000 }),
    }).providerPicoUsd,
    '750000000000',
  );
  assert.equal(
    calculateModelCost({
      resolution,
      date: '2027-01-01',
      usage: usage({ input: 1000000 }),
    }).providerPicoUsd,
    '1500000000000',
  );
  assert.throws(() => calculateModelCost({ resolution, date: 'not-a-date', usage: usage({}) }));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerModelCatalog } from '../src/model-catalog.ts';
import { modelCatalogSchema } from '../../../packages/config/src/model-catalog.ts';
import {
  initialModelMapping,
  legacyModels,
  resolveModelFamily,
} from '../../../packages/config/src/model-continuity.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

// Every provider key is set, so the shipped catalog serves all of its models.
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'k',
  XAI_API_KEY: 'k',
  GEMINI_API_KEY: 'k',
  AZURE_FOUNDRY_API_KEY: 'k',
  AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
});

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
const membershipId = '33333333-3333-4333-8333-333333333333';
const userId = 'signed-in-user';

function trustedResolution({ modelFamilyId }, modelId, mappingRevision = initialModelMapping.revision) {
  const family = initialModelMapping.families.find(candidate => candidate.id === modelFamilyId);
  const model = legacyModels.find(candidate => candidate.id === (modelId ?? family.modelId));
  return resolveModelFamily({
    familyId: modelFamilyId,
    mapping: {
      ...initialModelMapping,
      revision: mappingRevision,
      families: initialModelMapping.families.map(item =>
        item.id === modelFamilyId ? { ...item, modelId: model.id } : item,
      ),
    },
    routes: [
      {
        id: 'qualified-test',
        modelId: model.id,
        provider: model.provider,
        deployment: 'private-deployment',
        location: 'eastus',
        adapterVersion: 1,
        qualification: 'local-fixture',
        lifecycle: 'current',
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        boundedDecision: true,
      },
    ],
    allowedProviders: [model.provider],
    allowedLocations: ['eastus'],
  });
}

function fixture(t, eligible, resolve = trustedResolution, snapshot) {
  const state = {
    signedIn: true,
    member: true,
    current: true,
    role: 'member',
    brokenStorage: false,
    projected: false,
    checked: false,
  };
  const app = Fastify();
  t.after(() => app.close());
  const dependencies = {
    auth: {
      api: {
        async getSession({ headers }) {
          assert.equal(headers.get('cookie'), 'session=test');
          return state.signedIn ? { user: { id: userId } } : null;
        },
      },
    },
    compatibility: commonCompatibility,
    runtime: {
      async transaction(id, compatibility, operation) {
        assert.deepEqual(compatibility, commonCompatibility);
        if (state.brokenStorage) throw new Error('postgres://private-password');
        state.checked = false;
        return operation({
          schema: 'catalog_test',
          client: {
            async query(sql, values) {
              if (sql.includes('tf_model_availability')) return { rows: [], rowCount: 0 };
              if (sql.includes('tf_authorization_lock')) {
                assert.match(sql, /FOR SHARE$/);
                return { rows: [{ id: 1 }], rowCount: 1 };
              }
              assert.match(sql, /"catalog_test"\."tf_memberships"/);
              assert.match(sql, /removed_at IS NULL/);
              const checkingCurrent = sql.includes('WHERE id = $1');
              assert.deepEqual(values, checkingCurrent ? [membershipId, userId] : [userId]);
              state.checked = checkingCurrent;
              const rows =
                id === workspaceId && state.member && (!checkingCurrent || state.current)
                  ? [{ id: membershipId, user_id: userId, role: state.role }]
                  : [];
              return { rows, rowCount: rows.length };
            },
          },
        });
      },
    },
  };
  if (eligible)
    dependencies.modelFamilyEligibility = input => {
      assert.equal(state.checked, true, 'membership must be current before projection');
      state.projected = true;
      return eligible(input);
    };
  if (resolve)
    dependencies.modelFamilyResolution = input => {
      assert.equal(state.checked, true, 'membership must be current before resolution');
      assert.equal(input.workspaceId, workspaceId);
      state.projected = true;
      return resolve(input);
    };
  if (snapshot)
    dependencies.modelCatalogSnapshot = async id => {
      assert.equal(state.checked, true, 'membership must be current before snapshot acquisition');
      assert.equal(id, workspaceId);
      state.projected = true;
      return snapshot(id);
    };
  app.register(async routes => registerModelCatalog(routes, dependencies), { prefix: '/v1' });
  return {
    state,
    request: (id = workspaceId) =>
      app.inject({ url: `/v1/workspaces/${id}/model-catalog`, headers: { cookie: 'session=test' } }),
  };
}

test('catalog requires authentication and current membership before projecting any eligibility', async t => {
  const { state, request } = fixture(t, () => true);
  state.signedIn = false;
  let response = await request();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'sign-in-required' });
  assert.equal(state.projected, false);
  state.signedIn = true;
  for (const membership of [
    { member: false, current: true },
    { member: true, current: false },
  ]) {
    Object.assign(state, membership);
    response = await request();
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'model-catalog-not-found' });
    assert.equal(state.projected, false);
  }
  state.current = true;
  response = await request(otherWorkspaceId);
  assert.equal(response.statusCode, 404);
  assert.equal(state.projected, false);
  response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().families[0].available, true);
  assert.equal(state.projected, true);
});

test('catalog prices and families are visible but disabled without trusted eligibility', async t => {
  const { request } = fixture(t);
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const catalog = modelCatalogSchema.parse(response.json());
  assert.equal(catalog.families.length, 15);
  assert.equal(
    catalog.families.some(family => family.provider === 'google'),
    true,
  );
  assert.deepEqual(catalog.families[0], {
    id: 'claude-haiku',
    displayName: 'Claude Haiku',
    vendor: 'anthropic',
    currentVersion: 'claude-haiku-4-5',
    provider: 'anthropic',
    available: false,
    unavailableReason: 'model-family-unavailable',
    mappingRevision: null,
    pricingRevision: null,
    inputCreditsPerMillionTokens: 100,
    outputCreditsPerMillionTokens: 500,
    fallbackFor: [],
  });
  for (const family of catalog.families) {
    assert.equal(family.available, false);
    assert.equal(family.unavailableReason, 'model-family-unavailable');
    assert.deepEqual(family.fallbackFor, []);
  }
});

test('members and admins receive only eligible, directional non-self fallback pairs', async t => {
  const { state, request } = fixture(t, input => {
    assert.equal(input.workspaceId, workspaceId);
    if (input.fallbackFor) return input.modelFamilyId === 'gpt-astra' && input.fallbackFor === 'claude-opus';
    return ['claude-opus', 'gpt-astra'].includes(input.modelFamilyId);
  });
  for (const role of ['member', 'admin']) {
    state.role = role;
    const response = await request();
    assert.equal(response.statusCode, 200);
    const families = modelCatalogSchema.parse(response.json()).families;
    assert.deepEqual(
      families.find(family => family.id === 'gpt-astra'),
      {
        id: 'gpt-astra',
        displayName: 'GPT Astra',
        vendor: 'openai',
        currentVersion: 'gpt-6-astra',
        provider: 'azure',
        available: true,
        unavailableReason: null,
        inputCreditsPerMillionTokens: 1000,
        outputCreditsPerMillionTokens: 5000,
        mappingRevision: 'families-2026-10-19.1',
        pricingRevision: 'prices-2026-10-19.1',
        fallbackFor: ['claude-opus'],
      },
    );
    assert.deepEqual(families.find(family => family.id === 'claude-opus').fallbackFor, []);
    assert.equal(families.find(family => family.id === 'claude-haiku').available, false);
  }
});

test('catalog lists Gemini with the other families when an eligibility dependency enables every family', async t => {
  const { request } = fixture(t, () => true);
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().families.length, 15);
  assert.equal(
    response.json().families.every(family => family.available),
    true,
  );
  assert.deepEqual(
    response
      .json()
      .families.filter(family => family.id.startsWith('gemini'))
      .map(family => family.provider),
    ['google', 'google'],
  );
  assert.equal(
    response.json().families.find(family => family.id === 'deepseek-flash').inputCreditsPerMillionTokens,
    19,
  );
});

test('invalid paths and dependency failures return safe errors without credentials', async t => {
  const { state, request } = fixture(t, () => {
    throw new Error('api-key=private-secret');
  });
  const invalid = await request('not-a-uuid');
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'invalid-request' });
  assert.equal(state.projected, false);
  const unavailable = await request();
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: 'model-catalog-unavailable' });
  assert.equal(unavailable.headers['cache-control'], 'no-store');
  state.brokenStorage = true;
  const storage = await request();
  assert.equal(storage.statusCode, 503);
  assert.deepEqual(storage.json(), { error: 'model-catalog-unavailable' });
});

test('truthy non-boolean eligibility fails closed', async t => {
  const { request } = fixture(t, () => 'configured');
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().families[0].available, false);
  assert.deepEqual(response.json().families[0].fallbackFor, []);
});

test('permissive pair eligibility cannot include unavailable sources or self fallback', async t => {
  const { request } = fixture(
    t,
    input => input.fallbackFor !== undefined || ['claude-opus', 'gpt-astra'].includes(input.modelFamilyId),
  );
  const response = await request();
  assert.equal(response.statusCode, 200);
  const families = response.json().families;
  assert.deepEqual(families.find(family => family.id === 'claude-opus').fallbackFor, ['gpt-astra']);
  assert.deepEqual(families.find(family => family.id === 'gpt-astra').fallbackFor, ['claude-opus']);
  assert.deepEqual(families.find(family => family.id === 'claude-haiku').fallbackFor, []);
});

test('trusted rollback supplies the displayed version and prices instead of the static family default', async t => {
  const { request } = fixture(
    t,
    input => input.modelFamilyId === 'grok',
    input => trustedResolution(input, 'grok-4', 'rollback-1'),
  );
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().families.find(family => family.id === 'grok'),
    {
      id: 'grok',
      displayName: 'Grok',
      vendor: 'xai',
      currentVersion: 'grok-4',
      provider: 'azure',
      available: true,
      unavailableReason: null,
      mappingRevision: 'rollback-1',
      pricingRevision: 'prices-2026-10-19.1',
      inputCreditsPerMillionTokens: 300,
      outputCreditsPerMillionTokens: 1500,
      fallbackFor: [],
    },
  );
});

test('eligibility alone, resolution alone, and a missing family resolution cannot enable a family', async t => {
  for (const [eligible, resolve] of [
    [() => true, null],
    [undefined, trustedResolution],
    [() => true, () => null],
  ]) {
    const { request } = fixture(t, eligible, resolve);
    const response = await request();
    assert.equal(response.statusCode, 200);
    for (const family of response.json().families) {
      assert.equal(family.available, false);
      assert.equal(family.mappingRevision, null);
      assert.equal(family.pricingRevision, null);
      assert.deepEqual(family.fallbackFor, []);
    }
  }
});

test('trusted future bundle versions and prices are projected without original-price validation or private route fields', async t => {
  const { request } = fixture(
    t,
    input => input.modelFamilyId === 'grok',
    input => ({
      ...trustedResolution(input),
      modelId: 'grok-next',
      mappingRevision: 'promotion-2',
      pricingRevision: 'prices-future-2',
      rates: [
        {
          validFrom: null,
          validUntilExclusive: null,
          promptTokensAbove: null,
          usdPerMillionTokens: { input: 4, output: 16 },
        },
      ],
      credential: 'private-secret',
      route: {
        modelId: 'grok-next',
        provider: 'azure',
        lifecycle: 'current',
        boundedDecision: true,
        deployment: 'private-deployment',
        apiKey: 'private-secret',
        endpoint: 'https://private-endpoint',
      },
    }),
  );
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    modelCatalogSchema.parse(response.json()).families.find(family => family.id === 'grok'),
    {
      id: 'grok',
      displayName: 'Grok',
      vendor: 'xai',
      currentVersion: 'grok-next',
      provider: 'azure',
      available: true,
      unavailableReason: null,
      mappingRevision: 'promotion-2',
      pricingRevision: 'prices-future-2',
      inputCreditsPerMillionTokens: 400,
      outputCreditsPerMillionTokens: 1600,
      fallbackFor: [],
    },
  );
  assert.doesNotMatch(response.body, /private-|credential|apiKey|deployment|endpoint/);
});

test('mismatched or unqualified resolutions fail closed with a safe error', async t => {
  for (const change of [
    value => ({ ...value, familyId: 'claude-opus' }),
    value => ({ ...value, route: { ...value.route, modelId: 'other-model' } }),
    value => ({ ...value, route: { ...value.route, lifecycle: 'retired' } }),
    value => ({ ...value, rates: [] }),
    () => {
      throw new Error('private-resolution-secret');
    },
  ]) {
    const { request } = fixture(
      t,
      input => input.modelFamilyId === 'grok',
      input => change(trustedResolution(input)),
    );
    const response = await request();
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'model-catalog-unavailable' });
  }
});

test('fallback pairs exclude eligible sources without a trusted resolution', async t => {
  const { request } = fixture(
    t,
    () => true,
    input => (input.modelFamilyId === 'grok' ? trustedResolution(input) : null),
  );
  const response = await request();
  assert.equal(response.statusCode, 200);
  const families = response.json().families;
  assert.equal(families.find(family => family.id === 'grok').available, true);
  assert.deepEqual(families.find(family => family.id === 'grok').fallbackFor, []);
  assert.equal(families.find(family => family.id === 'claude-opus').available, false);
});

test('one authorized snapshot supplies consistent versions and prices across promotion during projection', async t => {
  let acquisitions = 0;
  let activeRevision = 2;
  const { state, request } = fixture(
    t,
    () => {
      throw new Error('Static eligibility must not run');
    },
    () => {
      throw new Error('Static resolution must not run');
    },
    async id => {
      acquisitions++;
      const revision = activeRevision;
      await Promise.resolve();
      return {
        modelFamilyEligibility(input) {
          assert.equal(input.workspaceId, id);
          activeRevision = 3;
          return ['grok', 'gpt-astra'].includes(input.modelFamilyId);
        },
        modelFamilyResolution(input) {
          assert.equal(input.workspaceId, id);
          const original = trustedResolution(input);
          return {
            ...original,
            modelId: `${input.modelFamilyId}-next-${revision}`,
            mappingRevision: `promotion-${revision}`,
            pricingRevision: `prices-${revision}`,
            route: { ...original.route, modelId: `${input.modelFamilyId}-next-${revision}` },
            rates: [
              {
                validFrom: null,
                validUntilExclusive: null,
                promptTokensAbove: null,
                usdPerMillionTokens: { input: revision, output: revision * 4 },
              },
            ],
          };
        },
      };
    },
  );
  state.signedIn = false;
  assert.equal((await request()).statusCode, 401);
  state.signedIn = true;
  state.current = false;
  assert.equal((await request()).statusCode, 404);
  state.current = true;
  assert.equal((await request(otherWorkspaceId)).statusCode, 404);
  assert.equal(acquisitions, 0);
  for (const revision of [2, 3]) {
    const response = await request();
    assert.equal(response.statusCode, 200);
    assert.equal(acquisitions, revision - 1);
    assert.deepEqual(
      response
        .json()
        .families.filter(family => family.available)
        .map(family => ({
          id: family.id,
          currentVersion: family.currentVersion,
          mappingRevision: family.mappingRevision,
          pricingRevision: family.pricingRevision,
          input: family.inputCreditsPerMillionTokens,
          output: family.outputCreditsPerMillionTokens,
          fallbackFor: family.fallbackFor,
        })),
      [
        {
          id: 'gpt-astra',
          currentVersion: `gpt-astra-next-${revision}`,
          mappingRevision: `promotion-${revision}`,
          pricingRevision: `prices-${revision}`,
          input: revision * 100,
          output: revision * 400,
          fallbackFor: ['grok'],
        },
        {
          id: 'grok',
          currentVersion: `grok-next-${revision}`,
          mappingRevision: `promotion-${revision}`,
          pricingRevision: `prices-${revision}`,
          input: revision * 100,
          output: revision * 400,
          fallbackFor: ['gpt-astra'],
        },
      ],
    );
  }
});

test('snapshot acquisition failures are hidden and never fall back to static callbacks', async t => {
  let acquisitions = 0;
  const { request } = fixture(
    t,
    () => true,
    trustedResolution,
    async () => {
      acquisitions++;
      throw new Error('registry-password=private-secret');
    },
  );
  const response = await request();
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: 'model-catalog-unavailable' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(acquisitions, 1);
});

test('a single provider credential makes exactly that provider’s families available, each priced from its own entry', async t => {
  const { createModelConfiguration } = await import('../src/model-configuration.ts');
  const pool = { query: async () => assert.fail('configuration must not query the database') };
  for (const [provider, env, families] of [
    ['anthropic', { ANTHROPIC_API_KEY: 'k' }, ['claude-haiku', 'claude-sonnet', 'claude-opus', 'claude-fable']],
    ['openai', { OPENAI_API_KEY: 'k' }, ['gpt-luna', 'gpt-sol', 'gpt-astra']],
    ['xai', { XAI_API_KEY: 'k' }, ['grok', 'grok-fast']],
    ['google', { GEMINI_API_KEY: 'k' }, ['gemini-flash', 'gemini-pro']],
    [
      'azure',
      { AZURE_FOUNDRY_API_KEY: 'k', AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/' },
      ['gpt-luna', 'gpt-sol', 'gpt-astra', 'deepseek-pro', 'deepseek-flash', 'grok', 'grok-fast', 'kimi', 'kimi-code'],
    ],
  ]) {
    const { modelCatalogSnapshot } = createModelConfiguration({ pool, env });
    const { request } = fixture(t, undefined, null, modelCatalogSnapshot);
    const response = await request();
    assert.equal(response.statusCode, 200);
    const available = response.json().families.filter(family => family.available);
    assert.deepEqual(
      available.map(family => family.id),
      families,
      provider,
    );
    for (const family of available) {
      const model = legacyModels.find(candidate => candidate.id === family.currentVersion);
      assert.equal(family.provider, provider, family.id);
      assert.equal(model.provider, provider, family.id);
      const base = model.rates.find(rate => rate.promptTokensAbove === null);
      // 100 credits per USD.
      assert.equal(family.inputCreditsPerMillionTokens, base.usdPerMillionTokens.input * 100, family.id);
      assert.equal(family.outputCreditsPerMillionTokens, base.usdPerMillionTokens.output * 100, family.id);
    }
  }
});

test('paused families stay listed as temporarily unavailable and keep fallback options as a source', async t => {
  const eligibleFamilies = ['claude-opus', 'gpt-astra'];
  const { request } = fixture(t, undefined, undefined, async () => ({
    modelFamilyEligibility(input) {
      if (input.fallbackFor) return input.modelFamilyId === 'gpt-astra' && input.fallbackFor === 'claude-opus';
      return (
        eligibleFamilies.includes(input.modelFamilyId) && (input.existing || input.modelFamilyId !== 'claude-opus')
      );
    },
    modelFamilyResolution: input => trustedResolution(input),
    modelFamilyPaused: familyId => familyId === 'claude-opus',
  }));
  const response = await request();
  assert.equal(response.statusCode, 200);
  const families = modelCatalogSchema.parse(response.json()).families;
  const opus = families.find(family => family.id === 'claude-opus');
  assert.equal(opus.displayName, 'Claude Opus');
  assert.equal(opus.available, false);
  assert.equal(opus.unavailableReason, 'model-family-paused');
  assert.deepEqual(opus.fallbackFor, []);
  assert.deepEqual(families.find(family => family.id === 'gpt-astra').fallbackFor, ['claude-opus']);
});

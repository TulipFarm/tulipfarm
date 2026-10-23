import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { createModelConfiguration } from '../src/model-configuration.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credential = 'synthetic-private-test-credential';
const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const catalogOf = (ids, change = model => model) =>
  JSON.stringify({
    ...shipped,
    models: ids.map(id => change({ ...shipped.models.find(model => model.id === id), default: id === ids[0] })),
  });
const env = { MODEL_CATALOG: catalogOf(['claude-opus', 'claude-sonnet']), ANTHROPIC_API_KEY: credential };
const pool = {
  query: async () => {
    throw new Error('configuration must not query the database');
  },
};
const request = (modelFamilyId = 'claude-opus', extra = {}) => ({ workspaceId, modelFamilyId, ...extra });

test('configuration without a provider key fails at composition', () => {
  assert.throws(() => createModelConfiguration({ pool, env: {} }), {
    message: /no model has a route with its key set/,
  });
});

test('configured families resolve with pricing and fallback needs both sides configured', async () => {
  const configured = createModelConfiguration({ pool, env });
  assert.notEqual(configured.modelContinuity, null);
  const snapshot = await configured.modelCatalogSnapshot(workspaceId);
  assert.equal(snapshot.modelFamilyEligibility(request()), true);
  assert.equal(snapshot.modelFamilyEligibility(request('claude-haiku')), false);
  assert.equal(snapshot.modelFamilyEligibility(request('claude-sonnet', { fallbackFor: 'claude-opus' })), true);
  assert.equal(snapshot.modelFamilyEligibility(request('claude-opus', { fallbackFor: 'claude-opus' })), false);
  assert.equal(snapshot.modelFamilyEligibility(request('claude-opus', { fallbackFor: 'claude-haiku' })), false);
  assert.equal(await configured.modelFamilyEligibility(request('claude-sonnet', { fallbackFor: 'claude-opus' })), true);
  const resolution = snapshot.modelFamilyResolution(request());
  assert.equal(resolution.modelId, 'claude-opus-5-5');
  assert.ok(resolution.rates.length > 0);
  assert.deepEqual(Object.keys(resolution.route).sort(), ['boundedDecision', 'lifecycle', 'modelId', 'provider']);
  assert.equal(JSON.stringify(resolution).includes(credential), false);
});

test('paused and non-selectable models serve existing work but cannot be chosen anew', async () => {
  const configured = createModelConfiguration({
    pool,
    env: {
      ANTHROPIC_API_KEY: credential,
      MODEL_CATALOG: catalogOf(['claude-sonnet', 'claude-opus', 'claude-haiku'], model =>
        model.id === 'claude-opus'
          ? { ...model, paused: true }
          : model.id === 'claude-haiku'
            ? { ...model, selectable: false }
            : model,
      ),
    },
  });
  const snapshot = await configured.modelCatalogSnapshot(workspaceId);
  for (const family of ['claude-opus', 'claude-haiku']) {
    assert.equal(snapshot.modelFamilyEligibility(request(family)), false, family);
    assert.equal(snapshot.modelFamilyEligibility(request(family, { existing: true })), true, family);
    assert.ok(snapshot.modelFamilyResolution(request(family)), family);
  }
  assert.equal(snapshot.modelFamilyEligibility(request('claude-sonnet')), true);
  assert.equal(snapshot.modelFamilyPaused('claude-opus'), true);
  assert.equal(snapshot.modelFamilyPaused('claude-haiku'), false);
});

test('the catalog and worker model calls enable the same families with the same price', async () => {
  const { conversationModel } = await import('../../worker/src/conversation-model.ts');
  const served = { MODEL_CATALOG: catalogOf(['claude-sonnet', 'claude-haiku']), ANTHROPIC_API_KEY: credential };
  const snapshot = await createModelConfiguration({ pool, env: served }).modelCatalogSnapshot(workspaceId);
  for (const family of ['claude-haiku', 'claude-sonnet', 'claude-opus', 'gpt-sol', 'unknown-family']) {
    const resolution = snapshot.modelFamilyResolution(request(family));
    const model = conversationModel(family, served);
    assert.equal(snapshot.modelFamilyEligibility(request(family)), model !== null, family);
    if (!model) {
      assert.equal(resolution, null, family);
      continue;
    }
    assert.equal(model.price.modelId, resolution.modelId);
    assert.equal(model.price.pricingRevision, resolution.pricingRevision);
    assert.deepEqual(model.price.rates, resolution.rates);
  }
  assert.ok(conversationModel('claude-haiku', served) && conversationModel('claude-sonnet', served));
  assert.equal(snapshot.modelFamilyEligibility(request('claude-opus')), false);
  assert.equal(conversationModel('claude-opus', served), null);
});

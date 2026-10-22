import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelConfiguration } from '../src/model-configuration.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credential = 'synthetic-private-test-credential';
const env = { MODEL_FAMILIES: 'claude-opus,claude-sonnet', ANTHROPIC_API_KEY: credential };
const pool = {
  query: async () => {
    throw new Error('configuration must not query the database');
  },
};
const request = (modelFamilyId = 'claude-opus', extra = {}) => ({ workspaceId, modelFamilyId, ...extra });

test('absent configuration denies every family', async () => {
  const configured = createModelConfiguration({ pool, env: {} });
  assert.equal(configured.modelContinuity, null);
  const snapshot = await configured.modelCatalogSnapshot(workspaceId);
  assert.equal(snapshot.modelFamilyEligibility(request()), false);
  assert.equal(snapshot.modelFamilyResolution(request()), null);
  assert.equal(await configured.modelFamilyEligibility(request()), false);
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

test('invalid configuration fails at composition', () => {
  assert.throws(() => createModelConfiguration({ pool, env: { MODEL_FAMILIES: 'claude-opus' } }), {
    message: 'Invalid server model configuration',
  });
});

test('the catalog and worker model calls enable the same families with the same price', async () => {
  const { conversationModel } = await import('../../worker/src/conversation-model.ts');
  const shipped = { MODEL_FAMILIES: 'claude-haiku,claude-sonnet', ANTHROPIC_API_KEY: credential };
  const snapshot = await createModelConfiguration({ pool, env: shipped }).modelCatalogSnapshot(workspaceId);
  for (const family of ['claude-haiku', 'claude-sonnet', 'claude-opus', 'gpt-sol', 'unknown-family']) {
    const resolution = snapshot.modelFamilyResolution(request(family));
    const model = conversationModel(family, shipped);
    assert.equal(snapshot.modelFamilyEligibility(request(family)), model !== null, family);
    if (!model) {
      assert.equal(resolution, null, family);
      continue;
    }
    assert.equal(model.price.modelId, resolution.modelId);
    assert.equal(model.price.pricingRevision, resolution.pricingRevision);
    assert.deepEqual(model.price.rates, resolution.rates);
  }
  assert.ok(conversationModel('claude-haiku', shipped) && conversationModel('claude-sonnet', shipped));
  assert.equal(snapshot.modelFamilyEligibility(request('claude-opus')), false);
  assert.equal(conversationModel('claude-opus', shipped), null);
});

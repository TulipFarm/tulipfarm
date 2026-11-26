import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  equivalentPlanFamilyIds,
  planCatalogModel,
  planModelFamilyId,
  planModelOfFamily,
  readModelCatalog,
} from '../src/index.ts';

test('dynamic plan and BYOK family IDs round-trip and scope custom endpoints per connection', () => {
  const copilotId = planModelFamilyId('copilot', 'gemini-4-neon');
  assert.equal(copilotId, 'copilot-gemini-4-neon');
  assert.deepEqual(planModelOfFamily(copilotId), { provider: 'copilot', model: 'gemini-4-neon' });

  const connA = 'aaaaaaaa-1111-4222-8333-444444444444';
  const connB = 'bbbbbbbb-1111-4222-8333-444444444444';
  const idA = planModelFamilyId('byok-openai-compatible', 'anthropic/claude-sonnet-5', connA);
  const idB = planModelFamilyId('byok-openai-compatible', 'anthropic/claude-sonnet-5', connB);
  assert.notEqual(idA, idB);
  assert.deepEqual(planModelOfFamily(idA), {
    provider: 'byok-openai-compatible',
    model: 'anthropic/claude-sonnet-5',
    connectionPrefix: 'aaaaaaaa',
  });
  assert.deepEqual(planModelOfFamily(idB), {
    provider: 'byok-openai-compatible',
    model: 'anthropic/claude-sonnet-5',
    connectionPrefix: 'bbbbbbbb',
  });
});

test('equivalentPlanFamilyIds links legacy short plan IDs with derived slug IDs', () => {
  assert.deepEqual(equivalentPlanFamilyIds('chatgpt-sol').sort(), ['chatgpt-gpt-6--1-sol', 'chatgpt-sol']);
  assert.deepEqual(equivalentPlanFamilyIds('chatgpt-gpt-6--1-sol').sort(), ['chatgpt-gpt-6--1-sol', 'chatgpt-sol']);
  assert.deepEqual(equivalentPlanFamilyIds('copilot-gemini-4-neon'), ['copilot-gemini-4-neon']);
});

test('planCatalogModel propagates provider-reported token limits and vision metadata', () => {
  const { catalog } = readModelCatalog();
  const built = planCatalogModel(catalog, 'byok-openai-compatible', 'openai/gpt-custom', 'GPT Custom', {
    maxInputTokens: 32000,
    maxOutputTokens: 4096,
    imageInput: true,
    connectionId: '12345678-1111-4222-8333-444444444444',
  });
  assert.ok(built);
  assert.equal(built.id, 'byok-compat-12345678-openai--sgpt-custom');
  assert.equal(built.limits.maxInputTokens, 32000);
  assert.equal(built.limits.maxOutputTokens, 4096);
  assert.equal(built.capabilities?.imageInput, true);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compactionBudgetFamilies,
  compactionDefaultFamily,
  compactionModelFamilies,
  modelFamilyEntrySchema,
  modelRoleDefault,
  modelRoles,
  modelRoleWarnings,
  pausedModelFamilies,
} from '../src/index.ts';
import { defaultChatModelFamilyId, modelCatalogSchema } from '../src/model-catalog.ts';
import { buildModelCatalog, modelCatalogRevision } from '../src/model-catalog-source.ts';
import { modelPricingEntrySchema } from '../src/model-continuity.ts';
import families from '../src/model-families.json' with { type: 'json' };
import pricing from '../src/model-pricing.json' with { type: 'json' };

const openaiOnly = fileURLToPath(new URL('fixtures/model-catalog-openai-only.json', import.meta.url));
const allShipped = { MODEL_FAMILIES: families.map(family => family.id).join(',') };
const chosen = env => Object.fromEntries(modelRoles.map(role => [role, modelRoleDefault(role, env)?.familyId ?? null]));

// The families each feature used before roles, when all of them are enabled.
const previousDefaults = {
  'default-chat': 'claude-sonnet',
  title: 'claude-haiku',
  compaction: 'claude-haiku',
  review: 'claude-sonnet',
  plan: 'claude-sonnet',
  heartbeat: 'claude-haiku',
  'public-guide': 'gpt-luna',
};

test('the shipped catalog keeps the families every feature chose before roles', () => {
  assert.deepEqual(chosen(allShipped), previousDefaults);
  assert.deepEqual(chosen({ MODEL_FAMILIES: 'claude-haiku,claude-sonnet,gpt-luna' }), previousDefaults);
  assert.equal(defaultChatModelFamilyId, 'claude-sonnet');
  assert.equal(defaultChatModelFamilyId, families.find(family => family.roles?.includes('default-chat')).id);
  assert.deepEqual(
    compactionBudgetFamilies.map(family => family.id),
    ['claude-haiku', 'deepseek-flash', 'grok-fast'],
  );
  assert.deepEqual(
    compactionModelFamilies(allShipped).map(family => family.id),
    ['claude-haiku', 'deepseek-flash', 'grok-fast'],
  );
  assert.equal(compactionDefaultFamily(allShipped), 'claude-haiku');
  assert.equal(compactionDefaultFamily({}), 'claude-haiku');
  assert.deepEqual(modelRoleWarnings(allShipped), []);
});

test('role settings override the catalog and are reported when outside MODEL_FAMILIES', () => {
  const env = {
    ...allShipped,
    CHAT_TITLE_MODEL_FAMILY: 'grok-fast',
    SKILL_REVIEW_MODEL_FAMILY: 'claude-opus',
    PLAN_SPECIALIST_MODEL_FAMILY: 'gpt-sol',
    GMAIL_HEARTBEAT_MODEL_FAMILY: 'deepseek-flash',
    PUBLIC_GUIDE_MODEL_FAMILY: 'gpt-sol',
  };
  assert.deepEqual(chosen(env), {
    ...previousDefaults,
    title: 'grok-fast',
    review: 'claude-opus',
    plan: 'gpt-sol',
    heartbeat: 'deepseek-flash',
    'public-guide': 'gpt-sol',
  });
  assert.deepEqual(modelRoleDefault('title', env), { familyId: 'grok-fast', source: 'setting' });
  assert.deepEqual(
    modelRoleWarnings({ MODEL_FAMILIES: 'claude-sonnet', SKILL_REVIEW_MODEL_FAMILY: 'gpt-sol' }, ['review']),
    ['SKILL_REVIEW_MODEL_FAMILY=gpt-sol is not in MODEL_FAMILIES; the review role has no model.'],
  );
});

test('defaults pick the first enabled family with the role, in catalog order', () => {
  const env = { MODEL_FAMILIES: 'grok-fast,gpt-sol,gpt-luna,deepseek-flash' };
  assert.deepEqual(chosen(env), {
    'default-chat': 'gpt-sol',
    title: 'gpt-luna',
    compaction: 'deepseek-flash',
    review: 'gpt-sol',
    plan: 'gpt-sol',
    heartbeat: 'gpt-luna',
    'public-guide': 'gpt-luna',
  });
  assert.deepEqual(modelRoleWarnings(env), []);
});

test('an unfilled role falls back to the default chat family and warns; titles fall back to the chat model', () => {
  const env = { MODEL_FAMILIES: 'kimi,claude-opus' };
  assert.deepEqual(modelRoleDefault('default-chat', env), { familyId: 'claude-opus', source: 'fallback' });
  assert.deepEqual(modelRoleDefault('review', env), { familyId: 'claude-opus', source: 'fallback' });
  assert.equal(modelRoleDefault('title', env), null);
  assert.equal(compactionDefaultFamily(env), 'claude-opus');
  assert.ok(compactionModelFamilies(env).some(family => family.id === 'claude-opus'));
  assert.deepEqual(modelRoleWarnings(env, ['default-chat', 'title', 'plan']), [
    'No family in MODEL_FAMILIES has the catalog role "default-chat"; using claude-opus. Add "default-chat" to a family\'s roles to choose one.',
    'No family in MODEL_FAMILIES has the catalog role "title"; chats are titled by their chat model.',
    'No family in MODEL_FAMILIES has the catalog role "plan"; using claude-opus. Add "plan" to a family\'s roles to choose one.',
  ]);
  assert.deepEqual(modelRoleWarnings({}), [], 'a server without models has nothing to warn about');
  assert.equal(modelRoleDefault('default-chat', {}), null);
});

test('external catalogs validate roles with the family entry schema and roles keep the revisions', () => {
  const shipped = {
    families: families.map(family => modelFamilyEntrySchema.parse(family)),
    models: pricing.models.map(model => modelPricingEntrySchema.parse(model)),
  };
  const schemas = { family: modelFamilyEntrySchema, model: modelPricingEntrySchema };
  const build = value =>
    buildModelCatalog({ shipped, schemas, source: { label: 'MODEL_CATALOG', mode: 'extend', value } });
  const haiku = families.find(family => family.id === 'claude-haiku');
  assert.throws(() => build({ families: [{ ...haiku, roles: ['summaries'] }] }), /roles/);
  assert.throws(() => build({ families: [{ ...haiku, roles: ['title', 'title'] }] }), /Duplicate role/);
  const rerolled = build({ families: [{ ...haiku, roles: ['default-chat'] }] });
  assert.deepEqual(rerolled.families.find(family => family.id === 'claude-haiku').roles, ['default-chat']);
  assert.equal(
    modelCatalogRevision('families', 'published', shipped.families, rerolled.families),
    'published',
    'roles are left out of the family revision',
  );
  assert.equal(modelCatalogSchema.parse({ families: [], defaultChatFamilyId: null }).defaultChatFamilyId, null);
});

test('a catalog of only OpenAI-model families fills every role from its own families', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const config = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
    const { defaultChatModelFamilyId } = await import(${JSON.stringify(new URL('../src/model-catalog.ts', import.meta.url).href)});
    const env = { MODEL_FAMILIES: 'openai-mini,openai-main' };
    console.log(JSON.stringify({
      roles: Object.fromEntries(config.modelRoles.map(role => [role, config.modelRoleDefault(role, env)])),
      compaction: config.compactionModelFamilies(env).map(family => family.id),
      compactionDefault: config.compactionDefaultFamily(env),
      warnings: config.modelRoleWarnings(env),
      defaultChatModelFamilyId,
    }));`,
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, MODEL_CATALOG_FILE: openaiOnly, MODEL_CATALOG_MODE: 'replace' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.roles, {
    'default-chat': { familyId: 'openai-main', source: 'catalog' },
    title: { familyId: 'openai-mini', source: 'catalog' },
    compaction: { familyId: 'openai-main', source: 'fallback' },
    review: { familyId: 'openai-main', source: 'catalog' },
    plan: { familyId: 'openai-main', source: 'catalog' },
    heartbeat: { familyId: 'openai-mini', source: 'catalog' },
    'public-guide': { familyId: 'openai-mini', source: 'catalog' },
  });
  assert.deepEqual(output.compaction, ['openai-main']);
  assert.equal(output.compactionDefault, 'openai-main');
  assert.deepEqual(output.warnings, [
    'No family in MODEL_FAMILIES has the catalog role "compaction"; using openai-main. Add "compaction" to a family\'s roles to choose one.',
  ]);
  // The browser constant names the shipped default; the server reports its own as `defaultChatFamilyId`.
  assert.equal(output.defaultChatModelFamilyId, 'claude-sonnet');
  assert.ok(JSON.parse(readFileSync(openaiOnly, 'utf8')).families.every(family => family.vendor === 'openai'));
});

test('a paused family cannot become the default chat family but keeps background roles', () => {
  const env = { MODEL_FAMILIES: 'gpt-luna,gpt-sol', MODEL_PAUSED_FAMILIES: ' gpt-sol , ' };
  assert.deepEqual([...pausedModelFamilies(env)], ['gpt-sol']);
  assert.deepEqual(modelRoleDefault('default-chat', env), { familyId: 'gpt-luna', source: 'fallback' });
  assert.equal(modelRoleDefault('review', { MODEL_FAMILIES: 'gpt-luna,gpt-sol' }).familyId, 'gpt-sol');
  assert.equal(modelRoleDefault('review', env).familyId, 'gpt-sol');
  assert.equal(modelRoleDefault('default-chat', { ...env, MODEL_PAUSED_FAMILIES: 'gpt-luna,gpt-sol' }), null);
});

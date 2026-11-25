import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configuredFeatureFlag,
  configuredFeatureFlags,
  featureFlags,
  parseFlagOverride,
} from '../dist/feature-flags.js';
import { settingsByName } from '../dist/settings.js';

test('every flag is declared once with a description, default, and its own settings variable', () => {
  const envs = new Set();
  for (const [flag, definition] of Object.entries(featureFlags)) {
    assert.match(flag, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(definition.description.length > 10, flag);
    assert.ok(
      definition.default === true || definition.default === false || definition.default === 'development',
      flag,
    );
    assert.equal(definition.env, `FEATURE_FLAG_${flag.toUpperCase().replaceAll('-', '_')}`);
    assert.ok(settingsByName.has(definition.env), `${definition.env} is in the settings registry`);
    assert.ok(!envs.has(definition.env));
    envs.add(definition.env);
  }
});

test('override values are true or false only', () => {
  assert.equal(parseFlagOverride('true'), true);
  assert.equal(parseFlagOverride(' False '), false);
  for (const value of [undefined, '', '1', 'on', 'yes']) assert.equal(parseFlagOverride(value), undefined);
});

test('configured flags resolve env override, then FEATURE_FLAGS_OFF, then default', () => {
  assert.equal(configuredFeatureFlag('openai-models', {}), true);
  assert.equal(configuredFeatureFlag('openai-models', { NODE_ENV: 'production' }), false);
  assert.equal(
    configuredFeatureFlag('openai-models', {
      NODE_ENV: 'production',
      FEATURE_FLAG_OPENAI_MODELS: 'true',
    }),
    true,
  );
  assert.equal(
    configuredFeatureFlag('openai-models', {
      FEATURE_FLAGS_OFF: 'other, openai-models',
    }),
    false,
  );
  assert.equal(
    configuredFeatureFlag('openai-models', {
      FEATURE_FLAGS_OFF: 'openai-models',
      FEATURE_FLAG_OPENAI_MODELS: 'true',
    }),
    true,
  );
  assert.equal(configuredFeatureFlag('toString', {}), false);
  assert.deepEqual(Object.keys(configuredFeatureFlags({})), Object.keys(featureFlags));
  for (const [name, value] of Object.entries(configuredFeatureFlags({ NODE_ENV: 'production' })))
    assert.equal(value, featureFlags[name].default === true, name);
});

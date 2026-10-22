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
  assert.equal(configuredFeatureFlag('slack-app-sender', {}), true);
  assert.equal(configuredFeatureFlag('slack-app-sender', { NODE_ENV: 'production' }), false);
  assert.equal(
    configuredFeatureFlag('slack-app-sender', { NODE_ENV: 'production', FEATURE_FLAG_SLACK_APP_SENDER: 'true' }),
    true,
  );
  assert.equal(configuredFeatureFlag('slack-app-sender', { FEATURE_FLAGS_OFF: 'slack-app-sender' }), false);
  assert.equal(
    configuredFeatureFlag('slack-app-sender', {
      FEATURE_FLAGS_OFF: 'slack-app-sender',
      FEATURE_FLAG_SLACK_APP_SENDER: 'true',
    }),
    true,
  );
  assert.equal(configuredFeatureFlag('toString', {}), false);
  assert.deepEqual(Object.keys(configuredFeatureFlags({})), Object.keys(featureFlags));
  assert.ok(Object.values(configuredFeatureFlags({ NODE_ENV: 'production' })).every(value => value === false));
});

test('Bud avatar is off for every environment unless its variable turns it on', () => {
  assert.equal(featureFlags['bud-avatar'].default, false);
  assert.equal(configuredFeatureFlag('bud-avatar', {}), false);
  assert.equal(configuredFeatureFlag('bud-avatar', { NODE_ENV: 'development' }), false);
  assert.equal(configuredFeatureFlag('bud-avatar', { NODE_ENV: 'production' }), false);
  assert.equal(configuredFeatureFlag('bud-avatar', { FEATURE_FLAG_BUD_AVATAR: 'true' }), true);
});

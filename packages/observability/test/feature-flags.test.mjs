import assert from 'node:assert/strict';
import test from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { featureFlags } from '@tulipfarm/config/feature-flags';
import { featureFlagSnapshot, isFeatureEnabled } from '../src/index.ts';

const user = { id: 'u1', email: 'a@example.com' };
const flag = 'slack-app-sender';
const env = featureFlags[flag].env;

async function withProvider(t, isEnabled) {
  t.after(resetExtensions);
  const calls = [];
  await registerExtension(
    {
      name: 'fixture',
      register(slots) {
        slots.flagProvider({
          isEnabled: async (name, subject) => {
            calls.push([name, subject]);
            return isEnabled(name);
          },
        });
      },
    },
    { app: 'api', env: {} },
  );
  return calls;
}

test('without a provider, flags use their declared default: on in development, off in production', async () => {
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'development' }), true);
  assert.equal(await isFeatureEnabled(flag, user, undefined, {}), true);
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production' }), false);
  assert.equal(await isFeatureEnabled('not-a-flag', user, undefined, { NODE_ENV: 'development' }), false);
});

test('without a provider, the env override wins over FEATURE_FLAGS_OFF and the default', async () => {
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production', [env]: 'true' }), true);
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production', [env]: ' TRUE ' }), true);
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'development', [env]: 'false' }), false);
  assert.equal(
    await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'development', FEATURE_FLAGS_OFF: `other, ${flag}` }),
    false,
  );
  assert.equal(
    await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'development', FEATURE_FLAGS_OFF: flag, [env]: 'true' }),
    true,
  );
  assert.equal(
    await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production', [env]: 'yes' }),
    false,
    'an invalid value is no override',
  );
});

test('a provider boolean wins over the env override and the default', async t => {
  const calls = await withProvider(t, name => name === flag);
  assert.equal(
    await isFeatureEnabled(flag, user, { id: 'w1', name: 'Acme' }, { NODE_ENV: 'production', [env]: 'false' }),
    true,
  );
  assert.equal(
    await isFeatureEnabled('google-calendar-canvas', user, undefined, {
      NODE_ENV: 'development',
      FEATURE_FLAG_GOOGLE_CALENDAR_CANVAS: 'true',
    }),
    false,
  );
  assert.deepEqual(calls, [
    [flag, { user, workspace: { id: 'w1', name: 'Acme' } }],
    ['google-calendar-canvas', { user }],
  ]);
});

test('a provider answering undefined falls back to the env override, then the default', async t => {
  await withProvider(t, () => undefined);
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production', [env]: 'true' }), true);
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production' }), false);
  assert.equal(await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'development' }), true);
});

test('a provider failure is logged and falls back', async t => {
  await withProvider(t, () => {
    throw new Error('flag service down');
  });
  const lines = [];
  const write = t.mock.method(process.stdout, 'write', line => {
    lines.push(String(line));
    return true;
  });
  const results = [
    await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production' }),
    await isFeatureEnabled(flag, user, undefined, { NODE_ENV: 'production', [env]: 'true' }),
  ];
  write.mock.restore();
  assert.deepEqual(results, [false, true]);
  const logged = lines.map(line => JSON.parse(line));
  assert.equal(logged.length, 2);
  assert.deepEqual(
    logged.map(entry => [
      entry.level,
      entry.event,
      entry.category,
      entry.operation,
      entry.outcome,
      entry['error.type'],
    ]),
    Array(2).fill(['warn', 'call_failed', 'dependency', `feature-flag.${flag}`, 'fallback', 'Error']),
  );
  assert.ok(!lines.join('').includes('flag service down'), 'the error message is not logged');
});

test('a snapshot evaluates every registered flag for one subject', async t => {
  assert.deepEqual(
    await featureFlagSnapshot(user, undefined, { NODE_ENV: 'production', [env]: 'true' }),
    Object.fromEntries(Object.keys(featureFlags).map(name => [name, name === flag])),
  );
  await withProvider(t, name => (name === 'google-calendar-canvas' ? true : undefined));
  const snapshot = await featureFlagSnapshot(user, { id: 'w1' }, { NODE_ENV: 'production' });
  assert.equal(snapshot['google-calendar-canvas'], true);
  assert.equal(snapshot[flag], false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

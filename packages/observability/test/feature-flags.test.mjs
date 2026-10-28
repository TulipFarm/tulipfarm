import assert from 'node:assert/strict';
import test from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { featureFlags } from '@tulipfarm/config/feature-flags';
import { featureFlagSnapshot, isFeatureEnabled, registerFlagSubjectResolver, resetFlagSubjects } from '../src/index.ts';

const user = { id: 'u1', email: 'a@example.com' };
const flag = 'google-calendar-canvas';
const env = featureFlags[flag].env;

async function withProvider(t, isEnabled, extra = {}) {
  t.after(resetExtensions);
  t.after(resetFlagSubjects);
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
          ...extra,
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
    await isFeatureEnabled('soul-repository-explorer', user, undefined, {
      NODE_ENV: 'development',
      FEATURE_FLAG_SOUL_REPOSITORY_EXPLORER: 'true',
    }),
    false,
  );
  const subjectUser = { id: 'u1', email: 'a@example.com', emailDomain: 'example.com' };
  assert.deepEqual(calls, [
    [flag, { scope: 'user', distinctId: 'u1', user: subjectUser, workspace: { id: 'w1', name: 'Acme' } }],
    ['soul-repository-explorer', { scope: 'user', distinctId: 'u1', user: subjectUser }],
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
    Object.fromEntries(
      Object.keys(featureFlags).map(name => [name, name === flag || featureFlags[name].default === true]),
    ),
  );
  await withProvider(t, name => (name === 'bud-avatar' ? true : undefined));
  const snapshot = await featureFlagSnapshot(user, { id: 'w1' }, { NODE_ENV: 'production' });
  assert.equal(snapshot['bud-avatar'], true);
  assert.equal(snapshot[flag], false);
  assert.equal(snapshot['default-connection-knowledge'], true);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

test('every flag declares a scope, and background-evaluated flags are workspace or global', () => {
  for (const definition of Object.values(featureFlags))
    assert.ok(['user', 'workspace', 'global'].includes(definition.scope));
  for (const name of ['social-publishing', 'default-connection-knowledge', 'slack-app-sender'])
    assert.equal(featureFlags[name].scope, 'workspace', `${name} runs in background work`);
  assert.equal(featureFlags['public-tulipfarm-guide'].scope, 'global');
});

test('a workspace flag ignores the user, so API and background callers send the same subject', async t => {
  const calls = await withProvider(t, () => true);
  await isFeatureEnabled('social-publishing', { id: userId, email: 'a@example.com' }, { id: workspaceId });
  await isFeatureEnabled('social-publishing', { id: 'social-publisher' }, { id: workspaceId });
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0][1], {
    scope: 'workspace',
    distinctId: `workspace:${workspaceId}`,
    workspace: { id: workspaceId },
  });
  calls.length = 0;
  assert.equal(
    await isFeatureEnabled('social-publishing', { id: userId }, undefined, { NODE_ENV: 'production' }),
    false,
  );
  assert.equal(calls.length, 0, 'a workspace flag without a workspace falls back without asking the provider');
});

test('a global flag uses one fixed subject', async t => {
  const calls = await withProvider(t, () => true);
  await isFeatureEnabled('public-tulipfarm-guide', { id: 'public-tulipfarm-guide' });
  await isFeatureEnabled('public-tulipfarm-guide', null);
  assert.deepEqual(
    calls.map(([, subject]) => subject),
    Array(2).fill({ scope: 'global', distinctId: 'global' }),
  );
});

test('the resolver fills missing attributes, caller values win, and lookups are cached and shared', async t => {
  const calls = await withProvider(t, () => true);
  const lookups = [];
  registerFlagSubjectResolver(async lookup => {
    lookups.push(lookup);
    await new Promise(resolve => setTimeout(resolve, 5));
    return {
      user: { email: 'Person@Example.COM' },
      workspace: { slug: 'acme', name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
    };
  });
  await Promise.all([
    isFeatureEnabled('bud-avatar', { id: userId }, { id: workspaceId }),
    isFeatureEnabled('bud-avatar', { id: userId }, { id: workspaceId, name: 'Renamed' }),
  ]);
  assert.equal(lookups.length, 1, 'concurrent cold lookups share one request');
  assert.deepEqual(lookups[0], { userId, workspaceId });
  const plain = calls.find(call => call[1].workspace.name !== 'Renamed');
  const renamed = calls.find(call => call[1].workspace.name === 'Renamed');
  assert.deepEqual(plain[1], {
    scope: 'user',
    distinctId: userId,
    user: { id: userId, email: 'Person@Example.COM', emailDomain: 'example.com' },
    workspace: { id: workspaceId, slug: 'acme', name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(renamed[1].workspace.name, 'Renamed');
  await isFeatureEnabled('social-publishing', { id: userId }, { id: workspaceId });
  assert.deepEqual(lookups[1], { workspaceId }, 'a workspace flag never looks up the user');
  await isFeatureEnabled('bud-avatar', { id: 'social-publisher' }, { id: workspaceId });
  await isFeatureEnabled('bud-avatar', { id: userId }, { id: workspaceId });
  assert.equal(lookups.length, 2, 'synthetic user IDs are never looked up, and repeats come from the cache');
});

test('a failing resolver is logged, not cached, and evaluation continues with caller values', async t => {
  const calls = await withProvider(t, () => true);
  let fail = true;
  let count = 0;
  registerFlagSubjectResolver(async () => {
    count++;
    if (fail) throw new Error('database down');
    return { workspace: { slug: 'acme' } };
  });
  const lines = [];
  const write = t.mock.method(process.stdout, 'write', line => {
    lines.push(String(line));
    return true;
  });
  assert.equal(await isFeatureEnabled('social-publishing', null, { id: workspaceId }), true);
  write.mock.restore();
  assert.deepEqual(calls[0][1].workspace, { id: workspaceId });
  const logged = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(logged.some(entry => entry.operation === 'feature-flag.subject'));
  fail = false;
  await isFeatureEnabled('social-publishing', null, { id: workspaceId });
  assert.equal(count, 2);
  assert.equal(calls[1][1].workspace.slug, 'acme');
});

test('without a provider the resolver is never called', async t => {
  t.after(resetFlagSubjects);
  let count = 0;
  registerFlagSubjectResolver(async () => {
    count++;
    return {};
  });
  await isFeatureEnabled('bud-avatar', { id: userId }, { id: workspaceId });
  await featureFlagSnapshot({ id: userId }, { id: workspaceId });
  assert.equal(count, 0);
});

test('a snapshot uses evaluateMany once per scope; false decides and missing falls back', async t => {
  const batches = [];
  const singles = [];
  await withProvider(
    t,
    name => {
      singles.push(name);
      return true;
    },
    {
      evaluateMany: async (flags, subject) => {
        batches.push([flags, subject.scope]);
        if (subject.scope === 'user') return { 'bud-avatar': false, 'google-calendar-canvas': true };
        if (subject.scope === 'global') throw new Error('down');
        return { 'social-publishing': true };
      },
    },
  );
  const write = t.mock.method(process.stdout, 'write', () => true);
  const snapshot = await featureFlagSnapshot({ id: userId }, { id: workspaceId }, { NODE_ENV: 'production' });
  write.mock.restore();
  assert.equal(singles.length, 0);
  assert.deepEqual(batches.map(([, scope]) => scope).sort(), ['global', 'user', 'workspace']);
  for (const [flags, scope] of batches) for (const name of flags) assert.equal(featureFlags[name].scope, scope);
  assert.equal(snapshot['bud-avatar'], false);
  assert.equal(snapshot['google-calendar-canvas'], true);
  assert.equal(snapshot['soul-repository-explorer'], false, 'a missing answer falls back to the default');
  assert.equal(snapshot['social-publishing'], true);
  assert.equal(snapshot['slack-app-sender'], false);
  assert.equal(snapshot['public-tulipfarm-guide'], false, 'a failed batch falls back');
});

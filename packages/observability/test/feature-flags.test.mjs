import assert from 'node:assert/strict';
import test from 'node:test';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { featureFlags } from '@tulipfarm/config/feature-flags';
import { flagSubject, resolveFlagContext } from '../src/flag-subjects.ts';
import {
  featureFlagAnswer,
  featureFlagSnapshot,
  isFeatureEnabled,
  registerFlagSubjectResolver,
  resetFlagSubjects,
} from '../src/index.ts';

const user = { id: 'u1', email: 'a@example.com' };
const workspace = { id: 'w1', name: 'Acme' };
const flag = 'openai-models';
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
  assert.equal(await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'development' }), true);
  assert.equal(await isFeatureEnabled(flag, user, workspace, {}), true);
  assert.equal(await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'production' }), false);
  assert.equal(await isFeatureEnabled('not-a-flag', user, undefined, { NODE_ENV: 'development' }), false);
});

test('a provider boolean wins over the env override and the default', async t => {
  const calls = await withProvider(t, name => name === flag);
  assert.equal(await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'production', [env]: 'false' }), true);
  assert.equal(
    await isFeatureEnabled('anthropic-models', user, workspace, {
      NODE_ENV: 'development',
      FEATURE_FLAG_ANTHROPIC_MODELS: 'true',
    }),
    false,
  );
  const subject = { scope: 'workspace', distinctId: 'workspace:w1', workspace };
  assert.deepEqual(calls, [
    [flag, subject],
    ['anthropic-models', subject],
  ]);
});

test('a provider answering undefined falls back to the env override, then the default', async t => {
  await withProvider(t, () => undefined);
  assert.equal(await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'production', [env]: 'true' }), true);
  assert.equal(await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'production' }), false);
  assert.equal(await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'development' }), true);
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
    await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'production' }),
    await isFeatureEnabled(flag, user, workspace, { NODE_ENV: 'production', [env]: 'true' }),
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
    await featureFlagSnapshot(user, workspace, { NODE_ENV: 'production', [env]: 'true' }),
    Object.fromEntries(
      Object.keys(featureFlags).map(name => [name, name === flag || featureFlags[name].default === true]),
    ),
  );
  await withProvider(t, name => (name === 'anthropic-models' ? true : undefined));
  const snapshot = await featureFlagSnapshot(user, { id: 'w1' }, { NODE_ENV: 'production' });
  assert.equal(snapshot['anthropic-models'], true);
  assert.equal(snapshot[flag], false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

test('every flag declares a scope, and background-evaluated flags are workspace or global', () => {
  for (const definition of Object.values(featureFlags))
    assert.ok(['user', 'workspace', 'global'].includes(definition.scope));
  for (const name of ['openai-models', 'anthropic-models', 'openai-image-models'])
    assert.equal(featureFlags[name].scope, 'workspace', `${name} runs in background work`);
});

test('a workspace flag ignores the user, so API and background callers send the same subject', async t => {
  const calls = await withProvider(t, () => true);
  await isFeatureEnabled(flag, { id: userId, email: 'a@example.com' }, { id: workspaceId });
  await isFeatureEnabled(flag, { id: 'social-publisher' }, { id: workspaceId });
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0][1], {
    scope: 'workspace',
    distinctId: `workspace:${workspaceId}`,
    workspace: { id: workspaceId },
  });
  calls.length = 0;
  assert.equal(await isFeatureEnabled(flag, { id: userId }, undefined, { NODE_ENV: 'production' }), false);
  assert.equal(calls.length, 0, 'a workspace flag without a workspace falls back without asking the provider');
});

test('a global subject is fixed, and a user subject needs a user and keeps the workspace', () => {
  const context = { user: { id: userId }, workspace: { id: workspaceId } };
  assert.deepEqual(flagSubject('global', context), { scope: 'global', distinctId: 'global' });
  assert.deepEqual(flagSubject('global', {}), { scope: 'global', distinctId: 'global' });
  assert.deepEqual(flagSubject('user', context), { scope: 'user', distinctId: userId, ...context });
  assert.equal(flagSubject('user', { workspace: { id: workspaceId } }), undefined);
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
  const fail = error => assert.fail(error);
  const [plain, renamed] = await Promise.all([
    resolveFlagContext({ id: userId }, { id: workspaceId }, fail),
    resolveFlagContext({ id: userId }, { id: workspaceId, name: 'Renamed' }, fail),
  ]);
  assert.equal(lookups.length, 1, 'concurrent cold lookups share one request');
  assert.deepEqual(lookups[0], { userId, workspaceId });
  assert.deepEqual(plain, {
    user: { id: userId, email: 'Person@Example.COM', emailDomain: 'example.com' },
    workspace: { id: workspaceId, slug: 'acme', name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(renamed.workspace.name, 'Renamed');
  await isFeatureEnabled(flag, { id: userId }, { id: workspaceId });
  assert.deepEqual(lookups[1], { workspaceId }, 'a workspace flag never looks up the user');
  assert.equal(calls[0][1].workspace.slug, 'acme');
  await resolveFlagContext({ id: 'social-publisher' }, { id: workspaceId }, fail);
  await resolveFlagContext({ id: userId }, { id: workspaceId }, fail);
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
  assert.equal(await isFeatureEnabled(flag, null, { id: workspaceId }), true);
  write.mock.restore();
  assert.deepEqual(calls[0][1].workspace, { id: workspaceId });
  const logged = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(logged.some(entry => entry.operation === 'feature-flag.subject'));
  fail = false;
  await isFeatureEnabled(flag, null, { id: workspaceId });
  assert.equal(count, 2);
  assert.equal(calls[1][1].workspace.slug, 'acme');
});

test('an answer comes from the provider only when the provider and the subject lookup both succeed', async t => {
  let provider = 'up';
  let resolver = 'down';
  await withProvider(t, () => {
    if (provider === 'down') throw new Error('flag service down');
    return true;
  });
  registerFlagSubjectResolver(async () => {
    if (resolver === 'down') throw new Error('database down');
    return {};
  });
  t.mock.method(process.stdout, 'write', () => true);
  const answer = () => featureFlagAnswer('openai-models', null, { id: workspaceId }, { NODE_ENV: 'production' });
  const answers = [await answer()];
  resolver = 'up';
  answers.push(await answer());
  provider = 'down';
  answers.push(await answer());
  assert.deepEqual(answers, [
    { enabled: true, fromProvider: false },
    { enabled: true, fromProvider: true },
    { enabled: false, fromProvider: false },
  ]);
});

test('without a provider the resolver is never called', async t => {
  t.after(resetFlagSubjects);
  let count = 0;
  registerFlagSubjectResolver(async () => {
    count++;
    return {};
  });
  await isFeatureEnabled(flag, { id: userId }, { id: workspaceId });
  await featureFlagSnapshot({ id: userId }, { id: workspaceId });
  assert.equal(count, 0);
});

test('a snapshot uses evaluateMany once per scope; false decides, missing and failed batches fall back', async t => {
  const batches = [];
  const singles = [];
  let down = false;
  await withProvider(
    t,
    name => {
      singles.push(name);
      return true;
    },
    {
      evaluateMany: async (flags, subject) => {
        batches.push([flags, subject.scope]);
        if (down) throw new Error('down');
        return { 'openai-models': false, 'anthropic-models': true };
      },
    },
  );
  const write = t.mock.method(process.stdout, 'write', () => true);
  const env = { NODE_ENV: 'production', FEATURE_FLAG_OPENAI_IMAGE_MODELS: 'true' };
  const snapshot = await featureFlagSnapshot({ id: userId }, { id: workspaceId }, env);
  down = true;
  const failed = await featureFlagSnapshot({ id: userId }, { id: workspaceId }, env);
  write.mock.restore();
  assert.equal(singles.length, 0);
  assert.deepEqual(
    batches.map(([, scope]) => scope),
    ['workspace', 'workspace'],
  );
  for (const [flags, scope] of batches) for (const name of flags) assert.equal(featureFlags[name].scope, scope);
  assert.deepEqual(snapshot, {
    'openai-models': false,
    'anthropic-models': true,
    'openai-image-models': true,
    'code-sessions': false,
    'decisions-tool-preload': false,
    'decisions-completion-check': false,
    'decisions-creation-review': false,
    'decisions-learning-gate': false,
    'decisions-heartbeat-filter': false,
    'decisions-drift-audit': false,
    'decisions-skill-preload': false,
    'decisions-row-and-calendar': false,
    'decisions-model-routing': false,
    'decisions-task-completion': false,
    'decisions-tool-gate': false,
    'decisions-security-guardrails': false,
    'decisions-goal-loops': false,
  });
  assert.deepEqual(failed, {
    'openai-models': false,
    'anthropic-models': false,
    'openai-image-models': true,
    'code-sessions': false,
    'decisions-tool-preload': false,
    'decisions-completion-check': false,
    'decisions-creation-review': false,
    'decisions-learning-gate': false,
    'decisions-heartbeat-filter': false,
    'decisions-drift-audit': false,
    'decisions-skill-preload': false,
    'decisions-row-and-calendar': false,
    'decisions-model-routing': false,
    'decisions-task-completion': false,
    'decisions-tool-gate': false,
    'decisions-security-guardrails': false,
    'decisions-goal-loops': false,
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engagementTextIssue, engagementTextMaximum, errorClassSchema } from '../dist/contracts.js';
import { FakePlatformError, createFakeAdapter, fakeEngagementTextLimit, fakeToken } from '../dist/platforms/fake.js';

const step = { kind: 'create-post', mode: 'mutate' };
const awaitStep = { kind: 'await', for: 'publish-status', maxSeconds: 600 };
const input = { attemptId: 'a1' };

test('the fake implements every adapter member, including the optional ones', () => {
  const adapter = createFakeAdapter({ platform: 'tiktok' });
  for (const method of [
    'scopes',
    'authorizationUrl',
    'exchangeCode',
    'refresh',
    'revoke',
    'listChannels',
    'validate',
    'targetRules',
    'reviewChoices',
    'plan',
    'mutate',
    'status',
    'reconcile',
    'readEngagement',
    'sendEngagement',
    'analytics',
    'retentionCheck',
    'classify',
  ])
    assert.equal(typeof adapter[method], 'function', method);
  assert.equal(adapter.platform, 'tiktok');
  assert.equal(adapter.mediaUrlTtlSeconds, 4500);
  assert.equal(createFakeAdapter().mediaUrlTtlSeconds, 1800);
  assert.equal(adapter.engagementTextLimit, fakeEngagementTextLimit);
  assert.ok(fakeEngagementTextLimit <= engagementTextMaximum);
  assert.equal(createFakeAdapter({ engagementTextLimit: 10 }).engagementTextLimit, 10);
  assert.equal(engagementTextIssue('a'.repeat(fakeEngagementTextLimit), adapter.engagementTextLimit), null);
  assert.equal(
    engagementTextIssue('a'.repeat(fakeEngagementTextLimit + 1), adapter.engagementTextLimit),
    'text-too-long',
  );
  assert.deepEqual(adapter.plan({}), [step]);
  assert.deepEqual(adapter.validate({}, {}, 'audited'), []);
  const url = adapter.authorizationUrl({
    app: { clientId: 'cid', accessTier: 'audited' },
    redirectUri: 'https://app.example/cb',
    state: 's',
    codeChallenge: 'c',
    scopes: ['a', 'b'],
  });
  assert.equal(url.searchParams.get('scope'), 'a b');
});

test('scripted step results are returned in order, then the fallback', async () => {
  const adapter = createFakeAdapter();
  adapter
    .script(
      'mutate',
      { kind: 'done', platformRefs: { media: 'm1' } },
      { kind: 'published', platformPostId: 'p1', permalink: 'https://x.com/i/status/p1' },
      { kind: 'rejected', code: 'duplicate' },
    )
    .fallback('mutate', { kind: 'rejected', code: 'fallback' });
  assert.equal(adapter.pending('mutate'), 3);
  assert.deepEqual(await adapter.mutate(step, input), { kind: 'done', platformRefs: { media: 'm1' } });
  assert.equal((await adapter.mutate(step, input)).kind, 'published');
  assert.deepEqual(await adapter.mutate(step, input), { kind: 'rejected', code: 'duplicate' });
  assert.deepEqual(await adapter.mutate(step, input), { kind: 'rejected', code: 'fallback' });
  assert.equal(adapter.calls.filter(call => call.method === 'mutate').length, 4);
  assert.deepEqual(adapter.calls[0].args, [step, input]);
});

test('every status and reconcile result can be scripted', async () => {
  const adapter = createFakeAdapter();
  const statuses = [
    { kind: 'pending', pollAfterSeconds: 30 },
    { kind: 'ready' },
    { kind: 'published', platformPostId: 'p1', permalink: null },
    { kind: 'failed', code: 'processing-failed' },
  ];
  const reconciles = [
    { kind: 'found', platformPostId: 'p1', evidence: 'platform-ref' },
    { kind: 'found', platformPostId: 'p1', evidence: 'idempotency-key' },
    { kind: 'absent', evidence: 'platform-ref' },
    { kind: 'candidates', items: [{ platformPostId: 'p2', permalink: null, createdAt: '2026-06-01T00:00:00Z' }] },
    { kind: 'unknown' },
  ];
  adapter.script('status', ...statuses).script('reconcile', ...reconciles);
  for (const expected of statuses) assert.deepEqual(await adapter.status(awaitStep, input), expected);
  for (const expected of reconciles) assert.deepEqual(await adapter.reconcile({}), expected);
});

test('each error class can be thrown in either phase and classifies to itself', async () => {
  const adapter = createFakeAdapter();
  for (const errorClass of errorClassSchema.options)
    for (const phase of ['before-send', 'after-send']) {
      adapter.script('mutate', { throw: errorClass, phase });
      const error = await adapter.mutate(step, input).catch(error => error);
      assert.ok(error instanceof FakePlatformError);
      assert.equal(error.errorClass, errorClass);
      assert.equal(error.phase, phase);
      assert.equal(adapter.classify(error, phase), errorClass);
    }
  adapter.script('status', { throw: 'unknown' });
  assert.equal((await adapter.status(awaitStep, input).catch(error => error)).phase, 'after-send');
});

test('unscripted calls throw instead of inventing a result', async () => {
  const adapter = createFakeAdapter();
  await assert.rejects(adapter.reconcile({}), /nothing scripted for reconcile/);
});

test('scripted results are copies, so callers cannot change the script', async () => {
  const adapter = createFakeAdapter();
  const result = { kind: 'done', platformRefs: { a: '1' } };
  adapter.fallback('mutate', result);
  (await adapter.mutate(step, input)).platformRefs.a = 'changed';
  assert.equal((await adapter.mutate(step, input)).platformRefs.a, '1');
});

test('auth, channel, engagement, analytics and retention methods are scriptable', async () => {
  const adapter = createFakeAdapter()
    .script('exchangeCode', fakeToken)
    .script('refresh', { throw: 'reconnect' })
    .script('revoke', 'failed')
    .script('listChannels', [])
    .script('targetRules', { postingAllowed: true, flairRequired: false, flairIds: [] })
    .script('reviewChoices', ['privacy'])
    .script('readEngagement', { untrusted: true, sources: [], items: [], nextCursor: null })
    .script('sendEngagement', { kind: 'sent', platformId: 'c1' })
    .script('analytics', [{ name: 'likes', value: 1, status: 'ok' }])
    .script('retentionCheck', 'delete');
  assert.deepEqual(await adapter.exchangeCode({}), fakeToken);
  await assert.rejects(adapter.refresh(fakeToken), { errorClass: 'reconnect' });
  assert.equal(await adapter.revoke(fakeToken), 'failed');
  assert.deepEqual(await adapter.listChannels(fakeToken), []);
  assert.equal((await adapter.targetRules({}, {}, fakeToken)).postingAllowed, true);
  assert.deepEqual(await adapter.reviewChoices({}, fakeToken), ['privacy']);
  assert.equal((await adapter.readEngagement({})).untrusted, true);
  assert.equal((await adapter.sendEngagement({})).kind, 'sent');
  assert.equal((await adapter.analytics({}))[0].name, 'likes');
  assert.equal(await adapter.retentionCheck({}), 'delete');
});

test('plan and validate can be overridden', () => {
  const adapter = createFakeAdapter({
    plan: () => [{ kind: 'upload-video', mode: 'mutate' }, awaitStep],
    validate: () => [{ path: ['content'], code: 'bad' }],
  });
  assert.equal(adapter.plan({}).length, 2);
  assert.deepEqual(adapter.validate({}, {}, 'paid'), [{ path: ['content'], code: 'bad' }]);
});

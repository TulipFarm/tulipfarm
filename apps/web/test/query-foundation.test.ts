import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryObserver, focusManager } from '@tanstack/react-query';
import { IDBFactory } from 'fake-indexeddb';
import { registerHooks } from 'node:module';
import type { WorkspaceScope } from '../src/lib/query/scope.ts';

// Vite resolves extensionless source imports; mirror that resolution for Node's TS runner.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/query/policy')
      return next(new URL('../src/lib/query/policy.ts', import.meta.url).href, context);
    return next(
      context.parentURL?.includes('/src/lib/query/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)
        ? `${specifier}.ts`
        : specifier,
      context,
    );
  },
});
const { createFeatureClient } = await import('../src/lib/query/client.ts');
const { featureReadOptions } = await import('../src/lib/query/options.ts');
const { featureKey } = await import('../src/lib/query/scope.ts');
const { freshness, readState, retryDelay, retryRead } = await import('../src/lib/query/policy.ts');
const { createCatalogPersistence, parseCatalogSnapshot, catalogMaxAge } =
  await import('../src/lib/query/catalog-persistence.ts');
const { replyBackoff } = await import('../src/lib/query/polling.ts');
const { startEarlyReads } = await import('../src/lib/query/early-reads.ts');
const { scheduleDraftRead, retryDraftRead, draftRetryDelay } = await import('../src/features/chat/draft-reads.ts');
hooks.deregister();

const scope: WorkspaceScope = { kind: 'workspace', userId: 'alice', workspaceId: 'workspace', membershipId: 'member' };
const identity = { userId: 'alice', sessionId: 'session' };
const flush = async () => {
  await setImmediate();
  await setImmediate();
};

test('draft reads share requests, bound concurrency and remove cancelled queued reads', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const held = Array.from({ length: 5 }, () => Promise.withResolvers<string>());
  const calls: number[] = [];
  const readers = held.map(
    (_, index) =>
      new QueryObserver(
        runtime.client,
        featureReadOptions(runtime, scope, {
          key: ['draft', index],
          schedule: scheduleDraftRead,
          load: async () => {
            calls.push(index);
            return held[index]!.promise;
          },
        }),
      ),
  );
  const duplicate = new QueryObserver(runtime.client, readers[0]!.options);
  const unsubs = [...readers, duplicate].map(reader => reader.subscribe(() => {}));
  try {
    await flush();
    assert.deepEqual(calls, [0, 1, 2]);
    unsubs[3]!();
    await flush();
    held[0]!.resolve('first');
    await flush();
    assert.deepEqual(calls, [0, 1, 2, 4], 'a cancelled queued read does not run or block the next read');
    assert.equal(duplicate.getCurrentResult().data, 'first');
    held[1]!.resolve('second');
    held[2]!.resolve('third');
    held[4]!.resolve('last');
    await flush();
    assert.equal(readers[4]!.getCurrentResult().data, 'last');
  } finally {
    for (const result of held) result.resolve('cleanup');
    for (const unsub of unsubs) unsub();
    runtime.stop();
    await flush();
  }
});

test('draft retries recover transient errors, stop after the budget, and allow manual retry', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  try {
    const errors = [
      new TypeError('Network error'),
      new DOMException('Timed out', 'TimeoutError'),
      ...[0, 429, 502, 503, 504].map(status => Object.assign(new Error('Unavailable'), { status })),
    ];
    for (const [index, error] of errors.entries()) {
      let attempts = 0;
      const options = featureReadOptions(runtime, scope, {
        key: ['draft', index],
        schedule: scheduleDraftRead,
        retry: retryDraftRead,
        retryDelay: () => 1,
        load: async () => {
          if (++attempts < 4) throw error;
          return 'saved';
        },
      });
      assert.equal(await runtime.client.fetchQuery(options), 'saved');
      assert.equal(attempts, 4);
    }
    let failing = true;
    let attempts = 0;
    const options = featureReadOptions(runtime, scope, {
      key: ['draft', 'permanent'],
      retry: retryDraftRead,
      retryDelay: () => 1,
      load: async () => {
        attempts++;
        if (failing) throw Object.assign(new Error('Unavailable'), { status: 503 });
        return 'saved';
      },
    });
    await assert.rejects(runtime.client.fetchQuery(options), { status: 503 });
    assert.equal(attempts, 4);
    assert.equal(
      readState({ data: undefined, error: runtime.client.getQueryState(options.queryKey)?.error, isFetching: false })
        .kind,
      'error',
    );
    failing = false;
    assert.equal(await runtime.client.fetchQuery(options), 'saved');
    const delays = Array.from({ length: 20 }, () => draftRetryDelay(2, errors[0]));
    assert.ok(delays.every(delay => delay >= 3000 && delay <= 5000));
    assert.ok(new Set(delays).size > 1, 'backoff is jittered');
  } finally {
    runtime.stop();
  }
});

test('draft reads retain the shared workspace-update and rate-limit retry windows', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = createFeatureClient(identity);
  runtime.start();
  try {
    for (const { error, retries, delay } of [
      { error: { status: 503, code: 'workspace-updating' }, retries: 60, delay: 5000 },
      { error: { status: 429, retryAfter: '2' }, retries: 5, delay: 2000 },
    ]) {
      let calls = 0;
      const delays: number[] = [];
      const options = featureReadOptions(runtime, scope, {
        key: ['draft', error.status],
        retry: retryDraftRead,
        retryDelay: (attempt, failure) => {
          const value = draftRetryDelay(attempt, failure);
          delays.push(value);
          return value;
        },
        load: async () => {
          if (++calls <= retries) throw error;
          return 'saved';
        },
      });
      const result = runtime.client.fetchQuery(options).then(
        data => ({ data }),
        error => ({ error }),
      );
      await flush();
      for (let retry = 1; retry <= retries; retry++) {
        t.mock.timers.tick(delay);
        await flush();
        assert.equal(calls, retry + 1, 'drafts keep retrying until the shared recovery window ends');
      }
      assert.deepEqual(await result, { data: 'saved' });
      assert.ok(
        delays.every(value => value === delay),
        'shared recovery delays are preserved',
      );
    }
  } finally {
    runtime.stop();
  }
});

test('custom draft retries stop when the page becomes hidden or offline', async () => {
  for (const paused of ['hidden', 'offline']) {
    let visible = true;
    let online = true;
    const runtime = createFeatureClient(identity, { visible: () => visible, online: () => online });
    runtime.start();
    let calls = 0;
    let failing = true;
    const options = featureReadOptions(runtime, scope, {
      key: ['draft', paused],
      retry: retryDraftRead,
      retryDelay: () => 1,
      load: async () => {
        calls++;
        if (failing) {
          if (paused === 'hidden') visible = false;
          else online = false;
          throw Object.assign(new Error('Unavailable'), { status: 503 });
        }
        return 'saved';
      },
    });
    try {
      await assert.rejects(runtime.client.fetchQuery(options), { status: 503 });
      assert.equal(calls, 1, 'custom retries obey the same visibility and connectivity guards as ordinary reads');
      visible = true;
      online = true;
      failing = false;
      assert.equal(await runtime.client.fetchQuery(options), 'saved');
    } finally {
      runtime.stop();
    }
  }
});

test('observers share one in-flight read; focus is inert; transient errors retain data; denial clears only the query', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  runtime.client.mount();
  let calls = 0;
  let failure: number | null = null;
  const input = {
    key: ['records', 'one'],
    load: async () => {
      calls++;
      if (failure) throw Object.assign(new Error('failed'), { status: failure });
      return ['private'];
    },
  };
  const options = { ...featureReadOptions(runtime, scope, input), retry: false };
  const first = new QueryObserver(runtime.client, options);
  const second = new QueryObserver(runtime.client, options);
  const unsubs = [first.subscribe(() => {}), second.subscribe(() => {})];
  try {
    await flush();
    assert.equal(calls, 1);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();
    assert.equal(calls, 1);
    failure = 503;
    await first.refetch();
    assert.equal(readState(first.getCurrentResult()).kind, 'ready');
    assert.deepEqual(runtime.client.getQueryData(options.queryKey), ['private']);
    runtime.client.setQueryData(featureKey(scope, ['unrelated']), 'keep');
    failure = 404;
    await first.refetch();
    assert.deepEqual(readState(first.getCurrentResult()), { kind: 'unavailable', status: 404 });
    assert.equal(runtime.client.getQueryData(options.queryKey), undefined);
    assert.equal(runtime.client.getQueryData(featureKey(scope, ['unrelated'])), 'keep');
  } finally {
    for (const unsub of unsubs) unsub();
    runtime.client.unmount();
    runtime.stop();
    focusManager.setFocused(undefined);
  }
});

test('a change during initial fetch cancels that fetch and coalesces a post-change read', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  let calls = 0;
  const late = Promise.withResolvers<string>();
  const options = featureReadOptions(runtime, scope, {
    key: ['chat', 'one'],
    load: async () => (++calls === 1 ? late.promise : 'new'),
  });
  const observer = new QueryObserver(runtime.client, options);
  const unsub = observer.subscribe(() => {});
  try {
    await flush();
    await Promise.all([
      runtime.change(scope, { keys: [['chat']] }),
      runtime.change(scope, { keys: [['chat', 'one']] }),
    ]);
    assert.equal(calls, 2);
    late.resolve('old');
    await flush();
    assert.equal(runtime.client.getQueryData(options.queryKey), 'new');
  } finally {
    unsub();
    runtime.stop();
  }
});

test('credits changes start and settle independently of an unrelated held refresh', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const unrelated = Promise.withResolvers<string>();
  const credits = Promise.withResolvers<number>();
  let unrelatedCalls = 0,
    creditCalls = 0,
    unrelatedSettled = false,
    creditsSettled = false;
  const unrelatedOptions = featureReadOptions(runtime, scope, {
    key: ['unrelated'],
    load: async () => (++unrelatedCalls === 1 ? 'cached' : unrelated.promise),
  });
  const creditOptions = featureReadOptions(runtime, scope, {
    key: ['credits', 'balance'],
    load: async () => (++creditCalls === 1 ? 100 : credits.promise),
  });
  const readers = [
    new QueryObserver(runtime.client, unrelatedOptions),
    new QueryObserver(runtime.client, creditOptions),
  ];
  const unsubs = readers.map(reader => reader.subscribe(() => {}));
  try {
    await flush();
    const first = runtime.change(scope, { keys: [['unrelated']] }).then(() => {
      unrelatedSettled = true;
    });
    await flush();
    assert.equal(unrelatedCalls, 2);
    const second = runtime.change(scope, { keys: [['credits']] }).then(() => {
      creditsSettled = true;
    });
    const duplicate = runtime.change(scope, { keys: [['credits', 'balance']] });
    await flush();
    assert.equal(creditCalls, 2, 'the credits refresh starts before the unrelated response is released');
    assert.equal(creditsSettled, false, 'the change promise waits for its own refresh');
    credits.resolve(75);
    await flush();
    assert.equal(creditsSettled, true);
    assert.equal(unrelatedSettled, false);
    assert.equal(runtime.client.getQueryData(creditOptions.queryKey), 75);
    unrelated.resolve('updated');
    await Promise.all([first, second, duplicate]);
    await flush();
    assert.equal(runtime.client.getQueryData(unrelatedOptions.queryKey), 'updated');
    assert.deepEqual(
      [unrelatedCalls, creditCalls],
      [2, 2],
      'same-tick overlapping keys coalesce without follow-up refresh loops',
    );
  } finally {
    unrelated.resolve('cleanup');
    credits.resolve(0);
    for (const unsub of unsubs) unsub();
    runtime.stop();
  }
});

test('a later same-key change cancels a held refresh and waits for its replacement', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const old = Promise.withResolvers<string>(),
    replacement = Promise.withResolvers<string>();
  let calls = 0,
    settled = false;
  const signals: AbortSignal[] = [];
  const options = featureReadOptions(runtime, scope, {
    key: ['chat', 'one'],
    load: async signal => {
      signals.push(signal);
      calls++;
      return calls === 1 ? 'cached' : calls === 2 ? old.promise : replacement.promise;
    },
  });
  const observer = new QueryObserver(runtime.client, options);
  const unsub = observer.subscribe(() => {});
  try {
    await flush();
    const first = runtime.change(scope, { keys: [['chat']] });
    await flush();
    const second = runtime.change(scope, { keys: [['chat', 'one']] }).then(() => {
      settled = true;
    });
    await flush();
    assert.equal(calls, 3);
    assert.equal(signals[1]?.aborted, true);
    assert.equal(settled, false);
    old.resolve('obsolete');
    await flush();
    assert.equal(runtime.client.getQueryData(options.queryKey), 'cached');
    assert.equal(settled, false);
    replacement.resolve('post-change');
    await Promise.all([first, second]);
    assert.equal(runtime.client.getQueryData(options.queryKey), 'post-change');
    await flush();
    assert.equal(calls, 3);
  } finally {
    old.resolve('cleanup');
    replacement.resolve('cleanup');
    unsub();
    runtime.stop();
  }
});

test('one polling timer and budget serve all observers; hiding pauses, returning waits a full interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let visible = true;
  const runtime = createFeatureClient(identity, { visible: () => visible });
  runtime.start();
  let calls = 0;
  const options = featureReadOptions(runtime, scope, {
    key: ['progress'],
    load: async () => {
      calls++;
      return 'pending';
    },
  });
  const first = new QueryObserver(runtime.client, options);
  const second = new QueryObserver(runtime.client, options);
  const unsubs = [first.subscribe(() => {}), second.subscribe(() => {})];
  const poll = { pending: () => true, interval: 2000, maxChecks: 2 };
  const unregister = [
    runtime.polling.register(options.queryKey, poll),
    runtime.polling.register(options.queryKey, { ...poll }),
  ];
  try {
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 1);
    visible = false;
    runtime.visibilityChanged();
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(calls, 1);
    visible = true;
    runtime.visibilityChanged();
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 2);
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(calls, 3);
    assert.equal(runtime.polling.delayed(options.queryKey), true);
    visible = false;
    runtime.visibilityChanged();
    visible = true;
    runtime.visibilityChanged();
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(calls, 3);
    runtime.polling.reset(options.queryKey);
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(calls, 4);
  } finally {
    for (const unregisterPoll of unregister) unregisterPoll();
    for (const unsub of unsubs) unsub();
    runtime.stop();
  }
});

test('reconnect refreshes stale active visible reads only; hidden invalidations wait', async () => {
  let visible = true;
  const runtime = createFeatureClient(identity, { visible: () => visible });
  runtime.start();
  let staleCalls = 0;
  let freshCalls = 0;
  const stale = new QueryObserver(
    runtime.client,
    featureReadOptions(runtime, scope, { key: ['stale'], staleTime: 0, load: async () => ++staleCalls }),
  );
  const fresh = new QueryObserver(
    runtime.client,
    featureReadOptions(runtime, scope, { key: ['fresh'], load: async () => ++freshCalls }),
  );
  const unsubs = [stale.subscribe(() => {}), fresh.subscribe(() => {})];
  try {
    await flush();
    runtime.reconnected();
    await flush();
    assert.equal(staleCalls, 2);
    assert.equal(freshCalls, 1);
    visible = false;
    runtime.reconnected();
    await runtime.change(scope, { keys: [['fresh']] });
    await flush();
    assert.equal(staleCalls, 2);
    assert.equal(freshCalls, 1);
    visible = true;
    runtime.visibilityChanged();
    await flush();
    assert.equal(staleCalls, 2);
    assert.equal(freshCalls, 1);
  } finally {
    for (const unsub of unsubs) unsub();
    runtime.stop();
  }
});

test('authority fences reject late reads and leave other workspace scopes usable', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const late = Promise.withResolvers<string>();
  const options = featureReadOptions(runtime, scope, { key: ['private'], load: () => late.promise });
  const request = runtime.client.fetchQuery(options).catch(() => undefined);
  const other = { ...scope, workspaceId: 'other' };
  const otherFence = runtime.fence(other);
  runtime.revoke(scope);
  late.resolve('must not survive');
  await request;
  await flush();
  assert.equal(runtime.client.getQueryData(options.queryKey), undefined);
  assert.equal(otherFence(), true);
  const oldFence = runtime.fence(scope);
  runtime.admit(scope);
  assert.equal(oldFence(), false);
  const admittedFence = runtime.fence(scope);
  runtime.revoke(scope);
  runtime.admit(scope);
  assert.equal(admittedFence(), false);
  runtime.stop();
});

test('navigation suspension fences late responses but preserves fresh data and readmission', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  runtime.admit(scope);
  const key = featureKey(scope, ['retained']);
  runtime.client.setQueryData(key, 'cached');
  const late = Promise.withResolvers<string>();
  const options = featureReadOptions(runtime, scope, { key: ['pending'], load: () => late.promise });
  const request = runtime.client.fetchQuery(options).catch(() => undefined);
  const before = runtime.fence(scope);
  runtime.suspend(scope);
  late.resolve('old navigation');
  await request;
  await flush();
  assert.equal(before(), false);
  assert.equal(runtime.isCurrent(scope), true);
  assert.equal(runtime.client.getQueryData(key), 'cached');
  assert.equal(runtime.client.getQueryData(options.queryKey), undefined);
  runtime.admit(scope);
  assert.equal(before(), false);
  assert.equal(runtime.fence(scope)(), true);
  runtime.stop();
});

test('an admitted early read serves its first query once; another membership or a failure reads again', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const read = (name: string, early: () => Promise<string>, membershipId = scope.membershipId) => {
    const key = ['chat', name];
    startEarlyReads(identity, scope.workspaceId, [{ key, load: early }]).admit(membershipId);
    let own = 0;
    const options = featureReadOptions(runtime, scope, { key, load: async () => `own ${++own}` });
    return () => runtime.client.fetchQuery({ ...options, staleTime: 0 });
  };
  try {
    const early = Promise.withResolvers<string>();
    const admitted = read('admitted', () => early.promise);
    const first = admitted();
    await flush();
    early.resolve('early');
    assert.equal(await first, 'early', 'a read still in flight is handed over, not cancelled');
    assert.equal(await admitted(), 'own 1');
    assert.equal(await read('previous member', async () => 'early', 'previous')(), 'own 1');
    const failed = read('failed', async () => {
      throw Object.assign(new Error('denied'), { status: 404 });
    });
    assert.equal(await failed(), 'own 1');
  } finally {
    runtime.stop();
  }
});

test('denial, a change, revocation and sign-out abort early reads and leave queries to read for themselves', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const read = (name: string) => {
    const key = ['chat', name];
    const signal = Promise.withResolvers<AbortSignal>();
    const reads = startEarlyReads(identity, scope.workspaceId, [
      { key, load: started => (signal.resolve(started), new Promise(() => {})) },
    ]);
    reads.admit(scope.membershipId);
    const options = featureReadOptions(runtime, scope, { key, load: async () => 'own' });
    return { reads, signal: signal.promise, fetch: () => runtime.client.fetchQuery(options) };
  };
  try {
    const denied = read('denied');
    denied.reads.discard();
    assert.equal((await denied.signal).aborted, true);
    assert.equal(await denied.fetch(), 'own');

    const changed = read('changed');
    const unrelated = read('unrelated');
    await runtime.change(scope, { keys: [['chat', 'changed']] });
    assert.equal((await changed.signal).aborted, true);
    assert.equal((await unrelated.signal).aborted, false);
    assert.equal(await changed.fetch(), 'own');

    runtime.revoke(scope);
    assert.equal((await unrelated.signal).aborted, true);
    runtime.admit(scope);

    const signedOut = read('signed out');
    runtime.stop();
    assert.equal((await signedOut.signal).aborted, true);
  } finally {
    runtime.stop();
  }
});

test('concealment resumes idle readers once, respects admission, and does not reset exhausted progress budgets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let visible = true,
    admitted = true,
    pending = true,
    calls = 0;
  const runtime = createFeatureClient(identity, { visible: () => visible });
  runtime.start();
  const options = featureReadOptions(runtime, scope, { key: ['protected'], load: async () => ++calls }, () => admitted);
  const observer = new QueryObserver(runtime.client, options);
  const unsub = observer.subscribe(() => {});
  const unregister = runtime.polling.register(options.queryKey, {
    enabled: () => admitted,
    pending: () => pending && observer.getCurrentResult().data !== undefined,
    interval: 2000,
    maxChecks: 1,
  });
  try {
    await flush();
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(calls, 2);
    assert.equal(runtime.polling.delayed(options.queryKey), true);
    visible = false;
    runtime.visibilityChanged();
    await runtime.change(scope, { kind: 'conceal', keys: [['protected']] });
    assert.equal(runtime.client.getQueryData(options.queryKey), undefined);
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(calls, 2);
    visible = true;
    runtime.visibilityChanged();
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 3);
    assert.equal(runtime.polling.delayed(options.queryKey), true);
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(calls, 3, 'concealment does not restart the progress budget');
    pending = false;
    visible = false;
    runtime.visibilityChanged();
    await runtime.change(scope, { kind: 'conceal', keys: [['protected']] });
    admitted = false;
    visible = true;
    runtime.visibilityChanged();
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(calls, 3, 'no authorized reader remains');
    admitted = true;
    runtime.polling.sync();
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 3);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 4, 'idle query revalidates once after admission');
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(calls, 4);
  } finally {
    unregister();
    unsub();
    runtime.stop();
  }
});

test('concealment cancels an old private read; a failed replacement exposes retry without restoring private data', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const late = Promise.withResolvers<string>();
  let calls = 0;
  const options = featureReadOptions(runtime, scope, {
    key: ['private-skill'],
    load: async () => {
      calls++;
      if (calls === 1) return 'old private skill';
      if (calls === 2) return late.promise;
      if (calls === 3) throw Object.assign(new Error('Try again'), { status: 422 });
      return 'authorized replacement';
    },
  });
  const observer = new QueryObserver(runtime.client, options);
  const unsub = observer.subscribe(() => {});
  try {
    await flush();
    const oldRequest = observer.refetch();
    await flush();
    await runtime.change(scope, { kind: 'conceal', keys: [['private-skill']] });
    late.resolve('late private body');
    await oldRequest;
    await flush();
    assert.equal(calls, 3);
    assert.equal(runtime.client.getQueryData(options.queryKey), undefined);
    assert.equal(readState(observer.getCurrentResult()).kind, 'error');
    await observer.refetch();
    assert.equal(runtime.client.getQueryData(options.queryKey), 'authorized replacement');
  } finally {
    unsub();
    runtime.stop();
  }
});

test('a cancelled concealed revalidation remains scheduled after hidden ordinary invalidation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let visible = true,
    calls = 0;
  const late = Promise.withResolvers<string>();
  const runtime = createFeatureClient(identity, { visible: () => visible });
  runtime.start();
  const options = featureReadOptions(runtime, scope, {
    key: ['idle'],
    load: async () => (++calls === 2 ? late.promise : `authorized ${calls}`),
  });
  const observer = new QueryObserver(runtime.client, options);
  const unsub = observer.subscribe(() => {});
  const unregister = runtime.polling.register(options.queryKey, {
    pending: () => false,
    interval: 2000,
    maxChecks: 30,
  });
  try {
    await flush();
    visible = false;
    runtime.visibilityChanged();
    await runtime.change(scope, { kind: 'conceal', keys: [['idle']] });
    visible = true;
    runtime.visibilityChanged();
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(calls, 2);
    visible = false;
    runtime.visibilityChanged();
    await runtime.change(scope, { keys: [['idle']] });
    late.resolve('cancelled result');
    await flush();
    assert.equal(runtime.client.getQueryData(options.queryKey), undefined);
    visible = true;
    runtime.visibilityChanged();
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 3);
    assert.equal(runtime.client.getQueryData(options.queryKey), 'authorized 3');
  } finally {
    unregister();
    unsub();
    runtime.stop();
  }
});

test('cross-tab changes respect user, workspace and membership; old-session logout cannot revoke a replacement session', async () => {
  const runtime = createFeatureClient(identity);
  runtime.start();
  const key = featureKey(scope, ['credits']);
  runtime.client.setQueryData(key, 12);
  const notice = {
    version: 1,
    id: 'event',
    sessionId: identity.sessionId,
    scope,
    kind: 'change',
    keys: [['credits']],
  } satisfies Parameters<typeof runtime.receive>[0];
  runtime.receive({ ...notice, scope: { ...scope, userId: 'other' } });
  runtime.receive({ ...notice, scope: { ...scope, membershipId: 'previous' } });
  await flush();
  assert.equal(runtime.client.getQueryState(key)?.isInvalidated, false);
  runtime.receive(notice);
  await flush();
  assert.equal(runtime.client.getQueryState(key)?.isInvalidated, true);
  assert.equal(runtime.client.getQueryData(key), 12);
  runtime.receive({ ...notice, kind: 'logout', sessionId: 'old-session' });
  assert.equal(runtime.isCurrent(scope), true);
  runtime.stop();
});

test('credits can poll indefinitely at 15 seconds and stop when their final reader leaves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = createFeatureClient(identity);
  runtime.start();
  let calls = 0;
  const options = featureReadOptions(runtime, scope, { key: ['credits'], load: async () => ++calls });
  const observer = new QueryObserver(runtime.client, options);
  const unsub = observer.subscribe(() => {});
  const unregister = runtime.polling.register(options.queryKey, {
    pending: () => true,
    interval: 15_000,
    maxChecks: Infinity,
  });
  try {
    await flush();
    for (let i = 0; i < 35; i++) {
      t.mock.timers.tick(15_000);
      await flush();
    }
    assert.equal(calls, 36);
    assert.equal(runtime.polling.delayed(options.queryKey), false);
    unregister();
    unsub();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(calls, 36);
  } finally {
    unregister();
    unsub();
    runtime.stop();
  }
});

test('a reply backoff slows from 500 ms to 2 s to 5 s, never stops, and restarts fast after a reset', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = createFeatureClient(identity);
  runtime.start();
  let calls = 0;
  const options = featureReadOptions(runtime, scope, { key: ['reply'], load: async () => ++calls });
  const observer = new QueryObserver(runtime.client, options);
  const unsub = observer.subscribe(() => {});
  const unregister = runtime.polling.register(options.queryKey, {
    pending: () => true,
    interval: replyBackoff,
    maxChecks: Infinity,
  });
  const advance = async (ms: number, times: number) => {
    for (let i = 0; i < times; i++) {
      t.mock.timers.tick(ms);
      await flush();
    }
  };
  try {
    await flush();
    assert.equal(calls, 1);
    await advance(500, 20);
    assert.equal(calls, 21);
    await advance(500, 3);
    assert.equal(calls, 21, 'after 20 checks the next one waits 2 s');
    await advance(500, 1);
    assert.equal(calls, 22);
    await advance(2000, 39);
    assert.equal(calls, 61);
    await advance(2000, 2);
    assert.equal(calls, 61, 'after 60 checks the next one waits 5 s');
    await advance(1000, 1);
    assert.equal(calls, 62);
    await advance(5000, 200);
    assert.equal(calls, 262, 'a pending reply is checked indefinitely');
    assert.equal(runtime.polling.delayed(options.queryKey), false);
    runtime.polling.reset(options.queryKey);
    await advance(500, 1);
    assert.equal(calls, 263);
  } finally {
    unregister();
    unsub();
    runtime.stop();
  }
});

test('retry policy is bounded and excludes permissions and invalid payloads', () => {
  for (const status of [401, 403, 404, 409, 422]) assert.equal(retryRead(0, { status }), false);
  for (const status of [408, 500, 503]) {
    assert.equal(retryRead(1, { status }), true);
    assert.equal(retryRead(2, { status }), false);
  }
  assert.equal(retryRead(4, { status: 429 }), true);
  assert.equal(retryRead(5, { status: 429 }), false);
  assert.equal(retryRead(0, new Error('invalid response')), false);
  assert.equal(retryRead(0, new TypeError('network failed')), true);
  assert.equal(retryDelay(0, { status: 429, retryAfter: '9999' }), 30_000);
});

test('a workspace taking an update is retried every 5 seconds for about 5 minutes behind a calm state', () => {
  const updating = { status: 503, code: 'workspace-updating' };
  assert.equal(retryRead(59, updating), true);
  assert.equal(retryRead(60, updating), false);
  assert.equal(retryDelay(3, updating), 5000);
  assert.equal(retryRead(2, { status: 503, code: 'unavailable' }), false);

  const retrying = { data: undefined, error: null, failureReason: updating, isFetching: true };
  assert.deepEqual(readState(retrying), {
    kind: 'error',
    message: 'TulipFarm is still updating your workspace. Try again in a few minutes.',
    updating: 'retrying',
  });
  assert.equal(readState({ ...retrying, error: updating, isFetching: false }).updating, 'stopped');
  // Data already on screen stays there quietly while the update finishes.
  assert.deepEqual(readState({ ...retrying, data: ['plan'] }), {
    kind: 'ready',
    data: ['plan'],
    refreshing: true,
    error: null,
  });
});

test('real QueryClient performs at most two transient retries and zero authority retries', async () => {
  const runtime = createFeatureClient(identity);
  let calls = 0;
  try {
    await assert.rejects(
      runtime.client.fetchQuery({
        ...featureReadOptions(runtime, scope, {
          key: ['failing'],
          load: async () => {
            calls++;
            throw new TypeError('offline');
          },
        }),
        retryDelay: 0,
      }),
    );
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(
      runtime.client.fetchQuery({
        ...featureReadOptions(runtime, scope, {
          key: ['denied'],
          load: async () => {
            calls++;
            throw Object.assign(new Error('denied'), { status: 403 });
          },
        }),
        retryDelay: 0,
      }),
    );
    assert.equal(calls, 1);
  } finally {
    runtime.stop();
  }
});

test('catalog snapshots validate schema, scope, version, original age, and fresh admission', async () => {
  const store = createCatalogPersistence(new IDBFactory());
  const data = { families: [] };
  const updatedAt = Date.now() - 16 * 60_000;
  await store.save(scope, data, updatedAt, () => true);
  assert.equal((await store.restore(scope, () => true))?.updatedAt, updatedAt);
  assert.equal(await store.restore(scope, () => false), null);
  assert.equal(await store.restore({ ...scope, membershipId: 'new' }, () => true), null);
  const valid = {
    version: 1,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    membershipId: scope.membershipId,
    data,
    updatedAt,
  };
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, data: { families: [{ id: 'fake' }] } },
    { ...valid, updatedAt: Date.now() - catalogMaxAge },
    { ...valid, updatedAt: Date.now() + 1000 },
  ])
    assert.equal(parseCatalogSnapshot(invalid, scope), null);
  await store.clear(scope.userId);
  assert.equal(await store.restore(scope, () => true), null);
  const unavailable = createCatalogPersistence(undefined);
  assert.equal(await unavailable.restore(scope, () => true), null);
});

test('a restored catalog shows at once and is re-read once per page load despite its freshness window', async () => {
  const factory = new IDBFactory();
  const stored = { families: [], imageModels: [] };
  await createCatalogPersistence(factory).save(scope, stored, Date.now() - 60_000, () => true);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true });
  const runtime = createFeatureClient(identity);
  if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
  else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  runtime.start();
  runtime.client.mount();
  const key = ['model-catalog'];
  let calls = 0;
  let resolveRead!: (value: unknown) => void;
  const observer = new QueryObserver(runtime.client, {
    ...featureReadOptions(runtime, scope, {
      key,
      staleTime: freshness.catalog,
      load: () => {
        calls++;
        return new Promise(resolve => (resolveRead = resolve));
      },
    }),
    retry: false,
  });
  let unsubscribe = () => {};
  try {
    await runtime.prepareCatalog(scope, key, () => true);
    assert.deepEqual(runtime.client.getQueryData(featureKey(scope, key)), stored);
    unsubscribe = observer.subscribe(() => {});
    await flush();
    assert.equal(calls, 1);
    assert.deepEqual(observer.getCurrentResult().data, stored);
    resolveRead({ families: [{ id: 'current' }] });
    await flush();
    assert.deepEqual(observer.getCurrentResult().data, { families: [{ id: 'current' }] });
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();
    assert.equal(calls, 1);
  } finally {
    unsubscribe();
    runtime.stop();
  }
});

test('pending IndexedDB opens cannot resurrect snapshots after authority loss', async () => {
  const store = createCatalogPersistence(new IDBFactory());
  let current = true;
  const save = store.save(scope, { families: [] }, Date.now(), () => current);
  current = false;
  await store.clear(scope.userId);
  await save;
  assert.equal(await store.restore(scope, () => true), null);
});

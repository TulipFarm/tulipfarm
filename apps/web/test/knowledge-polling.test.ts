import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import type { KnowledgeEntry } from '../src/features/files/knowledge-api.ts';

const source = new URL('../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/auth')
      return { url: 'data:text/javascript,export const apiOrigin = "http://knowledge.test";', shortCircuit: true };
    if (specifier.startsWith('@/')) return next(new URL(`${specifier.slice(2)}.ts`, source).href, context);
    if (context.parentURL?.includes('/src/lib/query/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { knowledgeApi, personalKnowledgeRead } = await import('../src/features/files/knowledge-api.ts');
const { createFeatureClient } = await import('../src/lib/query/client.ts');
const { featureReadOptions } = await import('../src/lib/query/options.ts');
hooks.deregister();

const entry = (parsing: KnowledgeEntry['parsing']): KnowledgeEntry => ({
  documentId: randomUUID(),
  revisionId: randomUUID(),
  title: parsing,
  kind: 'note',
  parsing,
  failure: null,
  canRetry: false,
});
const flush = async () => {
  for (let i = 0; i < 4; i++) await setImmediate();
};

async function environment(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = entry('queued');
  const ready = entry('ready');
  let visible = true;
  let online = true;
  let status = 200;
  const requests: { at: number; path: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    options.signal!.throwIfAborted();
    const url = new URL(input);
    requests.push({ at: Date.now(), path: url.pathname + url.search });
    if (url.pathname.endsWith('/documents'))
      return Response.json({
        items: url.searchParams.has('cursor') ? [ready] : [pending],
        nextCursor: url.searchParams.has('cursor') ? null : pending.documentId,
      });
    return status === 200 ? Response.json(pending) : Response.json({ error: 'knowledge-not-found' }, { status });
  });
  const runtime = createFeatureClient(
    { userId: 'alice', sessionId: 'session' },
    { visible: () => visible, online: () => online },
  );
  runtime.start();
  const scope = { kind: 'workspace' as const, userId: 'alice', workspaceId: randomUUID(), membershipId: randomUUID() };
  const policy = personalKnowledgeRead(knowledgeApi(scope.workspaceId));
  const options = { ...featureReadOptions(runtime, scope, policy), retry: false };
  const observer = new QueryObserver(runtime.client, options);
  const unsubscribe = observer.subscribe(() => {});
  const key = options.queryKey;
  const unregister = runtime.polling.register(key, {
    pending: () => {
      const { data, error } = observer.getCurrentResult();
      return !error && data !== undefined && !!policy.pollWhile?.(data);
    },
    interval: policy.interval!,
    maxChecks: policy.maxChecks!,
    maxDuration: policy.maxDuration!,
  });
  t.after(() => {
    unregister();
    unsubscribe();
    runtime.stop();
  });
  await flush();
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return {
    pending,
    ready,
    runtime,
    observer,
    key,
    requests,
    change: () => runtime.change(scope, { kind: 'conceal', keys: [policy.key] }),
    advance,
    setStatus: (value: number) => {
      status = value;
    },
    visibility: (value: boolean) => {
      visible = value;
      runtime.visibilityChanged();
    },
    connectivity: (value: boolean) => {
      online = value;
      runtime.visibilityChanged();
    },
    refresh: async () => {
      await runtime.client.cancelQueries({ queryKey: key, exact: true });
      runtime.polling.reset(key);
      await observer.refetch({ cancelRefetch: false });
      await flush();
    },
    unmount: () => {
      unregister();
      unsubscribe();
    },
  };
}

test('personal Knowledge backs off pending-only reads, stops within five minutes, and Refresh reloads all pages', async t => {
  const env = await environment(t);
  assert.equal(env.requests.length, 2);
  for (let i = 0; i < 300; i++) await env.advance(1000);
  assert.deepEqual(
    env.requests.slice(2, 7).map(request => request.at),
    [2000, 6000, 14000, 30000, 60000],
  );
  assert.ok(env.requests.length <= 14, `at most 14 requests, got ${env.requests.length}`);
  assert.equal(env.requests.filter(request => request.path.includes('/documents?')).length, 1);
  assert.ok(env.requests.slice(2).every(request => request.path.endsWith(env.pending.documentId)));
  assert.equal(env.runtime.polling.delayed(env.key), true);
  const stopped = env.requests.length;
  await env.advance(300_000);
  assert.equal(env.requests.length, stopped);
  await env.refresh();
  assert.equal(env.requests.length, stopped + 2, 'manual Refresh traverses every page');
  assert.equal(env.runtime.polling.delayed(env.key), false);
  await env.advance(1999);
  assert.equal(env.requests.length, stopped + 2);
  env.pending.parsing = 'ready';
  await env.advance(1);
  assert.deepEqual(
    env.observer.getCurrentResult().data?.map(item => item.parsing),
    ['ready', 'ready'],
  );
  await env.advance(300_000);
  assert.equal(env.requests.length, stopped + 3, 'settled entries do not keep polling');
  console.log(`BOUNDED: ${stopped} requests in five simulated minutes; only pending entries checked.`);
});

test('hidden and offline time consume the elapsed budget; Refresh restarts it and unmount stops reads', async t => {
  const env = await environment(t);
  await env.advance(1000);
  env.visibility(false);
  await env.advance(10_000);
  assert.equal(env.requests.length, 2);
  env.visibility(true);
  await env.advance(1999);
  assert.equal(env.requests.length, 2);
  await env.advance(1);
  assert.equal(env.requests.length, 3);
  env.connectivity(false);
  await env.advance(300_000);
  assert.equal(env.requests.length, 3);
  env.connectivity(true);
  await env.advance(30_000);
  assert.equal(env.requests.length, 3, 'returning online does not reset an expired budget');
  assert.equal(env.runtime.polling.delayed(env.key), true);
  await env.refresh();
  await env.advance(2000);
  assert.equal(env.requests.length, 6);
  env.unmount();
  await env.advance(300_000);
  assert.equal(env.requests.length, 6);
});

test('a removed pending entry is dropped without discarding settled entries', async t => {
  const env = await environment(t);
  env.setStatus(404);
  await env.advance(2000);
  assert.deepEqual(env.observer.getCurrentResult().data, [env.ready]);
  await env.advance(300_000);
  assert.equal(env.requests.length, 3);
});

test('concealed changes revalidate the full library even after the progress budget expires', async t => {
  const env = await environment(t);
  await env.advance(300_000);
  assert.equal(env.runtime.polling.delayed(env.key), true);
  await env.change();
  await flush();
  assert.equal(env.requests.filter(request => request.path.includes('/documents?')).length, 2);
  assert.deepEqual(env.observer.getCurrentResult().data, [env.pending, env.ready]);
  const revalidated = env.requests.length;
  await env.advance(30_000);
  assert.equal(env.requests.length, revalidated, 'revalidation does not renew the elapsed budget');
});

test('a denied pending read clears protected cached data and stops polling', async t => {
  const env = await environment(t);
  env.setStatus(403);
  await env.advance(2000);
  assert.equal(env.observer.getCurrentResult().data, undefined);
  assert.equal(env.observer.getCurrentResult().isError, true);
  await env.advance(300_000);
  assert.equal(env.requests.length, 3);
});

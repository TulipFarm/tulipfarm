import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { registerHooks } from 'node:module';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { z } from 'zod';
import type { PersistedRead } from '../src/lib/query/persisted-reads.ts';
import type { WorkspaceScope } from '../src/lib/query/scope.ts';

// Vite resolves extensionless source imports; mirror that resolution for Node's TS runner.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(
      context.parentURL?.includes('/src/lib/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)
        ? `${specifier}.ts`
        : specifier,
      context,
    );
  },
});
Object.assign(globalThis, { IDBKeyRange, indexedDB: new IDBFactory() });
const { createReadPersistence, persistedReads } = await import('../src/lib/query/persisted-reads.ts');
const { persistedMaxAge } = await import('../src/lib/query/persistence.ts');
const { forgetSession, lastSession, rememberSession } = await import('../src/lib/last-workspace.ts');
const { createFeatureClient } = await import('../src/lib/query/client.ts');
const { featureReadOptions } = await import('../src/lib/query/options.ts');
hooks.deregister();

const scope: WorkspaceScope = { kind: 'workspace', userId: 'alice', workspaceId: 'workspace', membershipId: 'member' };
const chats = z.object({ items: z.array(z.string()) });
const definitions: PersistedRead[] = [
  { name: 'chats', limit: 2, match: key => key[0] === 'chats', schema: chats },
  { name: 'large', limit: 10, match: key => key[0] === 'large', schema: z.string() },
];
const admission = z.object({ workspace: z.string() });

function store(factory = new IDBFactory()) {
  const persistence = createReadPersistence(() => factory);
  persistence.configure(definitions);
  return persistence;
}

async function withNow<T>(now: number, run: () => Promise<T>) {
  const original = Date.now;
  Date.now = () => now;
  try {
    return await run();
  } finally {
    Date.now = original;
  }
}

test('persisted reads round-trip only within the same user, workspace and membership', async () => {
  const persistence = store();
  const updatedAt = Date.now() - 60_000;
  await persistence.save(scope, ['chats', 1], { items: ['a'] }, updatedAt, () => true);
  await persistence.save(scope, ['unlisted'], { items: ['b'] }, updatedAt, () => true);
  assert.deepEqual(await persistence.restore(scope), [{ key: ['chats', 1], data: { items: ['a'] }, updatedAt }]);
  for (const other of [
    { ...scope, userId: 'mallory' },
    { ...scope, workspaceId: 'other' },
    { ...scope, membershipId: 'replaced' },
  ])
    assert.deepEqual(await persistence.restore(other), []);
  await persistence.save(scope, ['chats', 2], { items: ['c'] }, updatedAt, () => false);
  assert.equal((await persistence.restore(scope)).length, 1, 'A save fenced out by authority loss writes nothing');
});

test('expired, future-dated, corrupt and schema-failing records are not restored', async () => {
  const factory = new IDBFactory();
  const persistence = store(factory);
  const updatedAt = Date.now() - 60_000;
  await persistence.save(scope, ['chats', 1], { items: ['a'] }, updatedAt, () => true);
  assert.equal((await persistence.restore(scope)).length, 1);
  assert.deepEqual(await withNow(updatedAt + persistedMaxAge, () => persistence.restore(scope)), []);
  assert.deepEqual(await withNow(updatedAt - 1, () => persistence.restore(scope)), []);
  const changed: PersistedRead[] = [{ ...definitions[0]!, schema: z.object({ items: z.array(z.number()) }) }];
  assert.deepEqual(await persistence.restore(scope, changed), [], 'Data failing the current schema is dropped');
  await persistence.clear();
  await persistence.save(scope, ['chats', 1], { items: [1] }, updatedAt, () => true);
  assert.deepEqual(await persistence.restore(scope), [], 'Invalid data is never saved');

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('tulipfarm-query-cache', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const id = JSON.stringify([scope.userId, scope.workspaceId, scope.membershipId, 'corrupt']);
  const transaction = db.transaction('reads', 'readwrite');
  transaction.objectStore('reads').put({ version: 2, data: { items: ['x'] } }, id);
  await new Promise(resolve => (transaction.oncomplete = resolve));
  db.close();
  await persistence.save(scope, ['chats', 2], { items: ['b'] }, updatedAt, () => true);
  assert.deepEqual(
    (await persistence.restore(scope)).map(read => read.key),
    [['chats', 2]],
  );
});

test('per-read limits and the per-user size cap evict the oldest saves first', async () => {
  const persistence = store();
  const updatedAt = Date.now() - 60_000;
  for (const page of [1, 2, 3]) {
    await persistence.save(scope, ['chats', page], { items: [String(page)] }, updatedAt, () => true);
    await delay(2);
  }
  const kept = (await persistence.restore(scope)).map(read => read.key[1]).sort();
  assert.deepEqual(kept, [2, 3]);

  await persistence.save(scope, ['large', 'too big'], 'x'.repeat(1_000_001), updatedAt, () => true);
  for (const name of ['first', 'second', 'third', 'fourth']) {
    await persistence.save(scope, ['large', name], 'x'.repeat(900_000), updatedAt, () => true);
    await delay(2);
  }
  const large = (await persistence.restore(scope)).filter(read => read.key[0] === 'large').map(read => read.key[1]);
  assert.deepEqual(large.sort(), ['fourth', 'second', 'third']);
});

test('clearing removes reads and admission snapshots for one workspace, one user or everyone', async () => {
  const persistence = store();
  const updatedAt = Date.now() - 60_000;
  const expiresAt = Date.now() + 60_000;
  const bob: WorkspaceScope = { ...scope, userId: 'bob' };
  const other: WorkspaceScope = { ...scope, workspaceId: 'other' };
  const seed = async () => {
    for (const target of [scope, other, bob]) {
      await persistence.save(target, ['chats', 1], { items: ['a'] }, updatedAt, () => true);
      await persistence.saveAdmission(
        { userId: target.userId, sessionId: 'session' },
        target.workspaceId,
        target.workspaceId,
        expiresAt,
        { workspace: target.workspaceId },
      );
    }
  };
  const present = async (target: WorkspaceScope) =>
    (await persistence.restore(target)).length > 0 &&
    !!(await persistence.restoreAdmission(target.userId, target.workspaceId, admission));
  await seed();
  assert.equal((await persistence.restoreAdmission('alice', 'workspace', admission))?.sessionId, 'session');
  assert.equal(await persistence.restoreAdmission('bob', 'workspace', z.object({ workspace: z.number() })), null);

  await persistence.clear('alice', 'workspace');
  assert.deepEqual(await Promise.all([scope, other, bob].map(present)), [false, true, true]);
  await persistence.clear('alice');
  assert.deepEqual(await Promise.all([scope, other, bob].map(present)), [false, false, true]);
  await seed();
  await persistence.clear();
  assert.deepEqual(await Promise.all([scope, other, bob].map(present)), [false, false, false]);
});

test('an admission snapshot is not restored once its session has expired', async () => {
  const persistence = store();
  const identity = { userId: 'alice', sessionId: 'session' };
  await persistence.saveAdmission(identity, 'acme', 'workspace', Date.now() + 1000, { workspace: 'workspace' });
  assert.ok(await persistence.restoreAdmission('alice', 'acme', admission));
  assert.equal(await withNow(Date.now() + 1000, () => persistence.restoreAdmission('alice', 'acme', admission)), null);
  assert.equal(await persistence.restoreAdmission('bob', 'acme', admission), null);
});

test('a read that succeeds before persisted reads are configured is saved once they are', async () => {
  const runtime = createFeatureClient({ userId: scope.userId, sessionId: 'session' });
  runtime.start();
  runtime.admit(scope);
  try {
    const options = featureReadOptions(runtime, scope, { key: ['chats', 1], load: async () => ({ items: ['early'] }) });
    await runtime.client.fetchQuery(options);
    persistedReads.configure(definitions);
    await delay(2200);
    assert.deepEqual(
      (await persistedReads.restore(scope)).map(read => read.data),
      [{ items: ['early'] }],
    );
  } finally {
    runtime.stop();
    await persistedReads.clear();
  }
});

test('the remembered session survives reloads; another user signing in or forgetting it clears the old cache', async t => {
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    },
  });
  t.after(() => delete (globalThis as { window?: unknown }).window);
  persistedReads.configure(definitions);
  const updatedAt = Date.now() - 60_000;
  const bob: WorkspaceScope = { ...scope, userId: 'bob' };
  const seed = (target: WorkspaceScope) =>
    persistedReads.save(target, ['chats', 1], { items: ['a'] }, updatedAt, () => true);
  storage.set('tulipfarm:last-session', '{"userId":"alice"}');
  assert.equal(lastSession(), null, 'An incomplete remembered session is ignored');

  rememberSession({ userId: 'alice', sessionId: 'one' });
  assert.deepEqual(lastSession(), { userId: 'alice', sessionId: 'one' });
  await seed(scope);
  rememberSession({ userId: 'alice', sessionId: 'two' });
  assert.deepEqual(lastSession(), { userId: 'alice', sessionId: 'two' });
  assert.equal((await persistedReads.restore(scope)).length, 1, 'A renewed session keeps the same user cache');

  await seed(bob);
  rememberSession({ userId: 'bob', sessionId: 'three' });
  await delay(20);
  assert.deepEqual(await persistedReads.restore(scope), [], 'The previous user cache is cleared');
  assert.equal((await persistedReads.restore(bob)).length, 1);

  await forgetSession();
  assert.equal(lastSession(), null);
  assert.deepEqual(await persistedReads.restore(bob), []);
  await forgetSession();
});

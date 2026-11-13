import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appRepositories } from '../src/store/index.ts';
import { git } from '../src/store/repository.ts';
import { startObjectStore } from './object-store.mjs';

const workspaceId = '5f0c2a8e-7b1d-4c3e-9a6f-2d8b4e1c7a90';
const appId = '0b5e3c2a-8d4f-4e1b-9c7a-6f2d1e0a3b4c';
const coAuthor = { name: 'Ada', email: 'ada@example.test' };
const text = value => new TextEncoder().encode(value);

test('saved commits restore from their bundles alone into an empty cache', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'app-source-'));
  const store = await startObjectStore();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const writer = appRepositories({ root: join(root, 'writer'), storage: store.storage });
  const bundles = [];
  async function save(head, changes) {
    const repository = await writer.open(workspaceId, appId, head, bundles);
    const saved = await writer.commit(repository, { head, changes, coAuthor, message: 'Save app draft' });
    const stored = await writer.upload(workspaceId, appId, bundles.length + 1, saved.bundle);
    bundles.push({ seq: bundles.length + 1, baseCommit: head, headCommit: saved.commit, ...stored });
    return saved;
  }

  const first = await save(null, [
    { path: 'index.html', content: text('<h1>Orders</h1>') },
    { path: 'app.js', content: text('console.log(1)') },
  ]);
  assert.deepEqual(Object.fromEntries(first.sizes), { 'app.js': 14, 'index.html': 15 });
  const second = await save(first.commit, [
    { path: 'app.js', content: null },
    { path: 'src/table.js', content: text('export {}') },
  ]);
  assert.deepEqual(Object.fromEntries(second.sizes), { 'index.html': 15, 'src/table.js': 9 });
  assert.match(
    bundles[1].objectKey,
    new RegExp(`^apps/${workspaceId}/${appId}/source/00000002-[0-9a-f-]{36}\\.bundle$`),
  );

  const reader = appRepositories({ root: join(root, 'reader'), storage: store.storage });
  const restored = await reader.open(workspaceId, appId, second.commit, bundles);
  assert.equal(await git(restored, ['rev-parse', 'refs/heads/main']), second.commit);
  assert.equal(await git(restored, ['show', `${second.commit}:src/table.js`]), 'export {}');
  assert.equal(await git(restored, ['config', 'gc.auto']), '0');
  assert.deepEqual(Object.fromEntries(await reader.tree(restored, second.commit)), {
    'index.html': 15,
    'src/table.js': 9,
  });
  const message = await git(restored, ['log', '-1', '--format=%an <%ae>%n%B', second.commit]);
  assert.equal(
    message,
    'TulipFarm <system@tulipfarm.invalid>\nSave app draft\n\nCo-authored-by: Ada <ada@example.test>',
  );

  const tampered = bundles.map(bundle => (bundle.seq === 2 ? { ...bundle, sha256: '0'.repeat(64) } : bundle));
  const other = appRepositories({ root: join(root, 'other'), storage: store.storage });
  await assert.rejects(other.open(workspaceId, appId, second.commit, tampered), /checksum mismatch/);
});

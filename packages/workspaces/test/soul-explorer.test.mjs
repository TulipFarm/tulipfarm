import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../src/soul.ts';
import { prepareSoulRevision } from '../src/soul-revisions.ts';
import { readSoulFile, readSoulRepository, readSoulTree } from '../src/soul-explorer.ts';
import { soulPreviewBytes, soulRepositorySchema, soulSnapshotBytes } from '../src/soul-explorer-contracts.ts';
import { explorerStorage, sha256 } from './soul-explorer.fixture.mjs';

const seed = { workspaceId: randomUUID(), createdBy: randomUUID(), createdAt: '2026-10-14T10:00:00.000Z' };
test('real Soul files preserve bytes, restrict paths and read only the selected verified revision', async t => {
  const f = await explorerStorage(seed);
  t.after(() => f.storage.client.destroy());
  const definition = {
    formatVersion: 2,
    id: randomUUID(),
    owningTeamId: randomUUID(),
    label: 'Invoices',
    fields: [],
    uniqueKeys: [],
  };
  const saved = await prepareSoulRevision(f.storage, seed, f.initial, {
    kind: 'table',
    commandId: randomUUID(),
    expectedParentCommit: f.initial.commit,
    createdAt: seed.createdAt,
    definition,
  });
  const filePath = saved.projection.path;
  const snapshot = { seed, pointer: saved.bundle, files: new Map([[filePath, saved.projection.sha256]]) };
  const before = f.reads.length;
  const loaded = soulRepositorySchema.parse(await readSoulRepository(f.storage, snapshot));
  assert.equal(f.reads.length - before, 1, 'the complete snapshot downloads and restores just one bundle');
  assert.equal(loaded.revision, saved.commit);
  assert.equal(loaded.files.find(file => file.path === filePath).content, `${JSON.stringify(definition, null, 2)}\n`);
  assert.equal(loaded.files.length, 9);
  assert.ok(loaded.files.every(file => file.revision === loaded.revision));
  const root = await readSoulTree(f.storage, snapshot, {});
  assert.equal(root.revision, saved.commit);
  assert.deepEqual(
    root.entries.map(entry => entry.path),
    ['agents', 'integrations', 'roles', 'skills', 'tables', 'workflows', 'skills-lock.json', 'soul.json'],
  );
  const contents = await readSoulFile(f.storage, snapshot, { path: filePath, revision: saved.commit });
  assert.equal(contents.content, `${JSON.stringify(definition, null, 2)}\n`);
  const search = await readSoulTree(f.storage, snapshot, { search: definition.id });
  assert.deepEqual(
    search.entries.map(entry => entry.path),
    [filePath],
  );
  const hidden = { ...snapshot, files: new Map() };
  const filtered = await readSoulRepository(f.storage, hidden);
  assert.ok(!JSON.stringify(filtered).includes(definition.id));
  await assert.rejects(readSoulRepository(f.storage, { ...snapshot, files: new Map([[filePath, '0'.repeat(64)]]) }), {
    code: 'soul-unavailable',
  });
  assert.deepEqual((await readSoulTree(f.storage, hidden, { search: definition.id })).entries, []);
  await assert.rejects(readSoulFile(f.storage, hidden, { path: filePath, revision: saved.commit }), {
    code: 'soul-not-found',
  });
  for (const path of ['../soul.json', '.git/config', '/soul.json', 'tables//bad', 'tables/../soul.json']) {
    await assert.rejects(readSoulFile(f.storage, snapshot, { path, revision: saved.commit }));
  }
  await assert.rejects(readSoulFile(f.storage, snapshot, { path: filePath, revision: f.initial.commit }), {
    code: 'soul-revision-changed',
  });
  await assert.rejects(
    readSoulTree(f.storage, { ...snapshot, pointer: { ...saved.bundle, sha256: '0'.repeat(64) } }, {}),
    /checksum/,
  );
  await assert.rejects(
    readSoulTree(f.storage, { ...snapshot, seed: { ...seed, workspaceId: randomUUID() } }, {}),
    /workspace/,
  );
  await assert.rejects(
    readSoulTree(f.storage, { ...snapshot, pointer: { ...saved.bundle, commit: '0'.repeat(40) } }, {}),
    /commit/,
  );
  await assert.rejects(
    readSoulTree(
      f.storage,
      {
        ...snapshot,
        pointer: { ...saved.bundle, key: `workspaces/${seed.workspaceId}/soul/revisions/${randomUUID()}.bundle` },
      },
      {},
    ),
    /Missing fixture object/,
  );
  await assert.rejects(
    readSoulFile(
      f.storage,
      { ...snapshot, files: new Map([[filePath, '0'.repeat(64)]]) },
      { path: filePath, revision: saved.commit },
    ),
    { code: 'soul-unavailable' },
  );
  assert.ok(f.reads.every(key => key.endsWith('.bundle') || key.includes('/projections/')));
});

test('file byte boundary, binary data, symlinks, unknown files and pagination', async t => {
  const f = await explorerStorage(seed);
  t.after(() => f.storage.client.destroy());
  const directory = await mkdtemp(join(tmpdir(), 'soul-explorer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'soul.bundle'), f.objects.get(f.initial.key).body);
  await git(directory, ['clone', '--bare', 'soul.bundle', 'repository']);
  const repository = join(directory, 'repository');
  const allowed = new Map();
  await git(repository, ['read-tree', f.initial.commit]);
  async function add(path, body, mode = '100644', permit = true) {
    await writeFile(join(directory, 'blob'), body);
    const id = (await git(repository, ['hash-object', '-w', join(directory, 'blob')])).stdout.trim();
    await git(repository, ['update-index', '--add', '--cacheinfo', `${mode},${id},${path}`]);
    if (permit) allowed.set(path, sha256(body));
  }
  await add('tables/exact.json', Buffer.alloc(soulPreviewBytes, 'a'));
  await add('tables/large.json', Buffer.alloc(soulPreviewBytes + 1, 'a'));
  await add('tables/binary.json', Buffer.from([0xc0, 0xc1, 0xff]));
  await add('tables/nul.json', Buffer.from('hello\0world'));
  await add('tables/empty.json', Buffer.from(''));
  await add('tables/bom.json', Buffer.from('\ufeff{"label":"Caf\u00e9"}\r\n'));
  await add('tables/link.json', Buffer.from('/etc/passwd'), '120000');
  await add('skills-lock.json', Buffer.from('{"unsupported":"withhold intact"}'), '100644', false);
  await add('integrations/private.json', Buffer.from('do not expose'), '100644', false);
  for (let i = 0; i < 102; i++) await add(`tables/page-${String(i).padStart(3, '0')}.json`, Buffer.from('{}'));
  const tree = (await git(repository, ['write-tree'])).stdout.trim();
  const commit = (
    await git(repository, ['commit-tree', tree, '-p', f.initial.commit, '-m', 'Explorer fixture'], seed)
  ).stdout.trim();
  await git(repository, ['update-ref', 'refs/heads/main', commit]);
  await git(repository, ['bundle', 'create', join(directory, 'new.bundle'), 'refs/heads/main']);
  const body = await readFile(join(directory, 'new.bundle'));
  const key = `workspaces/${seed.workspaceId}/soul/revisions/${randomUUID()}.bundle`;
  f.objects.set(key, { body, metadata: { sha256: sha256(body) } });
  const snapshot = { seed, pointer: { commit, bucket: f.storage.bucket, key, sha256: sha256(body) }, files: allowed };
  const before = f.reads.length;
  const loaded = await readSoulRepository(f.storage, snapshot);
  assert.equal(f.reads.length - before, 1);
  const contents = new Map(loaded.files.map(file => [file.path, file]));
  assert.equal(contents.get('tables/exact.json').content.length, soulPreviewBytes);
  assert.equal(contents.get('tables/large.json').reason, 'too-large');
  assert.equal(contents.get('tables/binary.json').reason, 'binary');
  assert.equal(contents.get('tables/nul.json').reason, 'binary');
  assert.equal(contents.get('tables/empty.json').content, '');
  assert.equal(contents.get('tables/bom.json').content, '\ufeff{"label":"Caf\u00e9"}\r\n');
  assert.ok(!contents.has('tables/link.json'));
  assert.ok(!contents.has('integrations/private.json'));
  assert.ok(!contents.has('skills-lock.json'));
  assert.equal(loaded.files.filter(file => file.path.includes('page-')).length, 102);
  const file = path => readSoulFile(f.storage, snapshot, { path, revision: commit });
  assert.equal((await file('tables/exact.json')).content.length, soulPreviewBytes);
  assert.equal((await file('tables/large.json')).reason, 'too-large');
  assert.equal((await file('tables/binary.json')).reason, 'binary');
  assert.equal((await file('tables/nul.json')).reason, 'binary');
  assert.equal((await file('tables/empty.json')).content, '');
  assert.equal((await file('tables/bom.json')).content, '\ufeff{"label":"Caf\u00e9"}\r\n');
  await assert.rejects(file('skills-lock.json'), { code: 'soul-not-found' });
  await assert.rejects(file('tables/link.json'), { code: 'soul-not-found' });
  await assert.rejects(file('integrations/private.json'), { code: 'soul-not-found' });
  const first = await readSoulTree(f.storage, snapshot, { search: 'page-' });
  assert.equal(first.entries.length, 100);
  const last = await readSoulTree(f.storage, snapshot, { search: 'page-', after: first.nextCursor, revision: commit });
  assert.equal(last.entries.length, 2);
  assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.entries, ...last.entries].map(entry => entry.path)).size, 102);
  assert.deepEqual((await readSoulTree(f.storage, snapshot, { search: 'private' })).entries, []);

  // JSON escaping counts toward the response bound, not just the raw file bytes.
  for (let i = 0; i < 6; i++) await add(`tables/escaped-${i}.json`, Buffer.alloc(soulPreviewBytes, 1));
  const oversizedTree = (await git(repository, ['write-tree'])).stdout.trim();
  const oversizedCommit = (
    await git(repository, ['commit-tree', oversizedTree, '-p', commit, '-m', 'Oversized snapshot'], seed)
  ).stdout.trim();
  await git(repository, ['update-ref', 'refs/heads/main', oversizedCommit]);
  await git(repository, ['bundle', 'create', join(directory, 'oversized.bundle'), 'refs/heads/main']);
  const oversizedBody = await readFile(join(directory, 'oversized.bundle'));
  const oversizedKey = `workspaces/${seed.workspaceId}/soul/revisions/${randomUUID()}.bundle`;
  assert.ok(oversizedBody.length < soulSnapshotBytes, 'a small compressed bundle can exceed the response limit');
  f.objects.set(oversizedKey, { body: oversizedBody, metadata: { sha256: sha256(oversizedBody) } });
  const oversized = {
    seed,
    pointer: { commit: oversizedCommit, bucket: f.storage.bucket, key: oversizedKey, sha256: sha256(oversizedBody) },
    files: allowed,
  };
  await assert.rejects(readSoulRepository(f.storage, oversized), { code: 'soul-snapshot-too-large' });

  const lastPath = 'tables/escaped-5.json';
  const belowLimit = new Map(allowed);
  belowLimit.delete(lastPath);
  const boundary = await readSoulRepository(f.storage, { ...oversized, files: belowLimit });
  const lastEntry = { path: lastPath, kind: 'file', size: 0 };
  const lastFile = { kind: 'text', revision: oversizedCommit, path: lastPath, content: '' };
  boundary.entries.push(lastEntry);
  boundary.files.push(lastFile);
  while (Buffer.byteLength(JSON.stringify(boundary)) !== soulSnapshotBytes) {
    lastEntry.size += soulSnapshotBytes - Buffer.byteLength(JSON.stringify(boundary));
    lastFile.content = 'a'.repeat(lastEntry.size);
  }
  assert.ok(lastEntry.size <= soulPreviewBytes);
  async function publishIndex() {
    const tree = (await git(repository, ['write-tree'])).stdout.trim();
    const commit = (
      await git(repository, ['commit-tree', tree, '-p', f.initial.commit, '-m', 'Snapshot limit'], seed)
    ).stdout.trim();
    await git(repository, ['update-ref', 'refs/heads/main', commit]);
    await git(repository, ['bundle', 'create', join(directory, 'limit.bundle'), 'refs/heads/main']);
    const body = await readFile(join(directory, 'limit.bundle'));
    const key = `workspaces/${seed.workspaceId}/soul/revisions/${randomUUID()}.bundle`;
    f.objects.set(key, { body, metadata: { sha256: sha256(body) } });
    return { seed, pointer: { commit, bucket: f.storage.bucket, key, sha256: sha256(body) }, files: allowed };
  }
  await add(lastPath, Buffer.from(lastFile.content));
  assert.equal(
    Buffer.byteLength(JSON.stringify(await readSoulRepository(f.storage, await publishIndex()))),
    soulSnapshotBytes,
  );
  await add(lastPath, Buffer.from(lastFile.content + 'a'));
  await assert.rejects(readSoulRepository(f.storage, await publishIndex()), { code: 'soul-snapshot-too-large' });

  await git(repository, ['read-tree', f.initial.commit]);
  allowed.clear();
  const emptyBlob = (await git(repository, ['rev-parse', `${f.initial.commit}:tables/.gitkeep`])).stdout.trim();
  for (let start = 0; start < 9993; start += 500) {
    const args = ['update-index', '--add'];
    for (let i = start; i < Math.min(start + 500, 9993); i++) {
      const path = `tables/count-${String(i).padStart(5, '0')}.json`;
      args.push('--cacheinfo', `100644,${emptyBlob},${path}`);
      allowed.set(path, sha256(''));
    }
    await git(repository, args);
  }
  await assert.rejects(
    readSoulRepository(f.storage, await publishIndex()),
    { code: 'soul-snapshot-too-large' },
    '10,001 visible files fail as a whole, including starter files',
  );
});

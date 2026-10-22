import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { dispatchGitHubWrite, reconcileGitHubWrite, requireWriteTarget } from '../dist/write-provider.js';
import { githubBatchInputSchema } from '../dist/batch-contracts.js';
import { releaseResult } from '../dist/release-writes.js';
import { releaseProviderFixture, releaseOperations, upload, binary } from './release-provider-fixture.mjs';

const credential = {
  accessToken: 'synthetic-release-credential',
  identity: { id: '123', login: 'octocat' },
  scopes: ['repo'],
};
const send = (f, operation) =>
  dispatchGitHubWrite({ operation, credential, bindings: [], fetcher: f.fetcher, authorize: async () => true });
for (const operation of releaseOperations)
  test(`real HTTP ${operation.kind} uses exact endpoint response and changes the provider`, async t => {
    const f = await releaseProviderFixture();
    t.after(f.close);
    await requireWriteTarget(operation, credential, f.fetcher, true);
    const result = await send(f, githubBatchInputSchema.parse({ actions: [operation] }).actions[0]);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result.repositoryId, 42);
    switch (operation.kind) {
      case 'release.create':
        assert.equal(f.releases.get(11).draft, true);
        assert.deepEqual(f.effects[0].body, {
          tag_name: 'v1.0',
          target_commitish: 'main',
          name: 'Version one',
          body: 'Reviewed notes',
          prerelease: false,
          draft: true,
        });
        break;
      case 'release.update':
        assert.equal(f.releases.get(10).name, 'Edited version');
        assert.equal(f.releases.get(10).draft, true);
        break;
      case 'release.publish':
        assert.equal(f.releases.get(10).draft, false);
        assert.equal(f.effects[0].body.draft, false);
        break;
      case 'release.delete':
        assert.deepEqual(result.result, { repositoryId: 42, releaseId: 10, assetIds: [20], deleted: true });
        assert.equal(f.releases.has(10), false);
        break;
      case 'release.asset-upload':
        assert.deepEqual(f.bytes.get(21), binary);
        assert.equal(f.effects[0].size, 8);
        assert.equal(f.effects[0].contentType, 'application/octet-stream');
        assert.equal(result.result.sha256, createHash('sha256').update(binary).digest('hex'));
        break;
      case 'release.asset-update':
        assert.equal(f.assets.get(20).name, 'renamed.bin');
        assert.deepEqual(f.effects[0].body, { name: 'renamed.bin', label: 'Renamed binary' });
        break;
      case 'release.asset-delete':
        assert.deepEqual(result.result, { repositoryId: 42, assetId: 20, deleted: true });
        assert.equal(f.assets.has(20), false);
        break;
    }
    assert.equal(f.effects.length, 1);
  });
test('upload validates canonical bytes and aggregate quota without URL or authority overrides', async t => {
  const f = await releaseProviderFixture();
  t.after(f.close);
  assert.equal(githubBatchInputSchema.safeParse({ actions: [upload] }).success, true);
  for (const changes of [
    { content: '////=' },
    { size: 7 },
    { content: 'x'.repeat(10925) },
    { name: '../x' },
    { contentType: 'text/plain\r\nInjected: x' },
    { url: 'https://evil.test' },
    { sourceFileId: 'arbitrary' },
    { accountId: 'arbitrary' },
  ])
    assert.equal(githubBatchInputSchema.safeParse({ actions: [{ ...upload, ...changes }] }).success, false);
  const large = Buffer.alloc(8192),
    bounded = {
      ...upload,
      content: large.toString('base64'),
      size: 8192,
      sha256: createHash('sha256').update(large).digest('hex'),
    };
  assert.equal(githubBatchInputSchema.safeParse({ actions: [bounded, bounded] }).success, true);
  assert.equal(githubBatchInputSchema.safeParse({ actions: [bounded, bounded, upload] }).success, false);
  await assert.rejects(
    requireWriteTarget({ ...upload, sha256: 'a'.repeat(64) }, credential, f.fetcher, true),
    /batch-conflict/,
  );
  assert.deepEqual(f.effects, []);
  assert.equal((await send(f, upload)).status, 'succeeded');
});
test('asset names reject provider normalization before approval without rewriting accepted input', () => {
  for (const operation of [upload, releaseOperations[5]]) {
    for (const name of [
      'binary.bin.',
      'binary.bin..',
      '.binary.bin',
      '..binary.bin',
      '.',
      'binary bin',
      'binary+bin',
      'binary/bin',
      'binäry.bin',
      'binary.bin\n',
      'a'.repeat(181),
    ]) {
      const result = githubBatchInputSchema.safeParse({ actions: [{ ...operation, name }] });
      assert.equal(result.success, false, name);
      assert.equal(
        result.error.issues[0].message,
        'Asset filename must be 1-180 ASCII letters, digits, dots, hyphens, or underscores, start with a letter or digit, and not end with a dot. GitHub may rename other filenames.',
      );
    }
    for (const name of [
      'binary.bin',
      'a',
      'a'.repeat(180),
      'Binary_v1.0-linux.bin',
      'binary..bin',
      'binary_',
      'binary-',
    ]) {
      assert.equal(githubBatchInputSchema.parse({ actions: [{ ...operation, name }] }).actions[0].name, name);
    }
  }
});
test('publication rejects changed notes assets timestamp identity and missing permission before dispatch', async t => {
  const f = await releaseProviderFixture();
  t.after(f.close);
  const publish = releaseOperations[2];
  for (const change of [
    { body: 'different' },
    { assetIds: [] },
    { repositoryId: 43 },
    { expectedUpdatedAt: '2026-10-01T00:00:00Z' },
  ])
    await assert.rejects(requireWriteTarget({ ...publish, ...change }, credential, f.fetcher, true));
  f.state.push = false;
  await assert.rejects(requireWriteTarget(publish, credential, f.fetcher, true));
  f.state.push = true;
  f.releases.get(10).immutable = true;
  await assert.rejects(requireWriteTarget(publish, credential, f.fetcher, true));
  f.releases.get(10).immutable = false;
  assert.deepEqual(f.effects, []);
  await requireWriteTarget(publish, credential, f.fetcher, true);
  assert.equal((await send(f, publish)).status, 'succeeded');
});
for (const operation of releaseOperations)
  test(`wrong status or lost ${operation.kind} acknowledgement never triggers a second mutation`, async t => {
    const f = await releaseProviderFixture();
    t.after(f.close);
    f.state.status = 202;
    assert.deepEqual(await send(f, operation), { status: 'unknown', result: null });
    assert.equal(f.effects.length, 1);
    const evidence = await reconcileGitHubWrite({ operation, credential, fetcher: f.fetcher, marker: 'not-present' });
    assert.equal(evidence.result, null);
    assert.equal(evidence.evidence.outcome, 'unresolved');
    assert.equal(f.effects.length, 1);
  });
test('create recovery needs the original marker author and exact draft, not a matching tag alone', async t => {
  const f = await releaseProviderFixture();
  t.after(f.close);
  f.state.lose = true;
  const marker = '<!-- tulipfarm:original:0 -->',
    operation = { ...releaseOperations[0], body: `Reviewed notes\n\n${marker}` };
  await assert.rejects(send(f, operation));
  const recover = () => reconcileGitHubWrite({ operation, credential, fetcher: f.fetcher, marker });
  assert.equal((await recover()).result.releaseId, 11);
  f.releases.get(11).author.id = 999;
  assert.equal((await recover()).result, null);
  f.releases.get(11).author.id = 123;
  f.releases.get(11).draft = false;
  assert.equal((await recover()).result, null);
  assert.equal(f.effects.length, 1);
});
test('malformed upload acknowledgement cannot leak provider credentials into a receipt', async t => {
  const f = await releaseProviderFixture();
  t.after(f.close);
  f.state.malformed = true;
  f.state.secret = credential.accessToken;
  await assert.rejects(send(f, upload), error => !String(error).includes(credential.accessToken));
  assert.deepEqual(f.bytes.get(21), binary);
});

test('documented optional release timestamp and nullable asset digest preserve acknowledged success', () => {
  const release = {
    id: 11,
    tag_name: 'v1.0',
    target_commitish: 'main',
    name: 'Version one',
    body: 'Reviewed notes',
    draft: true,
    prerelease: false,
    assets: [],
  };
  assert.deepEqual(releaseResult(releaseOperations[0], release), {
    repositoryId: 42,
    releaseId: 11,
    draft: true,
    tagName: 'v1.0',
    updatedAt: null,
  });
  const asset = {
    id: 21,
    name: 'binary.bin',
    label: 'Exact binary',
    content_type: 'application/octet-stream',
    size: 8,
    state: 'uploaded',
    digest: null,
  };
  assert.equal(releaseResult(upload, asset).sha256, upload.sha256);
  for (const change of [{ digest: 'sha256:wrong' }, { size: 7 }, { state: 'open' }, { name: 'renamed.bin' }])
    assert.throws(() => releaseResult(upload, { ...asset, ...change }), /batch-unavailable/);
});

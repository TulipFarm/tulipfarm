import assert from 'node:assert/strict';
import test from 'node:test';
import { receiptSource, receiptWrite } from '../src/batch-source-receipts.ts';

const target = { owner: 'octocat', repo: 'private', repositoryId: 42 };
const branch = { kind: 'branch.delete', ...target, branch: 'old', headSha: 'a'.repeat(40) };
const rename = { kind: 'repository.rename', ...target, name: 'renamed' };
const deletion = { kind: 'repository.delete', ...target };
const source = {
  kind: 'github-personal',
  accountId: 'account',
  generation: 1,
  proof: {
    operation: { kind: 'branch.read', owner: target.owner, repo: target.repo, branch: 'old' },
    transport: 'rest',
    digest: '0'.repeat(64),
  },
};
function view(actions) {
  return {
    snapshot: { accountId: 'account', generation: 1, actions },
    actions: actions.map((action, ordinal) => ({
      ordinal,
      status: 'succeeded',
      result: {
        repositoryId: action.repositoryId,
        ...(action.kind.endsWith('delete') ? { deleted: true } : {}),
        ...(action.kind === 'branch.delete' ? { headSha: action.headSha } : {}),
      },
    })),
  };
}

test('ordered receipts preserve stable identity through rename, branch deletion and repository tombstone', () => {
  const chain = view([rename, branch, deletion]);
  assert.equal(receiptSource(source, chain), null);
  assert.equal(receiptWrite(branch, chain), null);
  assert.deepEqual(receiptSource(source, view([branch, rename])).proof.operation, {
    kind: 'repository.read',
    owner: 'octocat',
    repo: 'renamed',
  });
  assert.deepEqual(receiptWrite(branch, view([rename])), { ...branch, repo: 'renamed' });
  assert.deepEqual(receiptWrite({ ...branch, repositoryId: 999 }, chain), { ...branch, repositoryId: 999 });
  assert.deepEqual(
    receiptSource(source, view([branch, rename, { ...deletion, repo: 'renamed', repositoryId: 999 }])).proof.operation,
    { kind: 'repository.read', owner: 'octocat', repo: 'renamed' },
  );
});

test('only acknowledged exact branch and repository receipts transform source access', () => {
  const repository = { kind: 'repository.read', owner: 'octocat', repo: 'private' };
  for (const status of ['unattempted', 'unknown', 'rejected']) {
    const chain = view([branch, deletion]);
    chain.actions[1].status = status;
    assert.deepEqual(receiptSource(source, chain).proof.operation, repository);
  }
  for (const result of [null, { repositoryId: 999, deleted: true }, { repositoryId: 42, deleted: false }]) {
    const chain = view([branch, deletion]);
    chain.actions[1].result = result;
    assert.deepEqual(receiptSource(source, chain).proof.operation, repository);
  }
  const wrongHead = view([branch]);
  wrongHead.actions[0].result.headSha = 'b'.repeat(40);
  assert.deepEqual(receiptSource(source, wrongHead), source);
  assert.deepEqual(receiptSource(source, view([{ ...branch, branch: 'another' }])), source);
});

test('account generation, download proofs and unrelated search targets keep their own checks', () => {
  const chain = view([branch, deletion]);
  for (const other of [
    { ...source, accountId: 'other' },
    { ...source, generation: 2 },
    { ...source, proof: { ...source.proof, download: { operation: { kind: 'release.download' } } } },
  ])
    assert.deepEqual(receiptSource(other, chain), other);
  const outside = { kind: 'repository.read', owner: 'outside', repo: 'source' };
  const search = {
    ...source,
    proof: {
      ...source.proof,
      operation: { kind: 'repository.search', query: 'private', page: 1, perPage: 10 },
      accessTargets: [source.proof.operation, outside],
    },
  };
  assert.deepEqual(receiptSource(search, chain), { ...search, proof: { ...search.proof, accessTargets: [outside] } });
  assert.deepEqual(
    receiptSource({ ...source, proof: { ...source.proof, operation: outside } }, chain).proof.operation,
    outside,
  );
});

test('file tombstones transform only the exact removed path and branch and keep ordered repository receipts', () => {
  const action = {
    kind: 'file.delete',
    ...target,
    branch: 'main',
    headSha: 'a'.repeat(40),
    blobSha: 'b'.repeat(40),
    path: 'old.txt',
    message: 'Delete',
  };
  const chain = view([action, rename]);
  chain.actions[0].result = {
    repositoryId: 42,
    commitSha: 'c'.repeat(40),
    branch: 'main',
    defaultBranch: 'main',
    headSha: action.headSha,
    files: [{ path: 'old.txt', deleted: true }],
  };
  const file = {
    ...source,
    proof: {
      ...source.proof,
      operation: { kind: 'file.read', owner: 'octocat', repo: 'private', path: 'old.txt', ref: 'main' },
    },
  };
  assert.deepEqual(receiptSource(file, chain).proof.operation, {
    kind: 'repository.read',
    owner: 'octocat',
    repo: 'renamed',
  });
  for (const change of [{ path: 'other.txt' }, { ref: 'other' }, { ref: action.headSha }])
    assert.deepEqual(
      receiptSource({ ...file, proof: { ...file.proof, operation: { ...file.proof.operation, ...change } } }, chain)
        .proof.operation,
      { ...file.proof.operation, ...change, repo: 'renamed' },
    );
  const search = {
    ...source,
    proof: {
      ...source.proof,
      operation: { kind: 'file.search', query: 'private', page: 1, perPage: 10 },
      accessTargets: [file.proof.operation, { ...file.proof.operation, path: 'secret.txt' }],
    },
  };
  assert.deepEqual(receiptSource(search, chain).proof.accessTargets, [
    { kind: 'repository.read', owner: 'octocat', repo: 'renamed' },
    { ...file.proof.operation, path: 'secret.txt', repo: 'renamed' },
  ]);
  chain.actions[0].status = 'unknown';
  assert.equal(receiptSource(file, chain).proof.operation.kind, 'file.read');
});

test('release tombstones preserve stable repository identity and only retire their exact asset sources', () => {
  const action = { kind: 'release.delete', ...target, releaseId: 10, assetIds: [20], expectedUpdatedAt: null };
  const chain = view([rename, action, { ...deletion, repo: 'renamed', repositoryId: 999 }]);
  chain.actions[1].result = { repositoryId: 42, releaseId: 10, assetIds: [20], deleted: true };
  const asset = {
    ...source,
    proof: { ...source.proof, operation: { kind: 'release.asset', owner: 'octocat', repo: 'private', id: 20 } },
  };
  assert.deepEqual(receiptSource(asset, chain).proof.operation, {
    kind: 'repository.read',
    owner: 'octocat',
    repo: 'renamed',
  });
  const download = {
    ...asset,
    proof: {
      ...asset.proof,
      download: { operation: { kind: 'release.download', owner: 'octocat', repo: 'private', id: 20 } },
    },
  };
  const reduced = receiptSource(download, chain);
  assert.deepEqual(reduced.proof.operation, { kind: 'repository.read', owner: 'octocat', repo: 'renamed' });
  assert.equal('download' in reduced.proof, false);
  const other = { ...asset, proof: { ...asset.proof, operation: { ...asset.proof.operation, id: 21 } } };
  assert.deepEqual(receiptSource(other, chain).proof.operation, { ...other.proof.operation, repo: 'renamed' });
  chain.actions[1].status = 'unknown';
  assert.equal(receiptSource(asset, chain).proof.operation.kind, 'release.asset');
  assert.deepEqual(receiptSource(download, chain), download);
});

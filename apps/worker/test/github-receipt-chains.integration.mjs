import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { repositoryFixture, repositoryTarget as target, branchSha as sha } from './github-repository-fixture.mjs';

const branch = { kind: 'branch.delete', ...target, branch: 'old', headSha: sha };
const deletion = { kind: 'repository.delete', ...target };
const rename = { kind: 'repository.rename', ...target, name: 'renamed' };
const creation = {
  kind: 'repository.create',
  owner: 'person-123',
  repo: 'new',
  ownerType: 'user',
  ownerId: 123,
  description: '',
  private: true,
  autoInit: true,
};
const source = { kind: 'branch.read', owner: target.owner, repo: target.repo, branch: 'old' };

for (const actions of [
  [branch, deletion],
  [branch, deletion, creation],
  [branch, rename, creation],
  [rename, branch, deletion, creation],
  [branch, rename, deletion, creation],
]) {
  test(`receipt chain ${actions.map(action => action.kind).join(' then ')} retains readable outcomes and continues`, async () => {
    const f = await repositoryFixture();
    try {
      const batch = await f.propose(actions, [source]);
      await f.approve(batch);
      let error;
      try {
        await f.execute(batch);
      } catch (caught) {
        error = caught.message;
      }
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        actions.map(() => 'succeeded'),
      );
      assert.equal(error, undefined, 'Acknowledged own mutations must retain readable outcomes');
      const expected = actions.map(action => ({
        status: 'succeeded',
        result:
          action.kind === 'branch.delete'
            ? { repositoryId: 42, deleted: true, headSha: sha }
            : action.kind === 'repository.delete'
              ? { repositoryId: 42, deleted: true }
              : action.kind === 'repository.create'
                ? { repositoryId: 43 }
                : { repositoryId: 42 },
      }));
      const recovered = createGitHubBatches(f.options);
      const args = [f.one.id, f.member.userId, f.chatId, batch.snapshot.id];
      const read = await recovered.read(...args);
      assert.deepEqual(
        read.actions.map(({ status, result }) => ({ status, result })),
        expected,
      );
      assert.deepEqual(read.snapshot, batch.snapshot);
      assert.deepEqual((await recovered.list(...args.slice(0, 3))).batches, [read]);
      assert.deepEqual((await recovered.execute(...args)).actions, read.actions);
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT status,result FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1 ORDER BY ordinal`,
            [batch.snapshot.id],
          )
        ).rows,
        expected,
      );
      let repo = 'private';
      const paths = actions.map(action => {
        if (action.kind === 'repository.create') return '/user/repos';
        const path = `/repos/octocat/${repo}${action.kind === 'branch.delete' ? '/git/refs/heads/old' : ''}`;
        if (action.kind === 'repository.rename') repo = action.name;
        return path;
      });
      assert.deepEqual(
        f.effects.map(effect => effect.path),
        paths,
      );
      assert.equal(f.branches.has('old'), false);
      if (actions.includes(creation)) assert.equal(f.creations[0].full_name, 'person-123/new');
    } finally {
      await f.close();
    }
  });
}

for (const failure of [
  'external-deletion',
  'source-rights',
  'outside-source',
  'unknown-deletion',
  'changed-identity',
  'admin-rights',
]) {
  test(`receipt chains retain ${failure} barriers before the next action`, async () => {
    const f = await repositoryFixture();
    try {
      const batch = await f.propose(
        [branch, deletion, creation],
        [source, { kind: 'repository.read', owner: 'outside', repo: 'source' }],
      );
      await f.approve(batch);
      let changed = false;
      const runtime = {
        ...f.runtime,
        transaction: async (...args) => {
          const result = await f.runtime.transaction(...args);
          const receipts = await f.db.platform.query(
            `SELECT ordinal FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1 AND status='succeeded'`,
            [batch.snapshot.id],
          );
          if (!changed && receipts.rowCount === (failure === 'outside-source' ? 2 : 1)) {
            changed = true;
            if (failure === 'external-deletion') f.externalDelete();
            if (failure === 'source-rights') f.deny();
            if (failure === 'outside-source') f.denyOutside();
            if (failure === 'unknown-deletion') f.lose();
            if (failure === 'changed-identity' || failure === 'admin-rights')
              f.setProvider(async (_url, init) => {
                assert.equal(init.method, 'GET');
                return Response.json({
                  id: failure === 'changed-identity' ? 999 : 42,
                  full_name: 'octocat/private',
                  archived: false,
                  default_branch: 'main',
                  permissions: { admin: failure !== 'admin-rights', push: true },
                });
              });
          }
          return result;
        },
      };
      const service = createGitHubBatches({ ...f.options, runtime });
      await service.execute(f.one.id, f.member.userId, f.chatId, batch.snapshot.id).catch(() => {});
      assert.equal(changed, true);
      const secondStatus =
        failure === 'outside-source'
          ? 'succeeded'
          : failure === 'unknown-deletion'
            ? 'unknown'
            : ['changed-identity', 'admin-rights'].includes(failure)
              ? 'rejected'
              : 'unattempted';
      assert.deepEqual((await f.status(batch)).actions, [
        { ordinal: 0, status: 'succeeded' },
        { ordinal: 1, status: secondStatus },
        { ordinal: 2, status: 'unattempted' },
      ]);
      const paths = [
        '/repos/octocat/private/git/refs/heads/old',
        ...(['outside-source', 'unknown-deletion'].includes(failure) ? ['/repos/octocat/private'] : []),
      ];
      assert.deepEqual(
        f.effects.map(effect => effect.path),
        paths,
      );
      assert.equal(f.creations.length, 0);
      if (failure !== 'admin-rights') {
        await assert.rejects(f.read(batch), /Resource not found|batch-conflict/);
        assert.deepEqual((await f.batches.list(f.one.id, f.member.userId, f.chatId)).batches, [await f.status(batch)]);
      }
      if (failure === 'unknown-deletion') {
        assert.equal((await f.reconcileStatus(batch)).actions[1].status, 'unknown');
        await assert.rejects(f.execute(batch));
        assert.deepEqual(
          f.effects.map(effect => effect.path),
          paths,
        );
      }
      if (failure === 'outside-source') {
        f.allowOutside();
        const recovered = createGitHubBatches(f.options);
        const result = await recovered.execute(f.one.id, f.member.userId, f.chatId, batch.snapshot.id);
        assert.deepEqual(
          result.actions.map(action => action.status),
          ['succeeded', 'succeeded', 'succeeded'],
        );
        assert.deepEqual(result.actions[1].result, { repositoryId: 42, deleted: true });
        assert.deepEqual(
          f.effects.map(effect => effect.path),
          [...paths, '/user/repos'],
        );
      }
    } finally {
      await f.close();
    }
  });
}

test('an own repository tombstone rejects a later same-target mutation without blocking unrelated completed evidence', async () => {
  const f = await repositoryFixture();
  try {
    const batch = await f.propose(
      [branch, deletion, { kind: 'repository.archive', ...target, archived: true }, creation],
      [source],
    );
    await f.approve(batch);
    assert.deepEqual(
      (await f.execute(batch)).actions.map(action => action.status),
      ['succeeded', 'succeeded', 'rejected', 'unattempted'],
    );
    assert.deepEqual((await f.read(batch)).actions[1].result, { repositoryId: 42, deleted: true });
    assert.deepEqual(
      f.effects.map(effect => effect.path),
      ['/repos/octocat/private/git/refs/heads/old', '/repos/octocat/private'],
    );
  } finally {
    await f.close();
  }
});

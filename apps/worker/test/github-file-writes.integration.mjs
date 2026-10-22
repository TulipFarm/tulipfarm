import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { githubFileFixture } from './github-file-fixture.mjs';
import { fileTarget, headSha, blob, forkOperation } from '../../../packages/github/test/file-provider-fixture.mjs';

const operations = [
  {
    kind: 'file.create',
    ...fileTarget,
    path: 'new.txt',
    content: 'exact new text\n',
    encoding: 'utf-8',
    message: 'Create exact file',
  },
  {
    kind: 'file.update',
    ...fileTarget,
    path: 'old.txt',
    blobSha: blob('old text\n'),
    content: 'updated text\n',
    encoding: 'utf-8',
    message: 'Update exact file',
  },
  { kind: 'file.delete', ...fileTarget, path: 'old.txt', blobSha: blob('old text\n'), message: 'Delete exact file' },
  {
    kind: 'files.commit',
    ...fileTarget,
    message: 'Atomic exact files',
    files: [
      { kind: 'create', path: 'new.txt', content: 'new text\n', encoding: 'utf-8' },
      { kind: 'delete', path: 'old.txt', blobSha: blob('old text\n') },
    ],
  },
  { ...forkOperation, head: 'other' },
];
for (const operation of operations)
  test(`registered worker ${operation.kind} persists exact approval, ordered effects, replay and a new proposal`, async () => {
    const f = await githubFileFixture();
    try {
      const next = { ...operations[0], branch: 'other', path: 'follow.txt' };
      const batch = await f.propose([operation, next]);
      await assert.rejects(f.execute(batch), /batch-approval-required/);
      await f.approve(batch);
      assert.equal((await f.worker(batch)).status, 'completed');
      const view = await f.read(batch);
      assert.deepEqual(
        view.actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
      assert.deepEqual(view.snapshot, batch.snapshot);
      assert.equal(f.effects.at(-1).path, '/repos/octocat/private/contents/follow.txt');
      if (operation.kind !== 'pull.create-fork') assert.equal(view.actions[0].result.commitSha, f.branches.get('main'));
      else assert.deepEqual(view.actions[0].result, { id: 88, number: 8 });
      const count = f.effects.length;
      const recovered = createGitHubBatches(f.options);
      await recovered.execute(f.one.id, f.member.userId, f.chatId, batch.snapshot.id);
      assert.equal(f.effects.length, count);
      assert.equal(
        (await f.propose([{ ...operations[0], path: 'later.txt', headSha: f.branches.get('main') }])).actions[0].status,
        'unattempted',
      );
    } finally {
      await f.close();
    }
  });

for (const index of [1, 2, 3])
  test(`own ${operations[index].kind} preserves batch source access but not other private content`, async () => {
    const f = await githubFileFixture();
    try {
      const batch = await f.propose(
        [operations[index], { ...operations[0], branch: 'other' }],
        [
          { kind: 'file.read', owner: 'octocat', repo: 'private', path: 'old.txt', ref: 'main' },
          { kind: 'repository.read', owner: 'outside', repo: 'source' },
        ],
      );
      await f.approve(batch);
      await f.worker(batch);
      assert.deepEqual(
        (await f.read(batch)).actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
      assert.equal(f.effects.at(-1).path, '/repos/octocat/private/contents/new.txt');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT status FROM ${f.table('tf_conversation_turns')} WHERE conversation_id=$1 ORDER BY accepted_sequence DESC LIMIT 1`,
            [f.chatId],
          )
        ).rows[0].status,
        operations[index].kind === 'file.update' ? 'completed' : 'blocked',
      );
      f.state.outsideDeny = true;
      await assert.rejects(f.read(batch), /Resource not found/);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
      f.state.outsideDeny = false;
      assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
    } finally {
      await f.close();
    }
  });

for (const index of [0, 1, 2, 3, 4])
  test(`lost ${operations[index].kind} acknowledgement reconciles without duplicate effects`, async () => {
    const f = await githubFileFixture();
    try {
      const batch = await f.propose([operations[index], { ...operations[0], branch: 'other', path: 'follow.txt' }]);
      await f.approve(batch);
      f.state.lose = index === 3 ? '/git/refs/heads/main' : index === 4 ? '/pulls' : operations[index].path;
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      const count = f.effects.length;
      await f.execute(batch);
      assert.equal(f.effects.length, count);
      const view = await f.reconcile(batch);
      assert.deepEqual(
        view.actions.map(action => action.status),
        ['succeeded', 'unattempted'],
      );
      f.state.lose = '';
      await f.execute(batch);
      assert.equal(f.effects.length, count + 1);
      assert.deepEqual(
        (await f.read(batch)).actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
    } finally {
      await f.close();
    }
  });

for (const failure of ['reject', 'lose', 'malformed'])
  test(`caught ${failure} preparing a commit rejects without a permanent uncertainty block`, async () => {
    const f = await githubFileFixture();
    try {
      const batch = await f.propose([operations[3]]);
      await f.approve(batch);
      f.state[failure] = '/git/commits';
      await f.worker(batch);
      assert.equal((await f.status(batch)).actions[0].status, 'rejected');
      assert.equal(f.branches.get('main'), headSha);
      assert.equal(
        f.effects.some(effect => effect.path.includes('/git/refs/')),
        false,
      );
      assert.equal((await f.propose([operations[0]])).actions[0].status, 'unattempted');
    } finally {
      await f.close();
    }
  });

test('changed head and old blob reject without dispatch or poisoning review', async () => {
  for (const change of ['head', 'blob']) {
    const f = await githubFileFixture();
    try {
      const batch = await f.propose([{ ...operations[1], ...(change === 'blob' ? { blobSha: 'f'.repeat(40) } : {}) }]);
      await f.approve(batch);
      if (change === 'head') f.branches.set('main', 'f'.repeat(40));
      await f.worker(batch);
      assert.equal((await f.read(batch)).actions[0].status, 'rejected');
      assert.deepEqual(f.effects, []);
    } finally {
      await f.close();
    }
  }
});

test('unknown deleted file can recover through owner status without authorizing unrelated sources', async () => {
  const f = await githubFileFixture();
  try {
    const batch = await f.propose(
      [operations[2]],
      [
        { kind: 'file.read', owner: 'octocat', repo: 'private', path: 'old.txt', ref: 'main' },
        { kind: 'repository.read', owner: 'outside', repo: 'source' },
      ],
    );
    await f.approve(batch);
    f.state.lose = 'old.txt';
    await f.worker(batch);
    await assert.rejects(f.read(batch), /Resource not found/);
    f.state.outsideDeny = true;
    assert.equal((await f.reconcileStatus(batch)).actions[0].status, 'succeeded');
    await assert.rejects(f.read(batch), /Resource not found/);
    f.state.outsideDeny = false;
    assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

for (const endpoint of ['/git/commits', '/git/refs/heads/main'])
  test(`credential rejection at ${endpoint} preserves accurate dispatch status and invalidates the account`, async () => {
    const f = await githubFileFixture();
    try {
      const batch = await f.propose([operations[3]]);
      await f.approve(batch);
      f.state.unauthorized = endpoint;
      await f.worker(batch);
      const receipt = (
        await f.db.platform.query(`SELECT status FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1`, [
          batch.snapshot.id,
        ])
      ).rows[0];
      assert.equal(receipt.status, endpoint === '/git/commits' ? 'rejected' : 'unknown');
      const account = (
        await f.db.platform.query(`SELECT state,credential FROM ${f.table('tf_github_accounts')} WHERE id=$1`, [
          f.accountId,
        ])
      ).rows[0];
      assert.deepEqual(account, { state: 'reconnect-required', credential: null });
      assert.equal(f.branches.get('main'), headSha);
    } finally {
      await f.close();
    }
  });

test('single-connection runtime persists candidate evidence without nested transactions', async () => {
  const f = await githubFileFixture({ connectionsPerPool: 1 });
  try {
    const batch = await f.propose([operations[3]]);
    await f.approve(batch);
    await f.worker(batch);
    assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
    assert.equal(f.effects.length, 3);
  } finally {
    await f.close();
  }
});

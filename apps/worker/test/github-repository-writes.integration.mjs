import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { repositoryFixture, repositoryTarget as target, branchSha as sha } from './github-repository-fixture.mjs';

const operations = [
  {
    kind: 'repository.create',
    owner: 'person-123',
    repo: 'new',
    ownerType: 'user',
    ownerId: 123,
    description: '',
    private: true,
    autoInit: true,
  },
  {
    kind: 'repository.create',
    owner: 'acme',
    repo: 'new',
    ownerType: 'organization',
    ownerId: 456,
    description: '',
    private: true,
    autoInit: false,
  },
  {
    kind: 'repository.settings',
    ...target,
    description: 'Updated',
    private: true,
    hasIssues: true,
    hasWiki: false,
    defaultBranch: 'main',
  },
  { kind: 'repository.rename', ...target, name: 'renamed' },
  { kind: 'repository.archive', ...target, archived: true },
  { kind: 'repository.delete', ...target },
  { kind: 'branch.create', ...target, branch: 'next', headSha: sha },
  { kind: 'branch.delete', ...target, branch: 'old', headSha: sha },
];
for (const operation of operations.slice(0, 2))
  test(`registered worker persists official MCP ${operation.ownerType} repository creation and follows with a separate target`, async () => {
    const args = {
      name: operation.repo,
      description: operation.description,
      private: operation.private,
      autoInit: operation.autoInit,
      ...(operation.ownerType === 'organization' ? { organization: operation.owner } : {}),
    };
    const f = await repositoryFixture({
      operation,
      args,
      name: 'create_repository',
      text: JSON.stringify({ id: '43', url: `https://github.com/${operation.owner}/${operation.repo}` }),
    });
    try {
      const batch = await f.propose([operation, operations[6]], []);
      await f.approve(batch);
      assert.equal((await f.worker(batch)).status, 'completed');
      assert.deepEqual(
        (await f.read(batch)).actions.map(action => ({ status: action.status, result: action.result })),
        [
          { status: 'succeeded', result: { repositoryId: '43' } },
          { status: 'succeeded', result: { repositoryId: 42, headSha: sha } },
        ],
      );
      assert.deepEqual(f.mcpEffects, [args]);
      await f.execute(batch);
      assert.equal(f.mcpEffects.length, 1);
      assert.equal(f.branches.get('next'), sha);
    } finally {
      await f.close();
    }
  });
for (const operation of operations)
  test(`registered worker approves ${operation.kind} ${operation.owner}, retains outcome and never repeats`, async () => {
    const f = await repositoryFixture();
    try {
      const batch = await f.propose([operation], []);
      await assert.rejects(f.execute(batch), /batch-approval-required/);
      await f.approve(batch);
      assert.equal((await f.worker(batch)).status, 'completed');
      const result = await f.read(batch);
      assert.deepEqual(
        result.actions.map(action => action.status),
        ['succeeded'],
      );
      assert.deepEqual(result.snapshot, batch.snapshot);
      const expected =
        operation.kind === 'repository.create'
          ? { repositoryId: 43 }
          : operation.kind === 'repository.delete'
            ? { repositoryId: 42, deleted: true }
            : operation.kind === 'branch.delete'
              ? { repositoryId: 42, deleted: true, headSha: sha }
              : operation.kind === 'branch.create'
                ? { repositoryId: 42, headSha: sha }
                : { repositoryId: 42 };
      assert.deepEqual(result.actions[0].result, expected);
      await f.execute(batch);
      assert.equal(f.effects.length, 1);
      assert.equal(
        f.effects[0].method,
        operation.kind.endsWith('delete') ? 'DELETE' : operation.kind.endsWith('create') ? 'POST' : 'PATCH',
      );
      await assert.rejects(f.batches.status(f.one.id, randomUUID(), f.chatId, batch.snapshot.id), /Resource not found/);
      if (operation.kind === 'repository.delete') {
        f.deny();
        assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
      }
    } finally {
      await f.close();
    }
  });

for (const index of [0, 3, 5, 6, 7])
  test(`lost ${operations[index].kind} acknowledgement stays unknown and owner status survives target loss`, async () => {
    const f = await repositoryFixture();
    try {
      const batch = await f.propose([operations[index]], []);
      await f.approve(batch);
      f.lose();
      await f.worker(batch);
      assert.deepEqual(await f.status(batch), {
        id: batch.snapshot.id,
        decision: 'approve',
        actions: [{ ordinal: 0, status: 'unknown' }],
      });
      assert.deepEqual(await f.reconcileStatus(batch), await f.status(batch));
      await f.execute(batch).catch(() => {});
      assert.equal(f.effects.length, 1);
      const receipt = (
        await f.db.platform.query(
          `SELECT status,reconciliation FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1`,
          [batch.snapshot.id],
        )
      ).rows[0];
      assert.equal(receipt.status, 'unknown');
      assert.equal(receipt.reconciliation.outcome, 'unresolved');
      if (index === 5 || index === 7) assert.equal(receipt.reconciliation.status, 404);
    } finally {
      await f.close();
    }
  });

test('own deletion receipt cannot authorize an outside source, and an external 404 cannot create a tombstone', async () => {
  const f = await repositoryFixture();
  try {
    const batch = await f.propose(
      [operations[5]],
      [
        { kind: 'repository.read', owner: 'octocat', repo: 'private' },
        { kind: 'repository.read', owner: 'outside', repo: 'source' },
      ],
    );
    await f.approve(batch);
    await f.execute(batch);
    assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
    f.denyOutside();
    await assert.rejects(f.read(batch), /Resource not found/);
    assert.equal((await f.status(batch)).actions[0].status, 'succeeded');
    const second = await repositoryFixture();
    try {
      const pending = await second.propose([operations[5]]);
      second.externalDelete();
      await assert.rejects(second.read(pending), /Resource not found/);
      assert.equal((await second.status(pending)).actions[0].status, 'unattempted');
      assert.equal(second.effects.length, 0);
    } finally {
      await second.close();
    }
  } finally {
    await f.close();
  }
});

test('changed branch head rejects only dispatch and leaves status and review usable', async () => {
  const f = await repositoryFixture();
  try {
    const batch = await f.propose(
      [operations[7]],
      [{ kind: 'branch.read', owner: 'octocat', repo: 'private', branch: 'old' }],
    );
    await f.approve(batch);
    f.branches.set('old', 'b'.repeat(40));
    assert.equal((await f.execute(batch)).actions[0].status, 'rejected');
    assert.equal((await f.read(batch)).actions[0].status, 'rejected');
    assert.equal(f.branches.get('old'), 'b'.repeat(40));
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

test('branch deletion preserves its own branch source receipt and rejects missing scope without poisoning review', async () => {
  const f = await repositoryFixture();
  try {
    const branch = await f.propose(
      [operations[7]],
      [{ kind: 'branch.read', owner: 'octocat', repo: 'private', branch: 'old' }],
    );
    await f.approve(branch);
    assert.equal((await f.execute(branch)).actions[0].status, 'succeeded');
    assert.equal(f.branches.has('old'), false);
  } finally {
    await f.close();
  }
  const second = await repositoryFixture();
  try {
    const batch = await second.propose([operations[5]], []);
    await second.db.platform.query(
      `UPDATE ${second.table('tf_github_accounts')} SET scopes=ARRAY['repo'] WHERE id=$1`,
      [second.accountId],
    );
    await second.approve(batch);
    assert.equal((await second.execute(batch)).actions[0].status, 'rejected');
    assert.equal((await second.read(batch)).actions[0].status, 'rejected');
  } finally {
    await second.close();
  }
});

test('own rename source follows only the acknowledged target while outside access stays required', async () => {
  const f = await repositoryFixture();
  try {
    const batch = await f.propose(
      [operations[3]],
      [
        { kind: 'repository.read', owner: 'octocat', repo: 'private' },
        { kind: 'repository.read', owner: 'outside', repo: 'source' },
      ],
    );
    await f.approve(batch);
    await f.execute(batch);
    assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
    f.denyOutside();
    await assert.rejects(f.read(batch), /Resource not found/);
    const list = await f.batches.list(f.one.id, f.member.userId, f.chatId);
    assert.deepEqual(list.batches, [
      { id: batch.snapshot.id, decision: 'approve', actions: [{ ordinal: 0, status: 'succeeded' }] },
    ]);
  } finally {
    await f.close();
  }
});

test('status-only reads still require original owner, account generation, selection and active membership', async () => {
  const f = await repositoryFixture();
  try {
    const batch = await f.propose([operations[5]], []);
    assert.equal((await f.status(batch)).actions[0].status, 'unattempted');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_github_chat_selection')} SET version=version+1 WHERE conversation_id=$1`,
      [f.chatId],
    );
    await assert.rejects(f.status(batch), /Resource not found/);
    await assert.rejects(f.reconcileStatus(batch), /Resource not found/);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_github_chat_selection')} SET version=version-1 WHERE conversation_id=$1`,
      [f.chatId],
    );
    await f.options.accounts.disconnect(f.one.id, f.member.userId, f.accountId);
    await assert.rejects(f.status(batch), /Resource not found/);
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

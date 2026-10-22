import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { githubReleaseFixture } from './github-release-fixture.mjs';
import { releaseOperations, upload, binary } from '../../../packages/github/test/release-provider-fixture.mjs';

test('provider-normalized filenames never create approval or effects and a corrected binary upload succeeds', async () => {
  const f = await githubReleaseFixture();
  try {
    f.state.afterEffect = () => {
      const asset = f.assets.get(21);
      if (asset) asset.name = asset.name.replace(/^\.+|\.+$/g, '');
    };
    for (const operation of [upload, releaseOperations[5]]) {
      for (const name of ['binary.bin.', 'binary.bin..', '.binary.bin', 'binary bin', 'binary+bin', 'binäry.bin']) {
        await assert.rejects(
          f.batches.propose(
            f.one.id,
            { kind: 'human', ...f.member },
            randomUUID(),
            { conversationId: f.chatId, turnId: randomUUID(), sources: [] },
            { actions: [{ ...operation, name }] },
          ),
          /Asset filename must be 1-180 ASCII/,
        );
        f.decide(
          [{ tool: 'github.personal.propose', actions: [{ ...operation, name }] }],
          'The invalid proposal was not executed.',
        );
        assert.equal((await f.send(f.chatId, `Upload as ${name}`)).status, 'completed');
      }
    }
    assert.deepEqual((await f.batches.list(f.one.id, f.member.userId, f.chatId)).batches, []);
    for (const table of ['tf_github_batches', 'tf_github_batch_decisions', 'tf_github_action_receipts']) {
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::integer AS count FROM ${f.table(table)}`)).rows[0].count,
        0,
      );
    }
    assert.deepEqual(f.effects, []);
    assert.equal(f.bytes.size, 0);
    assert.equal(f.assets.get(20).name, 'old.bin');
    const batch = await f.propose([upload]);
    assert.equal(batch.snapshot.actions[0].name, 'binary.bin');
    assert.equal(batch.decision, null);
    await f.approve(batch);
    assert.equal((await f.worker(batch)).status, 'completed');
    assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
    assert.equal(f.assets.get(21).name, 'binary.bin');
    assert.deepEqual(f.bytes.get(21), binary);
    await f.worker(batch);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('unexpected returned asset name remains unknown and blocks replacement without replay', async () => {
  const f = await githubReleaseFixture();
  try {
    const batch = await f.propose([upload, releaseOperations[0]]);
    await f.approve(batch);
    f.state.afterEffect = () => {
      f.assets.get(21).name = 'unexpected.bin';
    };
    await f.worker(batch);
    assert.deepEqual(f.bytes.get(21), binary);
    assert.equal(f.assets.get(21).name, 'unexpected.bin');
    assert.deepEqual(
      (await f.status(batch)).actions.map(action => action.status),
      ['unknown', 'unattempted'],
    );
    assert.equal((await f.reconcile(batch)).actions[0].status, 'unknown');
    const sent = await f.store.send(f.one.id, f.member.userId, f.chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Another intent' }],
    });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
      [sent.turnId],
    );
    await assert.rejects(
      f.batches.propose(
        f.one.id,
        { kind: 'human', ...f.member },
        randomUUID(),
        { conversationId: f.chatId, turnId: sent.turnId, sources: [] },
        { actions: [releaseOperations[0]] },
      ),
      /batch-unresolved/,
    );
    await f.execute(batch);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

for (const operation of releaseOperations)
  test(`registered ${operation.kind} requires approval and persists ordered effects without replay`, async () => {
    const f = await githubReleaseFixture();
    try {
      const next = { ...releaseOperations[0], tagName: 'v2.0' };
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
      assert.equal(f.effects.at(-1).body.tag_name, 'v2.0');
      if (operation.kind === 'release.asset-upload') assert.deepEqual(f.bytes.get(21), binary);
      await f.execute(batch);
      assert.equal(f.effects.length, 2);
    } finally {
      await f.close();
    }
  });
for (const index of [3, 6])
  test(`own ${releaseOperations[index].kind} retains review and continuation but cannot authorize outside sources`, async () => {
    const f = await githubReleaseFixture();
    try {
      const sources = [
        { kind: 'release.asset', owner: 'octocat', repo: 'private', id: 20 },
        { kind: 'repository.read', owner: 'outside', repo: 'source' },
      ];
      if (index === 3) sources.push({ kind: 'release.read', owner: 'octocat', repo: 'private', id: 10 });
      const batch = await f.propose([releaseOperations[index], releaseOperations[0]], sources);
      await f.approve(batch);
      await f.worker(batch);
      assert.deepEqual(
        (await f.read(batch)).actions.map(action => action.status),
        ['succeeded', 'succeeded'],
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
for (const operation of releaseOperations)
  test(`lost ${operation.kind} acknowledgement stops ordered writes and blocks replacement intent`, async () => {
    const f = await githubReleaseFixture();
    try {
      const batch = await f.propose([operation, releaseOperations[0]]);
      await f.approve(batch);
      f.state.lose = true;
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      await f.execute(batch);
      assert.equal(f.effects.length, 1);
      const view = await f.reconcile(batch);
      assert.equal(view.actions[0].status, operation.kind === 'release.create' ? 'succeeded' : 'unknown');
      assert.equal(f.effects.length, 1);
      if (operation.kind !== 'release.create') {
        const sent = await f.store.send(f.one.id, f.member.userId, f.chatId, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          model: 'claude-sonnet',
          parts: [{ kind: 'text', text: 'Another intent' }],
        });
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
          [sent.turnId],
        );
        await assert.rejects(
          f.batches.propose(
            f.one.id,
            { kind: 'human', ...f.member },
            randomUUID(),
            { conversationId: f.chatId, turnId: sent.turnId, sources: [] },
            { actions: [releaseOperations[0]] },
          ),
          /batch-unresolved/,
        );
      }
    } finally {
      await f.close();
    }
  });
test('upload source access loss and changed push rights prevent binary dispatch', async () => {
  for (const revoke of ['source', 'push']) {
    const f = await githubReleaseFixture();
    try {
      const batch = await f.propose([upload], [{ kind: 'repository.read', owner: 'outside', repo: 'source' }]);
      await f.approve(batch);
      if (revoke === 'source') f.state.outsideDeny = true;
      else f.state.push = false;
      await assert.rejects(f.execute(batch));
      assert.deepEqual(f.effects, []);
      assert.equal((await f.status(batch)).actions[0].status, 'unattempted');
      f.state.outsideDeny = false;
      f.state.push = true;
      await f.execute(batch);
      assert.deepEqual(f.bytes.get(21), binary);
    } finally {
      await f.close();
    }
  }
});
test('permission loss between approved release actions preserves first effect and stops the second', async () => {
  const f = await githubReleaseFixture();
  try {
    const batch = await f.propose([releaseOperations[0], upload]);
    await f.approve(batch);
    f.state.afterEffect = () => {
      f.state.push = false;
    };
    await f.worker(batch);
    assert.equal(f.effects.length, 1);
    assert.equal(f.releases.get(11).draft, true);
    assert.deepEqual(
      (await f.status(batch)).actions.map(action => action.status),
      ['succeeded', 'rejected'],
    );
  } finally {
    await f.close();
  }
});

test('download-derived deletion keeps the receipt readable without restoring the deleted download', async () => {
  const f = await githubReleaseFixture();
  try {
    const batch = await f.propose(
      [releaseOperations[6], releaseOperations[0]],
      [
        { kind: 'release.download', owner: 'octocat', repo: 'private', id: 20 },
        { kind: 'repository.read', owner: 'outside', repo: 'source' },
      ],
    );
    assert.equal(
      batch.snapshot.sources.some(source => source.proof?.download?.size === 8),
      true,
    );
    await f.approve(batch);
    await f.worker(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(action => action.status),
      ['succeeded', 'succeeded'],
    );
    f.state.outsideDeny = true;
    await assert.rejects(f.read(batch), /Resource not found/);
    assert.equal(f.assets.has(20), false);
    assert.equal(f.effects.length, 2);
  } finally {
    await f.close();
  }
});

test('draft creation then a separately approved publication preserves recovery-marked notes and proposal replay', async () => {
  const f = await githubReleaseFixture();
  try {
    const created = await f.propose([releaseOperations[0]]);
    await f.approve(created);
    await f.worker(created);
    const draft = f.releases.get(11);
    const action = { ...releaseOperations[2], releaseId: 11, body: draft.body, assetIds: [] };
    const publish = await f.propose([action]);
    const replay = await f.batches.propose(
      f.one.id,
      { kind: 'human', ...f.member },
      publish.snapshot.commandId,
      { conversationId: f.chatId, turnId: publish.snapshot.origin.turnId, sources: publish.snapshot.sources },
      { actions: [action] },
    );
    assert.equal(replay.digest, publish.digest);
    await f.approve(publish);
    await f.worker(publish);
    assert.equal(f.releases.get(11).draft, false);
    assert.equal(f.releases.get(11).body, draft.body);
    assert.equal(f.effects.length, 2);
  } finally {
    await f.close();
  }
});

test('mixed release upload and issue comment retain exact ordering and private upload ownership', async () => {
  const f = await githubReleaseFixture();
  try {
    const batch = await f.propose([
      upload,
      { kind: 'issue.comment', owner: 'octocat', repo: 'private', issueNumber: 7, body: 'Binary attached' },
    ]);
    const other = { userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      other.membershipId,
      other.userId,
    ]);
    await assert.rejects(f.batches.read(f.one.id, other.userId, f.chatId, batch.snapshot.id), /Resource not found/);
    await f.approve(batch);
    await f.worker(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(action => action.status),
      ['succeeded', 'succeeded'],
    );
    assert.deepEqual(
      f.effects.map(effect => effect.path),
      ['/repos/octocat/private/releases/10/assets', '/repos/octocat/private/issues/7/comments'],
    );
    assert.deepEqual(f.bytes.get(21), binary);
  } finally {
    await f.close();
  }
});

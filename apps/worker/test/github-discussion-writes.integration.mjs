import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { githubDiscussionFixture } from './github-discussion-fixture.mjs';
import { discussionOperations } from '../../../packages/github/test/discussion-provider-fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const unrelated = {
  kind: 'issue.comment',
  owner: 'octocat',
  repo: 'private',
  issueNumber: 7,
  body: 'Discussion changes complete.',
};
for (const operation of discussionOperations)
  test(`registered ${operation.kind} requires exact approval and persists mixed receipts without replay`, async () => {
    const f = await githubDiscussionFixture();
    try {
      const batch = await f.propose([operation, unrelated]);
      await assert.rejects(f.execute(batch), /batch-approval-required/);
      assert.equal(f.effects.length, 0);
      await f.approve(batch);
      await f.worker(batch);
      assert.deepEqual(
        (await f.read(batch)).actions.map(a => a.status),
        ['succeeded', 'succeeded'],
      );
      assert.equal(f.effects.at(-1).name, 'issueComment');
      assert.deepEqual(f.schemaErrors, []);
      await f.worker(batch);
      await f.execute(batch);
      assert.equal(f.effects.length, 2);
    } finally {
      await f.close();
    }
  });
for (const change of ['generation', 'selection', 'turn-generation', 'cancel', 'expiry'])
  test(`Discussion ${change} fencing stops approved writes`, async () => {
    const f = await githubDiscussionFixture();
    try {
      const batch = await f.propose([discussionOperations[0]]);
      await f.approve(batch);
      if (change === 'generation')
        await f.options.accounts.reconnect(f.one.id, f.member.userId, 'new-session', f.accountId);
      if (change === 'selection')
        await f.db.platform.query(`UPDATE ${f.table('tf_github_chat_selection')} SET version=version+1`);
      if (change === 'turn-generation')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET generation=generation+1 WHERE id=$1`,
          [batch.snapshot.origin.turnId],
        );
      if (change === 'cancel')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET status='cancelled',response_message_id=NULL,lease_until=NULL WHERE id=$1`,
          [batch.snapshot.origin.turnId],
        );
      if (change === 'expiry')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_github_batches')} SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
          [batch.snapshot.id],
        );
      await assert.rejects(f.execute(batch));
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });
test('protected Discussion approval and concurrent executors cannot create duplicate effects', async () => {
  const f = await githubDiscussionFixture();
  try {
    const batch = await f.propose([discussionOperations[0]]);
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        tx.client.query(
          `INSERT INTO ${f.table('tf_github_batch_decisions')} (batch_id,digest,decision) VALUES ($1,$2,'approve')`,
          [batch.snapshot.id, batch.digest],
        ),
      ),
      /permission denied/,
    );
    await f.approve(batch);
    await Promise.allSettled([f.execute(batch), f.execute(batch)]);
    assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});
for (const operation of discussionOperations.filter(
  op => !['discussion.create', 'discussion.comment-create'].includes(op.kind),
))
  test(`lost ${operation.kind} remains unknown after reconciliation and blocks replay`, async () => {
    const f = await githubDiscussionFixture();
    try {
      const batch = await f.propose([operation, unrelated]);
      await f.approve(batch);
      f.state.lose = true;
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['unknown', 'unattempted'],
      );
      await f.execute(batch);
      await f.reconcile(batch);
      await f.reconcileStatus(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['unknown', 'unattempted'],
      );
      assert.equal(f.effects.length, 1);
      const sent = await f.store.send(f.one.id, f.member.userId, f.chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text: 'Replacement intent' }],
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
          { actions: [unrelated] },
        ),
        /batch-unresolved/,
      );
    } finally {
      await f.close();
    }
  });
for (const kind of ['discussion.read', 'discussion.comments', 'discussion.replies'])
  test(`own Discussion deletion preserves ${kind} receipts and succeeding unrelated actions without outside disclosure`, async () => {
    const f = await githubDiscussionFixture();
    try {
      const operation = {
        kind,
        owner: 'octocat',
        repo: 'private',
        number: 7,
        ...(kind === 'discussion.replies' ? { commentId: 'DC_1' } : {}),
      };
      const batch = await f.propose(
        [discussionOperations[2], unrelated],
        [operation, { kind: 'repository.read', owner: 'outside', repo: 'source' }],
      );
      const proof = batch.snapshot.sources.find(
        s => s.kind === 'github-personal' && s.proof?.operation.kind === kind,
      )?.proof;
      assert.deepEqual(proof?.discussionIdentity, {
        discussionId: 'D_7',
        repositoryNodeId: 'R_42',
        repositoryId: 42,
        ownerNodeId: 'U_123',
      });
      await f.approve(batch);
      await f.worker(batch);
      assert.deepEqual(
        (await f.read(batch)).actions.map(a => a.status),
        ['succeeded', 'succeeded'],
      );
      assert.equal(f.discussions.has('D_7'), false);
      f.state.outsideDeny = true;
      await assert.rejects(f.read(batch), /Resource not found/);
      const status = await f.status(batch);
      assert.deepEqual(
        status.actions.map(a => a.status),
        ['succeeded', 'succeeded'],
      );
      assert.equal('snapshot' in status, false);
      f.state.outsideDeny = false;
      assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
      f.repository.databaseId = 999;
      await assert.rejects(f.read(batch));
    } finally {
      await f.close();
    }
  });
test('comment deletion and then discussion deletion reduce source receipts in order', async () => {
  const f = await githubDiscussionFixture();
  try {
    const batch = await f.propose(
      [discussionOperations[5], discussionOperations[2], unrelated],
      [{ kind: 'discussion.replies', owner: 'octocat', repo: 'private', number: 7, commentId: 'DC_1' }],
    );
    assert.equal(
      batch.snapshot.sources.some(s => s.proof?.discussionIdentity?.discussionId === 'D_7'),
      true,
    );
    await f.approve(batch);
    await f.worker(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(a => a.status),
      ['succeeded', 'succeeded', 'succeeded'],
    );
    assert.deepEqual(
      f.effects.map(e => e.name),
      ['deleteDiscussionComment', 'deleteDiscussion', 'issueComment'],
    );
  } finally {
    await f.close();
  }
});
for (const mode of ['partial', 'malformed'])
  test(`${mode} GraphQL data with an actual effect stops the remaining batch`, async () => {
    const f = await githubDiscussionFixture();
    try {
      const batch = await f.propose([discussionOperations[1], unrelated]);
      await f.approve(batch);
      f.state[mode] = true;
      await f.worker(batch);
      assert.equal(f.discussions.get('D_7').title, 'Updated questions');
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['unknown', 'unattempted'],
      );
      await f.reconcile(batch);
      await f.execute(batch);
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
test('changed rights stop dispatch and fresh category discovery can create a discussion', async () => {
  const f = await githubDiscussionFixture();
  try {
    const batch = await f.propose([discussionOperations[4], unrelated]);
    await f.approve(batch);
    f.comments.get('DC_1').viewerCanUpdate = false;
    await f.worker(batch);
    assert.deepEqual(
      (await f.status(batch)).actions.map(a => a.status),
      ['rejected', 'unattempted'],
    );
    assert.equal(f.effects.length, 0);
    const next = await f.propose(
      [discussionOperations[0]],
      [{ kind: 'discussion.categories', owner: 'octocat', repo: 'private' }],
    );
    assert.equal(
      next.snapshot.sources.some(s => s.proof?.operation.kind === 'discussion.categories'),
      true,
    );
    await f.approve(next);
    await f.worker(next);
    assert.equal((await f.read(next)).actions[0].status, 'succeeded');
    assert.equal(f.discussions.get('D_9').title, 'Release questions');
  } finally {
    await f.close();
  }
});
test('deferred Discussion receipt commit failure leaves a durable unknown and never repeats the mutation', async () => {
  const f = await githubDiscussionFixture();
  try {
    const batch = await f.propose([discussionOperations[1], unrelated]);
    await f.approve(batch);
    await f.db.platform.query(
      `CREATE FUNCTION ${f.table('fail_discussion_receipt')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$`,
    );
    await f.db.platform.query(
      `CREATE CONSTRAINT TRIGGER fail_discussion_receipt AFTER UPDATE ON ${f.table('tf_github_action_receipts')} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${f.table('fail_discussion_receipt')}()`,
    );
    await f.worker(batch);
    assert.deepEqual(
      (await f.status(batch)).actions.map(a => a.status),
      ['unknown', 'unattempted'],
    );
    assert.equal(f.discussions.get('D_7').title, 'Updated questions');
    await f.db.platform.query(`DROP TRIGGER fail_discussion_receipt ON ${f.table('tf_github_action_receipts')}`);
    await f.reconcile(batch);
    await f.execute(batch);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});
for (const operation of [
  discussionOperations[0],
  discussionOperations[3],
  { ...discussionOperations[3], replyToId: 'DC_1' },
])
  test(`lost ${operation.kind} ${operation.replyToId ?? ''} recovers only its exact original author marker and parent`, async () => {
    const f = await githubDiscussionFixture();
    try {
      const batch = await f.propose([operation, unrelated]);
      await f.approve(batch);
      f.state.lose = true;
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['unknown', 'unattempted'],
      );
      const item = operation.kind === 'discussion.create' ? f.discussions.get('D_9') : f.comments.get('DC_3');
      const originalBody = item.body;
      item.body = operation.body;
      await f.reconcile(batch);
      assert.equal((await f.status(batch)).actions[0].status, 'unknown');
      item.body = originalBody;
      item.author = { __typename: 'User', databaseId: 999 };
      await f.reconcile(batch);
      assert.equal((await f.status(batch)).actions[0].status, 'unknown');
      item.author = f.repository.owner;
      const view = await f.reconcile(batch);
      assert.equal(view.actions[0].status, 'succeeded');
      assert.equal(view.actions[0].reconciliation.outcome, 'confirmed-original-success');
      f.state.lose = false;
      await f.execute(batch);
      await f.execute(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['succeeded', 'succeeded'],
      );
      assert.equal(f.effects.length, 2);
    } finally {
      await f.close();
    }
  });

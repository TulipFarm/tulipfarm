import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { githubActionsFixture } from './github-actions-fixture.mjs';
import { actionsOperations } from '../../../packages/github/test/actions-provider-fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const comment = { kind: 'issue.comment', owner: 'octocat', repo: 'private', issueNumber: 7, body: 'Actions requested' };
for (const operation of actionsOperations)
  test(`registered ${operation.kind} ${operation.mode ?? ''} enforces approval and ordered mixed receipts without replay`, async () => {
    const f = await githubActionsFixture();
    try {
      const batch = await f.propose([operation, comment]);
      await assert.rejects(f.execute(batch), /batch-approval-required/);
      assert.equal(f.effects.length, 0);
      await f.approve(batch);
      assert.equal((await f.worker(batch)).status, 'completed');
      const view = await f.read(batch);
      assert.deepEqual(
        view.actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
      assert.deepEqual(view.snapshot, batch.snapshot);
      assert.equal(f.effects.at(-1).path, '/repos/octocat/private/issues/7/comments');
      if (operation.kind === 'actions.dispatch') {
        assert.equal(view.actions[0].result.runId, 22);
        assert.deepEqual(f.effects[0].body.inputs, operation.inputs);
      }
      if (operation.kind === 'actions.rerun') assert.equal(f.runs.get(20).run_attempt, 2);
      if (operation.kind === 'actions.cancel') assert.equal(f.runs.get(21).conclusion, 'cancelled');
      if (operation.kind === 'actions.artifact-delete') assert.equal(f.artifacts.has(30), false);
      await f.worker(batch);
      await f.execute(batch);
      assert.equal(f.effects.length, 2);
    } finally {
      await f.close();
    }
  });
for (const operation of actionsOperations)
  test(`lost ${operation.kind} ${operation.mode ?? ''} blocks new intent and never infers original attribution`, async () => {
    const f = await githubActionsFixture();
    try {
      const batch = await f.propose([operation, comment]);
      await f.approve(batch);
      f.state.lose = true;
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      await f.execute(batch);
      await f.reconcile(batch);
      await f.reconcileStatus(batch);
      assert.equal((await f.status(batch)).actions[0].status, 'unknown');
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
          { actions: [comment] },
        ),
        /batch-unresolved/,
      );
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
for (const change of ['attempt', 'head', 'workflow', 'status', 'repository', 'permission', 'archived'])
  test(`changed ${change} prevents rerun before any effect`, async () => {
    const f = await githubActionsFixture();
    try {
      const batch = await f.propose([actionsOperations[1], comment]);
      await f.approve(batch);
      if (change === 'attempt') f.runs.get(20).run_attempt = 2;
      if (change === 'head') f.runs.get(20).head_sha = 'b'.repeat(40);
      if (change === 'workflow') f.runs.get(20).workflow_id = 999;
      if (change === 'status') f.runs.get(20).status = 'queued';
      if (change === 'repository') f.state.repositoryId = 999;
      if (change === 'permission') f.state.push = false;
      if (change === 'archived') f.state.archived = true;
      await f.worker(batch);
      const statuses = (await f.status(batch)).actions.map(action => action.status);
      assert.deepEqual(
        statuses,
        change === 'repository' ? ['unattempted', 'unattempted'] : ['rejected', 'unattempted'],
      );
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });
test('artifact deletion preserves own read and download receipts but outside denial still conceals details', async () => {
  for (const kind of ['actions.artifact', 'actions.artifact-download']) {
    const f = await githubActionsFixture();
    try {
      const batch = await f.propose(
        [actionsOperations[4], comment],
        [
          { kind, owner: 'octocat', repo: 'private', id: 30 },
          { kind: 'repository.read', owner: 'outside', repo: 'source' },
        ],
      );
      const source = batch.snapshot.sources.find(
        source => source.kind === 'github-personal' && source.proof?.operation.kind === 'actions.artifact',
      );
      assert.deepEqual(source?.proof.operation, {
        kind: 'actions.artifact',
        owner: 'octocat',
        repo: 'private',
        id: 30,
      });
      if (kind === 'actions.artifact-download')
        assert.deepEqual(source.proof.download.operation, { kind, owner: 'octocat', repo: 'private', id: 30 });
      assert.equal(
        batch.snapshot.sources.some(
          source =>
            source.kind === 'github-personal' &&
            source.proof?.operation.kind === 'repository.read' &&
            source.proof.operation.owner === 'outside',
        ),
        true,
      );
      await f.approve(batch);
      await f.worker(batch);
      assert.deepEqual(
        (await f.read(batch)).actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
      assert.equal(f.artifacts.has(30), false);
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
  }
});
test('workflow discovery reaches registered reads before dispatch and current source checks preserve ordered effects', async () => {
  const f = await githubActionsFixture();
  try {
    const batch = await f.propose(
      [actionsOperations[0], comment],
      [
        { kind: 'actions.workflows', owner: 'octocat', repo: 'private' },
        { kind: 'actions.workflow', owner: 'octocat', repo: 'private', id: 10 },
      ],
    );
    await f.approve(batch);
    await f.worker(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(action => action.status),
      ['succeeded', 'succeeded'],
    );
    assert.equal(f.runs.get(22).status, 'queued');
  } finally {
    await f.close();
  }
});
test('concurrent execution and private ownership cannot duplicate dispatch or grant approval to another admin', async () => {
  const f = await githubActionsFixture();
  try {
    const batch = await f.propose([actionsOperations[0]]),
      other = { userId: randomUUID(), membershipId: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      other.membershipId,
      other.userId,
    ]);
    await assert.rejects(f.batches.read(f.one.id, other.userId, f.chatId, batch.snapshot.id), /Resource not found/);
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
test('source revocation and rejection cause no effect while valid approval dispatches', async () => {
  const f = await githubActionsFixture();
  try {
    const rejected = await f.propose([actionsOperations[0]]);
    await f.reject(rejected);
    await assert.rejects(f.execute(rejected), /batch-approval-required/);
    const batch = await f.propose(
      [actionsOperations[0]],
      [{ kind: 'repository.read', owner: 'outside', repo: 'source' }],
    );
    await f.approve(batch);
    f.state.outsideDeny = true;
    await assert.rejects(f.execute(batch));
    assert.equal(f.effects.length, 0);
    f.state.outsideDeny = false;
    await f.worker(batch);
    assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});
test('between-action permission loss retains first request and rejects remaining mutation', async () => {
  const f = await githubActionsFixture();
  try {
    const batch = await f.propose([actionsOperations[0], actionsOperations[4]]);
    await f.approve(batch);
    f.state.afterEffect = () => {
      f.state.push = false;
    };
    await f.worker(batch);
    assert.deepEqual(
      (await f.status(batch)).actions.map(action => action.status),
      ['succeeded', 'rejected'],
    );
    assert.equal(f.effects.length, 1);
    assert.equal(f.artifacts.has(30), true);
  } finally {
    await f.close();
  }
});

for (const operation of [actionsOperations[0], actionsOperations[1], actionsOperations[3], actionsOperations[4]])
  test(`deferred receipt commit failure for ${operation.kind} retains unknown and cannot replay`, async () => {
    const f = await githubActionsFixture();
    try {
      const batch = await f.propose([operation, comment]);
      await f.approve(batch);
      await f.db.platform.query(
        `CREATE FUNCTION ${f.table('fail_actions_receipt')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$`,
      );
      await f.db.platform.query(
        `CREATE CONSTRAINT TRIGGER fail_actions_receipt AFTER UPDATE ON ${f.table('tf_github_action_receipts')} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${f.table('fail_actions_receipt')}()`,
      );
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      await f.db.platform.query(`DROP TRIGGER fail_actions_receipt ON ${f.table('tf_github_action_receipts')}`);
      await f.execute(batch);
      await f.reconcile(batch);
      assert.equal((await f.status(batch)).actions[0].status, 'unknown');
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
test('a committed Actions claim without dispatch never adopts another matching run', async () => {
  const f = await githubActionsFixture();
  try {
    const batch = await f.propose([actionsOperations[0], comment]);
    await f.approve(batch);
    await f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      tx.client.query(`INSERT INTO ${f.table('tf_github_action_receipts')} (batch_id,ordinal) VALUES ($1,0)`, [
        batch.snapshot.id,
      ]),
    );
    await f.execute(batch);
    await f.reconcile(batch);
    assert.deepEqual(
      (await f.status(batch)).actions.map(action => action.status),
      ['unknown', 'unattempted'],
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});
for (const change of ['generation', 'selection', 'turn-generation', 'cancel', 'expiry'])
  test(`Actions ${change} fencing stops an approved dispatch`, async () => {
    const f = await githubActionsFixture();
    try {
      const batch = await f.propose([actionsOperations[0]]);
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
test('malformed dispatch acknowledgement cannot become success or authorize the next action', async () => {
  const f = await githubActionsFixture();
  try {
    const batch = await f.propose([actionsOperations[0], comment]);
    await f.approve(batch);
    f.state.value = {};
    await f.worker(batch);
    assert.equal(f.runs.get(22).status, 'queued');
    assert.deepEqual(
      (await f.status(batch)).actions.map(action => action.status),
      ['unknown', 'unattempted'],
    );
    await f.reconcile(batch);
    await f.execute(batch);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

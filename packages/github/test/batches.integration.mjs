import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { githubFixture } from './fixture.mjs';
import { createConversations } from '../../conversations/dist/index.js';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

async function fixture() {
  const f = await githubFixture();
  const actor = { kind: 'human', ...f.member };
  const store = createConversations(f.runtime);
  const conversationId = randomUUID();
  await store.create(f.one.id, f.member.userId, { chatId: conversationId, commandId: randomUUID() });
  const accountId = await f.connect();
  await createGitHubReads({ runtime: f.runtime, accounts: f.service }).select(
    f.one.id,
    f.member.userId,
    conversationId,
    { accountId, expectedVersion: 0 },
  );
  const sent = await store.send(f.one.id, f.member.userId, conversationId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    model: 'claude-sonnet',
    parts: [{ kind: 'text', text: 'Create the issue.' }],
  });
  await f.db.platform.query(
    `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
    [sent.turnId],
  );
  const effects = [];
  let failure = false,
    rejection = false,
    targetDenied = false;
  const fetcher = async (url, init) => {
    if (init.method === 'GET') {
      const path = new URL(String(url)).pathname;
      if (targetDenied) return Response.json({}, { status: 403 });
      if (path === '/repos/octocat/private')
        return Response.json({ id: 1, full_name: 'octocat/private', archived: false, permissions: { push: true } });
      if (path === '/repos/octocat/private/pulls/7')
        return Response.json({
          id: 10,
          number: 7,
          base: { ref: 'main', repo: { id: 1 } },
          head: { ref: 'feature', sha: 'a'.repeat(40) },
          state: 'open',
          merged: false,
          draft: false,
        });
      return Response.json(String(url).includes('?') ? effects : { id: 1 });
    }
    if (rejection) return Response.json({}, { status: 422 });
    const result = { id: effects.length + 10, number: effects.length + 1, ...JSON.parse(init.body), user: { id: 123 } };
    effects.push(result);
    if (failure) throw new Error('connection lost after commit');
    return Response.json(result, { status: init.method === 'POST' ? 201 : 200 });
  };
  const options = {
    runtime: f.runtime,
    accounts: f.service,
    fetcher,
    requireSources: async (_tx, _actor, sources) => assert.deepEqual(sources, []),
  };
  const batches = createGitHubBatches(options);
  const decide = createGitHubBatchDecision({
    ...options,
    resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
  });
  const origin = { conversationId, turnId: sent.turnId, sources: [] };
  const propose = actions => batches.propose(f.one.id, actor, randomUUID(), origin, { actions });
  const approve = view =>
    decide(f.one.id, f.member.userId, conversationId, view.snapshot.id, { digest: view.digest, decision: 'approve' });
  const execute = view => batches.execute(f.one.id, actor, conversationId, view.snapshot.id);
  return {
    ...f,
    actor,
    conversationId,
    accountId,
    effects,
    batches,
    propose,
    approve,
    decide,
    execute,
    origin,
    options,
    failure() {
      failure = true;
    },
    reject() {
      rejection = true;
    },
    denyTarget() {
      targetDenied = true;
    },
  };
}
const create = { kind: 'issue.create', owner: 'octocat', repo: 'private', title: 'Exact title', body: 'Exact body' };

test('ordered issue batch requires protected human decision and dispatches each action once', async () => {
  const f = await fixture();
  try {
    const actions = [
      create,
      { kind: 'issue.update', owner: 'octocat', repo: 'private', issueNumber: 7, title: 'Updated', body: 'Changed' },
      { kind: 'issue.comment', owner: 'octocat', repo: 'private', issueNumber: 7, body: 'Comment' },
      { kind: 'issue.close', owner: 'octocat', repo: 'private', issueNumber: 7 },
      { kind: 'issue.reopen', owner: 'octocat', repo: 'private', issueNumber: 7 },
    ];
    const proposal = await f.propose(actions);
    assert.deepEqual(
      proposal.actions.map(action => action.status),
      Array(5).fill('unattempted'),
    );
    await assert.rejects(f.execute(proposal), /batch-approval-required/);
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        tx.client.query(
          `INSERT INTO ${f.table('tf_github_batch_decisions')} (batch_id,membership_id,digest,decision) VALUES ($1,$2,$3,'approve')`,
          [proposal.snapshot.id, f.member.membershipId, proposal.digest],
        ),
      ),
      error => error.code === '42501',
    );
    await f.approve(proposal);
    await Promise.all([f.execute(proposal), f.execute(proposal)]);
    const outcome = await f.execute(proposal);
    assert.deepEqual(
      outcome.actions.map(action => action.status),
      Array(5).fill('succeeded'),
    );
    assert.deepEqual(
      f.effects.map(effect => effect.title ?? effect.state ?? 'comment'),
      ['Exact title', 'Updated', 'comment', 'closed', 'open'],
    );
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${f.table('tf_github_batches')} SET digest='forged'`),
      ),
      error => error.code === '42501',
    );
  } finally {
    await f.close();
  }
});

test('issue update can preserve the exact body created with TulipFarm recovery marker', async () => {
  const f = await fixture();
  try {
    const created = await f.propose([create]);
    const existingBody = created.snapshot.actions[0].body;
    assert.match(existingBody, /<!-- tulipfarm:[a-f0-9-]+:0 -->$/);
    const update = await f.propose([
      {
        kind: 'issue.update',
        owner: 'octocat',
        repo: 'private',
        issueNumber: 7,
        title: 'Retitled',
        body: existingBody,
      },
    ]);
    await f.approve(update);
    const outcome = await f.execute(update);
    assert.equal(outcome.actions[0].status, 'succeeded');
    assert.deepEqual(f.effects, [{ id: 10, number: 1, title: 'Retitled', body: existingBody, user: { id: 123 } }]);
  } finally {
    await f.close();
  }
});

test('pull update can preserve the exact body created with TulipFarm recovery marker', async () => {
  const f = await fixture();
  try {
    const createPull = {
      kind: 'pull.create',
      owner: 'octocat',
      repo: 'private',
      repositoryId: 1,
      title: 'Exact pull',
      body: 'Pull body',
      head: 'feature',
      base: 'main',
      draft: false,
    };
    const created = await f.propose([createPull]);
    const existingBody = created.snapshot.actions[0].body;
    assert.match(existingBody, /<!-- tulipfarm:[a-f0-9-]+:0 -->$/);
    const update = await f.propose([
      {
        kind: 'pull.update',
        owner: 'octocat',
        repo: 'private',
        repositoryId: 1,
        pullRequestId: 10,
        pullNumber: 7,
        title: 'Retitled pull',
        body: existingBody,
        base: 'main',
      },
    ]);
    await f.approve(update);
    const outcome = await f.execute(update);
    assert.equal(outcome.actions[0].status, 'succeeded');
    assert.deepEqual(f.effects, [
      { id: 10, number: 1, title: 'Retitled pull', body: existingBody, base: 'main', user: { id: 123 } },
    ]);
  } finally {
    await f.close();
  }
});

test('lost provider acknowledgement blocks later effects and replacement intent until provider reconciliation', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose([create, { ...create, title: 'Must not run' }]);
    await f.approve(proposal);
    f.failure();
    const outcome = await f.execute(proposal);
    assert.deepEqual(
      outcome.actions.map(action => action.status),
      ['unknown', 'unattempted'],
    );
    await f.execute(proposal);
    assert.equal(f.effects.length, 1);
    await assert.rejects(
      f.propose([{ ...create, title: 'A different command cannot bypass uncertainty' }]),
      /batch-unresolved/,
    );
    const reconciled = await f.batches.reconcile(f.one.id, f.member.userId, f.conversationId, proposal.snapshot.id);
    assert.equal(reconciled.actions[0].status, 'succeeded');
    assert.equal(reconciled.actions[0].reconciliation.outcome, 'confirmed-original-success');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('confirmed provider rejection stops the batch and cannot dispatch again', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose([create, { ...create, title: 'Never' }]);
    await f.approve(proposal);
    f.reject();
    assert.deepEqual(
      (await f.execute(proposal)).actions.map(action => action.status),
      ['rejected', 'unattempted'],
    );
    assert.deepEqual(
      (await f.execute(proposal)).actions.map(action => action.status),
      ['rejected', 'unattempted'],
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

test('committed claim survives a crash before dispatch and does not treat matching state as original success', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose([{ kind: 'issue.close', owner: 'octocat', repo: 'private', issueNumber: 7 }]);
    await f.approve(proposal);
    await f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      tx.client.query(`INSERT INTO ${f.table('tf_github_action_receipts')} (batch_id,ordinal) VALUES ($1,0)`, [
        proposal.snapshot.id,
      ]),
    );
    assert.equal((await f.execute(proposal)).actions[0].status, 'unknown');
    const checked = await f.batches.reconcile(f.one.id, f.member.userId, f.conversationId, proposal.snapshot.id);
    assert.equal(checked.actions[0].status, 'unknown');
    assert.equal(checked.actions[0].reconciliation.outcome, 'unresolved');
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

test('receipt commit failure after a successful provider response stays unknown and never retries', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose([create]);
    await f.approve(proposal);
    let transactions = 0;
    const runtime = {
      transaction: (...args) => {
        transactions++;
        if (transactions === 3) throw new Error('receipt storage unavailable');
        return f.runtime.transaction(...args);
      },
    };
    const broken = createGitHubBatches({ ...f.options, runtime });
    const result = await broken.execute(f.one.id, f.actor, f.conversationId, proposal.snapshot.id);
    assert.equal(result.actions[0].status, 'unknown');
    assert.equal(f.effects.length, 1);
    assert.equal((await f.execute(proposal)).actions[0].status, 'unknown');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

for (const change of ['generation', 'selection', 'cancel', 'turn-generation', 'provider-access', 'expiry'])
  test(`${change} invalidates pending execution`, async () => {
    const f = await fixture();
    try {
      const proposal = await f.propose([create]);
      await f.approve(proposal);
      if (change === 'generation') await f.service.reconnect(f.one.id, f.member.userId, 'new-session', f.accountId);
      if (change === 'selection')
        await f.db.platform.query(`UPDATE ${f.table('tf_github_chat_selection')} SET version=version+1`);
      if (change === 'cancel')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET status='cancelled',lease_until=NULL WHERE id=$1`,
          [f.origin.turnId],
        );
      if (change === 'turn-generation')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET generation=generation+1 WHERE id=$1`,
          [f.origin.turnId],
        );
      if (change === 'expiry')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_github_batches')} SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
          [proposal.snapshot.id],
        );
      if (change === 'provider-access') f.denyTarget();
      await assert.rejects(f.execute(proposal));
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });

test('configuration changes, source revocation, forged digests and another member cannot authorize effects', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose([create]);
    await assert.rejects(
      f.decide(f.one.id, f.member.userId, f.conversationId, proposal.snapshot.id, {
        digest: '0'.repeat(64),
        decision: 'approve',
      }),
      /batch-conflict/,
    );
    await assert.rejects(f.batches.read(f.one.id, f.one.userId, f.conversationId, proposal.snapshot.id));
    await f.approve(proposal);
    const changed = createGitHubBatches({
      ...f.options,
      bindings: [{ operation: 'issue.create', name: 'issue_write', contractDigest: 'a'.repeat(64) }],
    });
    await assert.rejects(changed.execute(f.one.id, f.actor, f.conversationId, proposal.snapshot.id), /batch-conflict/);
    const denied = createGitHubBatches({
      ...f.options,
      requireSources: async () => {
        throw new Error('source revoked');
      },
    });
    await assert.rejects(denied.execute(f.one.id, f.actor, f.conversationId, proposal.snapshot.id), /source revoked/);
    assert.equal(f.effects.length, 0);
    assert.equal((await f.execute(proposal)).actions[0].status, 'succeeded');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('a real deferred PostgreSQL commit failure retains uncertainty after provider success', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose([create]);
    await f.approve(proposal);
    await f.db.platform.query(
      `CREATE FUNCTION ${f.table('fail_github_receipt')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$`,
    );
    await f.db.platform.query(
      `CREATE CONSTRAINT TRIGGER fail_github_receipt AFTER UPDATE ON ${f.table('tf_github_action_receipts')} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${f.table('fail_github_receipt')}()`,
    );
    assert.equal((await f.execute(proposal)).actions[0].status, 'unknown');
    assert.equal(f.effects.length, 1);
    assert.equal((await f.execute(proposal)).actions[0].status, 'unknown');
    assert.equal(f.effects.length, 1);
    await f.db.platform.query(`DROP TRIGGER fail_github_receipt ON ${f.table('tf_github_action_receipts')}`);
    assert.equal(
      (await f.batches.reconcile(f.one.id, f.member.userId, f.conversationId, proposal.snapshot.id)).actions[0].status,
      'succeeded',
    );
  } finally {
    await f.close();
  }
});

for (const change of ['cancel', 'disconnect'])
  test(`${change} between durable claim and credential callback fences dispatch`, async () => {
    const f = await fixture();
    try {
      const proposal = await f.propose([create]);
      await f.approve(proposal);
      let checked = false;
      const runtime = {
        transaction: async (...args) => {
          const result = await f.runtime.transaction(...args);
          const receipts = await f.db.platform.query(
            `SELECT status FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1`,
            [proposal.snapshot.id],
          );
          if (!checked && receipts.rowCount) {
            checked = true;
            if (change === 'disconnect') await f.service.disconnect(f.one.id, f.member.userId, f.accountId);
            else
              await f.db.platform.query(
                `UPDATE ${f.table('tf_conversation_turns')} SET status='cancelled',lease_until=NULL WHERE id=$1`,
                [f.origin.turnId],
              );
          }
          return result;
        },
      };
      const service = createGitHubBatches({ ...f.options, runtime });
      if (change === 'disconnect')
        await assert.rejects(service.execute(f.one.id, f.actor, f.conversationId, proposal.snapshot.id));
      else
        assert.equal(
          (await service.execute(f.one.id, f.actor, f.conversationId, proposal.snapshot.id)).actions[0].status,
          'unknown',
        );
      assert.equal(checked, true);
      assert.equal(f.effects.length, 0);
      assert.equal(
        (
          await f.db.platform.query(`SELECT status FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1`, [
            proposal.snapshot.id,
          ])
        ).rows[0].status,
        'unknown',
      );
    } finally {
      await f.close();
    }
  });

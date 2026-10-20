import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { githubChatFixture } from './github-read-fixture.mjs';
import { createGitHubAccounts } from '@tulipfarm/github';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { createGitHubBatchDecision } from '@tulipfarm/github/batch-approval';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';

const update = {
  kind: 'issue.update',
  owner: 'octocat',
  repo: 'private',
  issueNumber: 7,
  title: 'After',
  body: 'Updated',
};
const comment = {
  kind: 'issue.comment',
  owner: 'octocat',
  repo: 'private',
  issueNumber: 7,
  body: 'Updated as requested',
};
const create = { kind: 'issue.create', owner: 'octocat', repo: 'private', title: 'Created', body: 'New issue' };

async function fixture() {
  const f = await githubChatFixture();
  const accountId = await f.connect(123),
    chatId = await f.chat();
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
  const accounts = createGitHubAccounts({ runtime: f.runtime, configuration: f.configuration, keyring: f.keyring });
  const options = { runtime: f.runtime, accounts, requireSources: requireDraftSources };
  const batches = createGitHubBatches(options);
  const decide = createGitHubBatchDecision({
    ...options,
    resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
  });
  const effects = [],
    comments = [],
    created = [];
  let issue = {
    id: 7,
    number: 7,
    title: 'Before',
    body: 'Original',
    state: 'open',
    url: 'https://api.github.com/repos/octocat/private/issues/7',
  };
  let denied = 0,
    loseAck = false;
  f.setProvider(async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === 'GET') {
      if (path.startsWith('/search/'))
        return Response.json({ items: denied ? [] : [issue], total_count: denied ? 0 : 1 });
      if (denied && path.includes('/issues/7')) return Response.json({}, { status: denied });
      return Response.json(path.endsWith('/comments') ? comments : path.endsWith('/issues') ? created : issue);
    }
    const body = JSON.parse(init.body);
    const result = { id: 88 + effects.length, number: 8 + effects.length, ...body, user: { id: 123 } };
    effects.push(body);
    if (init.method === 'PATCH') issue = { ...issue, ...body };
    else if (path.endsWith('/comments')) comments.push(result);
    else created.push(result);
    if (loseAck) throw new Error('Provider committed but acknowledgement was lost');
    return Response.json(init.method === 'PATCH' ? issue : result, { status: init.method === 'POST' ? 201 : 200 });
  });
  async function propose(operation, actions) {
    f.decide(
      [
        { tool: 'github.personal.read', operation },
        { tool: 'github.personal.propose', actions },
      ],
      'Review the exact batch.',
    );
    const sent = await f.send(chatId);
    assert.equal(sent.status, 'completed');
    const batch = (await batches.list(f.one.id, f.member.userId, chatId)).batches[0];
    assert.equal(
      batch.snapshot.sources.some(source => source.kind === 'github-personal' && source.proof?.digest),
      true,
    );
    return batch;
  }
  const read = batch => batches.read(f.one.id, f.member.userId, chatId, batch.snapshot.id);
  const approve = batch =>
    decide(f.one.id, f.member.userId, chatId, batch.snapshot.id, { digest: batch.digest, decision: 'approve' });
  const execute = batch => batches.execute(f.one.id, f.member.userId, chatId, batch.snapshot.id);
  const reconcile = batch => batches.reconcile(f.one.id, f.member.userId, chatId, batch.snapshot.id);
  const receipts = async batch =>
    (
      await f.db.platform.query(
        `SELECT ordinal,status FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1 ORDER BY ordinal`,
        [batch.snapshot.id],
      )
    ).rows;
  return {
    ...f,
    accountId,
    chatId,
    batches,
    options,
    effects,
    comments,
    propose,
    read,
    approve,
    execute,
    reconcile,
    receipts,
    deny(status) {
      denied = status;
    },
    loseAck() {
      loseAck = true;
    },
    changeIssue() {
      issue = { ...issue, title: 'External edit', body: 'External content' };
    },
  };
}

for (const operation of [
  { kind: 'issue.read', owner: 'octocat', repo: 'private', number: 7 },
  { kind: 'issue.search', query: 'repo:octocat/private is:issue' },
])
  test(`worker ${operation.kind} then approved update and comment keeps snapshot and recovery readable`, async () => {
    const f = await fixture();
    try {
      const batch = await f.propose(operation, [update, comment]);
      await f.approve(batch);
      const result = await f.execute(batch);
      assert.deepEqual(
        result.actions.map(action => action.status),
        ['succeeded', 'succeeded'],
      );
      assert.deepEqual(f.effects, [
        { title: 'After', body: 'Updated' },
        { body: `Updated as requested\n\n<!-- tulipfarm:${batch.snapshot.id}:1 -->` },
      ]);
      assert.deepEqual(await f.receipts(batch), [
        { ordinal: 0, status: 'succeeded' },
        { ordinal: 1, status: 'succeeded' },
      ]);
      assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
      assert.equal((await f.reconcile(batch)).digest, batch.digest);
      assert.equal(
        (await f.batches.list(f.one.id, f.member.userId, f.chatId)).batches[0].actions[1].status,
        'succeeded',
      );
      await f.execute(batch);
      assert.equal(f.effects.length, 2);
      for (const status of [403, 404]) {
        f.deny(status);
        await assert.rejects(f.read(batch), /Resource not found/);
        await assert.rejects(f.reconcile(batch), /Resource not found/);
        assert.deepEqual((await f.batches.list(f.one.id, f.member.userId, f.chatId)).batches, [
          {
            id: batch.snapshot.id,
            decision: 'approve',
            actions: [
              { ordinal: 0, status: 'succeeded' },
              { ordinal: 1, status: 'succeeded' },
            ],
          },
        ]);
        assert.equal(f.effects.length, 2);
      }
    } finally {
      await f.close();
    }
  });

test('worker comments source remains recoverable after lost acknowledgement without repeating its mutation', async () => {
  const f = await fixture();
  try {
    const batch = await f.propose({ kind: 'issue.comments', owner: 'octocat', repo: 'private', number: 7 }, [
      comment,
      create,
    ]);
    await f.approve(batch);
    f.loseAck();
    assert.deepEqual(
      (await f.execute(batch)).actions.map(action => action.status),
      ['unknown', 'unattempted'],
    );
    assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
    const actor = { kind: 'human', ...f.member };
    const blockedChat = await f.chat();
    await f.reads.select(f.one.id, f.member.userId, blockedChat, { accountId: f.accountId, expectedVersion: 0 });
    const sent = await f.store.send(f.one.id, f.member.userId, blockedChat, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Prepare another issue.' }],
    });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
      [sent.turnId],
    );
    const replacement = () =>
      f.batches.propose(
        f.one.id,
        actor,
        randomUUID(),
        { conversationId: blockedChat, turnId: sent.turnId, sources: [] },
        { actions: [create] },
      );
    await assert.rejects(replacement(), /batch-unresolved/);
    f.deny(403);
    await assert.rejects(f.reconcile(batch), /Resource not found/);
    assert.deepEqual(await f.receipts(batch), [{ ordinal: 0, status: 'unknown' }]);
    f.deny(0);
    f.comments[0].user.id = 456;
    assert.equal((await f.reconcile(batch)).actions[0].status, 'unknown');
    f.comments[0].user.id = 123;
    const result = await f.reconcile(batch);
    assert.deepEqual(
      result.actions.map(action => action.status),
      ['succeeded', 'unattempted'],
    );
    assert.equal(result.actions[0].reconciliation.outcome, 'confirmed-original-success');
    assert.equal(result.digest, batch.digest);
    assert.equal(f.effects.length, 1);
    assert.equal((await replacement()).actions[0].status, 'unattempted');
    const nextChat = await f.chat();
    await f.reads.select(f.one.id, f.member.userId, nextChat, { accountId: f.accountId, expectedVersion: 0 });
    f.decide([{ tool: 'github.personal.propose', actions: [create] }]);
    assert.equal((await f.send(nextChat)).status, 'completed');
    assert.equal(
      (await f.batches.list(f.one.id, f.member.userId, nextChat)).batches[0].actions[0].status,
      'unattempted',
    );
  } finally {
    await f.close();
  }
});

test('a changed update source permits evidence inspection but matching content cannot resolve an unknown update', async () => {
  const f = await fixture();
  try {
    const batch = await f.propose({ kind: 'issue.read', owner: 'octocat', repo: 'private', number: 7 }, [
      update,
      comment,
    ]);
    await f.approve(batch);
    f.loseAck();
    assert.deepEqual(
      (await f.execute(batch)).actions.map(action => action.status),
      ['unknown', 'unattempted'],
    );
    const result = await f.reconcile(batch);
    assert.equal(result.actions[0].status, 'unknown');
    assert.equal(result.actions[0].reconciliation.outcome, 'unresolved');
    f.changeIssue();
    assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
    assert.equal((await f.execute(batch)).actions[0].status, 'unknown');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('lost create acknowledgement reconciles its exact marker after an original issue source changes', async () => {
  const f = await fixture();
  try {
    const batch = await f.propose({ kind: 'issue.read', owner: 'octocat', repo: 'private', number: 7 }, [create]);
    f.changeIssue();
    await f.approve(batch);
    f.loseAck();
    assert.equal((await f.execute(batch)).actions[0].status, 'unknown');
    f.deny(404);
    await assert.rejects(f.reconcile(batch), /Resource not found/);
    f.deny(0);
    const result = await f.reconcile(batch);
    assert.equal(result.actions[0].status, 'succeeded');
    assert.equal(result.actions[0].reconciliation.outcome, 'confirmed-original-success');
    assert.deepEqual(result.snapshot, batch.snapshot);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

for (const change of ['cancel', 'generation', 'selection', 'turn-generation', 'source-access'])
  test(`${change} after an acknowledged update stops the later comment`, async () => {
    const f = await fixture();
    try {
      const batch = await f.propose({ kind: 'issue.read', owner: 'octocat', repo: 'private', number: 7 }, [
        update,
        comment,
      ]);
      await f.approve(batch);
      let changed = false;
      const runtime = {
        transaction: async (...args) => {
          const result = await f.runtime.transaction(...args);
          if (!changed && (await f.receipts(batch))[0]?.status === 'succeeded') {
            changed = true;
            if (change === 'cancel')
              await f.db.platform.query(
                `UPDATE ${f.table('tf_conversation_turns')} SET status='cancelled',lease_until=NULL,response_message_id=NULL WHERE id=$1`,
                [batch.snapshot.origin.turnId],
              );
            if (change === 'turn-generation')
              await f.db.platform.query(
                `UPDATE ${f.table('tf_conversation_turns')} SET generation=generation+1 WHERE id=$1`,
                [batch.snapshot.origin.turnId],
              );
            if (change === 'generation')
              await f.db.platform.query(
                `UPDATE ${f.table('tf_github_accounts')} SET generation=generation+1 WHERE id=$1`,
                [f.accountId],
              );
            if (change === 'selection')
              await f.db.platform.query(
                `UPDATE ${f.table('tf_github_chat_selection')} SET version=version+1 WHERE conversation_id=$1`,
                [f.chatId],
              );
            if (change === 'source-access') f.deny(403);
          }
          return result;
        },
      };
      await assert.rejects(
        createGitHubBatches({ ...f.options, runtime }).execute(f.one.id, f.member.userId, f.chatId, batch.snapshot.id),
      );
      assert.equal(changed, true);
      assert.deepEqual(await f.receipts(batch), [{ ordinal: 0, status: 'succeeded' }]);
      assert.deepEqual(f.effects, [{ title: 'After', body: 'Updated' }]);
    } finally {
      await f.close();
    }
  });

test('a search that omits revoked source objects cannot authorize a write to a still-accessible target', async () => {
  const f = await fixture();
  try {
    let revoked = false,
      changed = false;
    const writes = [];
    f.setProvider(async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method !== 'GET') {
        writes.push(JSON.parse(init.body));
        return Response.json({ id: 99 }, { status: 201 });
      }
      if (path.startsWith('/search/'))
        return Response.json({
          items:
            changed || revoked
              ? []
              : [{ url: 'https://api.github.com/repos/other/source/issues/9', title: 'Private original' }],
        });
      if (path.includes('/other/source/'))
        return revoked
          ? Response.json({}, { status: 404 })
          : Response.json({ id: 9, title: changed ? 'No longer matches query' : 'Private original' });
      return Response.json({ id: 7 });
    });
    const batch = await f.propose({ kind: 'issue.search', query: 'repo:other/source Private' }, [comment]);
    changed = true;
    assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
    revoked = true;
    await assert.rejects(f.approve(batch), /Resource not found/);
    await assert.rejects(f.read(batch), /Resource not found/);
    assert.deepEqual(writes, []);
    revoked = false;
    await f.approve(batch);
    assert.equal((await f.execute(batch)).actions[0].status, 'succeeded');
    assert.deepEqual(writes, [{ body: `Updated as requested\n\n<!-- tulipfarm:${batch.snapshot.id}:0 -->` }]);
  } finally {
    await f.close();
  }
});

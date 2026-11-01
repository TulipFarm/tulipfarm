import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createConversations } from '../../conversations/src/index.ts';
import { followUpChainLimit } from '../src/follow-up-contracts.ts';
import { cancelReactionFollowUp, createFollowUps, createReactionFollowUp } from '../src/follow-ups.ts';

test('follow-ups run later in the chat they were asked in, once, as the requester', { timeout: 120000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const chats = createConversations(runtime),
    followUps = createFollowUps(runtime),
    chatId = randomUUID();
  await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const asked = await chats.send(w.id, w.userId, chatId, {
    messageId: randomUUID(),
    commandId: randomUUID(),
    parts: [{ kind: 'text', text: 'In 10 minutes, post a coding quote in #tech' }],
  });
  const origin = { conversationId: chatId, turnId: asked.turnId };
  const schedule = (call, from = origin) =>
    followUps.schedule(w.id, actor, randomUUID(), from, { tool: 'followups.schedule', ...call });
  const forceDue = id =>
    db.platform.query(`UPDATE ${table('tf_follow_ups')} SET due_at=now()-interval '1 second' WHERE id=$1`, [id]);
  const firedTurn = async id =>
    (
      await db.platform.query(
        `SELECT t.id FROM ${table('tf_conversation_turns')} t JOIN ${table('tf_follow_ups')} f ON f.fired_message_id=t.source_message_id WHERE f.id=$1`,
        [id],
      )
    ).rows[0]?.id;

  let quote;
  await t.test('a delay inside the range is saved and readable as a pending card', async () => {
    const saved = await schedule({ instruction: 'Post a coding quote in #tech.', delayMinutes: 10 });
    assert.equal(saved.status, 'scheduled');
    quote = saved.followUp;
    const card = await followUps.readInChat(w.id, w.userId, chatId, quote.id);
    assert.deepEqual(
      { id: card.id, status: card.status, instruction: card.instruction },
      { id: quote.id, status: 'pending', instruction: 'Post a coding quote in #tech.' },
    );
    const minutes = (Date.parse(card.dueAt) - Date.parse(card.createdAt)) / 60000;
    assert.ok(Math.abs(minutes - 10) < 0.1, `due ${minutes} minutes after the request`);
  });

  await t.test('a delay outside one minute to one day is refused, not saved', async () => {
    const before = (await followUps.list(w.id, actor, origin)).followUps.length;
    assert.deepEqual(
      [
        await schedule({ instruction: 'Too late', delayMinutes: 2000 }),
        await schedule({ instruction: 'Now', delayMinutes: 0 }),
      ].map(result => [result.status, result.reason]),
      [
        ['not-scheduled', 'too-late'],
        ['not-scheduled', 'too-soon'],
      ],
    );
    assert.equal((await followUps.list(w.id, actor, origin)).followUps.length, before);
  });

  await t.test('cancelling twice leaves one cancelled follow-up that never fires', async () => {
    const { followUp } = await schedule({ instruction: 'Cancel me.', delayMinutes: 5 });
    assert.equal((await followUps.cancelInChat(w.id, w.userId, chatId, followUp.id)).status, 'cancelled');
    assert.equal((await followUps.cancelInChat(w.id, w.userId, chatId, followUp.id)).status, 'cancelled');
    await forceDue(followUp.id);
    assert.deepEqual(await followUps.due(w.id, chats.send), []);
    assert.equal(await firedTurn(followUp.id), undefined);
  });

  await t.test('the due sweep sends one marked message and queues one turn', async () => {
    await forceDue(quote.id);
    assert.deepEqual(await followUps.due(w.id, chats.send), [chatId]);
    assert.deepEqual(await followUps.due(w.id, chats.send), []);
    const fired = (await chats.history(w.id, w.userId, chatId)).messages.filter(message => message.followUp);
    assert.equal(fired.length, 1);
    assert.deepEqual(
      { id: fired[0].followUp.id, instruction: fired[0].followUp.instruction, author: fired[0].author },
      { id: quote.id, instruction: 'Post a coding quote in #tech.', author: 'human' },
    );
    assert.equal(fired[0].turn.status, 'queued');
    assert.equal((await followUps.readInChat(w.id, w.userId, chatId, quote.id)).status, 'fired');
  });

  await t.test('a fired turn can chain another follow-up until the chain limit', async () => {
    const turnId = await firedTurn(quote.id);
    const next = await schedule({ instruction: 'Check again.', delayMinutes: 5 }, { conversationId: chatId, turnId });
    assert.deepEqual([next.status, next.followUp.chainDepth], ['scheduled', 2]);
    await db.platform.query(`UPDATE ${table('tf_follow_ups')} SET chain_depth=$2 WHERE id=$1`, [
      quote.id,
      followUpChainLimit,
    ]);
    const capped = await schedule(
      { instruction: 'Check once more.', delayMinutes: 5 },
      { conversationId: chatId, turnId },
    );
    assert.deepEqual([capped.status, capped.reason], ['not-scheduled', 'chain-limit']);
  });

  await t.test('a requester removed before it is due is skipped without a message', async () => {
    const { followUp } = await schedule({ instruction: 'Say hello.', delayMinutes: 5 });
    const messages = (await chats.history(w.id, w.userId, chatId)).messages.length;
    await forceDue(followUp.id);
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [w.membershipId]);
    assert.deepEqual(await followUps.due(w.id, chats.send), []);
    assert.deepEqual(
      (
        await db.platform.query(`SELECT status,failure_reason FROM ${table('tf_follow_ups')} WHERE id=$1`, [
          followUp.id,
        ])
      ).rows,
      [{ status: 'skipped', failure_reason: 'requester-access-lost' }],
    );
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [w.membershipId]);
    assert.equal((await chats.history(w.id, w.userId, chatId)).messages.length, messages);
  });
});

test(
  'an alarm clock reaction from a linked member sets a reminder that removing it cancels',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => `"${w.names.schema}".${name}`;
    const installationId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_installations')}(id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES($1,'ATEST','TONE','UBOT',1,'active','{}','{}',0)`,
      [installationId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_identities')}(id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES($1,$2,1,'UASHA',$3,$4,'authorized','{}','{}')`,
      [randomUUID(), installationId, w.userId, w.membershipId],
    );
    const reaction = user => ({
      installationId,
      generation: 1,
      user,
      channel: 'CTECH',
      itemTs: '2.000001',
      rootTs: '1.000001',
    });
    const inTx = work => runtime.transaction(w.id, commonCompatibility, work);
    const status = async id =>
      (await db.platform.query(`SELECT status FROM ${table('tf_follow_ups')} WHERE id=$1`, [id])).rows[0]?.status;

    assert.equal(await inTx(tx => createReactionFollowUp(tx, reaction('USTRANGER'))), null);
    const reminder = await inTx(tx => createReactionFollowUp(tx, reaction('UASHA')));
    assert.deepEqual(
      [reminder.membership_id, reminder.origin, reminder.slack_thread_ts, await status(reminder.id)],
      [w.membershipId, 'slack-reaction', '1.000001', 'pending'],
    );
    assert.equal(await inTx(tx => createReactionFollowUp(tx, reaction('UASHA'))), null);
    await inTx(tx => cancelReactionFollowUp(tx, { ...reaction('USTRANGER') }));
    assert.equal(await status(reminder.id), 'pending');
    await inTx(tx => cancelReactionFollowUp(tx, reaction('UASHA')));
    assert.equal(await status(reminder.id), 'cancelled');
  },
);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture, connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createBudAssistant, BudConflict } from '../../src/bud-assistant.ts';
import { createConversations } from '../../src/index.ts';
import { createPersonalMemoryService, PersonalMemoryConflict } from '../../src/personal-memory.ts';
import { budGreeting } from '../../src/bud-contracts.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test(
  'Bud persists one private thread, consent, undo, and quiet nudges per membership',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      const w = await db.create(),
        other = await db.create();
      const table = name => qualified(w.names.schema, name);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        connectionsPerPool: 3,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        resolveCredential: async id => ({
          workspaceId: id,
          generation: 1,
          connectionString: db.login(id === w.id ? w : other),
        }),
      });
      const bud = createBudAssistant(runtime),
        chats = createConversations(runtime),
        memory = createPersonalMemoryService(runtime);
      const results = await Promise.all([
        bud.command(w.id, w.userId, { kind: 'bootstrap' }),
        bud.command(w.id, w.userId, { kind: 'bootstrap' }),
      ]);
      assert.equal(results[0].onboarding, 'active');
      assert.equal(results[0].conversationId, results[1].conversationId);
      const chatId = results[0].conversationId;
      assert.equal((await chats.history(w.id, w.userId, chatId)).messages[0].parts[0].text, budGreeting);
      assert.equal((await chats.history(w.id, w.userId, chatId)).messages.length, 1);
      await assert.rejects(bud.read(other.id, w.userId), AccessDenied);
      await assert.rejects(bud.command(w.id, 'outsider', { kind: 'bootstrap' }), AccessDenied);
      const memberId = randomUUID(),
        userId = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        memberId,
        userId,
      ]);
      const memberChat = (await bud.command(w.id, userId, { kind: 'bootstrap' })).conversationId;
      assert.notEqual(memberChat, chatId);
      const integrationId = randomUUID(),
        memberMessage = randomUUID(),
        memberTurn = randomUUID(),
        integrationCall = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_google_integrations')}(id,user_id,membership_id,generation,status,account_id,email,credential)
      VALUES($1,$2,$3,1,'connected','test-google','test@example.com','{}')`,
        [integrationId, userId, memberId],
      );
      assert.equal(
        (await bud.command(w.id, userId, { kind: 'sync' })).onboarding,
        'active',
        'unrelated integration activity is not completion',
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_messages')}(id,conversation_id,sequence,author_kind,membership_id)
      VALUES($1,$2,2,'human',$3)`,
        [memberMessage, memberChat, memberId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_parts')}(conversation_id,message_id,ordinal,kind,text)
      VALUES($1,$2,0,'text','Check my new integration')`,
        [memberChat, memberMessage],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_turns')}(id,conversation_id,source_message_id,accepted_sequence,responder,status,lease_until)
      VALUES($1,$2,$3,2,'default','processing',now()+interval '1 hour')`,
        [memberTurn, memberChat, memberMessage],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_tool_calls')}(id,conversation_id,turn_id,tool,status,sequence)
      VALUES($1,$2,$3,'google.read','completed',1)`,
        [integrationCall, memberChat, memberTurn],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_execution_steps')}(call_id,turn_id,call,sources,output)
      VALUES($1,$2,'{}','[]',$3)`,
        [
          integrationCall,
          memberTurn,
          JSON.stringify({
            result: { status: 'connected' },
            sources: [{ kind: 'google-integration', integrationId, generation: 1 }],
          }),
        ],
      );
      assert.equal(
        (await bud.command(w.id, userId, { kind: 'sync' })).onboarding,
        'completed',
        'Bud verifies the new integration before finishing setup',
      );

      const messageId = randomUUID(),
        turnId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_messages')}(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,2,'human',$3)`,
        [messageId, chatId, w.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_parts')}(conversation_id,message_id,ordinal,kind,text)
      VALUES($1,$2,0,'text','Help me set my preferences')`,
        [chatId, messageId],
      );
      await db.platform.query(`UPDATE ${table('tf_conversations')} SET next_message_sequence=3 WHERE id=$1`, [chatId]);
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_turns')}(id,conversation_id,source_message_id,accepted_sequence,responder,status,lease_until)
      VALUES($1,$2,$3,2,'default','processing',now()+interval '1 hour')`,
        [turnId, chatId, messageId],
      );
      const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId },
        origin = { conversationId: chatId, turnId };
      const id = randomUUID();
      await bud.propose(w.id, actor, id, origin, {
        tool: 'bud.preference.ask',
        topic: 'reply-style',
        question: 'How should I reply?',
      });
      assert.deepEqual(await memory.read(w.id, w.userId), { content: '', revision: 0 });
      await assert.rejects(
        bud.command(w.id, userId, { kind: 'answer-preference', id, value: 'Steal this' }),
        AccessDenied,
      );
      const saved = await bud.command(w.id, w.userId, { kind: 'answer-preference', id, value: 'Keep it short.' });
      assert.equal(saved.preferences[0].status, 'saved');
      assert.equal(saved.onboarding, 'completed', 'confirmed useful setup ends onboarding');
      assert.equal((await memory.read(w.id, w.userId)).content, 'Reply style: Keep it short.');
      await bud.command(w.id, w.userId, { kind: 'answer-preference', id, value: 'Keep it short.' });
      assert.equal((await memory.read(w.id, w.userId)).revision, 1, 'retry saves only once');
      await bud.command(w.id, w.userId, { kind: 'undo-preference', id });
      assert.equal((await memory.read(w.id, w.userId)).content, '');
      const proposed = randomUUID();
      await bud.propose(w.id, actor, proposed, origin, {
        tool: 'bud.preference.propose',
        topic: 'role',
        question: 'Remember your role?',
        value: 'Support',
      });
      assert.equal((await memory.read(w.id, w.userId)).content, '', 'inference is not consent');
      await bud.command(w.id, w.userId, { kind: 'accept-preference', id: proposed });
      const newer = randomUUID();
      await bud.propose(w.id, actor, newer, origin, {
        tool: 'bud.preference.propose',
        topic: 'goals',
        question: 'Remember your goal?',
        value: 'Faster replies',
      });
      await bud.command(w.id, w.userId, { kind: 'accept-preference', id: newer });
      await assert.rejects(
        bud.command(w.id, w.userId, { kind: 'undo-preference', id: proposed }),
        PersonalMemoryConflict,
      );
      await memory.delete(w.id, w.userId, { expectedRevision: 4 });
      assert.equal((await bud.read(w.id, w.userId)).preferences.length, 0, 'memory deletion removes retained receipts');

      await bud.command(w.id, w.userId, { kind: 'skip' });
      const items = [
        {
          id: 'create-table',
          label: 'Create a table',
          action: { kind: 'prompt', prompt: 'Help me create a table for review.' },
        },
        ...['follow-ups', 'support', 'week', 'process'].map(id => ({
          id,
          label: id,
          action: { kind: 'prompt', prompt: id },
        })),
      ];
      await db.platform.query(
        `INSERT INTO ${table('tf_recommendation_refresh')}(membership_id,generation,status) VALUES($1,1,'ready')
      ON CONFLICT(membership_id) DO UPDATE SET generation=1,status='ready'`,
        [w.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_recommendation_snapshots')}(membership_id,fingerprint,items,generation,policy,sources)
      VALUES($1,$2,$3,1,'event-driven-v1','[]') ON CONFLICT(membership_id) DO UPDATE SET items=$3,generation=1,policy='event-driven-v1'`,
        [w.membershipId, 'a'.repeat(64), JSON.stringify(items)],
      );
      let state = await bud.read(w.id, w.userId);
      assert.equal(state.nudge.presented, false);
      const fingerprint = state.nudge.fingerprint;
      await Promise.all([
        bud.command(w.id, w.userId, { kind: 'present', fingerprint }),
        bud.command(w.id, w.userId, { kind: 'present', fingerprint }),
      ]);
      assert.equal((await bud.read(w.id, w.userId)).nudge.presented, true);
      await bud.command(w.id, w.userId, { kind: 'dismiss', fingerprint });
      assert.equal((await bud.read(w.id, w.userId)).nudge, null);
      items[0] = { ...items[0], label: 'Create an invoices table' };
      await db.platform.query(`UPDATE ${table('tf_recommendation_snapshots')} SET items=$2 WHERE membership_id=$1`, [
        w.membershipId,
        JSON.stringify(items),
      ]);
      assert.equal((await bud.read(w.id, w.userId)).nudge, null, 'new facts do not bypass the cooldown');
      await db.platform.query(
        `UPDATE ${table('tf_bud_state')} SET last_presented_at=now()-interval '31 minutes' WHERE membership_id=$1`,
        [w.membershipId],
      );
      state = await bud.read(w.id, w.userId);
      assert.ok(state.nudge);
      await bud.command(w.id, w.userId, {
        kind: 'settings',
        snoozedUntil: new Date(Date.now() + 3600000).toISOString(),
      });
      assert.equal((await bud.read(w.id, w.userId)).nudge, null);
      await bud.command(w.id, w.userId, { kind: 'settings', enabled: false, snoozedUntil: null });
      assert.equal((await bud.read(w.id, w.userId)).nudge, null);
      await bud.command(w.id, w.userId, { kind: 'settings', enabled: true });
      assert.ok((await bud.read(w.id, w.userId)).nudge);
      await assert.rejects(bud.command(w.id, w.userId, { kind: 'present', fingerprint: 'f'.repeat(64) }), BudConflict);
      const nextFingerprint = (await bud.read(w.id, w.userId)).nudge.fingerprint;
      await assert.rejects(
        bud.command(w.id, w.userId, { kind: 'open-nudge', fingerprint: nextFingerprint }),
        BudConflict,
      );
      await bud.command(w.id, w.userId, { kind: 'present', fingerprint: nextFingerprint });
      const beforeOpen = (await chats.history(w.id, w.userId, chatId)).messages.length;
      const priorActivity = (
        await db.platform.query(
          `UPDATE ${table('tf_conversations')} SET is_closed=true WHERE id=$1 RETURNING activity_generation`,
          [chatId],
        )
      ).rows[0].activity_generation;
      const available = (await db.platform.query(`SELECT available FROM ${table('tf_credit_account')} WHERE id=1`))
        .rows[0].available;
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=0 WHERE id=1`);
      await assert.rejects(
        bud.command(w.id, w.userId, { kind: 'open-nudge', fingerprint: nextFingerprint }),
        error => error.code === 'credits-exhausted',
      );
      assert.equal(
        (await chats.history(w.id, w.userId, chatId)).messages.length,
        beforeOpen,
        'failed admission does not append a message',
      );
      assert.equal(
        (await bud.read(w.id, w.userId)).nudge.fingerprint,
        nextFingerprint,
        'failed admission keeps the action available for retry',
      );
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1 WHERE id=1`, [available]);
      await Promise.all([
        bud.command(w.id, w.userId, { kind: 'open-nudge', fingerprint: nextFingerprint }),
        bud.command(w.id, w.userId, { kind: 'open-nudge', fingerprint: nextFingerprint }),
      ]);
      const opened = (await chats.history(w.id, w.userId, chatId)).messages;
      assert.equal(opened.length, beforeOpen + 1, 'uncertain opening replays without another message');
      const accepted = opened.at(-1);
      assert.equal(accepted.author, 'human');
      assert.equal(accepted.parts[0].text, items[0].action.prompt, 'acceptance sends the action, not the invitation');
      assert.equal(accepted.turn.status, 'queued');
      assert.equal(
        (
          await db.platform.query(`SELECT 1 FROM ${table('tf_conversation_outbox')} WHERE turn_id=$1`, [
            accepted.turn.id,
          ])
        ).rowCount,
        1,
        'reply is durably queued',
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT status FROM ${table('tf_bud_nudges')} WHERE membership_id=$1 AND fingerprint=$2`,
            [w.membershipId, nextFingerprint],
          )
        ).rows[0].status,
        'answered',
      );
      const activity = (
        await db.platform.query(`SELECT is_closed,activity_generation FROM ${table('tf_conversations')} WHERE id=$1`, [
          chatId,
        ])
      ).rows[0];
      assert.equal(activity.is_closed, false, 'a Bud question reopens an inactive chat');
      assert.equal(
        Number(activity.activity_generation),
        Number(priorActivity) + 1,
        'nudge replay records activity only once',
      );

      const pendingId = randomUUID();
      await bud.propose(w.id, actor, pendingId, origin, {
        tool: 'bud.preference.ask',
        topic: 'reply-style',
        question: 'Which reply style works for you?',
      });
      await db.platform.query(
        `UPDATE ${table('tf_bud_state')} SET last_presented_at=now()-interval '31 minutes' WHERE membership_id=$1`,
        [w.membershipId],
      );
      const pending = (await bud.read(w.id, w.userId)).nudge;
      assert.equal(pending.suggestionId, `preference-${pendingId}`);
      await bud.command(w.id, w.userId, { kind: 'present', fingerprint: pending.fingerprint });
      const turnsBefore = (
        await db.platform.query(
          `SELECT count(*)::int AS count FROM ${table('tf_conversation_turns')} WHERE conversation_id=$1`,
          [chatId],
        )
      ).rows[0].count;
      const reopened = await bud.command(w.id, w.userId, { kind: 'open-nudge', fingerprint: pending.fingerprint });
      assert.equal(reopened.preferences[0].id, pendingId, 'pending preference remains actionable');
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS count FROM ${table('tf_conversation_turns')} WHERE conversation_id=$1`,
            [chatId],
          )
        ).rows[0].count,
        turnsBefore,
        'opening a pending question does not ask the model again',
      );

      await chats.remove(w.id, w.userId, chatId, { commandId: randomUUID() });
      state = await bud.command(w.id, w.userId, { kind: 'bootstrap' });
      assert.equal(state.conversationId, null);
      assert.equal(state.onboarding, 'completed');
      const replacement = await bud.command(w.id, w.userId, { kind: 'open' });
      assert.notEqual(replacement.conversationId, chatId);
      assert.equal((await chats.history(w.id, w.userId, replacement.conversationId)).messages.length, 0);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [memberId]);
      assert.equal(
        (await db.platform.query(`SELECT 1 FROM ${table('tf_bud_state')} WHERE membership_id=$1`, [memberId])).rowCount,
        0,
      );
      await assert.rejects(bud.read(w.id, userId), AccessDenied);
      for (const capability of ['migration', 'confirmation']) {
        const client = await connect(db.login(w, capability));
        try {
          await denied(client, `SELECT * FROM ${table('tf_bud_preferences')}`);
        } finally {
          await client.end();
        }
      }
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);

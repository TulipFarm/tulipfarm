import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promptFixture } from './link-prompts.integration.mjs';
import { createSlackDirectMessages } from '../src/direct-messages.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createSlackInbox } from '../src/inbox.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests exhaust workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

export async function authorizeDm(f, user = 'UPERSON') {
  const id = randomUUID();
  const credential = f.options.cipher.encrypt(
    {
      workspaceId: f.workspace.id,
      installationId: f.installationId,
      generation: 1,
      kind: 'user',
      identityId: id,
      membershipId: f.workspace.membershipId,
      slackUserId: user,
    },
    'synthetic-user-token',
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,$3,$4,$5,'authorized',$6,ARRAY['im:history'])`,
    [id, f.installationId, user, f.workspace.userId, f.workspace.membershipId, credential],
  );
  // Slack use now needs an explicit installation grant, as 0107 backfills for linked identities.
  if ((await f.db.platform.query(`SELECT to_regclass($1) AS t`, [f.table('tf_slack_installation_grants')])).rows[0].t)
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [f.installationId, f.workspace.membershipId],
    );
  return id;
}

test('rich-only DM file shares and rich-only edits use the same source content', async () => {
  const f = await promptFixture();
  try {
    await authorizeDm(f);
    const dm = createSlackDirectMessages(f.options),
      calls = [];
    const executor = createConversationExecutor(f.runtime, async input => {
      calls.push(input.messages);
      return { text: 'Received the agenda.', sources: [] };
    });
    const id = await f.event('UPERSON', 'DONE', {
      text: '',
      subtype: 'file_share',
      files: [{ title: 'agenda.pdf', mimetype: 'application/pdf' }],
    });
    await dm.admitPending(f.workspace.id);
    const [work] = await executor.due(f.workspace.id);
    assert.ok(work);
    assert.equal(await executor.process(work), 'completed');
    assert.match(calls[0][0].text, /agenda.pdf/);
    assert.match(calls[0][0].text, /contents not read/);
    assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: id }), 'sent');
    await createSlackInbox(f.runtime).accept(
      { workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 },
      {
        type: 'event_callback',
        api_app_id: 'ATEST',
        team_id: 'TONE',
        event_id: 'RICHCHANGE',
        event_time: 123,
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'DONE',
          event_ts: '2.000001',
          message: { user: 'UPERSON', ts: '1.000001', text: '', files: [{ title: 'different.pdf' }] },
        },
      },
    );
    await f.event('UPERSON', 'DONE', { thread_ts: '1.000001', text: 'Continue' });
    await dm.admitPending(f.workspace.id);
    for (const next of await executor.due(f.workspace.id)) await executor.process(next);
    assert.equal(calls.length, 1);
  } finally {
    await f.close();
  }
});

for (const phase of ['before', 'queued', 'history', 'edited'])
  test(`direct DM ${phase} source changes never execute deleted text`, async () => {
    const f = await promptFixture();
    try {
      await authorizeDm(f);
      const dm = createSlackDirectMessages(f.options),
        calls = [];
      const executor = createConversationExecutor(f.runtime, async input => {
        calls.push(input.messages);
        return { text: 'DM RESULT', sources: [] };
      });
      const id = await f.event();
      if (phase !== 'before' && phase !== 'edited') await dm.admitPending(f.workspace.id);
      if (phase === 'history') {
        const [work] = await executor.due(f.workspace.id);
        assert.equal(await executor.process(work), 'completed');
        assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: id }), 'sent');
      }
      const edited = phase === 'edited';
      await createSlackInbox(f.runtime).accept(
        { workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 },
        {
          type: 'event_callback',
          api_app_id: 'ATEST',
          team_id: 'TONE',
          event_id: 'CHANGE',
          event_time: 123,
          event: edited
            ? {
                type: 'message',
                subtype: 'message_changed',
                channel: 'DONE',
                event_ts: '2.000001',
                message: { user: 'UPERSON', text: 'CURRENT DM TEXT', ts: '1.000001' },
              }
            : {
                type: 'message',
                subtype: 'message_deleted',
                channel: 'DONE',
                event_ts: '2.000001',
                deleted_ts: '1.000001',
              },
        },
      );
      if (phase === 'history') await f.event('UPERSON', 'DONE', { thread_ts: '1.000001', text: 'Continue' });
      await dm.admitPending(f.workspace.id);
      for (const work of await executor.due(f.workspace.id)) await executor.process(work);
      if (edited) {
        assert.deepEqual(calls, [[{ role: 'user', text: 'CURRENT DM TEXT' }]]);
        assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: id }), 'sent');
      } else {
        assert.equal(calls.length, phase === 'history' ? 1 : 0);
        assert.equal(
          (await dm.due(f.workspace.id)).every(work => work.eventId === id || phase === 'history'),
          true,
        );
      }
    } finally {
      await f.close();
    }
  });

test('original DM admission, root history and rendered bot delivery survive restart without repeated execution', async () => {
  const f = await promptFixture();
  let restarted;
  try {
    const dm = createSlackDirectMessages(f.options);
    const eventId = await f.event();
    assert.deepEqual(await dm.discover(f.workspace.id), []);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_conversation_turns')}`)).rows[0].n,
      0,
    );
    await authorizeDm(f);
    await Promise.all([dm.discover(f.workspace.id), dm.discover(f.workspace.id)]);
    const calls = [];
    const executor = createConversationExecutor(f.runtime, async input => {
      calls.push(input.messages);
      await input.executeTool('rows.list', false, async context => {
        assert.equal(context.actor.userId, f.workspace.userId);
        assert.equal(context.actor.membershipId, f.workspace.membershipId);
        return [];
      });
      return { text: '**Done** for your request.', sources: [] };
    });
    const [work] = await executor.due(f.workspace.id);
    assert.ok(work);
    assert.equal(await executor.process(work), 'completed');
    assert.deepEqual(calls, [[{ role: 'user', text: 'PRIVATE ORIGINAL REQUEST' }]]);
    const [delivery] = await dm.discover(f.workspace.id);
    assert.equal(delivery.eventId, eventId);
    f.setResponse('retry');
    assert.equal(await dm.process(delivery), 'retry');
    restarted = f.createRuntime();
    const fresh = createSlackDirectMessages({ ...f.options, runtime: restarted });
    assert.deepEqual(await fresh.discover(f.workspace.id), []);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_dm_events')} SET next_attempt_at=clock_timestamp()-interval '1 second'`,
    );
    f.setResponse('success');
    assert.equal(await fresh.process(delivery), 'sent');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].authorization, 'Bearer synthetic-bot-token');
    assert.equal(f.requests[1].body.channel, 'DONE');
    assert.equal(f.requests[1].body.thread_ts, '1.000001');
    assert.equal(f.requests[1].body.blocks[0].type, 'rich_text');
    assert.equal(JSON.stringify(f.requests[1].body.blocks).includes('**'), false);
    assert.equal(await executor.process(work), 'idle');
    assert.equal(calls.length, 1);
    await assert.rejects(
      f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${f.table('tf_slack_dm_events')} SET state='pending' WHERE event_id=$1`, [eventId]),
      ),
      /Slack delivery is terminal/,
    );
    await assert.rejects(
      f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
        tx.client.query(`UPDATE ${f.table('tf_slack_dm_events')} SET model_started=false WHERE event_id=$1`, [eventId]),
      ),
      /Slack execution cannot be replayed/,
    );
    const followup = await f.event('UPERSON', 'DONE', { thread_ts: '1.000001', text: 'What did I ask?' });
    await fresh.discover(f.workspace.id);
    const [next] = await executor.due(f.workspace.id);
    assert.equal(next.conversationId, work.conversationId);
    assert.equal(await executor.process(next), 'completed');
    assert.deepEqual(calls[1], [
      { role: 'user', text: 'PRIVATE ORIGINAL REQUEST' },
      { role: 'assistant', text: '**Done** for your request.' },
      { role: 'user', text: 'What did I ask?' },
    ]);
    assert.equal(await fresh.process({ workspaceId: f.workspace.id, eventId: followup }), 'sent');
    assert.deepEqual(await fresh.discover(f.workspace.id), []);
    assert.equal(calls.length, 2);
    await f.event('UPERSON', 'CCHANNEL');
    await fresh.discover(f.workspace.id);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS n FROM ${f.table('tf_slack_dm_roots')}`)).rows[0].n,
      1,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('revocation blocks execution and delivery, unknown delivery never retries, uncertain execution never calls the model twice', async () => {
  const f = await promptFixture();
  try {
    await authorizeDm(f);
    const dm = createSlackDirectMessages(f.options);
    const first = await f.event();
    await dm.discover(f.workspace.id);
    let calls = 0;
    const executor = createConversationExecutor(f.runtime, async () => {
      calls++;
      return { text: 'Answer', sources: [] };
    });
    const [work] = await executor.due(f.workspace.id);
    assert.equal(await executor.process(work), 'completed');
    f.setResponse('lost');
    assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: first }), 'unknown');
    assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: first }), 'idle');
    assert.equal(f.requests.length, 1);
    const second = await f.event();
    await dm.discover(f.workspace.id);
    const [uncertain] = await executor.due(f.workspace.id);
    const crashing = createConversationExecutor(f.runtime, async () => {
      calls++;
      throw new Error('model acknowledgement lost');
    });
    assert.equal(await crashing.process(uncertain), 'retry');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [uncertain.turnId],
    );
    assert.equal(await crashing.process({ ...uncertain, generation: 1 }), 'idle');
    assert.equal(calls, 2);
    assert.equal(
      (
        await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
          uncertain.turnId,
        ])
      ).rows[0].status,
      'blocked',
    );
    const third = await f.event();
    await dm.discover(f.workspace.id);
    const [revoked] = await executor.due(f.workspace.id);
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_identities')} SET state='revoked',credential=NULL`);
    assert.equal(await executor.process(revoked), 'idle');
    assert.equal(calls, 2);
    assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: third }), 'blocked');
    assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: second }), 'blocked');
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

for (const change of ['membership', 'generation', 'scope', 'source'])
  test(`${change} changes block saved DM answers and follow-up execution`, async () => {
    const f = await promptFixture();
    try {
      await authorizeDm(f);
      const dm = createSlackDirectMessages(f.options);
      const id = await f.event();
      await dm.discover(f.workspace.id);
      const resource = randomUUID(),
        team = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Private')`, [team]);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'private_records','Private','revision')`,
        [resource, team],
      );
      let calls = 0;
      const executor = createConversationExecutor(f.runtime, async () => {
        calls++;
        return { text: 'Restricted answer', sources: [{ kind: 'table', tableId: resource }] };
      });
      const [work] = await executor.due(f.workspace.id);
      assert.equal(await executor.process(work), 'completed');
      await f.event('UPERSON', 'DONE', { thread_ts: '1.000001', text: 'Continue' });
      await dm.discover(f.workspace.id);
      const [next] = await executor.due(f.workspace.id);
      if (change === 'membership') {
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          f.workspace.membershipId,
        ]);
        await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
          randomUUID(),
          f.workspace.userId,
        ]);
      } else if (change === 'generation')
        await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET generation=2`);
      else if (change === 'scope')
        await f.db.platform.query(`UPDATE ${f.table('tf_slack_identities')} SET scopes='{}'`);
      else
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='member' WHERE id=$1`, [
          f.workspace.membershipId,
        ]);
      assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: id }), 'blocked');
      assert.equal(f.requests.length, 0);
      assert.equal(await executor.process(next), 'idle');
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  });

test('lost answer outcome commit and abandoned claims never resend a bot answer', async () => {
  const f = await promptFixture();
  try {
    await authorizeDm(f);
    const dm = createSlackDirectMessages(f.options);
    const eventId = await f.event();
    await dm.discover(f.workspace.id);
    const executor = createConversationExecutor(f.runtime, async () => ({ text: 'Saved answer', sources: [] }));
    const [work] = await executor.due(f.workspace.id);
    assert.equal(await executor.process(work), 'completed');
    const broken = {
      transaction: (workspace, range, action) =>
        f.runtime.transaction(workspace, range, tx =>
          action({
            ...tx,
            client: {
              query: (sql, values) => {
                if (sql.includes('SET state=$2,next_attempt_at=')) throw new Error('commit lost');
                return tx.client.query(sql, values);
              },
            },
          }),
        ),
    };
    const delivery = { workspaceId: f.workspace.id, eventId };
    await assert.rejects(createSlackDirectMessages({ ...f.options, runtime: broken }).process(delivery), /commit lost/);
    assert.equal(f.requests.length, 1);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_dm_events')} SET next_attempt_at=clock_timestamp()-interval '1 second'`,
    );
    assert.equal(await dm.process(delivery), 'idle');
    assert.equal(f.requests.length, 1);
    assert.equal(
      (await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_dm_events')}`)).rows[0].state,
      'unknown',
    );
  } finally {
    await f.close();
  }
});

test('credit exhaustion for a new event never hides a completed paid answer', async () => {
  const f = await promptFixture();
  try {
    await authorizeDm(f);
    const dm = createSlackDirectMessages(f.options);
    const paid = await f.event();
    await dm.discover(f.workspace.id);
    const executor = createConversationExecutor(f.runtime, async () => ({ text: 'Already paid answer', sources: [] }));
    const [work] = await executor.due(f.workspace.id);
    assert.equal(await executor.process(work), 'completed');
    const held = await f.event();
    await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
    const due = await dm.discover(f.workspace.id);
    assert.deepEqual(due, [{ workspaceId: f.workspace.id, eventId: paid }]);
    assert.equal(await dm.process(due[0]), 'sent');
    assert.equal(f.requests[0].body.text, 'Already paid answer');
    assert.equal(
      (
        await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_slack_dm_events')} WHERE event_id=$1`, [
          held,
        ])
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await dm.discover(f.workspace.id), []);
  } finally {
    await f.close();
  }
});

test('fifty whitespace-only DMs cannot starve the next valid request', async () => {
  const f = await promptFixture();
  try {
    await authorizeDm(f);
    const dm = createSlackDirectMessages(f.options);
    for (let i = 0; i < 50; i++) await f.event('UPERSON', 'DONE', { text: '\n\t\u00a0\ufeff' });
    const valid = await f.event('UPERSON', 'DONE', { text: 'Please answer this request' });
    for (let i = 0; i < 3; i++) await dm.discover(f.workspace.id);
    assert.deepEqual((await f.db.platform.query(`SELECT event_id FROM ${f.table('tf_slack_dm_events')}`)).rows, [
      { event_id: valid },
    ]);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_slack_dm_rejections')}`)).rows[0].n,
      50,
    );
  } finally {
    await f.close();
  }
});

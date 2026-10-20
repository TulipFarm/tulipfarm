import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createSlackInbox, slackCredentialCipher } from '../../slack/src/index.ts';
import { createSlackChannelAgents } from '../src/slack-channels.ts';

test('a bot mention starts a default thread in any channel the bot belongs to and untagged thread replies continue it', async () => {
  const f = await conversationFixture(),
    installationId = randomUUID();
  const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } });
  let info = { is_archived: false, is_member: true };
  const lookups = [];
  const fetcher = async url => {
    const target = new URL(String(url));
    assert.equal(target.pathname, '/api/conversations.info');
    lookups.push(target.searchParams.get('channel'));
    return Response.json({ ok: true, channel: { id: target.searchParams.get('channel'), ...info } });
  };
  try {
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TTEST','UBOT',1,'active',ARRAY['chat:write','im:write'],$2,0)`,
      [
        installationId,
        cipher.encrypt({ workspaceId: f.workspace.id, installationId, generation: 1, kind: 'bot' }, 'xoxb-fixture'),
      ],
    );
    const channels = createSlackChannelAgents({ runtime: f.runtime, appId: 'ATEST', cipher, fetcher, model: null });
    const inbox = createSlackInbox(f.runtime, channels.freeze);
    const route = { workspaceId: f.workspace.id, installationId, generation: 1 };
    let sequence = 0;
    const send = (channel, text, ts, thread_ts) =>
      inbox.accept(route, {
        type: 'event_callback',
        api_app_id: 'ATEST',
        team_id: 'TTEST',
        event_id: `Ev${++sequence}`,
        event_time: sequence,
        event: { type: 'message', channel, user: 'UALICE', text, ts, ...(thread_ts ? { thread_ts } : {}) },
      });
    await send('CTEST', '<@UBOT> hey', '1.000001');
    await send('CTEST', 'and a follow-up without a tag', '2.000001', '1.000001');
    await send('CTEST', 'no mention here', '3.000001');
    info = { is_archived: false, is_member: false };
    await send('COUTSIDE', '<@UBOT> hello', '4.000001');
    info = { is_archived: true, is_member: true };
    await send('CARCHIVED', '<@UBOT> hello', '5.000001');
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT channel,root_ts,agent_id FROM ${f.table('tf_slack_channel_roots')} ORDER BY channel,root_ts`,
        )
      ).rows,
      [{ channel: 'CTEST', root_ts: '1.000001', agent_id: null }],
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_slack_channel_invocations')}`)).rows[0]
        .n,
      2,
    );
    assert.deepEqual(lookups, ['CTEST', 'COUTSIDE', 'CARCHIVED']);
  } finally {
    await f.close();
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createSlackInbox, slackCredentialCipher } from '../../slack/src/index.ts';
import { createSlackChannelAgents } from '../src/slack-channels.ts';
import { createSlackDefault } from '../src/slack-default.ts';

for (const edited of [false, true])
  test(`rich alert and multi-speaker thread ${edited ? 'reject an in-flight rich edit' : 'reach the default reply with names and stable IDs'}`, async () => {
    const f = await conversationFixture(),
      installationId = randomUUID(),
      identityId = randomUUID();
    const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } });
    const posts = [],
      lookups = [],
      prompts = [];
    const messages = [
      {
        bot_id: 'BALERT',
        ts: '1.000001',
        text: '',
        attachments: [{ title: 'FIRING: 55P03', text: 'Database lock could not be acquired' }],
      },
      { user: 'UJOHN', ts: '2.000001', text: "Hey I'm going to come on Saturday" },
      { user: 'UJACK', ts: '3.000001', text: "I'm going to come on Sunday. <@UJOHN>" },
      { user: 'UREQUESTER', ts: '4.000001', text: '<@UBOT> Triage this alert and tell me who will come on each day' },
    ];
    const fetcher = async (url, init) => {
      const method = new URL(String(url)).pathname.split('/').at(-1);
      const params =
        new Headers(init?.headers).get('content-type') === 'application/json'
          ? JSON.parse(init.body)
          : Object.fromEntries(new URLSearchParams(init?.body));
      if (method === 'conversations.info')
        return Response.json({
          ok: true,
          channel: { id: params.channel ?? 'CTEST', is_archived: false, is_member: true },
        });
      if (method === 'conversations.members')
        return Response.json({ ok: true, members: ['UREQUESTER', 'UJOHN', 'UJACK', 'UBOT'] });
      if (method === 'conversations.replies') return Response.json({ ok: true, messages, has_more: false });
      if (method === 'users.info') {
        lookups.push(params.user);
        return Response.json({
          ok: true,
          user: {
            id: params.user,
            profile: {
              display_name: { UJOHN: 'John', UJACK: 'Jack', UREQUESTER: 'Requester', UBOT: 'TulipFarm' }[params.user],
            },
          },
        });
      }
      if (method === 'bots.info') {
        lookups.push(params.bot);
        return Response.json({ ok: true, bot: { id: params.bot, name: 'Alert service' } });
      }
      if (method === 'conversations.open')
        return Response.json({ ok: true, channel: { id: 'DREQUESTER', is_im: true, user: 'UREQUESTER' } });
      if (method === 'assistant.threads.setStatus') return Response.json({ ok: true });
      if (method === 'chat.postMessage') {
        posts.push(params);
        return Response.json({ ok: true, channel: params.channel, ts: '5.000001' });
      }
      assert.fail(`Unexpected Slack method ${method}`);
    };
    try {
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after)
      VALUES ($1,'ATEST','TTEST','UBOT',1,'active',ARRAY['chat:write','im:write'],$2,0)`,
        [
          installationId,
          cipher.encrypt({ workspaceId: f.workspace.id, installationId, generation: 1, kind: 'bot' }, 'xoxb-fixture'),
        ],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes)
      VALUES ($1,$2,1,'UREQUESTER',$3,$4,'authorized',$5,ARRAY['channels:history','im:history','users:read'])`,
        [
          identityId,
          installationId,
          f.workspace.userId,
          f.workspace.membershipId,
          cipher.encrypt(
            {
              workspaceId: f.workspace.id,
              installationId,
              generation: 1,
              kind: 'user',
              identityId,
              membershipId: f.workspace.membershipId,
              slackUserId: 'UREQUESTER',
            },
            'xoxp-fixture',
          ),
        ],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2)`,
        [installationId, f.workspace.membershipId],
      );
      const options = { runtime: f.runtime, appId: 'ATEST', cipher, fetcher, model: null, publicDelivery: true };
      const channels = createSlackChannelAgents(options);
      const policy = {
        automatic: true,
        triggerPercent: 55,
        targetPercent: 25,
        outputPrompt: null,
        revision: 3,
        families: ['claude-haiku'],
      };
      const defaults = createSlackDefault({
        ...options,
        channels,
        compactor: {
          policy: async () => policy,
          measure: async () => null,
          window: async () => 200_000,
          summarize: async () => {
            throw new Error('a channel reply keeps no working summary');
          },
        },
        reply: () => async input => {
          // A channel reply compacts its own tool results with the workspace policy, like a private chat.
          assert.deepEqual(input.compactionPolicy, policy);
          const prompt = input.messages.at(-1).text;
          prompts.push(prompt);
          assert.match(prompt, /Database lock could not be acquired/);
          assert.match(prompt, /"UJOHN":"John","UJACK":"Jack"/);
          const context = JSON.parse(prompt.split('Current thread: ')[1].split('\nPrivate prior answers:')[0]);
          assert.equal(context.find(message => message.user === 'UJOHN').text, "Hey I'm going to come on Saturday");
          assert.equal(context.find(message => message.user === 'UJACK').text, "I'm going to come on Sunday. <@UJOHN>");
          if (edited) messages[0].attachments[0].text = 'Changed after inference started';
          return { text: 'The alert reports a database lock failure. John: Saturday. Jack: Sunday.', sources: [] };
        },
      });
      const inbox = createSlackInbox(f.runtime, channels.freeze);
      await inbox.accept(
        { workspaceId: f.workspace.id, installationId, generation: 1 },
        {
          type: 'event_callback',
          api_app_id: 'ATEST',
          team_id: 'TTEST',
          event_id: 'ERICH',
          event_time: 1,
          event: { type: 'app_mention', channel: 'CTEST', thread_ts: '1.000001', ...messages[3] },
        },
      );
      const [work] = await defaults.due(f.workspace.id);
      assert.ok(work);
      const snapshot = (
        await f.db.platform.query(
          `SELECT thread_snapshot FROM ${f.table('tf_slack_default_turns')} WHERE event_id=$1`,
          [work.eventId],
        )
      ).rows[0].thread_snapshot;
      assert.equal(snapshot[0].content, 'FIRING: 55P03\nDatabase lock could not be acquired');
      assert.equal(snapshot[0].user, 'BALERT');
      assert.equal(JSON.stringify(snapshot).includes('display_name'), false);
      assert.equal(await defaults.process(work), edited ? 'blocked' : 'sent');
      assert.equal(prompts.length, 1);
      assert.deepEqual(lookups, ['BALERT', 'UJOHN', 'UJACK', 'UREQUESTER']);
      assert.equal(posts.length, edited ? 0 : 1);
      if (!edited) {
        assert.equal(posts[0].thread_ts, '1.000001');
        assert.match(posts[0].text, /John: Saturday\. Jack: Sunday\./);
      }
    } finally {
      await f.close();
    }
  });

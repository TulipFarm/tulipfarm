import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createSlackInbox, slackCredentialCipher } from '../../slack/src/index.ts';
import { createSlackChannelAgents } from '../src/slack-channels.ts';
import { createSlackDefault } from '../src/slack-default.ts';
import { createChatTools } from '../src/tools.ts';
import { createTableWithRows, tableDefinition, textField } from '../../tables/test/fixture.mjs';
import { AccessDenied } from '@tulipfarm/access';

// Slack does not hand back the text a bot posted. A blocks-backed post comes back from conversations.replies with its
// newlines flattened, and plain text can come back with bare URLs auto-linked. The fake does both, like production.
const slackStoredText = text => text.replace(/\n/g, ' ').replace(/(^|\s)(https?:\/\/[^\s<>]+)/g, '$1<$2>');

const answer = [
  "*Short answer:* we don't self-host yet.",
  '',
  'Live production:',
  '• Web app: https://app.tulipfarm.ai',
  '• API: https://api.tulipfarm.ai',
  '',
  'Run `pnpm deploy` from the `deploy` repo.',
].join('\n');

async function threadFixture({ reply, outbound = false } = {}) {
  const f = await conversationFixture(),
    installationId = randomUUID(),
    identityId = randomUUID();
  const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } });
  const posts = [],
    prompts = [];
  const messages = [{ user: 'UREQUESTER', ts: '1.000001', text: 'hey <@UBOT> how do we host our production app?' }];
  let sequence = 1;
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
      return Response.json({ ok: true, members: ['UREQUESTER', 'UMOHIT', 'UBOT'] });
    if (method === 'conversations.replies') return Response.json({ ok: true, messages, has_more: false });
    if (method === 'users.info')
      return Response.json({ ok: true, user: { id: params.user, profile: { display_name: params.user } } });
    if (method === 'conversations.open')
      return Response.json({ ok: true, channel: { id: 'DREQUESTER', is_im: true, user: 'UREQUESTER' } });
    if (method === 'assistant.threads.setStatus') return Response.json({ ok: true });
    if (method === 'chat.postMessage') {
      posts.push(params);
      const ts = `${++sequence}.000001`;
      messages.push({
        user: 'UBOT',
        bot_id: 'BBOT',
        ts,
        thread_ts: params.thread_ts,
        text: slackStoredText(params.text),
        blocks: params.blocks,
      });
      return Response.json({ ok: true, channel: params.channel, ts });
    }
    assert.fail(`Unexpected Slack method ${method}`);
  };
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
  const options = { runtime: f.runtime, appId: 'ATEST', cipher, fetcher, model: null, publicDelivery: true, outbound };
  const channels = createSlackChannelAgents(options);
  const defaults = createSlackDefault({
    ...options,
    channels,
    reply:
      reply ??
      (() => async input => {
        prompts.push(input.messages.at(-1).text);
        return { text: prompts.length === 1 ? answer : 'Opened a draft PR proposal.', sources: [] };
      }),
  });
  const inbox = createSlackInbox(f.runtime, channels.freeze);
  let events = 0;
  async function send(message, type = 'app_mention') {
    const ts = `${++sequence}.000001`,
      payload = { user: 'UREQUESTER', ts, ...message };
    messages.push(payload);
    await inbox.accept(
      { workspaceId: f.workspace.id, installationId, generation: 1 },
      {
        type: 'event_callback',
        api_app_id: 'ATEST',
        team_id: 'TTEST',
        event_id: `EV${++events}`,
        event_time: events,
        event: { type, channel: 'CTEST', ...payload },
      },
    );
    return ts;
  }
  const rejections = async () =>
    (
      await f.db.platform.query(
        `SELECT e.payload->>'ts' AS ts FROM ${f.table('tf_slack_agent_rejections')} r JOIN ${f.table('tf_slack_events')} e ON e.id=r.event_id ORDER BY e.created_at`,
      )
    ).rows.map(row => row.ts);
  return { f, defaults, messages, posts, prompts, send, rejections };
}

test('a tagged follow-up after a bot reply with URLs, bullets and paragraphs is answered', async () => {
  const { f, defaults, messages, posts, prompts, send, rejections } = await threadFixture();
  try {
    await send(messages[0]);
    messages.shift();
    const [first] = await defaults.due(f.workspace.id);
    assert.equal(await defaults.process(first), 'sent');
    const reply = messages.find(message => message.user === 'UBOT');
    assert.notEqual(reply.text, posts[0].text, 'the fake must return reformatted text, as Slack does');
    assert.match(reply.text, /<https:\/\/app\.tulipfarm\.ai>/);
    assert.equal(reply.text.includes('\n'), false);

    await send({ thread_ts: '1.000001', text: '<@UBOT> can you raise a PR to propose to use aws bedrock?' });
    const [follow] = await defaults.due(f.workspace.id);
    assert.ok(follow, 'the follow-up must be admitted');
    assert.deepEqual(await rejections(), []);
    assert.equal(await defaults.process(follow), 'sent');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Current request: <@UBOT> can you raise a PR/);
    assert.equal(posts.length, 2);
    assert.equal(posts[1].thread_ts, '1.000001');
    assert.equal(posts[1].text, 'Opened a draft PR proposal.');
  } finally {
    await f.close();
  }
});

test('a tagged message that is rejected still gets a visible reply; an untagged one is logged only', async () => {
  const { f, defaults, messages, posts, prompts, send, rejections } = await threadFixture();
  try {
    await send(messages[0]);
    messages.shift();
    const [first] = await defaults.due(f.workspace.id);
    assert.equal(await defaults.process(first), 'sent');
    // Our reply can no longer be matched to what we published, so the thread is not safe to build on.
    messages.find(message => message.user === 'UBOT').text = 'Something we never said';
    const untagged = await send({ thread_ts: '1.000001', text: '<@UMOHIT> does this look good to you' }, 'message');
    const tagged = await send({ thread_ts: '1.000001', text: '<@UBOT> can you raise a PR?' }, 'message');
    const lines = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => {
      lines.push(String(chunk));
      return write.call(process.stdout, chunk, ...rest);
    };
    try {
      assert.deepEqual(await defaults.due(f.workspace.id), []);
      assert.deepEqual(await defaults.due(f.workspace.id), []);
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual(await rejections(), [untagged, tagged]);
    assert.equal(prompts.length, 1);
    assert.equal(posts.length, 2, 'only the tagged message gets a notice');
    assert.equal(posts[1].thread_ts, '1.000001');
    assert.match(posts[1].text, /^I can't answer this in this thread because/);
    assert.match(posts[1].text, /\(reason: publication-unverified\)$/);
    const logged = lines
      .flatMap(line => line.split('\n'))
      .filter(line => line.includes('slack.default.admission'))
      .map(line => JSON.parse(line));
    assert.deepEqual(
      logged.map(line => [line.outcome, line['error.type']]),
      [
        ['rejected', 'publication-unverified'],
        ['rejected_notified', 'publication-unverified'],
      ],
    );
    for (const line of logged) {
      assert.match(line['slack.event_id'], /^[0-9a-f-]{36}$/);
      assert.equal(JSON.stringify(line).includes('PR'), false, 'logs carry no message content');
    }
    // The notice is posted once; a later dispatch does not repeat it.
    await defaults.due(f.workspace.id);
    assert.equal(posts.length, 2);
  } finally {
    await f.close();
  }
});

async function leadsTable(f, permissions) {
  const team = randomUUID(),
    note = textField('Note');
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Operators')`, [team]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    f.workspace.membershipId,
    team,
  ]);
  const table = await createTableWithRows({
    db: f.db,
    workspace: f.workspace,
    runtime: f.runtime,
    definition: tableDefinition({ owningTeamId: team, label: 'Leads', fields: [note] }),
    records: [],
  });
  for (const permission of permissions)
    await f.db.platform.query(`INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
      team,
      table.tableId,
      permission,
    ]);
  return { table, note };
}

test('a channel reply that used web content drafts its row change with owner-only Slack buttons', async () => {
  let call;
  const { f, defaults, messages, posts, send } = await threadFixture({
    outbound: true,
    reply:
      (_guard, slack) =>
      async ({ executeTool }) => {
        await executeTool(
          'rows.create',
          false,
          context => createChatTools(context.runtime, { slack }).invokeWithSources(context, call),
          [{ kind: 'public-web', url: 'https://example.net/page' }],
          call,
        );
        return { text: 'I drafted the row for your approval.', sources: [] };
      },
  });
  try {
    const { table, note } = await leadsTable(f, ['table.row.read', 'table.row.create']);
    call = {
      tool: 'rows.create',
      tableId: table.tableId,
      expectedAppliedRevision: table.revision,
      values: { [note.id]: { kind: 'text', value: 'Acme' } },
    };
    const live = async () =>
      (
        await f.db.platform.query(`SELECT row_id FROM ${f.table('tf_table_identities')} WHERE table_id=$1 AND live`, [
          table.tableId,
        ])
      ).rows.map(row => row.row_id);
    await send(messages[0]);
    messages.shift();
    const [work] = await defaults.due(f.workspace.id);
    assert.equal(await defaults.process(work), 'sent');
    assert.deepEqual(await live(), []);
    const blocks = posts[0].blocks;
    assert.equal(posts[0].text, 'I drafted the row for your approval.');
    assert.ok(
      blocks.some(block => block.type === 'section' && block.text?.text === 'Review row change: Add a row in Leads'),
    );
    assert.ok(blocks.some(block => block.fields?.some(field => field.text === 'Note\nAcme')));
    const buttons = blocks.find(block => block.type === 'actions').elements;
    assert.deepEqual(
      buttons.map(button => button.action_id),
      ['slack_row_draft_approve', 'slack_row_draft_dismiss'],
    );
    const value = JSON.parse(buttons[0].value);
    assert.equal(buttons[1].value, buttons[0].value);
    const clicker = slackUserId => ({ appId: 'ATEST', teamId: 'TTEST', slackUserId });

    await assert.rejects(defaults.decideRowDraft(value, 'save', clicker('UMOHIT')), AccessDenied);
    await assert.rejects(
      defaults.decideRowDraft(value, 'save', { ...clicker('UREQUESTER'), teamId: 'TOTHER' }),
      AccessDenied,
    );
    assert.deepEqual(await live(), []);
    assert.equal(await defaults.decideRowDraft(value, 'save', clicker('UREQUESTER')), 'created');
    assert.equal(await defaults.decideRowDraft(value, 'save', clicker('UREQUESTER')), 'created');
    assert.equal(await defaults.decideRowDraft(value, 'dismiss', clicker('UREQUESTER')), 'decided');
    assert.deepEqual(await live(), [value.draftId]);
  } finally {
    await f.close();
  }
});

test('dismissing a Slack row draft changes nothing', async () => {
  let call;
  const { f, defaults, messages, posts, send } = await threadFixture({
    outbound: true,
    reply:
      (_guard, slack) =>
      async ({ executeTool }) => {
        await executeTool(
          'rows.create',
          false,
          context => createChatTools(context.runtime, { slack }).invokeWithSources(context, call),
          [{ kind: 'public-web', url: 'https://example.net/page' }],
          call,
        );
        return { text: 'I drafted the row for your approval.', sources: [] };
      },
  });
  try {
    const { table, note } = await leadsTable(f, ['table.row.read', 'table.row.create']);
    call = {
      tool: 'rows.create',
      tableId: table.tableId,
      expectedAppliedRevision: table.revision,
      values: { [note.id]: { kind: 'text', value: 'Acme' } },
    };
    await send(messages[0]);
    messages.shift();
    const [work] = await defaults.due(f.workspace.id);
    assert.equal(await defaults.process(work), 'sent');
    const value = JSON.parse(posts[0].blocks.find(block => block.type === 'actions').elements[1].value);
    const clicker = { appId: 'ATEST', teamId: 'TTEST', slackUserId: 'UREQUESTER' };
    assert.equal(await defaults.decideRowDraft(value, 'dismiss', clicker), 'dismissed');
    assert.equal(await defaults.decideRowDraft(value, 'save', clicker), 'decided');
    assert.equal(
      (await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_table_identities')} WHERE table_id=$1`, [table.tableId]))
        .rowCount,
      0,
    );
  } finally {
    await f.close();
  }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, canAccessAsset, requireAgentRunInvocation } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createSlackInbox, createSlackLinkPrompts, slackCredentialCipher } from '../../slack/src/index.ts';
import { createAgentChat } from '../src/chat.ts';
import { requireAgentPermission } from '../src/saved-policy.ts';
import { createAgentStore } from '../src/store.ts';
import { createSlackChannelAgents } from '../src/slack-channels.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';

async function linkedChannelFixture({ publicDelivery = true } = {}) {
  const f = await conversationFixture();
  const installationId = randomUUID(),
    membershipId = randomUUID();
  const actor = { kind: 'human', userId: 'bob', membershipId };
  const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } });
  const threads = new Map(),
    posts = [],
    modelInputs = [],
    userTokens = [];
  const state = {
    members: ['UALICE', 'UBOB', 'UBOT', 'UGUEST'],
    archived: false,
    retry: false,
    rejectUser: false,
    onInfer: async () => {},
    decision: { kind: 'answer', text: 'Channel answer' },
  };
  const fetcher = async (url, init) => {
    const method = new URL(String(url)).pathname.slice('/api/'.length);
    const authorization = new Headers(init?.headers).get('authorization');
    if (authorization?.startsWith('Bearer xoxp-')) {
      userTokens.push(authorization);
      if (state.rejectUser) return Response.json({ ok: false, error: 'token_revoked' });
      const input = Object.fromEntries(new URLSearchParams(init.body));
      if (method === 'conversations.info')
        return Response.json({ ok: true, channel: { id: input.channel, is_archived: state.archived } });
      if (method === 'conversations.members')
        return Response.json({
          ok: true,
          members: input.channel.startsWith('D') ? ['UBOB', 'UBOT'] : state.members,
          response_metadata: { next_cursor: '' },
        });
      if (method === 'conversations.replies')
        return Response.json({
          ok: true,
          messages: threads.get(`${input.channel}/${input.ts}`) ?? [],
          has_more: false,
        });
      if (method === 'users.info')
        return Response.json({
          ok: true,
          user: { id: input.user, profile: { display_name: input.user === 'UALICE' ? 'John' : 'Jack' } },
        });
      if (method === 'bots.info') return Response.json({ ok: true, bot: { id: input.bot, name: 'Alerts' } });
      assert.fail(`Unexpected user method ${method}`);
    }
    if (method === 'conversations.info')
      return Response.json({
        ok: true,
        channel: {
          id: new URL(String(url)).searchParams.get('channel'),
          is_archived: state.archived,
          is_member: state.members.includes('UBOT'),
        },
      });
    const input = JSON.parse(init.body);
    if (method === 'conversations.open')
      return Response.json({
        ok: true,
        channel: { id: input.users === 'UBOB' ? 'DBOB' : 'DALICE', is_im: true, user: input.users },
      });
    if (method === 'assistant.threads.setStatus') return Response.json({ ok: true });
    if (method === 'chat.postEphemeral') {
      posts.push(input);
      return Response.json({ ok: true, message_ts: '999.000001' });
    }
    assert.equal(method, 'chat.postMessage');
    if (state.retry) return Response.json({}, { status: 429, headers: { 'retry-after': '1' } });
    posts.push(input);
    const ts = `${1000 + posts.length}.000001`,
      key = `${input.channel}/${input.thread_ts ?? ts}`;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push({ user: 'UBOT', text: input.text, ts });
    return Response.json({ ok: true, channel: input.channel, ts });
  };
  const model = syntheticContinuity(async input => {
    modelInputs.push(input);
    await state.onInfer(input);
    return state.decision;
  });
  const channels = createSlackChannelAgents({
    runtime: f.runtime,
    appId: 'ATEST',
    cipher,
    fetcher,
    model,
    publicDelivery,
  });
  const inbox = createSlackInbox(f.runtime, channels.freeze);
  const tx = operation => f.runtime.transaction(f.workspace.id, commonCompatibility, operation);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'bob','member')`, [
    membershipId,
  ]);
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TTEST','UBOT',1,'active',ARRAY['chat:write','im:write'],$2,0)`,
    [
      installationId,
      cipher.encrypt({ workspaceId: f.workspace.id, installationId, generation: 1, kind: 'bot' }, 'xoxb-fixture'),
    ],
  );
  for (const [userId, memberId, slackUserId, token] of [
    [f.workspace.userId, f.workspace.membershipId, 'UALICE', 'alice'],
    ['bob', membershipId, 'UBOB', 'bob'],
  ]) {
    const id = randomUUID(),
      credential = cipher.encrypt(
        {
          workspaceId: f.workspace.id,
          installationId,
          generation: 1,
          kind: 'user',
          identityId: id,
          membershipId: memberId,
          slackUserId,
        },
        `xoxp-${token}`,
      );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,$3,$4,$5,'authorized',$6,ARRAY['channels:history','im:history'])`,
      [id, installationId, slackUserId, userId, memberId, credential],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2)`,
      [installationId, memberId],
    );
  }
  async function saveDefinition(agentId, definition) {
    const revision = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    const command = randomUUID(),
      soul = createHash('sha1').update(command).digest('hex');
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
      [agentId, revision, definition],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input,status) VALUES ($1,$2,$3,$4,$1,'{}','accepted')`,
      [command, agentId, f.workspace.membershipId, f.workspace.userId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_soul_revisions')} (revision,parent_revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,$3,'fixture',$4)`,
      [soul, '0'.repeat(40), command, 'b'.repeat(64)],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
      [agentId, soul, revision],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [agentId, soul]);
    return revision;
  }
  async function addAgent(responseRule = 'tag', tools = []) {
    const id = randomUUID(),
      activationId = randomUUID();
    const definition = {
      name: 'Channel agent',
      instructions: 'Use only the requester authority.',
      tools,
      responseRule,
    };
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agents')} (id,enabled,display_name) VALUES ($1,true,'Channel agent')`,
      [id],
    );
    const revision = await saveDefinition(id, definition);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'invoke'),($1,$2,'read'),($1,$2,'manage')`,
      [id, f.workspace.membershipId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,'[]')`,
      [activationId, id, revision],
    );
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_limits')} (agent_id,scope) VALUES ($1,'[]')`, [id]);
    return { id, activationId, revision, definition };
  }
  let sequence = 0;
  async function send(text = '<@UBOT> Help', { channel = 'CTEAM', user = 'UBOB', thread, type = 'message' } = {}) {
    const ts = `${++sequence}.000001`,
      key = `${channel}/${thread ?? ts}`;
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push({ user, text, ts });
    await inbox.accept(
      { workspaceId: f.workspace.id, installationId, generation: 1 },
      {
        type: 'event_callback',
        api_app_id: 'ATEST',
        team_id: 'TTEST',
        event_id: `EVENT${sequence}`,
        event_time: sequence,
        event: { type, channel, user, text, ts, ...(thread ? { thread_ts: thread } : {}) },
      },
    );
    const id = (
      await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_events')} WHERE event_id=$1`, [`EVENT${sequence}`])
    ).rows[0].id;
    return { id, ts };
  }
  const attach = (agentId, channel = 'CTEAM', expectedVersion = 0) =>
    channels.attach(f.workspace.id, f.workspace.userId, { agentId, channel, expectedVersion });
  const process = event => channels.process({ workspaceId: f.workspace.id, eventId: event.id });
  const admit = async event => (await channels.due(f.workspace.id)).some(work => work.eventId === event.id);
  const countRuns = async event =>
    (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [event.id]))
      .rows[0].n;
  return {
    ...f,
    tx,
    actor,
    installationId,
    channels,
    model,
    state,
    posts,
    modelInputs,
    userTokens,
    threads,
    addAgent,
    saveDefinition,
    attach,
    send,
    process,
    admit,
    countRuns,
    cipher,
    fetcher,
  };
}

test('linked channel membership grants only the attached invocation, never normal agent access', async () => {
  const f = await linkedChannelFixture();
  try {
    const agent = await f.addAgent();
    assert.deepEqual(await f.attach(agent.id), { version: 1, channelResponses: true });
    assert.deepEqual(await f.channels.inspect(f.workspace.id, 'bob', 'CTEAM'), {
      agentId: null,
      version: 1,
      occupied: true,
      channelResponses: true,
    });
    for (const permission of ['read', 'edit', 'manage', 'invoke'])
      await assert.rejects(
        f.tx(tx => requireAgentPermission(tx, f.actor, agent.id, permission)),
        AccessDenied,
      );
    const normal = createAgentChat(f.runtime, f.model);
    await assert.rejects(
      normal.submit(f.workspace.id, 'bob', agent.id, {
        id: randomUUID(),
        activationId: agent.activationId,
        scope: [],
        prompt: 'Outside Slack',
      }),
      AccessDenied,
    );
    await assert.rejects(
      createAgentStore(f.runtime).startDelegated(f.workspace.id, f.actor, {
        activationId: agent.activationId,
        scope: [],
      }),
      AccessDenied,
    );
    const event = await f.send();
    f.userTokens.length = 0;
    assert.equal(await f.admit(event), true);
    assert.equal(await f.process(event), 'sent');
    assert.equal(f.posts.at(-1).channel, 'CTEAM');
    assert.equal(f.posts.at(-1).thread_ts, event.ts);
    assert.equal(f.modelInputs.length, 1);
    assert.match(f.modelInputs[0].prompt, /current requester is UBOB/);
    assert.ok(f.userTokens.length > 0);
    assert.ok(f.userTokens.every(token => token === 'Bearer xoxp-bob'));
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT user_id,membership_id FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [
          event.id,
        ])
      ).rows,
      [{ user_id: 'bob', membership_id: f.actor.membershipId }],
    );
    await assert.rejects(normal.read(f.workspace.id, 'bob', agent.id, event.id), AccessDenied);
    await assert.rejects(normal.processTurn(f.workspace.id, event.id), AccessDenied);
    await assert.rejects(
      f.tx(tx => requireAgentPermission(tx, f.actor, agent.id, 'invoke')),
      AccessDenied,
    );
    await assert.rejects(
      f.tx(tx => requireAgentRunInvocation(tx, f.actor, agent.id, randomUUID())),
      AccessDenied,
    );
    const outside = await f.send(undefined, { channel: 'COTHER' });
    assert.equal(await f.admit(outside), false);
    assert.equal(await f.countRuns(outside), 0);
    const follow = await f.send('Continue without a mention', { thread: event.ts });
    assert.equal(await f.admit(follow), true);
    assert.equal(await f.process(follow), 'sent');
    assert.equal(f.posts.at(-1).channel, 'CTEAM');
    const creator = await f.send(undefined, { user: 'UALICE' });
    assert.equal(await f.admit(creator), true);
    await assert.rejects(
      f.tx(tx => requireAgentRunInvocation(tx, f.actor, agent.id, creator.id)),
      AccessDenied,
    );
  } finally {
    await f.close();
  }
});

test('named agent receives rich thread roots and distinct named speakers', async () => {
  const f = await linkedChannelFixture();
  try {
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_identities')} SET scopes=array_append(scopes,'users:read')`);
    await f.attach((await f.addAgent()).id);
    f.threads.set('CTEAM/0.000001', [
      { bot_id: 'BALERT', ts: '0.000001', text: '', attachments: [{ title: 'Alert', text: 'Database lock failed' }] },
      { user: 'UALICE', ts: '0.000002', text: "I'm going to come on Saturday" },
      { user: 'UBOB', ts: '0.000003', text: "I'm going to come on Sunday" },
    ]);
    const event = await f.send('<@UBOT> Triage the alert. Who is coming when?', { thread: '0.000001' });
    assert.equal(await f.admit(event), true);
    assert.equal(await f.process(event), 'sent');
    const prompt = f.modelInputs[0].prompt;
    assert.match(prompt, /Database lock failed/);
    assert.match(prompt, /"UALICE":"John","UBOB":"Jack"/);
    const context = JSON.parse(prompt.split('Current thread: ')[1].split('\nPrivate prior answers:')[0]);
    assert.equal(context.find(message => message.user === 'UALICE').text, "I'm going to come on Saturday");
    assert.equal(context.find(message => message.ts === '0.000003').text, "I'm going to come on Sunday");
    assert.equal(f.posts.at(-1).thread_ts, '0.000001');
  } finally {
    await f.close();
  }
});

test('unlinked channel sender stays in link-account flow without any invocation', async () => {
  const f = await linkedChannelFixture();
  try {
    await f.attach((await f.addAgent()).id);
    const event = await f.send(undefined, { user: 'UGUEST' });
    assert.equal(await f.admit(event), false);
    assert.equal(await f.countRuns(event), 0);
    assert.equal(f.modelInputs.length, 0);
    const prompts = createSlackLinkPrompts({
      runtime: f.runtime,
      appId: 'ATEST',
      cipher: f.cipher,
      fetcher: f.fetcher,
      webOrigin: 'https://app.example.test',
    });
    const due = await prompts.discover(f.workspace.id);
    assert.ok(due.some(work => work.eventId === event.id));
    await prompts.process(due.find(work => work.eventId === event.id));
    assert.equal(f.posts.at(-1).user, 'UGUEST');
    assert.equal(f.posts.at(-1).channel, 'CTEAM');
    assert.equal(f.posts.at(-1).text.includes('<@UBOT> Help'), false);
  } finally {
    await f.close();
  }
});

for (const failure of [
  'identity',
  'membership',
  'installation-grant',
  'user-revocation',
  'provider-token',
  'requester-channel',
  'bot-channel',
  'archived',
  'disabled',
  'activation',
])
  test(`attached invocation rejects current ${failure} loss`, async () => {
    const f = await linkedChannelFixture();
    try {
      const agent = await f.addAgent();
      await f.attach(agent.id);
      const event = await f.send();
      if (failure === 'identity')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE user_id='bob'`,
        );
      if (failure === 'membership')
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          f.actor.membershipId,
        ]);
      if (failure === 'installation-grant')
        await f.db.platform.query(`DELETE FROM ${f.table('tf_slack_installation_grants')} WHERE membership_id=$1`, [
          f.actor.membershipId,
        ]);
      if (failure === 'user-revocation')
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_slack_user_revocations')} (installation_id,generation,slack_user_id,event_id) SELECT $1,1,'UBOB',event_id FROM ${f.table('tf_slack_events')} WHERE id=$2`,
          [f.installationId, event.id],
        );
      if (failure === 'provider-token') f.state.rejectUser = true;
      if (failure === 'requester-channel') f.state.members = f.state.members.filter(user => user !== 'UBOB');
      if (failure === 'bot-channel') f.state.members = f.state.members.filter(user => user !== 'UBOT');
      if (failure === 'archived') f.state.archived = true;
      if (failure === 'disabled')
        await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET enabled=false WHERE id=$1`, [agent.id]);
      if (failure === 'activation')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_agent_activations')} SET revoked_at=clock_timestamp() WHERE id=$1`,
          [agent.activationId],
        );
      assert.equal(await f.admit(event), false);
      assert.equal(await f.countRuns(event), 0);
      assert.equal(f.modelInputs.length, 0);
      // A denied mention is never silent: the requester gets one content-free notice in the thread, never an answer.
      // An unlinked identity stays in the link-account flow, and a rejected user token is retried, not denied.
      assert.deepEqual(
        f.posts.map(post => [
          post.thread_ts,
          /^I can't answer this in this thread because [^.]+\. Mention me in a new thread and I'll start fresh\. \(reason: [a-z-]+\)$/.test(
            post.text,
          ),
        ]),
        ['identity', 'provider-token'].includes(failure) ? [] : [[event.ts, true]],
      );
    } finally {
      await f.close();
    }
  });

test('mention policy uses active definition, applies across channels, and preserves immutable replacement roots', async () => {
  const f = await linkedChannelFixture();
  try {
    const agent = await f.addAgent();
    await f.attach(agent.id);
    assert.equal(await f.admit(await f.send('No mention')), false);
    await f.saveDefinition(agent.id, { ...agent.definition, responseRule: 'every-message' });
    assert.equal(await f.admit(await f.send('Draft does not activate')), false);
    const original = await f.send('A typed mention', { type: 'app_mention' });
    assert.equal(await f.admit(original), true);
    const replacement = await f.addAgent('every-message');
    await f.attach(replacement.id, 'CTEAM', 1);
    assert.equal(await f.process(original), 'blocked');
    assert.equal(f.modelInputs.length, 0);
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT r.agent_id FROM ${f.table('tf_slack_channel_roots')} r JOIN ${f.table('tf_slack_channel_invocations')} i ON i.root_id=r.id WHERE i.event_id=$1`,
          [original.id],
        )
      ).rows[0].agent_id,
      agent.id,
    );
    const stale = await f.send('Old thread without normal grant', { thread: original.ts });
    assert.equal(await f.admit(stale), false);
    await f.attach(replacement.id, 'CSECOND');
    for (const channel of ['CTEAM', 'CSECOND']) {
      const event = await f.send('No tag needed', { channel });
      assert.equal(await f.admit(event), true);
      assert.equal(await f.process(event), 'sent');
      assert.equal(f.posts.at(-1).channel, channel);
      assert.equal(
        (await f.db.platform.query(`SELECT agent_id FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [event.id])).rows[0]
          .agent_id,
        replacement.id,
      );
    }
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'invoke')`,
      [agent.id, f.actor.membershipId],
    );
    const normalFollow = await f.send('Old mapping with normal grant', { thread: original.ts });
    assert.equal(await f.admit(normalFollow), true);
    assert.equal(await f.process(normalFollow), 'sent');
    assert.equal(
      (await f.db.platform.query(`SELECT agent_id FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [normalFollow.id]))
        .rows[0].agent_id,
      agent.id,
    );
  } finally {
    await f.close();
  }
});

test('DM-only replies do not grant private-chat invocation or named DM continuation', async () => {
  const f = await linkedChannelFixture({ publicDelivery: false });
  try {
    const agent = await f.addAgent();
    assert.deepEqual(await f.attach(agent.id), { version: 1, channelResponses: false });
    assert.equal((await f.channels.inspect(f.workspace.id, f.workspace.userId, 'CTEAM')).channelResponses, false);
    const event = await f.send();
    assert.equal(await f.admit(event), true);
    assert.equal(await f.process(event), 'sent');
    assert.equal(f.posts.at(-1).channel, 'DBOB');
    const branch = (await f.db.platform.query(`SELECT dm_root FROM ${f.table('tf_slack_agent_branches')}`)).rows[0];
    const privateFollow = await f.send('Continue privately', { channel: 'DBOB', thread: branch.dm_root });
    assert.equal(await f.admit(privateFollow), false);
    assert.equal(await f.countRuns(privateFollow), 0);
    assert.equal(f.modelInputs.length, 1);
    await assert.rejects(
      f.tx(tx =>
        f.channels.attachSetup(tx, f.workspace.id, f.workspace.userId, {
          channel: 'CSECOND',
          agentId: agent.id,
          expectedVersion: 0,
          replaceAgentId: null,
        }),
      ),
      /slack-channel-delivery-disabled/,
    );
  } finally {
    await f.close();
  }
});

test('linked channel invocation can execute allowed tools through the ordinary executor', async () => {
  const f = await linkedChannelFixture();
  try {
    const agent = await f.addAgent('tag', ['tables.list']);
    await f.attach(agent.id);
    f.state.decision = { kind: 'tool', text: 'Only authorized tables', call: { tool: 'tables.list' } };
    const event = await f.send();
    assert.equal(await f.admit(event), true);
    assert.equal(await f.process(event), 'sent');
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT status,result FROM ${f.table('tf_agent_tool_calls')} WHERE run_id=$1`, [
          event.id,
        ])
      ).rows,
      [{ status: 'completed', result: { tables: [], total: 0, nextCursor: null } }],
    );
    assert.match(f.posts.at(-1).text, /Action status: completed/);
    await assert.rejects(
      f.tx(tx => requireAgentPermission(tx, f.actor, agent.id, 'invoke')),
      AccessDenied,
    );
  } finally {
    await f.close();
  }
});

test('channel-only invocation retains requester/agent data intersection and never borrows creator access', async () => {
  const f = await linkedChannelFixture();
  try {
    const agent = await f.addAgent(),
      tableId = randomUUID(),
      teamId = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Private data')`, [teamId]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
      agent.id,
      teamId,
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [teamId, tableId],
    );
    const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      agent.activationId,
      JSON.stringify(scope),
    ]);
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_limits')} SET scope=$2 WHERE agent_id=$1`, [
      agent.id,
      JSON.stringify(scope),
    ]);
    await f.attach(agent.id);
    const event = await f.send();
    assert.equal(await f.admit(event), true);
    await f.tx(async tx => {
      await requireAgentRunInvocation(tx, f.actor, agent.id, event.id);
      assert.equal(await canAccessAsset(tx, f.actor, tableId, 'table.row.read'), false);
      assert.equal(await canAccessAsset(tx, { kind: 'agent', runId: event.id }, tableId, 'table.row.read'), false);
    });
    assert.equal(await f.process(event), 'blocked');
    assert.equal(f.modelInputs.length, 0);
    assert.equal(f.posts.length, 0);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      f.actor.membershipId,
      teamId,
    ]);
    const allowed = await f.send();
    assert.equal(await f.admit(allowed), true);
    assert.equal(await f.process(allowed), 'sent');
    assert.equal(f.modelInputs.length, 1);
    await f.db.platform.query(`DELETE FROM ${f.table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
      f.actor.membershipId,
      teamId,
    ]);
    const later = await f.send();
    assert.equal(await f.admit(later), true);
    assert.equal(await f.process(later), 'blocked');
    assert.equal(f.modelInputs.length, 1);
  } finally {
    await f.close();
  }
});

for (const loss of ['requester', 'bot', 'attachment', 'identity', 'activation'])
  test(`delivery rechecks ${loss} after a retry without repeating the model`, async () => {
    const f = await linkedChannelFixture();
    try {
      const agent = await f.addAgent();
      await f.attach(agent.id);
      const event = await f.send();
      assert.equal(await f.admit(event), true);
      f.state.retry = true;
      assert.equal(await f.process(event), 'retry');
      assert.equal(f.modelInputs.length, 1);
      if (loss === 'requester') f.state.members = f.state.members.filter(user => user !== 'UBOB');
      if (loss === 'bot') f.state.members = f.state.members.filter(user => user !== 'UBOT');
      if (loss === 'attachment') await f.attach(null, 'CTEAM', 1);
      if (loss === 'identity')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE user_id='bob'`,
        );
      if (loss === 'activation')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_agent_activations')} SET revoked_at=clock_timestamp() WHERE id=$1`,
          [agent.activationId],
        );
      f.state.retry = false;
      await f.db.platform.query(
        `UPDATE ${f.table('tf_slack_agent_turns')} SET next_attempt_at=clock_timestamp() WHERE event_id=$1`,
        [event.id],
      );
      assert.equal(await f.process(event), 'blocked');
      assert.equal(f.modelInputs.length, 1);
      assert.equal(f.posts.length, 0);
    } finally {
      await f.close();
    }
  });

test('revocation during inference prevents an answer and later tool dispatch', async () => {
  const f = await linkedChannelFixture();
  try {
    const agent = await f.addAgent('tag', ['schema.inspect']);
    await f.attach(agent.id);
    const event = await f.send();
    assert.equal(await f.admit(event), true);
    f.state.decision = {
      kind: 'tool',
      text: 'Read protected data',
      call: { tool: 'schema.inspect', tableId: randomUUID() },
    };
    f.state.onInfer = () =>
      f.db.platform.query(
        `UPDATE ${f.table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE user_id='bob'`,
      );
    assert.equal(await f.process(event), 'blocked');
    assert.equal(f.modelInputs.length, 1);
    assert.equal(f.posts.length, 0);
    assert.equal(
      (
        await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_agent_tool_calls')} WHERE run_id=$1`, [
          event.id,
        ])
      ).rows[0].n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('setup attachment participates in rollback and requires exact replacement/detachment consent', async () => {
  const f = await linkedChannelFixture();
  try {
    const agent = await f.addAgent(),
      replacement = await f.addAgent();
    const attach = (tx, agentId, expectedVersion, replaceAgentId) =>
      f.channels.attachSetup(tx, f.workspace.id, f.workspace.userId, {
        channel: 'CTEAM',
        agentId,
        expectedVersion,
        replaceAgentId,
      });
    await assert.rejects(
      f.tx(async tx => {
        await attach(tx, agent.id, 0, null);
        throw new Error('later setup failed');
      }),
      /later setup failed/,
    );
    assert.equal((await f.channels.inspect(f.workspace.id, f.workspace.userId, 'CTEAM')).version, 0);
    assert.deepEqual(await f.tx(tx => attach(tx, agent.id, 0, null)), { version: 1, channelResponses: true });
    await assert.rejects(
      f.tx(tx => attach(tx, replacement.id, 1, null)),
      /slack-attachment-conflict/,
    );
    await assert.rejects(
      f.tx(tx => attach(tx, replacement.id, 0, agent.id)),
      /slack-attachment-conflict/,
    );
    assert.deepEqual(await f.tx(tx => attach(tx, replacement.id, 1, agent.id)), { version: 2, channelResponses: true });
    await assert.rejects(
      f.tx(tx => attach(tx, null, 2, agent.id)),
      /slack-attachment-conflict/,
    );
    assert.deepEqual(await f.tx(tx => attach(tx, null, 2, replacement.id)), { version: 3, channelResponses: true });
  } finally {
    await f.close();
  }
});

test('attachment readiness does not claim public delivery with missing bot scopes or expired credentials', async () => {
  const f = await linkedChannelFixture();
  try {
    const agent = await f.addAgent();
    await f.attach(agent.id);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_installations')} SET scopes=array_remove(scopes,'im:write') WHERE id=$1`,
      [f.installationId],
    );
    assert.equal((await f.channels.inspect(f.workspace.id, f.workspace.userId, 'CTEAM')).channelResponses, false);
    await assert.rejects(
      f.tx(tx =>
        f.channels.attachSetup(tx, f.workspace.id, f.workspace.userId, {
          channel: 'CSECOND',
          agentId: agent.id,
          expectedVersion: 0,
          replaceAgentId: null,
        }),
      ),
      AccessDenied,
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_installations')} SET scopes=array_append(scopes,'im:write'),bot_credential=jsonb_set(bot_credential,'{rotation}','{"state":"reconnect-required"}'::jsonb) WHERE id=$1`,
      [f.installationId],
    );
    assert.equal((await f.channels.inspect(f.workspace.id, f.workspace.userId, 'CTEAM')).channelResponses, false);
    await assert.rejects(
      f.tx(tx =>
        f.channels.attachSetup(tx, f.workspace.id, f.workspace.userId, {
          channel: 'CSECOND',
          agentId: agent.id,
          expectedVersion: 0,
          replaceAgentId: null,
        }),
      ),
      AccessDenied,
    );
  } finally {
    await f.close();
  }
});

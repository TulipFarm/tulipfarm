import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createSlackInbox, slackCredentialCipher } from '../../slack/src/index.ts';
import { slackUserCall, slackUserRequest } from '../../slack/test/web-api-fixture.mjs';
import { createSlackChannelAgents } from '../src/slack-channels.ts';
import { createSlackDefault } from '../src/slack-default.ts';
import { respondToConversation } from '../../../apps/worker/dist/conversation-responder.js';
import { anthropicChat } from '../../../apps/worker/test/native-chat-fixture.mjs';
import { markWorkspaceReady } from '../../workspace-storage/test/integration/fixture.mjs';

test('GENERAL default answers use complete current audiences and retain private fallback', async () => {
  const f = await conversationFixture(),
    installationId = randomUUID();
  const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } });
  const threads = new Map(),
    posts = [],
    modelInputs = [],
    tokens = [];
  let members = ['UALICE', 'UBOB', 'UBOT'],
    archived = false,
    sequence = 0,
    revoke = false,
    general = true,
    loop = false;
  let temporal, connection, clientConnection, worker, running, composition, api;
  const originalEnv = { ...process.env };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/info')) {
      res.end(
        JSON.stringify({
          ok: true,
          channel: { id: 'CGENERAL', is_general: general, is_archived: archived, is_member: true },
        }),
      );
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    if (req.url.startsWith('/user/')) {
      const { method, params, authorization } = await slackUserRequest(req);
      tokens.push(authorization);
      const audience = params.channel?.startsWith('D') ? ['UALICE', 'UBOT'] : members;
      if (method === 'conversations.info') {
        res.end(JSON.stringify({ ok: true, channel: { id: params.channel, is_archived: archived } }));
        return;
      }
      if (method === 'conversations.members') {
        res.end(
          JSON.stringify({
            ok: true,
            members: params.cursor ? audience.slice(1) : audience.slice(0, 1),
            response_metadata: { next_cursor: params.cursor && !loop ? '' : 'page2' },
          }),
        );
        return;
      }
      if (method === 'conversations.replies') {
        res.end(
          JSON.stringify({ ok: true, messages: threads.get(`${params.channel}/${params.ts}`) ?? [], has_more: false }),
        );
        return;
      }
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/model') {
      modelInputs.push(input);
      if (revoke)
        await f.db.platform.query(
          `UPDATE ${f.table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE slack_user_id='UALICE'`,
        );
      const decision = { kind: 'answer', text: 'A safe shared answer.' };
      res.end(
        JSON.stringify(
          anthropicChat(decision, {
            model: input.model,
            usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        ),
      );
      return;
    }
    if (req.url === '/open') {
      res.end(
        JSON.stringify({
          ok: true,
          channel: { id: input.users === 'UALICE' ? 'DALICE' : 'DBOB', is_im: true, user: input.users },
        }),
      );
      return;
    }
    if (req.url === '/post') {
      posts.push(input);
      const ts = `${100 + posts.length}.000001`;
      if (input.channel.startsWith('D') && !input.thread_ts)
        threads.set(`${input.channel}/${ts}`, [{ user: 'UBOT', text: input.text, ts }]);
      else threads.get(`${input.channel}/${input.thread_ts}`)?.push({ user: 'UBOT', text: input.text, ts });
      res.end(JSON.stringify({ ok: true, channel: input.channel, ts }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const native = globalThis.fetch;
  const fetcher = (url, init) =>
    native(
      `http://127.0.0.1:${server.address().port}/${slackUserCall(url, init) ? `user/${slackUserCall(url, init)}` : String(url).includes('conversations.info') ? 'info' : String(url).endsWith('conversations.open') ? 'open' : String(url).endsWith('chat.postMessage') ? 'post' : 'unknown'}`,
      init,
    );
  const channels = createSlackChannelAgents({
    runtime: f.runtime,
    appId: 'ATEST',
    cipher,
    fetcher,
    model: null,
    publicDelivery: true,
  });
  const defaults = createSlackDefault({
    runtime: f.runtime,
    appId: 'ATEST',
    cipher,
    fetcher,
    model: null,
    modelFamilyId: 'claude-sonnet',
    publicDelivery: true,
    channels,
    reply:
      () =>
      async ({ messages }) => {
        const result = await respondToConversation(
          {
            provider: 'anthropic',
            endpoint: 'https://api.anthropic.com/',
            apiKey: 'fixture',
            model: 'claude-opus-5-5',
          },
          messages,
          async () => assert.fail('no tool expected'),
        );
        return result;
      },
  });
  const inbox = createSlackInbox(f.runtime, channels.freeze);
  try {
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TTEST','UBOT',1,'active',ARRAY['chat:write','im:write'],$2,0)`,
      [
        installationId,
        cipher.encrypt({ workspaceId: f.workspace.id, installationId, generation: 1, kind: 'bot' }, 'xoxb-fixture'),
      ],
    );
    const bob = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'bob','member')`, [
      bob,
    ]);
    for (const [userId, membershipId, slackUserId, token] of [
      [f.workspace.userId, f.workspace.membershipId, 'UALICE', 'alice'],
      ['bob', bob, 'UBOB', 'bob'],
    ]) {
      const id = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,$3,$4,$5,'authorized',$6,ARRAY['channels:history','im:history'])`,
        [
          id,
          installationId,
          slackUserId,
          userId,
          membershipId,
          cipher.encrypt(
            {
              workspaceId: f.workspace.id,
              installationId,
              generation: 1,
              kind: 'user',
              identityId: id,
              membershipId,
              slackUserId,
            },
            `xoxp-${token}`,
          ),
        ],
      );
      // Slack use now needs an explicit installation grant, as 0107 backfills for linked identities.
      if (
        (await f.db.platform.query(`SELECT to_regclass($1) AS t`, [f.table('tf_slack_installation_grants')])).rows[0].t
      )
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [installationId, membershipId],
        );
    }
    globalThis.fetch = (url, init) =>
      String(url).startsWith('https://api.anthropic.com/')
        ? native(`http://127.0.0.1:${server.address().port}/model`, init)
        : String(url).startsWith('https://slack.com/')
          ? fetcher(url, init)
          : native(url, init);
    const { default: Fastify } = await import('../../../apps/api/node_modules/fastify/fastify.js');
    const { registerSlack } = await import('../../../apps/api/dist/slack.js');
    const { registerConversations } = await import('../../../apps/api/dist/conversations.js');
    api = Fastify();
    const config = {
      appId: 'ATEST',
      signingSecret: 'fixture-signing-secret',
      clientId: 'fixture',
      clientSecret: 'fixture',
      redirectUri: 'https://api.example.test/callback',
      scopeApproval: { reference: 'fixture', botScopes: ['chat:write', 'im:write'] },
      memberLinking: {
        identityRedirectUri: 'https://api.example.test/identity',
        operationalRedirectUri: 'https://api.example.test/operational',
        distribution: 'internal',
        scopeApproval: {
          reference: 'fixture',
          userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
        },
      },
    };
    process.env.WEB_ORIGIN = 'https://app.example.test';
    process.env.BETTER_AUTH_URL = 'https://api.example.test';
    api.register(
      async routes =>
        registerSlack(
          routes,
          { api: { getSession: async () => ({ user: { id: f.workspace.userId }, session: { id: 'fixture' } }) } },
          {
            config,
            inbox,
            channels,
            installations: { route: async () => ({ workspaceId: f.workspace.id, installationId, generation: 1 }) },
          },
        ),
      { prefix: '/v1' },
    );
    api.register(
      async routes =>
        registerConversations(routes, {
          auth: { api: { getSession: async () => ({ user: { id: f.workspace.userId }, session: { id: 'fixture' } }) } },
          service: f.store,
        }),
      { prefix: '/v1' },
    );
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const chatBase = `${address}/v1/workspaces/${f.workspace.id}/conversations`;
    const privateChats = [];
    async function createPrivateChats() {
      for (let index = 0; index < 26; index++) {
        const id = randomUUID();
        const response = await fetch(`${chatBase}/${id}`, {
          method: 'PUT',
          headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: randomUUID() }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { id });
        privateChats.push(id);
      }
    }
    await createPrivateChats();
    async function execute(eventId) {
      if (!worker) {
        assert.ok(process.env.TEST_TEMPORAL_CLI);
        const { createServer: netServer } = await import('node:net');
        const socket = netServer();
        socket.listen(0, '127.0.0.1');
        await once(socket, 'listening');
        const port = socket.address().port;
        await new Promise(resolve => socket.close(resolve));
        temporal = spawn(
          process.env.TEST_TEMPORAL_CLI,
          ['server', 'start-dev', '--ip', '127.0.0.1', '--port', String(port), '--headless', '--log-level', 'error'],
          { stdio: 'ignore' },
        );
        const { NativeConnection, Worker } =
          await import('../../../apps/worker/node_modules/@temporalio/worker/lib/index.js');
        const { Connection } = await import('../../../apps/worker/node_modules/@temporalio/client/lib/index.js');
        for (let i = 0; i < 100; i++) {
          try {
            clientConnection = await Connection.connect({ address: `127.0.0.1:${port}`, connectTimeout: '1 second' });
            break;
          } catch {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        connection = await NativeConnection.connect({ address: `127.0.0.1:${port}` });
        await markWorkspaceReady(f.db.platform, f.workspace.id);
        Object.assign(process.env, {
          ANTHROPIC_API_KEY: 'fixture',
          MODEL_FAMILIES: 'claude-haiku,claude-sonnet',
          SLACK_LINK_PROMPTS_ENABLED: 'true',
          SLACK_CHANNEL_AGENTS_ENABLED: 'true',
          SLACK_PUBLIC_DELIVERY_ENABLED: 'true',
          SLACK_CONFIGURATION: JSON.stringify(config),
          SLACK_CREDENTIAL_KEYS: JSON.stringify({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } }),
          WORKSPACE_AUTHORING_DATABASE_URL: f.db.connectionString,
          TEMPORAL_ADDRESS: `127.0.0.1:${port}`,
          TEMPORAL_TASK_QUEUE: `safe-${f.workspace.id}`,
        });
        const { createSlackPromptComposition } = await import('../../../apps/worker/dist/slack-composition.js');
        composition = await createSlackPromptComposition(f.runtime, null, 'claude-sonnet');
        worker = await Worker.create({
          connection,
          taskQueue: `safe-${f.workspace.id}`,
          workflowsPath: fileURLToPath(new URL('../../../apps/worker/dist/workflows.js', import.meta.url)),
          activities: composition.activities,
        });
        running = worker.run();
      }
      const { Client } = await import('../../../apps/worker/node_modules/@temporalio/client/lib/index.js');
      const client = new Client({ connection: clientConnection });
      for (let n = 0; n < 200; n++) {
        try {
          return await client.workflow.getHandle(`slack-channel-agent-${f.workspace.id}-${eventId}`).result();
        } catch (error) {
          if (!String(error).includes('not found')) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      assert.fail('compiled poller did not dispatch');
    }
    async function invoke(text, { channel = 'CGENERAL', root, user = 'UALICE' } = {}) {
      const ts = `${++sequence}.000001`,
        key = `${channel}/${root ?? ts}`;
      if (!threads.has(key)) threads.set(key, []);
      threads.get(key).push({ user, text, ts });
      const timestamp = String(Math.floor(Date.now() / 1000)),
        body = JSON.stringify({
          type: 'event_callback',
          api_app_id: 'ATEST',
          team_id: 'TTEST',
          event_id: `E${sequence}`,
          event_time: Number(timestamp),
          event: { type: 'message', channel, user, text, ts, ...(root ? { thread_ts: root } : {}) },
        });
      const received = await fetch(`${address}/v1/slack/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': `v0=${createHmac('sha256', config.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
        },
        body,
      });
      assert.equal(received.status, 200);
      const eventId = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_events')} WHERE event_id=$1`, [`E${sequence}`])
      ).rows[0].id;
      const due = await defaults.due(f.workspace.id);
      if (!due.some(work => work.eventId === eventId)) return { eventId, status: 'not-admitted' };
      let status = await execute(eventId);
      for (let n = 0; status === 'waiting' && n < 150; n++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const state = (
          await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_default_turns')} WHERE event_id=$1`, [
            eventId,
          ])
        ).rows[0]?.state;
        if (!['pending', 'retry', 'sending'].includes(state)) status = state;
      }
      if (status === 'blocked' && !revoke)
        assert.fail(
          JSON.stringify(
            (await f.db.platform.query(`SELECT status,error_code FROM ${f.table('tf_conversation_turns')}`)).rows,
          ),
        );
      return { eventId, status };
    }
    assert.equal((await invoke('ordinary message')).status, 'not-admitted');
    const first = await invoke('<@UBOT> Explain');
    assert.equal(first.status, 'sent');
    assert.equal(posts[0].channel, 'CGENERAL');
    assert.equal(posts[0].thread_ts, '2.000001');
    assert.equal(posts[0].text, 'A safe shared answer.');
    assert.ok(posts[0].blocks.length);
    assert.equal(posts[0].unfurl_links, false);
    await createPrivateChats();
    const sources = (
      await f.db.platform.query(
        `SELECT r.sources FROM ${f.table('tf_conversation_results')} r JOIN ${f.table('tf_slack_default_turns')} t ON t.turn_id=r.turn_id WHERE t.event_id=$1`,
        [first.eventId],
      )
    ).rows[0].sources;
    assert.deepEqual(sources, [{ kind: 'shared-slack-turn', eventId: first.eventId }]);
    const bobTurn = await invoke('Continue', { root: '2.000001', user: 'UBOB' });
    assert.equal(bobTurn.status, 'sent');
    assert.equal(posts[1].channel, 'CGENERAL');
    assert.ok(tokens.includes('Bearer xoxp-bob'));
    members.push('UGUEST');
    assert.equal((await invoke('<@UBOT> Another')).status, 'sent');
    assert.equal(posts[2].channel, 'CGENERAL');
    assert.equal(posts[2].thread_ts, '4.000001');
    assert.equal(posts.length, 3);
    members = members.filter(id => id !== 'UGUEST');
    members.push('BOTHERBOT');
    assert.equal((await invoke('<@UBOT> Other bot included')).status, 'sent');
    assert.equal(posts.at(-1).channel, 'CGENERAL');
    assert.equal(posts.at(-1).thread_ts, '5.000001');
    members.pop();
    general = false;
    assert.equal((await invoke('<@UBOT> Any channel')).status, 'sent');
    general = true;
    loop = true;
    assert.equal((await invoke('<@UBOT> Incomplete pages')).status, 'not-admitted');
    loop = false;
    archived = true;
    assert.equal((await invoke('<@UBOT> Archived')).status, 'not-admitted');
    archived = false;
    const attach = await fetch(`${address}/v1/workspaces/${f.workspace.id}/slack/channels/COTHER`, {
      method: 'PUT',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: null, expectedVersion: 0 }),
    });
    assert.equal(attach.status, 200);
    assert.equal((await invoke('Untagged other', { channel: 'COTHER' })).status, 'not-admitted');
    assert.equal((await invoke('<@UBOT> Attached default', { channel: 'COTHER' })).status, 'sent');
    assert.equal(posts.at(-1).channel, 'COTHER');
    assert.ok(tokens.includes('Bearer xoxp-bob'));
    const before = posts.length;
    revoke = true;
    assert.equal((await invoke('<@UBOT> Revoke in flight')).status, 'blocked');
    assert.equal(posts.length, before);
    assert.equal(modelInputs.length, 7);
    const firstPage = await fetch(chatBase);
    assert.equal(firstPage.status, 200);
    const page = await firstPage.json();
    assert.equal(page.chats.length, 50);
    assert.equal(typeof page.nextCursor, 'string');
    const secondPage = await fetch(`${chatBase}?cursor=${page.nextCursor}`);
    assert.equal(secondPage.status, 200);
    const older = await secondPage.json();
    assert.equal(older.chats.length, 2);
    assert.equal(older.nextCursor, null);
    assert.deepEqual(
      [...page.chats, ...older.chats].map(chat => chat.id),
      privateChats.toReversed(),
    );
    for (const id of privateChats) {
      const response = await fetch(`${chatBase}/${id}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, id);
    }
    const executionChats = (
      await f.db.platform.query(
        `SELECT conversation_id,state FROM ${f.table('tf_slack_default_turns')} JOIN ${f.table('tf_conversations')} ON id=conversation_id WHERE owner_user_id=$1`,
        [f.workspace.userId],
      )
    ).rows;
    assert.ok(executionChats.some(chat => chat.state === 'sent'));
    assert.ok(executionChats.some(chat => chat.state === 'blocked'));
    for (const { conversation_id: id } of executionChats) {
      for (const suffix of ['', '/messages']) {
        const response = await fetch(`${chatBase}/${id}${suffix}`);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'conversation-not-found' });
      }
      const response = await fetch(`${chatBase}/${id}`, {
        method: 'PATCH',
        headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: randomUUID(), archived: true }),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'conversation-not-found' });
    }
  } finally {
    await composition?.close();
    if (worker) {
      worker.shutdown();
      await running;
    }
    await connection?.close();
    await clientConnection?.close();
    temporal?.kill();
    await api?.close();
    globalThis.fetch = native;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});

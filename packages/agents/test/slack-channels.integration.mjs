import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { connect, markWorkspaceReady } from '../../workspace-storage/test/integration/fixture.mjs';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import {
  createSlackInbox,
  createSlackMemberLinking,
  createSlackLinkPrompts,
  slackCredentialCipher,
} from '../../slack/src/index.ts';
import { memberProviderFixture } from '../../slack/test/member-provider-fixture.mjs';
import { slackUserCall, slackUserRead, slackUserRequest } from '../../slack/test/web-api-fixture.mjs';
import { createSlackChannelAgents } from '../src/slack-channels.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';
import { inferDecision } from '../src/inference.ts';
import { createSoulAgentFixture, policyVersion } from './soul-fixture.mjs';
import { createAgentStore } from '../src/store.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIntegrationService } from '../../integrations/src/service.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { nativeReply, useCall } from './native-fixture.mjs';

for (const scenario of [
  'github',
  'public',
  'journey',
  'private-before',
  'private-after',
  'private-edit',
  'private-edit-admitted',
  'private-inflight',
  'private-tool-inflight',
  'private-history',
  'private-delivery',
  'poison',
  'starvation',
])
  test(`channel agent ${scenario}`, async () => {
    const f = await conversationFixture();
    const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } });
    const installationId = randomUUID(),
      agentId = randomUUID(),
      teamId = randomUUID(),
      activationId = randomUUID();
    const tableId = randomUUID(),
      tableTeam = randomUUID(),
      integrationId = randomUUID(),
      sourceId = randomUUID();
    const definition = {
      name: 'HR',
      instructions: 'You are the saved HR specialist.',
      tools: scenario === 'github' ? ['github.issue.read'] : ['schema.inspect'],
      responseRule: 'tag',
    };
    const revision = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    const messages = [{ user: 'UALICE', text: '<@UBOT> HR question', ts: '1.000001' }];
    const delivered = [],
      modelInputs = [];
    let members = ['UALICE', 'UBOB', 'UBOT'],
      archived = false,
      loseAnswer = false,
      rejectAlice = false;
    const privateThreads = new Map();
    const server = createServer(async (req, res) => {
      if (req.url === '/github') {
        assert.equal(req.headers.authorization, 'Bearer fixture-github-token');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ number: 17, title: 'Shared issue', body: 'Source content', state: 'open' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/user/')) {
        const { method, params, authorization } = await slackUserRequest(req);
        if (rejectAlice && authorization === 'Bearer xoxp-alice') {
          res.writeHead(401).end();
          return;
        }
        assert.match(authorization, /^Bearer xoxp-(alice|bob|synthetic-user-token)$/);
        res.end(
          JSON.stringify(
            slackUserRead(method, params, {
              archived: () => archived,
              audience: () => members,
              messages: args =>
                args.channel.startsWith('D') ? (privateThreads.get(`${args.channel}/${args.ts}`) ?? []) : messages,
            }),
          ),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      if (req.url === '/model') {
        modelInputs.push(input);
        const decision =
          scenario === 'github'
            ? {
                kind: 'tool',
                text: 'Reading the saved source',
                call: { tool: 'github.issue.read', integrationId, sourceId, issueNumber: 17 },
              }
            : JSON.stringify(input).includes('Inspect HR records')
              ? { kind: 'tool', text: 'Inspecting HR records', call: { tool: 'schema.inspect', tableId } }
              : { kind: 'answer', text: 'HR PRIVATE ANSWER' };
        res.end(
          JSON.stringify({
            ...nativeReply(
              'anthropic',
              decision.kind === 'answer' ? { text: decision.text } : { calls: [useCall(decision.call, decision.text)] },
            ),
            model: input.model,
          }),
        );
        return;
      }
      if (req.url === '/open') {
        res.end(
          JSON.stringify({
            ok: true,
            channel: {
              id: input.users === 'UALICE' ? 'DALICE' : input.users === 'UCAROL' ? 'DCAROL' : 'DBOB',
              is_im: true,
              user: input.users,
            },
          }),
        );
        return;
      }
      if (req.url === '/ephemeral') {
        delivered.push(input);
        res.end(JSON.stringify({ ok: true, message_ts: `${100 + delivered.length}.000001` }));
        return;
      }
      if (req.url === '/post') {
        delivered.push(input);
        const ts = `${100 + delivered.length}.000001`;
        if (!input.thread_ts) privateThreads.set(`${input.channel}/${ts}`, [{ user: 'UBOT', text: input.text, ts }]);
        if (input.channel.startsWith('C')) messages.push({ user: 'UBOT', text: input.text, ts });
        if (loseAnswer) {
          req.socket.destroy();
          return;
        }
        res.end(JSON.stringify({ ok: true, channel: input.channel, ts }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const fetcher = (url, init) =>
      fetch(
        `http://127.0.0.1:${server.address().port}/${slackUserCall(url, init) ? `user/${slackUserCall(url, init)}` : String(url).endsWith('conversations.open') ? 'open' : String(url).endsWith('chat.postMessage') ? 'post' : String(url).endsWith('chat.postEphemeral') ? 'ephemeral' : 'unknown'}`,
        init,
      );
    const model = syntheticContinuity(async () => assert.fail('real adapter must run'));
    model.infer = async (_resolution, input, timeoutMs, signal) => {
      const native = globalThis.fetch;
      globalThis.fetch = (url, init) =>
        String(url).startsWith('https://api.anthropic.com/')
          ? native(`http://127.0.0.1:${server.address().port}/model`, init)
          : native(url, init);
      try {
        return await inferDecision(
          {
            provider: 'anthropic',
            endpoint: 'https://api.anthropic.com/',
            apiKey: 'fixture',
            model: 'claude-opus-5-5',
            timeoutMs,
          },
          input,
          signal,
        );
      } finally {
        globalThis.fetch = native;
      }
    };
    const channels = createSlackChannelAgents({
      runtime: f.runtime,
      appId: 'ATEST',
      cipher,
      fetcher,
      model,
      publicDelivery: scenario === 'public',
    });
    const inbox = createSlackInbox(f.runtime, channels.freeze);
    const { default: Fastify } = await import('../../../apps/api/node_modules/fastify/fastify.js');
    const { registerSlack } = await import('../../../apps/api/dist/slack.js');
    const api = Fastify(),
      config = {
        appId: 'ATEST',
        signingSecret: 'synthetic-signing-secret',
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
    const oauth = await memberProviderFixture(config);
    const installations = { route: async () => ({ workspaceId: f.workspace.id, installationId, generation: 1 }) };
    const linking = createSlackMemberLinking({
      runtime: f.runtime,
      config,
      cipher,
      installations,
      fetcher: oauth.fetcher,
    });
    let sessionUser = 'bob';
    process.env.WEB_ORIGIN = 'https://app.example.test';
    process.env.BETTER_AUTH_URL = 'https://api.example.test';
    api.register(
      async routes =>
        registerSlack(
          routes,
          { api: { getSession: async () => ({ user: { id: sessionUser }, session: { id: 'fixture' } }) } },
          { config, inbox, channels, installations, memberLinking: linking },
        ),
      { prefix: '/v1' },
    );
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    let temporal, connection, clientConnection, worker, running, composition;
    const originalFetch = globalThis.fetch,
      originalEnv = { ...process.env };
    async function execute(eventId) {
      if (!worker) {
        assert.ok(process.env.TEST_TEMPORAL_CLI, 'Set TEST_TEMPORAL_CLI for real workflow proof');
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
        assert.ok(clientConnection);
        connection = await NativeConnection.connect({ address: `127.0.0.1:${port}` });
        await markWorkspaceReady(f.db.platform, f.workspace.id);
        Object.assign(process.env, {
          SLACK_LINK_PROMPTS_ENABLED: 'true',
          SLACK_CHANNEL_AGENTS_ENABLED: 'true',
          SLACK_CONFIGURATION: JSON.stringify({
            ...config,
            clientId: 'fixture',
            clientSecret: 'fixture',
            redirectUri: 'https://api.example.test/slack/callback',
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
          }),
          SLACK_CREDENTIAL_KEYS: JSON.stringify({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } }),
          WORKSPACE_AUTHORING_DATABASE_URL: f.db.connectionString,
          TEMPORAL_ADDRESS: `127.0.0.1:${port}`,
          TEMPORAL_TASK_QUEUE: `channels-${f.workspace.id}`,
        });
        globalThis.fetch = (url, init) =>
          String(url).startsWith('https://api.github.com/')
            ? originalFetch(`http://127.0.0.1:${server.address().port}/github`, init)
            : String(url).startsWith('https://slack.com/')
              ? originalFetch(
                  `http://127.0.0.1:${server.address().port}/${slackUserCall(url, init) ? `user/${slackUserCall(url, init)}` : String(url).endsWith('conversations.open') ? 'open' : String(url).endsWith('chat.postMessage') ? 'post' : String(url).endsWith('chat.postEphemeral') ? 'ephemeral' : 'unknown'}`,
                  init,
                )
              : originalFetch(url, init);
        const { createSlackPromptComposition } = await import('../../../apps/worker/dist/slack-composition.js');
        process.env.SLACK_PUBLIC_DELIVERY_ENABLED = scenario === 'public' ? 'true' : 'false';
        composition = await createSlackPromptComposition(f.runtime, model);
        worker = await Worker.create({
          connection,
          taskQueue: `channels-${f.workspace.id}`,
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
    try {
      if (scenario === 'github') {
        process.env.INTEGRATION_CREDENTIAL_KEY_ID = 'fixture';
        process.env.INTEGRATION_CREDENTIAL_KEY = 'ab'.repeat(32);
      }
      const bot = cipher.encrypt(
        { workspaceId: f.workspace.id, installationId, generation: 1, kind: 'bot' },
        'xoxb-fixture',
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TTEST','UBOT',1,'active',ARRAY['chat:write','im:write'],$2,0)`,
        [installationId, bot],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_slack_installations')} SET scopes=array_append(scopes,'chat:write.customize') WHERE id=$1`,
        [installationId],
      );
      const bobMember = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'bob','member')`,
        [bobMember],
      );
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'HR')`, [teamId]);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        bobMember,
        teamId,
      ]);
      // Alice invokes through the same explicit team grant as Bob. Admin status grants no agent access.
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        f.workspace.membershipId,
        teamId,
      ]);
      for (const [userId, membershipId, slackUserId, token] of [
        [f.workspace.userId, f.workspace.membershipId, 'UALICE', 'alice'],
        ['bob', bobMember, 'UBOB', 'bob'],
      ]) {
        const id = randomUUID(),
          credential = cipher.encrypt(
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
          );
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,$3,$4,$5,'authorized',$6,ARRAY['channels:history','im:history'])`,
          [id, installationId, slackUserId, userId, membershipId, credential],
        );
        // Slack use now needs an explicit installation grant, as 0107 backfills for linked identities.
        if (
          (await f.db.platform.query(`SELECT to_regclass($1) AS t`, [f.table('tf_slack_installation_grants')])).rows[0]
            .t
        )
          await f.db.platform.query(
            `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [installationId, membershipId],
          );
      }
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agents')} (id,enabled,owning_team_id,display_name) VALUES ($1,true,$2,'HR')`,
        [agentId, teamId],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [agentId, revision, definition],
      );
      const command = randomUUID(),
        soul = 'a'.repeat(40);
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
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke'),($1,$2,'read')`,
        [agentId, teamId],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,'[]')`,
        [activationId, agentId, revision],
      );
      await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_limits')} (agent_id,scope) VALUES ($1,'[]')`, [
        agentId,
      ]);
      if (scenario === 'github') {
        const service = createIntegrationService({
          runtime: f.runtime,
          keyring: { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } },
        });
        const actor = { kind: 'human', userId: f.workspace.userId, membershipId: f.workspace.membershipId };
        await service.create(f.workspace.id, actor, {
          id: integrationId,
          name: 'Shared source',
          owningTeamId: teamId,
          token: 'fixture-github-token',
          repositories: [{ id: sourceId, owner: 'tulipfarm', repo: 'fixture' }],
        });
        await service.setGrants(f.workspace.id, actor, integrationId, {
          expectedGrantsVersion: 1,
          grants: [{ teamId, permissions: ['read', 'use'] }],
          sourceGrants: [{ teamId, sourceId }],
        });
        const scope = [
          { assetId: integrationId, permissions: ['integration.read', 'integration.use'] },
          { assetId: sourceId, permissions: ['github.issue.read'] },
        ];
        await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
          agentId,
          teamId,
        ]);
        await f.db.platform.query(`UPDATE ${f.table('tf_agent_limits')} SET scope=$2 WHERE agent_id=$1`, [
          agentId,
          JSON.stringify(scope),
        ]);
        await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
          activationId,
          JSON.stringify(scope),
        ]);
      }
      const attachment = await fetch(`${address}/v1/workspaces/${f.workspace.id}/slack/channels/CHR`, {
        method: 'PUT',
        headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, expectedVersion: 0 }),
      });
      assert.equal(attachment.status, 200);
      assert.deepEqual(await attachment.json(), { version: 1, channelResponses: scenario === 'public' });
      let sequence = 0;
      async function event(user, text, ts, thread_ts, channel = 'CHR') {
        if (channel.startsWith('D') && thread_ts)
          privateThreads.get(`${channel}/${thread_ts}`)?.push({ user, text, ts });
        const event_id = `E${++sequence}`;
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({
          type: 'event_callback',
          api_app_id: 'ATEST',
          team_id: 'TTEST',
          event_id,
          event_time: Number(timestamp),
          event: { type: 'message', user, channel, ts, text, ...(thread_ts ? { thread_ts } : {}) },
        });
        const response = await fetch(`${address}/v1/slack/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-slack-request-timestamp': timestamp,
            'x-slack-signature': `v0=${createHmac('sha256', config.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
          },
          body,
        });
        assert.equal(response.status, 200);
        return (await f.db.platform.query(`SELECT id FROM ${f.table('tf_slack_events')} WHERE event_id=$1`, [event_id]))
          .rows[0].id;
      }
      const id = await event('UALICE', messages[0].text, '1.000001');
      assert.deepEqual(await channels.due(f.workspace.id), [{ workspaceId: f.workspace.id, eventId: id }]);
      await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET display_name='People Ops' WHERE id=$1`, [agentId]);
      assert.equal(await execute(id), 'sent');
      assert.equal('icon_url' in delivered[0], false);
      assert.equal('icon_emoji' in delivered[0], false);
      if (scenario === 'public') {
        assert.equal(delivered[0].username, 'People Ops \u00b7 TulipFarm');
        assert.equal(delivered[0].blocks[0].type, 'rich_text');
      } else {
        assert.equal('username' in delivered[0], false);
        assert.deepEqual(delivered[0].blocks[0], {
          type: 'context',
          elements: [{ type: 'plain_text', text: 'People Ops' }],
        });
      }
      if (scenario === 'github') {
        assert.equal(delivered[0].channel, 'DALICE');
        assert.match(delivered[0].text, /Shared issue/);
        assert.deepEqual(
          (await f.db.platform.query(`SELECT sources FROM ${f.table('tf_slack_tool_sources')} WHERE call_id=$1`, [id]))
            .rows[0].sources,
          [{ kind: 'github-source', integrationId, sourceId, generation: 1, grantsVersion: 2 }],
        );
        await composition.close();
        composition = undefined;
        await f.db.platform.query(`UPDATE ${f.table('tf_integrations')} SET enabled=false WHERE id=$1`, [
          integrationId,
        ]);
        const follow = await event('UALICE', 'Use previous source', '2.000001', '101.000001', 'DALICE');
        await channels.due(f.workspace.id);
        assert.equal(await channels.process({ workspaceId: f.workspace.id, eventId: follow }), 'idle');
        assert.equal(delivered.length, 1);
        assert.equal(
          (
            await f.db.platform.query(
              `SELECT count(*)::int AS n FROM ${f.table('tf_slack_agent_rejections')} WHERE event_id=$1`,
              [follow],
            )
          ).rows[0].n,
          1,
        );
        return;
      }
      if (scenario === 'public') {
        assert.equal(delivered[0].channel, 'CHR');
        assert.equal(delivered[0].thread_ts, '1.000001');
        await composition.close();
        composition = undefined;
        await f.db.platform.query(
          `UPDATE ${f.table('tf_slack_installations')} SET scopes=array_remove(scopes,'chat:write.customize') WHERE id=$1`,
          [installationId],
        );
        members.push('UGUEST');
        messages.push({ user: 'UALICE', text: 'Private with guest', ts: '2.000001' });
        const restricted = await event('UALICE', 'Private with guest', '2.000001', '1.000001');
        await channels.due(f.workspace.id);
        assert.equal(await channels.process({ workspaceId: f.workspace.id, eventId: restricted }), 'sent');
        assert.equal(
          delivered.at(-1).channel,
          'CHR',
          '#512 replies in the source thread even when an unlinked guest is a member',
        );
        assert.equal('username' in delivered.at(-1), false);
        assert.deepEqual(delivered.at(-1).blocks[0], {
          type: 'context',
          elements: [{ type: 'plain_text', text: 'People Ops' }],
        });
        members = members.filter(member => member !== 'UGUEST');
        await f.db.platform.query(`DELETE FROM ${f.table('tf_agent_grants')} WHERE agent_id=$1 AND permission='read'`, [
          agentId,
        ]);
        messages.push({ user: 'UBOB', text: 'Continue the attached channel answer', ts: '4.000001' });
        const continued = await event('UBOB', 'Continue the attached channel answer', '4.000001', '1.000001');
        await channels.due(f.workspace.id);
        assert.equal(await channels.process({ workspaceId: f.workspace.id, eventId: continued }), 'sent');
        assert.equal(delivered.length, 3);
        assert.equal(delivered.at(-1).channel, 'CHR');
        return;
      }
      assert.equal(delivered[0].channel, 'DALICE');
      assert.equal(delivered[0].text, 'HR PRIVATE ANSWER');
      assert.match(JSON.stringify(modelInputs[0]), /You are the saved HR specialist/);
      if (scenario !== 'journey') {
        await composition.close();
        composition = undefined;
        const process = id => channels.process({ workspaceId: f.workspace.id, eventId: id });
        async function change(ts, text, updateProvider = true) {
          const timestamp = String(Math.floor(Date.now() / 1000));
          const thread = privateThreads.get('DALICE/101.000001'),
            before = thread.find(m => m.ts === ts);
          const event =
            text === null
              ? {
                  type: 'message',
                  subtype: 'message_deleted',
                  channel: 'DALICE',
                  deleted_ts: ts,
                  event_ts: '999.000001',
                  previous_message: { ...before, thread_ts: '101.000001' },
                }
              : {
                  type: 'message',
                  subtype: 'message_changed',
                  channel: 'DALICE',
                  event_ts: '998.000001',
                  message: { ...before, text, thread_ts: '101.000001', edited: { ts: '998.000001' } },
                  previous_message: before,
                };
          const body = JSON.stringify({
            type: 'event_callback',
            api_app_id: 'ATEST',
            team_id: 'TTEST',
            event_id: `CHANGE${ts}`,
            event_time: Number(timestamp),
            event,
          });
          assert.equal(
            (
              await fetch(`${address}/v1/slack/events`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-slack-request-timestamp': timestamp,
                  'x-slack-signature': `v0=${createHmac('sha256', config.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
                },
                body,
              })
            ).status,
            200,
          );
          if (updateProvider) {
            if (text === null) thread.splice(thread.indexOf(before), 1);
            else before.text = text;
          }
        }
        if (scenario.startsWith('private')) {
          const request = await event('UALICE', 'STALE PRIVATE TEXT', '3.000001', '101.000001', 'DALICE');
          if (
            [
              'private-after',
              'private-edit-admitted',
              'private-inflight',
              'private-tool-inflight',
              'private-history',
              'private-delivery',
            ].includes(scenario)
          )
            await channels.due(f.workspace.id);
          if (scenario === 'private-delivery') {
            const native = globalThis.fetch;
            globalThis.fetch = (url, init) =>
              String(url).endsWith('/post')
                ? Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '1' } }))
                : native(url, init);
            try {
              assert.equal(await process(request), 'retry');
            } finally {
              globalThis.fetch = native;
            }
            await change('3.000001', null);
            await f.db.platform.query(
              `UPDATE ${f.table('tf_slack_agent_turns')} SET next_attempt_at=clock_timestamp() WHERE event_id=$1`,
              [request],
            );
            assert.equal(await process(request), 'blocked');
            assert.equal(modelInputs.length, 2);
            assert.equal(delivered.length, 1);
            return;
          }
          if (scenario === 'private-history') {
            assert.equal(await process(request), 'sent');
            await change('3.000001', null);
            const follow = await event('UALICE', 'After deletion', '4.000001', '101.000001', 'DALICE');
            await channels.due(f.workspace.id);
            assert.equal(await process(follow), 'sent');
            const reused = (
              await f.db.platform.query(
                `SELECT history_run_ids FROM ${f.table('tf_slack_agent_turns')} WHERE event_id=$1`,
                [follow],
              )
            ).rows[0].history_run_ids;
            assert.equal(reused.includes(request), false);
            assert.equal(modelInputs.length, 3);
            assert.equal(JSON.stringify(modelInputs.at(-1)).includes('STALE PRIVATE TEXT'), false);
            return;
          }
          if (scenario === 'private-inflight' || scenario === 'private-tool-inflight') {
            const infer = model.infer;
            model.infer = async (...args) => {
              const result = await infer(...args);
              await change('3.000001', null, false);
              return scenario === 'private-tool-inflight'
                ? { ...result, decision: { kind: 'tool', text: 'Inspect', call: { tool: 'schema.inspect', tableId } } }
                : result;
            };
            assert.equal(await process(request), 'blocked');
            assert.equal(
              (
                await f.db.platform.query(`SELECT decision FROM ${f.table('tf_agent_chat_turns')} WHERE id=$1`, [
                  request,
                ])
              ).rows[0].decision,
              null,
            );
            assert.equal(
              (
                await f.db.platform.query(
                  `SELECT count(*)::int AS n FROM ${f.table('tf_agent_tool_calls')} WHERE run_id=$1`,
                  [request],
                )
              ).rows[0].n,
              0,
            );
            assert.equal(delivered.length, 1);
            return;
          }
          await change(
            '3.000001',
            ['private-edit', 'private-edit-admitted'].includes(scenario) ? 'CURRENT PRIVATE TEXT' : null,
            scenario !== 'private-after',
          );
          await channels.due(f.workspace.id);
          const result = await process(request);
          if (scenario === 'private-edit') {
            assert.equal(result, 'sent');
            assert.match(JSON.stringify(modelInputs.at(-1)), /CURRENT PRIVATE TEXT/);
            assert.equal(JSON.stringify(modelInputs.at(-1)).includes('STALE PRIVATE TEXT'), false);
          } else {
            assert.equal(result, scenario === 'private-before' ? 'idle' : 'blocked');
            assert.equal(modelInputs.length, 1);
            assert.equal(delivered.length, 1);
          }
        } else if (scenario === 'poison') {
          messages.push({ user: 'UBOB', text: 'Bob ready', ts: '2.000001' });
          const bob = await event('UBOB', 'Bob ready', '2.000001', '1.000001');
          await channels.due(f.workspace.id);
          messages.push({ user: 'UALICE', text: 'Alice rejected', ts: '3.000001' });
          const alice = await event('UALICE', 'Alice rejected', '3.000001', '1.000001');
          rejectAlice = true;
          for (let n = 0; n < 2; n++)
            assert.ok((await channels.due(f.workspace.id)).some(work => work.eventId === bob));
          assert.equal(await process(bob), 'sent');
          assert.equal(delivered.at(-1).channel, 'DBOB');
          assert.deepEqual(
            (
              await f.db.platform.query(
                `SELECT state,attempts FROM ${f.table('tf_slack_agent_admission_waits')} WHERE event_id=$1`,
                [alice],
              )
            ).rows,
            [{ state: 'reauthorization-required', attempts: 1 }],
          );
          rejectAlice = false;
          await f.db.platform.query(
            `UPDATE ${f.table('tf_slack_agent_admission_waits')} SET next_attempt_at=clock_timestamp() WHERE event_id=$1`,
            [alice],
          );
          assert.ok((await channels.due(f.workspace.id)).some(work => work.eventId === alice));
          assert.equal(await process(alice), 'sent');
        } else {
          const uncertain = await event('UALICE', 'Lose answer', '2.000001', '101.000001', 'DALICE');
          await channels.due(f.workspace.id);
          loseAnswer = true;
          assert.equal(await process(uncertain), 'unknown');
          loseAnswer = false;
          for (let n = 0; n < 50; n++)
            await event('UALICE', 'Blocked successor', `${10 + n}.000001`, '101.000001', 'DALICE');
          messages.push({ user: 'UBOB', text: 'Bob independent', ts: '99.000001' });
          const bob = await event('UBOB', 'Bob independent', '99.000001', '1.000001');
          assert.ok((await channels.due(f.workspace.id)).some(work => work.eventId === bob));
          assert.equal(await process(bob), 'sent');
          assert.equal(delivered.at(-1).channel, 'DBOB');
          assert.equal(await process(uncertain), 'idle');
        }
        return;
      }
      const replacement = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agents')} (id,enabled,owning_team_id,display_name) VALUES ($1,true,$2,'Finance')`,
        [replacement, teamId],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [replacement, revision, { ...definition, name: 'Finance' }],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
        [replacement, soul, revision],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [
        replacement,
        soul,
      ]);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke')`,
        [replacement, teamId],
      );
      await channels.attach(f.workspace.id, 'bob', { channel: 'CHR', agentId: replacement, expectedVersion: 1 });
      messages.push({ user: 'UBOB', text: 'My follow-up', ts: '2.000001' });
      const second = await event('UBOB', 'My follow-up', '2.000001', '1.000001');
      await channels.due(f.workspace.id);
      assert.equal(await execute(second), 'sent');
      assert.equal(delivered[1].channel, 'DBOB');
      assert.equal(JSON.stringify(modelInputs[1]).includes('HR PRIVATE ANSWER'), false);
      assert.match(JSON.stringify(modelInputs[1]), /You are the saved HR specialist/);
      assert.equal(
        (await f.db.platform.query(`SELECT user_id FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [second])).rows[0]
          .user_id,
        'bob',
      );
      const follow = await event('UALICE', 'Continue privately', '3.000001', '101.000001', 'DALICE');
      await channels.due(f.workspace.id);
      assert.equal(await execute(follow), 'sent');
      assert.equal(delivered[2].thread_ts, '101.000001');
      assert.equal(JSON.stringify(modelInputs[2]).includes('HR PRIVATE ANSWER'), true);
      members = ['UBOB', 'UBOT'];
      const revoked = await event('UALICE', 'After channel loss', '4.000001', '101.000001', 'DALICE');
      await channels.due(f.workspace.id);
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [revoked]))
          .rows[0].n,
        0,
      );
      assert.equal(delivered.length, 3);
      members = ['UALICE', 'UBOB', 'UBOT'];
      messages[1] = { ...messages[1], text: 'Edited public follow-up' };
      const edited = await event('UALICE', 'Use current text', '5.000001', '101.000001', 'DALICE');
      await channels.due(f.workspace.id);
      assert.equal(await execute(edited), 'sent');
      assert.match(JSON.stringify(modelInputs.at(-1)), /Edited public follow-up/);
      assert.equal(JSON.stringify(modelInputs.at(-1)).includes('My follow-up'), false);
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [id]))
          .rows[0].n,
        1,
      );
      const deletedIndex = messages.findIndex(message => message.ts === '2.000001');
      messages.splice(deletedIndex, 1);
      const afterDelete = await event('UALICE', 'After deleted context', '5.000002', '101.000001', 'DALICE');
      await channels.due(f.workspace.id);
      assert.equal(await execute(afterDelete), 'sent');
      assert.equal(JSON.stringify(modelInputs.at(-1)).includes('Edited public follow-up'), false);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Restricted HR')`, [
        tableTeam,
      ]);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'hr_records','Private HR salaries',$3)`,
        [tableId, tableTeam, 'c'.repeat(40)],
      );
      // Record tools read the active generation since #267, so the restricted resource needs a real applied definition.
      const hrDefinition = {
        formatVersion: 2,
        id: tableId,
        owningTeamId: tableTeam,
        label: 'Private HR salaries',
        fields: [],
        uniqueKeys: [],
      };
      const migrator = await connect(f.db.login(f.workspace, 'migration'));
      try {
        await inTransaction(migrator, async client => {
          await client.query(`SET LOCAL ROLE "${f.workspace.names.customOwner}"`);
          const tx = { client, schema: f.workspace.names.schema };
          const generation = await createGeneration(tx, { definition: hrDefinition, revision: 'c'.repeat(40) });
          await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
          await client.query(
            `UPDATE ${f.table('tf_table_catalog')} SET applied_revision=$2,applied_definition=$3,physical_table=$4 WHERE id=$1`,
            [tableId, 'c'.repeat(40), hrDefinition, generation.physical_table],
          );
        });
      } finally {
        await migrator.end();
      }
      await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
        agentId,
        tableTeam,
      ]);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [tableTeam, tableId],
      );
      // #478 removed admins' automatic team access, so Alice reads the restricted resource as a team member.
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        f.workspace.membershipId,
        tableTeam,
      ]);
      const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
      await f.db.platform.query(`UPDATE ${f.table('tf_agent_limits')} SET scope=$2 WHERE agent_id=$1`, [
        agentId,
        JSON.stringify(scope),
      ]);
      await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
        activationId,
        JSON.stringify(scope),
      ]);
      const tool = await event('UALICE', 'Inspect HR records', '6.000001', '101.000001', 'DALICE');
      await channels.due(f.workspace.id);
      assert.equal(await execute(tool), 'sent');
      assert.match(delivered.at(-1).text, /Private HR salaries/);
      const before = modelInputs.length;
      const denied = await event('UBOB', 'Inspect HR records', '7.000001', '102.000001', 'DBOB');
      await channels.due(f.workspace.id);
      assert.equal(await execute(denied), 'blocked');
      assert.equal(modelInputs.length, before);
      assert.equal(
        delivered.every(message => message.channel.startsWith('D')),
        true,
      );
      await channels.attach(f.workspace.id, 'bob', { channel: 'CNEW', agentId, expectedVersion: 0 });
      const carolMember = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'carol','member')`,
        [carolMember],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2),($1,$3)`,
        [carolMember, teamId, tableTeam],
      );
      // Linking a Slack identity requires an explicit installation use grant.
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2)`,
        [installationId, carolMember],
      );
      members.push('UCAROL');
      await event('UCAROL', 'Unrelated message', '8.000001', undefined, 'CNEW');
      const prompts = createSlackLinkPrompts({
        ...f.options,
        runtime: f.runtime,
        appId: 'ATEST',
        cipher,
        webOrigin: 'https://app.example.test',
        fetcher,
      });
      const uninvoked = await prompts.discover(f.workspace.id);
      assert.equal(uninvoked.length, 0);
      messages.push({ user: 'UCAROL', text: '<@UBOT> Original Carol request', ts: '9.000001' });
      const held = await event('UCAROL', '<@UBOT> Original Carol request', '9.000001', undefined, 'CNEW');
      await channels.attach(f.workspace.id, 'bob', { channel: 'CNEW', agentId: replacement, expectedVersion: 1 });
      assert.equal(
        (await f.db.platform.query(`SELECT agent_id FROM ${f.table('tf_slack_channel_roots')} WHERE channel='CNEW'`))
          .rows[0].agent_id,
        agentId,
      );
      const prompt = await prompts.discover(f.workspace.id);
      assert.equal(prompt.length, 1);
      await prompts.process(prompt[0]);
      assert.equal(
        (await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_link_prompts')} WHERE event_id=$1`, [held]))
          .rows[0].state,
        'sent',
      );
      assert.equal(delivered.at(-1).channel, 'CNEW');
      assert.equal(delivered.at(-1).user, 'UCAROL');
      assert.equal(delivered.at(-1).text.includes('Original Carol request'), false);
      sessionUser = 'carol';
      const begin = await fetch(`${address}/v1/workspaces/${f.workspace.id}/slack/link`, {
        method: 'POST',
        headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: held }),
      });
      assert.equal(begin.status, 200);
      const url = new URL((await begin.json()).url),
        state = url.searchParams.get('state'),
        cookie = begin.headers.get('set-cookie').split(';')[0];
      oauth.set({ user: 'UCAROL', team: 'TTEST', nonce: url.searchParams.get('nonce') });
      assert.equal(
        (
          await fetch(`${address}/v1/slack/link/identity`, {
            method: 'POST',
            redirect: 'manual',
            headers: { cookie, origin: 'https://slack.com', 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ state, code: 'fixture' }),
          })
        ).status,
        303,
      );
      assert.equal(
        (await fetch(`${address}/v1/slack/link/consent?state=${state}`, { headers: { cookie }, redirect: 'manual' }))
          .status,
        302,
      );
      oauth.set({ user: 'UCAROL', team: 'TTEST' });
      assert.equal(
        (
          await fetch(`${address}/v1/slack/link/complete?state=${state}&code=fixture`, {
            headers: { cookie },
            redirect: 'manual',
          })
        ).status,
        200,
      );
      assert.equal(await execute(held), 'sent');
      assert.equal(delivered.at(-1).channel, 'DCAROL');
      assert.match(JSON.stringify(modelInputs.at(-1)), /You are the saved HR specialist/);
      const { Client } = await import('../../../apps/worker/node_modules/@temporalio/client/lib/index.js');
      const temporalClient = new Client({ connection: clientConnection });
      const workflowHistory = JSON.stringify(
        await temporalClient.workflow.getHandle(`slack-channel-agent-${f.workspace.id}-${held}`).fetchHistory(),
      );
      for (const secret of ['PRIVATE ANSWER', 'Original Carol request', 'xoxp-', 'synthetic-signing-secret'])
        assert.equal(workflowHistory.includes(secret), false);
      await f.runtime.transaction(f.workspace.id, commonCompatibility, async tx => {
        await assert.rejects(
          tx.client.query(`UPDATE ${f.table('tf_slack_channel_roots')} SET agent_id=$1`, [replacement]),
          error => error.code === '42501',
        );
      });
      await assert.rejects(
        f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
          tx.client.query(
            `UPDATE ${f.table('tf_slack_agent_branches')} SET dm_root='999.000001' WHERE dm_channel='DALICE'`,
          ),
        ),
        /immutable/,
      );
      const soulFixture = await createSoulAgentFixture({
        runtime: f.runtime,
        owner: f.db.platform,
        table: f.table,
        workspaceId: f.workspace.id,
        createdBy: f.workspace.userId,
      });
      try {
        const every = randomUUID(),
          actor = { kind: 'human', userId: f.workspace.userId, membershipId: f.workspace.membershipId };
        const saved = await soulFixture.save(f.workspace.id, actor, every, teamId, {
          ...definition,
          name: 'Every HR',
          responseRule: 'every-message',
        });
        const store = createAgentStore(f.runtime);
        await store.configure(f.workspace.id, actor, {
          agentId: every,
          version: await policyVersion(f.db.platform, f.table, every),
          enabled: true,
          teamIds: [],
          limits: [],
        });
        await store.activate(f.workspace.id, actor, { agentId: every, revision: saved.revision, scope: [] });
        for (const channel of ['CEVERY', 'CSECOND']) {
          await channels.attach(f.workspace.id, actor.userId, { channel, agentId: every, expectedVersion: 0 });
          const ts = channel === 'CEVERY' ? '10.000001' : '11.000001';
          messages.push({ user: 'UALICE', text: 'No tag needed', ts });
          const invocation = await event('UALICE', 'No tag needed', ts, undefined, channel);
          assert.equal(await execute(invocation), 'sent');
        }
        const { createSlackDirectMessages } = await import('../../slack/src/direct-messages.ts');
        const { createConversationExecutor } = await import('../../conversations/src/runtime.ts');
        const fresh = await event('UALICE', 'Fresh DM request', '12.000001', undefined, 'DALICE');
        const dm = createSlackDirectMessages({ runtime: f.runtime, appId: 'ATEST', cipher, fetcher });
        await dm.admitPending(f.workspace.id);
        const replies = createConversationExecutor(f.runtime, async input => {
          assert.deepEqual(input.messages, [{ role: 'user', text: 'Fresh DM request' }]);
          return { text: 'DEFAULT ANSWER', sources: [] };
        });
        const [work] = await replies.due(f.workspace.id);
        assert.equal(await replies.process(work), 'completed');
        assert.equal(await dm.process({ workspaceId: f.workspace.id, eventId: fresh }), 'sent');
        assert.equal(delivered.at(-1).text, 'DEFAULT ANSWER');
        const archivedSource = { installationId, generation: 1, channel: 'CEVERY', rootTs: '10.000001' };
        const { createChannelProvider } = await import('../../slack/src/channel-provider.ts');
        archived = true;
        await assert.rejects(
          f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
            createChannelProvider({ appId: 'ATEST', cipher, fetcher }).observe(
              tx,
              f.workspace.id,
              actor,
              archivedSource,
            ),
          ),
          error => error.constructor.name === 'AccessDenied',
        );
        archived = false;
        const noAccess = await channels.inspect(f.workspace.id, 'bob', 'CSECOND');
        assert.equal(noAccess.agentId, null);
        assert.equal(noAccess.version, 1);
        assert.deepEqual(
          await channels.attach(f.workspace.id, 'bob', {
            channel: 'CSECOND',
            agentId: replacement,
            expectedVersion: 1,
          }),
          { version: 2, channelResponses: false },
        );
        messages.push({ user: 'UALICE', text: 'Uncertain delivery request', ts: '13.000001' });
        const uncertain = await event('UALICE', 'Uncertain delivery request', '13.000001', undefined, 'CEVERY');
        loseAnswer = true;
        assert.equal(await execute(uncertain), 'unknown');
        loseAnswer = false;
        const count = delivered.length;
        assert.equal(await channels.process({ workspaceId: f.workspace.id, eventId: uncertain }), 'idle');
        assert.equal(delivered.length, count);
        const rootsBefore = (
          await f.db.platform.query(
            `SELECT id,agent_id,generation FROM ${f.table('tf_slack_channel_roots')} ORDER BY id`,
          )
        ).rows;
        await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET generation=2,bot_credential=$1`, [
          cipher.encrypt({ workspaceId: f.workspace.id, installationId, generation: 2, kind: 'bot' }, 'xoxb-renewed'),
        ]);
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_slack_channel_attachments')}(installation_id,generation,channel,agent_id)VALUES($1,2,'CHR',$2)`,
          [installationId, replacement],
        );
        const renewed = randomUUID();
        await f.runtime.transaction(f.workspace.id, commonCompatibility, async tx => {
          const payload = {
            type: 'message',
            channel: 'CHR',
            user: 'UBOB',
            ts: '20.000001',
            thread_ts: '1.000001',
            text: 'Continue original HR thread',
          };
          await tx.client.query(
            `INSERT INTO ${f.table('tf_slack_events')}(id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition)VALUES($1::uuid,$2,2,$1::text,'renewed',20,$3,'held')`,
            [renewed, installationId, payload],
          );
          assert.equal(
            (await channels.freeze(tx, renewed, payload, installationId, 2, f.workspace.id)).agent_id,
            agentId,
          );
        });
        assert.deepEqual(
          (
            await f.db.platform.query(
              `SELECT id,agent_id,generation FROM ${f.table('tf_slack_channel_roots')} WHERE generation=1 ORDER BY id`,
            )
          ).rows,
          rootsBefore,
        );
        assert.equal(
          (
            await f.db.platform.query(
              `SELECT agent_id FROM ${f.table('tf_slack_channel_roots')} WHERE generation=2 AND channel='CHR'`,
            )
          ).rows[0].agent_id,
          agentId,
        );
      } finally {
        await soulFixture.close();
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
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      await api.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await f.close();
    }
  });

import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { slackCredentialCipher } from '../../slack/src/index.ts';
import { slackUserCall, slackUserEffect, slackUserRead, slackUserRequest } from '../../slack/test/web-api-fixture.mjs';
import { createSlackActions, createSlackActionDecision } from '../src/slack-actions.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createFiles } from '../../files/dist/index.js';

/**
 * A workspace with a Slack installation, alice and bob linked to it, an HR destination on channel CHR and an agent that
 * may post there, with a fake Slack server behind `fetcher`. With `images`, Slack actions read generated images from an
 * in-memory Files store, and the fake server answers Slack's external file upload: `files` records each `files.*` call
 * and `uploads` each upload URL post. `bodies` keeps the body of every request sent to Slack.
 */
export async function outboundFixture({ channelName, prepareActors, images = false } = {}) {
  let actors;
  const f = await conversationFixture(
    undefined,
    prepareActors
      ? async db => {
          actors = await prepareActors(db);
          return { userId: actors.aliceUserId, close: actors.close };
        }
      : undefined,
  );
  const installationId = randomUUID(),
    agentId = randomUUID(),
    teamId = randomUUID(),
    activationId = randomUUID(),
    destinationId = randomUUID();
  const cipher = slackCredentialCipher({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } });
  const effects = [],
    cards = [],
    files = [],
    uploads = [],
    bodies = [];
  const users = [{ id: 'UBOB', name: 'bob', profile: { display_name: 'Bob' } }];
  let directoryResponse = method =>
    method === 'conversations.list'
      ? { channels: [{ id: 'CHR', name: 'slack-bot-test' }], response_metadata: { next_cursor: '' } }
      : { members: users, response_metadata: { next_cursor: '' } };
  let mode = 'success',
    audience = ['UALICE', 'UBOB', 'UGUEST', 'BOTHERBOT', 'UBOT'],
    messages = [{ user: 'UALICE', text: 'Shared request', ts: '1.000001' }];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/user/')) {
      const { method, params, authorization } = await slackUserRequest(req);
      assert.match(authorization, /^Bearer (?:xoxe\.)?xoxp-(alice|bob)$/);
      const read = slackUserRead(method, params, {
        channelName: () => channelName,
        audience: () => audience,
        messages: () => messages,
        directory: (name, args) => directoryResponse(name, args),
      });
      if (read) {
        res.end(JSON.stringify(read));
        return;
      }
      if (mode === 'retry') {
        res.writeHead(429, { 'retry-after': '1' }).end();
        return;
      }
      if (mode === 'auth') {
        res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
        return;
      }
      effects.push({ token: authorization, ...slackUserEffect(method, params) });
      if (mode === 'lost') {
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify({ ok: true, channel: params.channel, ts: '6.000001' }));
      return;
    }
    if (req.url.startsWith('/upload/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      uploads.push({ path: req.url.slice(7), headers: req.headers, bytes: Buffer.concat(chunks) });
      res.setHeader('content-type', 'text/plain');
      res.end(`OK - ${Buffer.concat(chunks).byteLength}`);
      return;
    }
    if (req.url.startsWith('/bot/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const method = req.url.slice(5);
      if (method.startsWith('files.')) {
        files.push({ token: req.headers.authorization, method, params });
        const n = files.filter(call => call.method === 'files.getUploadURLExternal').length;
        res.end(
          JSON.stringify(
            method === 'files.getUploadURLExternal'
              ? { ok: true, upload_url: `https://files.slack.com/upload/v1/U${n}`, file_id: `F000${n}` }
              : { ok: true, files: JSON.parse(params.files).map(file => ({ id: file.id, title: file.title })) },
          ),
        );
        return;
      }
      effects.push({ token: req.headers.authorization, ...slackUserEffect(req.url.slice(5), params) });
      res.end(JSON.stringify({ ok: true, channel: params.channel, ts: '7.000001' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/post') {
      cards.push(input);
      res.end(JSON.stringify({ ok: true, channel: input.channel, ts: '5.000001' }));
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
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const fetcher = (url, init) => {
    bodies.push(
      init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : String(init?.body ?? ''),
    );
    if (new URL(String(url)).hostname === 'files.slack.com')
      return fetch(`http://127.0.0.1:${server.address().port}/upload${new URL(String(url)).pathname}`, init);
    const method = slackUserCall(url, init),
      headers = new Headers(init?.headers);
    if (
      (headers.get('authorization') ?? '').startsWith('Bearer xoxb-') &&
      headers.get('content-type') === 'application/x-www-form-urlencoded'
    )
      return fetch(
        `http://127.0.0.1:${server.address().port}/bot/${new URL(String(url)).pathname.replace(/^\/api\//, '')}`,
        init,
      );
    return fetch(
      `http://127.0.0.1:${server.address().port}/${method ? `user/${method}` : String(url).endsWith('chat.postMessage') || String(url).endsWith('chat.update') ? 'post' : String(url).endsWith('conversations.open') ? 'open' : 'unknown'}`,
      init,
    );
  };
  const objects = new Map();
  const imageFiles = images
    ? createFiles(f.runtime, {
        putIfAbsent: async (key, value) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(value));
        },
        read: async key => objects.get(key),
        remove: async key => {
          objects.delete(key);
        },
      })
    : undefined;
  const settings = { appId: 'ATEST', cipher, outbound: true, fetcher, ...(imageFiles ? { images: imageFiles } : {}) };
  const service = createSlackActions({ ...settings, runtime: f.runtime });
  const decide = createSlackActionDecision({
    ...settings,
    runtime: f.runtime,
    resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
  });
  const executor = createAgentExecutor({
    runtime: f.runtime,
    slack: runtime => createSlackActions({ ...settings, runtime }),
  });
  const bob = { userId: actors ? actors.bobUserId : 'bob', membershipId: randomUUID() };
  const alice = { userId: f.workspace.userId, membershipId: f.workspace.membershipId };
  const tools = ['slack.message.send', 'slack.thread.reply', 'slack.reaction.add'];
  const scope = [{ assetId: destinationId, permissions: tools }];
  try {
    const bot = cipher.encrypt(
      { workspaceId: f.workspace.id, installationId, generation: 1, kind: 'bot' },
      'xoxb-fixture',
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TTEST','UBOT',1,'active',ARRAY['chat:write','im:write'],$2,0)`,
      [installationId, bot],
    );
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      bob.membershipId,
      bob.userId,
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'HR')`, [teamId]);
    for (const [actor, slackUserId, token] of [
      [alice, 'UALICE', 'alice'],
      [bob, 'UBOB', 'bob'],
    ]) {
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        actor.membershipId,
        teamId,
      ]);
      const id = randomUUID(),
        credential = cipher.encrypt(
          {
            workspaceId: f.workspace.id,
            installationId,
            generation: 1,
            kind: 'user',
            identityId: id,
            membershipId: actor.membershipId,
            slackUserId,
          },
          `xoxp-${token}`,
        );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,$3,$4,$5,'authorized',$6,ARRAY['channels:history','im:history','chat:write','reactions:write'])`,
        [id, installationId, slackUserId, actor.userId, actor.membershipId, credential],
      );
      // Slack use needs an explicit installation grant for each linked identity.
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [installationId, actor.membershipId],
      );
    }
    const definition = { name: 'HR', instructions: 'Help with HR', tools };
    const revision = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agents')} (id,enabled,owning_team_id,display_name,slack_approval) VALUES ($1,true,$2,'HR','direct')`,
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
      [command, agentId, alice.membershipId, alice.userId],
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
      `INSERT INTO ${f.table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage')`,
      [agentId, alice.membershipId],
    );
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
      agentId,
      teamId,
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,$4)`,
      [activationId, agentId, revision, JSON.stringify(scope)],
    );
    await f.db.platform.query(`INSERT INTO ${f.table('tf_agent_limits')} (agent_id,scope) VALUES ($1,$2)`, [
      agentId,
      JSON.stringify(scope),
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_destinations')} (id,installation_id,generation,channel,name,approval_required) VALUES ($1,$2,1,'CHR','HR',false)`,
      [destinationId, installationId],
    );
    for (const permission of tools)
      await f.db.platform.query(`INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
        teamId,
        destinationId,
        permission,
      ]);
    async function queue(actor = alice, tool = 'slack.message.send') {
      const { runId } = await executor.startDelegated(
        f.workspace.id,
        { kind: 'human', ...actor },
        { activationId, scope },
      );
      const callId = randomUUID(),
        call =
          tool === 'slack.message.send'
            ? { tool, destinationId, text: 'Approved HR update' }
            : tool === 'slack.thread.reply'
              ? { tool, destinationId, threadTs: '1.000001', text: 'Thread update' }
              : { tool, destinationId, messageTs: '1.000001', reaction: 'white_check_mark' };
      await executor.queueCall(f.workspace.id, { kind: 'human', ...actor }, { runId, callId, sequence: 0, call });
      return { ids: { workspaceId: f.workspace.id, runId, callId }, call };
    }
    // Recreates actions prepared before approval was removed, which stay decidable until they expire.
    async function legacyApproval(enabled = true) {
      if (!enabled) {
        await f.db.platform.query(`DROP TRIGGER IF EXISTS legacy_slack_approval ON ${f.table('tf_slack_actions')}`);
        return;
      }
      await f.db.platform.query(
        `CREATE OR REPLACE FUNCTION ${f.table('legacy_slack_approval')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.approval_required := true; RETURN NEW; END $$`,
      );
      await f.db.platform.query(
        `CREATE OR REPLACE TRIGGER legacy_slack_approval BEFORE INSERT ON ${f.table('tf_slack_actions')} FOR EACH ROW EXECUTE FUNCTION ${f.table('legacy_slack_approval')}()`,
      );
    }
    return {
      ...f,
      settings,
      legacyApproval,
      setDirectoryResponse: value => {
        directoryResponse = value;
      },
      service,
      decide,
      executor,
      queue,
      alice,
      bob,
      agentId,
      teamId,
      destinationId,
      installationId,
      activationId,
      scope,
      effects,
      cards,
      files,
      uploads,
      bodies,
      imageFiles,
      setMode: value => {
        mode = value;
      },
      setAudience: value => {
        audience = value;
      },
      setMessages: value => {
        messages = value;
      },
      close: async () => {
        await new Promise(resolve => server.close(resolve));
        await f.close();
      },
    };
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    await f.close();
    throw error;
  }
}

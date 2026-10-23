import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createProjects } from '@tulipfarm/conversations/projects';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { workspaceMcpFactory } from '../dist/workspace-mcp-composition.js';
import { completionReply, isCompletionRequest, anthropicText, isTitleRequest } from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

const mcp = (enabled = false) =>
  workspaceMcpFactory({
    admissionEnabled: enabled,
    dispatchEnabled: enabled,
    keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
    protocol: {
      discover: async () => {
        throw new Error('Unexpected MCP discovery');
      },
      call: async () => {
        throw new Error('Unexpected MCP call');
      },
    },
  });

function model(t) {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isTitleRequest(body)) return Response.json(anthropicText('Hello'));
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    requests.push(body);
    return Response.json(anthropicText('Your chat is working.'));
  });
  return requests;
}

const hello = (f, userId, chatId) =>
  f.store.send(f.workspace.id, userId, chatId, {
    messageId: randomUUID(),
    commandId: randomUUID(),
    model: 'claude-sonnet',
    parts: [{ kind: 'text', text: 'Hello' }],
  });

async function projectChat(f) {
  const w = f.workspace,
    member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() },
    projectId = randomUUID(),
    chatId = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member.membershipId,
    member.userId,
  ]);
  const projects = createProjects(f.runtime);
  await projects.create(w.id, w.userId, { id: projectId, name: 'Launch' });
  await projects.member(w.id, w.userId, projectId, {
    membershipId: member.membershipId,
    role: 'member',
    removed: false,
  });
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID(), projectId });
  const sent = await hello(f, member.userId, chatId);
  return { actor: member, chatId, turnId: sent.turnId };
}

async function legacySlackDm(f) {
  const w = f.workspace,
    q = (sql, values) => f.db.platform.query(sql, values);
  const installationId = randomUUID(),
    identityId = randomUUID(),
    eventId = randomUUID(),
    chatId = randomUUID();
  await q(
    `INSERT INTO ${f.table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TONE','UBOT',1,'active',ARRAY['chat:write'],'{}',0)`,
    [installationId],
  );
  await q(
    `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,'UPERSON',$3,$4,'authorized','{}',ARRAY['im:history'])`,
    [identityId, installationId, w.userId, w.membershipId],
  );
  await q(
    `INSERT INTO ${f.table('tf_slack_events')} (id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition) VALUES ($1,$2,1,'event-1','message:DONE:1.000001',123,$3,'held')`,
    [
      eventId,
      installationId,
      JSON.stringify({ type: 'message', user: 'UPERSON', channel: 'DONE', ts: '1.000001', text: 'Hello' }),
    ],
  );
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  await q(
    `INSERT INTO ${f.table('tf_slack_dm_roots')} (conversation_id,identity_id,installation_id,generation,channel,root_ts) VALUES ($1,$2,$3,1,'DONE','1.000001')`,
    [chatId, identityId, installationId],
  );
  const sent = await hello(f, w.userId, chatId);
  await q(`INSERT INTO ${f.table('tf_slack_dm_events')} (event_id,conversation_id,turn_id) VALUES ($1,$2,$3)`, [
    eventId,
    chatId,
    sent.turnId,
  ]);
  return { actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId }, chatId, turnId: sent.turnId };
}

const ownedChat = async f => {
  const chatId = randomUUID();
  await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
  return {
    actor: { kind: 'human', userId: f.workspace.userId, membershipId: f.workspace.membershipId },
    chatId,
    turnId: (await hello(f, f.workspace.userId, chatId)).turnId,
  };
};

const origins = {
  'private owner': { create: ownedChat, versions: [44, 61, 62, 63, 79, 'current'] },
  'project non-owner': { create: projectChat, versions: [74, 'current'] },
  'legacy Slack DM': { create: legacySlackDm, versions: [74, 'current'] },
};

for (const [name, origin] of Object.entries(origins))
  for (const version of origin.versions)
    test(`${name} chat completes at common version ${version} with MCP rollout controls disabled`, async t => {
      const f = await conversationFixture(version === 'current' ? undefined : stream => stream.slice(0, version));
      t.after(() => f.close());
      const requests = model(t);
      const chat = await origin.create(f);
      const work = { workspaceId: f.workspace.id, conversationId: chat.chatId, turnId: chat.turnId, generation: 0 };
      assert.equal(
        await createConversationActivities(f.runtime, undefined, undefined, mcp()).processConversationReply(work),
        'completed',
      );
      const history = await f.store.history(f.workspace.id, chat.actor.userId, chat.chatId);
      assert.equal(history.messages[0].turn.status, 'completed');
      assert.equal(history.messages[1].parts[0].text, 'Your chat is working.');
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0].tools.some(tool => tool.name.startsWith('mcp_')),
        false,
        'disabled MCP exposes no MCP tools',
      );
    });

test('project non-owners and legacy Slack DMs cannot execute custom MCP calls', async () => {
  const f = await conversationFixture();
  try {
    for (const create of [projectChat, legacySlackDm]) {
      const chat = await create(f);
      const context = {
        workspaceId: f.workspace.id,
        actor: chat.actor,
        origin: { kind: 'private-chat', conversationId: chat.chatId, turnId: chat.turnId, stepId: randomUUID() },
      };
      for (const enabled of [false, true]) {
        const port = mcp(enabled)(f.runtime);
        await assert.rejects(
          port.execute(context, randomUUID(), { tool: 'mcp.call', handle: 'any', arguments: {} }),
          AccessDenied,
        );
        await assert.rejects(port.execute(context, randomUUID(), { tool: 'mcp.search', query: 'any' }), AccessDenied);
      }
      await assert.rejects(mcp(true)(f.runtime).catalog(context), AccessDenied);
      assert.deepEqual(await mcp(false)(f.runtime).catalog(context), {
        model: { discovery: false, tools: [] },
        sources: [],
      });
    }
  } finally {
    await f.close();
  }
});

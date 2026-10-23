import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGoogleKnowledge, createSlackKnowledge, withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { createKnowledgeTools } from '../src/knowledge-tools-composition.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversations } from '../../../packages/conversations/src/index.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
} from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

const respond = decision => Response.json(anthropicChat(decision));
const ROOT = '1767225600.000100';

async function sync(service, workspaceId, sourceId, table, db, name) {
  for (let i = 0; i < 20; i++) {
    await db.platform.query(`UPDATE ${table(name)} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`, [
      sourceId,
    ]);
    const work = (await service.due(workspaceId)).find(item => item.sourceId === sourceId);
    if (!work) return;
    if ((await service.process(work)).disposition === 'ready') return;
  }
  assert.fail('bounded sync did not complete');
}

// The worker chat composition answers from Google Drive and Slack sources synced through their
// own adapters, using the same eligibility gate as search.
test('chat answers from an indexed Google Drive file and a Slack channel thread', { timeout: 300000 }, async t => {
  const f = await conversationFixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  t.after(useModelCatalog());
  try {
    const w = f.workspace;
    const table = name => f.table(name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
    f.store = createConversations(withKnowledgeSourceAuthorization(f.runtime));

    const driveBinding = {
      integrationId: randomUUID(),
      accountId: 'owner-account',
      generation: 1,
      requiredScopes: ['https://www.googleapis.com/auth/drive'],
    };
    await f.db.platform.query(
      `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,1,'connected',$4,'owner@example.test',$5,'{}')`,
      [driveBinding.integrationId, w.userId, w.membershipId, driveBinding.accountId, driveBinding.requiredScopes],
    );
    const driveFile = () => ({
      nativeId: 'refund-doc',
      title: 'Refund policy',
      canonicalURL: 'https://drive.google.com/file/d/refund-doc',
      sourceRevision: '1',
      accessedAt: new Date().toISOString(),
      kind: 'file',
      mediaType: 'text/plain',
      parentIds: ['my-drive-real-id'],
      coverage: 'supported',
    });
    const google = createGoogleKnowledge({
      runtime: f.runtime,
      provider: {
        discover: async () => ({ binding: driveBinding, items: [], nextCursor: null }),
        inspectSelection: async (_w, _u, selection) => ({
          binding: driveBinding,
          selection,
          title: 'My Drive (all files)',
        }),
        list: async () => ({ observations: [driveFile()], nextCursor: null }),
        check: async () => driveFile(),
        read: async () => {
          const o = driveFile();
          return {
            ...o,
            bytes: Buffer.from('Refunds are issued within 14 days of a returned order.'),
            filename: 'refund-policy.txt',
            normalizedContent: null,
            metadataBefore: o,
            metadataAfter: o,
          };
        },
      },
    });
    const drive = await google.configure(w.id, w.userId, {
      commandId: randomUUID(),
      selection: { kind: 'drive-folder', folderId: 'my-drive-real-id' },
      memberIds: [],
    });
    await sync(google, w.id, drive.sourceId, table, f.db, 'google_sources');

    const installationId = randomUUID(),
      identityId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'AAPP','TTEAM','UBOT',1,'active','{chat:write}','{}',0)`,
      [installationId],
    );
    await f.db.platform.query(
      `INSERT INTO ${table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,'UOWNER',$3,$4,'authorized','{}',$5)`,
      [
        identityId,
        installationId,
        w.userId,
        w.membershipId,
        [
          'channels:history',
          'channels:read',
          'groups:history',
          'groups:read',
          'im:history',
          'im:read',
          'mpim:history',
          'mpim:read',
        ],
      ],
    );
    const slackBinding = {
      installationId,
      installationGeneration: 1,
      identityId,
      slackUserId: 'UOWNER',
      teamId: 'TTEAM',
    };
    const thread = () => ({
      nativeId: `CSUPPORT:${ROOT}`,
      conversationId: 'CSUPPORT',
      ts: ROOT,
      title: '#support thread',
      canonicalURL: `https://app.slack.com/client/TTEAM/CSUPPORT/thread/CSUPPORT-${ROOT}`,
      sourceRevision: '1',
      accessedAt: new Date().toISOString(),
      coverage: 'supported',
    });
    const slack = createSlackKnowledge({
      runtime: f.runtime,
      provider: {
        discover: async () => ({ binding: slackBinding, items: [], nextCursor: null }),
        inspectSelection: async () => ({
          binding: slackBinding,
          title: '#support',
          conversations: [{ conversationId: 'CSUPPORT', kind: 'public', title: '#support' }],
        }),
        access: async () => ({
          conversationId: 'CSUPPORT',
          kind: 'public',
          title: '#support',
          accessedAt: new Date().toISOString(),
          member: true,
          archived: false,
        }),
        list: async () => ({ observations: [thread()], nextCursor: null }),
        read: async () => ({
          ...thread(),
          markdown:
            '# Thread\n\n## Message by UOWNER at 2026-01-01T00:00:00.000Z\n\nThe warehouse outage was caused by a failed conveyor motor.\n',
        }),
      },
    });
    const channel = await slack.configure(w.id, w.userId, {
      commandId: randomUUID(),
      selection: {
        kind: 'channels',
        conversationIds: ['CSUPPORT'],
        after: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      },
      memberIds: [],
    });
    await sync(slack, w.id, channel.sourceId, table, f.db, 'slack_sources');

    const knowledge = createKnowledgeTools({ runtime: f.runtime, env: {} });
    const requests = [];
    const plan = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Knowledge question'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      requests.push(body);
      return respond(plan.shift()(JSON.stringify(body.messages)));
    });
    async function ask(text, steps) {
      plan.push(...steps);
      const chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text }],
      });
      assert.equal(
        await createConversationActivities(
          f.runtime,
          undefined,
          undefined,
          undefined,
          undefined,
          knowledge,
        ).processConversationReply({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      return f.store.history(w.id, w.userId, chatId);
    }

    const driveHistory = await ask('How fast do we issue refunds?', [
      () => ({ kind: 'tool', call: { tool: 'knowledge.search', query: 'refunds', kind: 'google' } }),
      messages => {
        assert.match(messages, /within 14 days of a returned order/);
        assert.match(messages, /Refund policy/);
        return { kind: 'answer', text: 'Refunds are issued within 14 days.' };
      },
    ]);
    assert.deepEqual(
      driveHistory.messages[0].tools.map(({ tool, status }) => [tool, status]),
      [['knowledge.search', 'completed']],
    );
    assert.equal(driveHistory.messages[1].parts[0].text, 'Refunds are issued within 14 days.');

    const slackHistory = await ask('What caused the warehouse outage?', [
      () => ({ kind: 'tool', call: { tool: 'knowledge.search', query: 'warehouse outage', kind: 'slack' } }),
      messages => {
        assert.match(messages, /failed conveyor motor/);
        return { kind: 'answer', text: 'A failed conveyor motor caused it.' };
      },
    ]);
    assert.equal(slackHistory.messages[1].parts[0].text, 'A failed conveyor motor caused it.');
    assert.match(
      requests[0].tools.find(tool => tool.name === 'knowledge_search').description,
      /Prefer knowledge.retrieve/,
    );
    assert.ok(requests[0].tools.some(tool => tool.name === 'knowledge_retrieve'));
  } finally {
    await f.close();
  }
});

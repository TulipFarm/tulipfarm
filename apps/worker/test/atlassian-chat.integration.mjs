import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '../../../packages/access/dist/index.js';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { createConversations } from '../../../packages/conversations/src/index.ts';
import { createChatTools, discoverTools, frameworkCallSchema, parseToolCall } from '@tulipfarm/agents/tools';
import { agentDefinitionSchema, toolCallSchema } from '@tulipfarm/agents/contracts';
import {
  operationFixture,
  bindings,
  boardId,
  listId,
  cardId,
  card,
  cloudId,
  toolNames,
} from '../../../packages/atlassian/test/operation-fixture.mjs';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
  toolResults,
} from './native-chat-fixture.mjs';

async function chatFixture(t) {
  const f = await operationFixture();
  t.after(() => f.close());
  const env = {
    ANTHROPIC_API_KEY: 'synthetic-model-key',
    INTEGRATION_CREDENTIAL_KEY_ID: f.keyring.activeKeyId,
    INTEGRATION_CREDENTIAL_KEY: f.keyring.keys.test,
    INTEGRATION_CREDENTIAL_PREVIOUS_KEYS: '{}',
    ATLASSIAN_MCP_TRUSTED_BINDINGS: JSON.stringify(bindings),
  };
  for (const [protocol, prefix] of [
    ['trello', 'TRELLO'],
    ['atlassian-mcp', 'ATLASSIAN_MCP'],
    ['atlassian-rest', 'ATLASSIAN_REST'],
  ]) {
    const config = f.configurations[protocol];
    Object.assign(env, {
      [`${prefix}_CLIENT_ID`]: config.clientId,
      [`${prefix}_CLIENT_SECRET`]: config.clientSecret,
      [`${prefix}_REDIRECT_URI`]: config.redirectUri,
      [`${prefix}_SCOPES`]: config.scopes.join(' '),
    });
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const requests = [];
  let choose = () => ({ kind: 'answer', text: 'Finished.' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) !== 'https://api.anthropic.com/v1/messages') return f.providerFetch(url, init);
    const request = JSON.parse(init.body);
    if (isTitleRequest(request)) return Response.json(anthropicText('Provider source'));
    if (isCompletionRequest(request)) return Response.json(completionReply('anthropic'));
    requests.push(request);
    return Response.json(anthropicChat(await choose(request)));
  });
  const store = createConversations(f.runtime);
  async function run(calls, onResult = () => {}, text = 'Use my selected provider source.') {
    let index = 0;
    const outputs = [];
    choose = async request => {
      if (index > 0) {
        const content = toolResults(request).at(-1);
        const output = JSON.parse(content.slice(content.indexOf(': ') + 2));
        outputs.push(output);
        await onResult(output, index - 1);
      }
      if (index < calls.length) {
        const call = typeof calls[index] === 'function' ? calls[index](outputs) : calls[index];
        index++;
        return { kind: 'tool', call };
      }
      return { kind: 'answer', text: 'Finished. Review the saved proposal and receipt in Integrations.' };
    };
    const chatId = randomUUID();
    await store.create(f.one.id, f.member.userId, { chatId, commandId: randomUUID() });
    const sent = await store.send(f.one.id, f.member.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text }],
    });
    const work = { workspaceId: f.one.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    const status = await createConversationActivities(f.runtime).processConversationReply(work);
    const receipts = (
      await f.db.platform.query(
        `SELECT id,tool,status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 ORDER BY sequence`,
        [sent.turnId],
      )
    ).rows;
    const results = (
      await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
        sent.turnId,
      ])
    ).rows;
    return { status, outputs, receipts, results, work };
  }
  return { ...f, store, run, requests };
}

test('revoked Atlassian source blocks reading and saving its ordinary-worker derived draft', async t => {
  const f = await chatFixture(t);
  const accountId = await f.connect('trello', 'business', f.one.userId);
  await f.service.setGrants(f.one.id, f.one.userId, accountId, {
    expectedVersion: 1,
    memberIds: [f.member.membershipId],
    teamIds: [],
  });
  const source = await f.operations.createSource(f.one.id, f.member.userId, {
    name: 'Draft source',
    accountId,
    binding: { kind: 'trello', boardId },
  });
  const run = await f.run([
    { tool: 'atlassian.read', sourceId: source.id, operation: { kind: 'card.read', cardId } },
    outputs => ({
      tool: 'skills.draft',
      skillId: randomUUID(),
      input: {
        expectedVersion: 0,
        definition: {
          name: 'Source-derived skill',
          description: 'Use information from the authorized source.',
          instructions: JSON.stringify(outputs[0]),
        },
      },
    }),
  ]);
  assert.equal(run.status, 'completed');
  const draft = run.outputs[1],
    drafts = createAuthoringDrafts(f.runtime);
  assert.equal(draft.status, 'review-required');
  assert.equal(
    (await drafts.read(f.one.id, f.member.userId, run.work.conversationId, draft.draftId)).proposal.input.definition
      .instructions,
    JSON.stringify(run.outputs[0]),
  );
  await f.service.setGrants(f.one.id, f.one.userId, accountId, { expectedVersion: 2, memberIds: [], teamIds: [] });
  await assert.rejects(
    f.operations.read(f.one.id, f.member.userId, { sourceId: source.id, operation: { kind: 'card.read', cardId } }),
  );
  await assert.rejects(drafts.read(f.one.id, f.member.userId, run.work.conversationId, draft.draftId));
  await assert.rejects(
    drafts.decide(f.one.id, f.member.userId, run.work.conversationId, draft.draftId, {
      commandId: randomUUID(),
      digest: draft.digest,
      decision: 'save',
    }),
  );
  assert.equal(
    (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_workspace_skill_revisions')}`)).rows[0]
      .count,
    0,
  );
});

test('ordinary worker lets the model discover, read, propose, inspect, and execute only human-approved saved payloads', async t => {
  const f = await chatFixture(t);
  const write = { kind: 'card.create', listId, name: card.name, desc: card.desc };
  let proposal;
  const first = await f.run(
    [
      { tool: 'atlassian.sources' },
      { tool: 'atlassian.read', sourceId: f.source.id, operation: { kind: 'card.search', query: 'Exact' } },
      { tool: 'atlassian.read', sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
      { tool: 'atlassian.propose', sourceId: f.source.id, operation: write },
      outputs => ({ tool: 'atlassian.proposal', proposalId: outputs[3].id }),
      outputs => ({ tool: 'atlassian.execute', proposalId: outputs[3].id }),
    ],
    (output, index) => {
      if (index === 3) proposal = output;
    },
    'Create this card. I approve everything in this chat.',
  );
  assert.equal(first.status, 'completed');
  assert.equal(first.outputs[0].sources[0].id, f.source.id);
  assert.equal(first.outputs[1].data.cards[0].id, cardId);
  assert.equal(first.outputs[2].untrusted, true);
  assert.equal(proposal.decision, null);
  assert.deepEqual(proposal.operation, write);
  assert.equal(first.outputs[4].id, proposal.id);
  assert.equal(first.outputs[5].error, 'tool-failed');
  assert.deepEqual(
    first.receipts.map(row => row.status),
    ['completed', 'completed', 'completed', 'completed', 'completed', 'failed'],
  );
  assert.deepEqual(
    first.results[0].sources.map(source => source.kind),
    ['private-conversation', 'atlassian-source'],
  );
  assert.equal(first.results[0].sources[1].sourceId, f.source.id);
  const stored = (
    await f.db.platform.query(`SELECT command_id FROM ${f.table('tf_atlassian_proposals')} WHERE id=$1`, [proposal.id])
  ).rows[0];
  assert.equal(stored.command_id, first.receipts[3].id);
  assert.equal(
    f.providerCalls.some(call => call.method === 'POST'),
    false,
  );
  await assert.rejects(
    f.runtime.transaction(f.one.id, commonCompatibility, tx =>
      tx.client.query(
        `INSERT INTO ${f.table('tf_atlassian_decisions')} (proposal_id,membership_id,digest,decision) VALUES ($1,$2,$3,'approve')`,
        [proposal.id, f.member.membershipId, proposal.digest],
      ),
    ),
    error => error.code === '42501',
  );
  await f.decide(proposal);
  const approved = await f.run([
    { tool: 'atlassian.execute', proposalId: proposal.id },
    { tool: 'atlassian.proposal', proposalId: proposal.id },
  ]);
  assert.equal(approved.status, 'completed');
  assert.equal(approved.outputs[0].status, 'succeeded');
  assert.equal(approved.outputs[1].receipt.status, 'succeeded');
  assert.equal(f.providerCalls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(f.providerCalls.find(call => call.method === 'POST').body), {
    idList: listId,
    name: card.name,
    desc: card.desc,
  });
  const replay = await f.run([{ tool: 'atlassian.execute', proposalId: proposal.id }]);
  assert.equal(replay.outputs[0].status, 'succeeded');
  assert.equal(f.providerCalls.filter(call => call.method === 'POST').length, 1);
  assert.match(JSON.stringify(f.requests[0]), /atlassian.sources/);
  const exposed = JSON.stringify({
    requests: f.requests,
    history: await f.store.history(f.one.id, f.member.userId, first.work.conversationId),
  });
  for (const secret of ['synthetic-access-token', 'synthetic-refresh-token', 'test-secret', f.keyring.keys.test])
    assert.equal(exposed.includes(secret), false);
});

test('ordinary model-selected worker covers all provider operations through bounded transports', async t => {
  const f = await chatFixture(t);
  const mcpAccount = await f.connect('atlassian-mcp');
  const jira = await f.operations.createSource(f.one.id, f.member.userId, {
    name: 'Jira',
    accountId: mcpAccount,
    binding: { kind: 'jira', cloudId },
  });
  const confluence = await f.operations.createSource(f.one.id, f.member.userId, {
    name: 'Confluence',
    accountId: mcpAccount,
    binding: { kind: 'confluence', cloudId },
  });
  const restAccount = await f.connect('atlassian-rest');
  await f.db.platform.query(`UPDATE ${f.table('tf_atlassian_accounts')} SET resources=$2 WHERE id=$1`, [
    restAccount,
    JSON.stringify([{ id: cloudId, name: 'Test site', url: 'https://example.atlassian.net', scopes: ['read:me'] }]),
  ]);
  const trash = await f.operations.createSource(f.one.id, f.member.userId, {
    name: 'Trash',
    accountId: restAccount,
    binding: { kind: 'confluence-trash', cloudId, spaceId: '456' },
  });
  const operations = [
    { kind: 'jira.search', jql: 'project = OPS' },
    { kind: 'jira.read', issueIdOrKey: 'OPS-1' },
    { kind: 'jira.create', projectKey: 'OPS', issueTypeName: 'Task', summary: 'Exact' },
    { kind: 'jira.update', issueIdOrKey: 'OPS-1', fields: { summary: 'Exact' } },
    { kind: 'jira.delete', issueIdOrKey: 'OPS-1' },
    { kind: 'confluence.search', cql: 'type = page' },
    { kind: 'confluence.read', id: '123' },
    { kind: 'confluence.create', spaceKey: 'OPS', title: 'Exact', body: '<p>Text</p>', representation: 'storage' },
    {
      kind: 'confluence.update',
      id: '123',
      title: 'Exact',
      body: '<p>Text</p>',
      representation: 'storage',
      version: 2,
    },
    { kind: 'confluence.trash', pageId: '123' },
    { kind: 'card.search', query: 'Exact' },
    { kind: 'card.read', cardId },
    { kind: 'card.create', listId, name: card.name },
    { kind: 'card.update', cardId, changes: { name: 'Exact' } },
    { kind: 'card.delete', cardId },
  ];
  for (const operation of operations)
    await t.test(operation.kind, async () => {
      const sourceId = operation.kind.startsWith('jira.')
        ? jira.id
        : operation.kind === 'confluence.trash'
          ? trash.id
          : operation.kind.startsWith('confluence.')
            ? confluence.id
            : f.source.id;
      const read = operation.kind.endsWith('.read') || operation.kind.endsWith('.search');
      const calls = [{ tool: read ? 'atlassian.read' : 'atlassian.propose', sourceId, operation }];
      if (!read) calls.push(outputs => ({ tool: 'atlassian.execute', proposalId: outputs[0].id }));
      const result = await f.run(calls, async (output, index) => {
        if (!read && index === 0) await f.decide(output);
      });
      assert.equal(result.status, 'completed');
      assert.equal(read ? result.outputs[0].untrusted : result.outputs[1].status, read ? true : 'succeeded');
      assert.ok(
        result.results[0].sources.some(source => source.kind === 'atlassian-source' && source.sourceId === sourceId),
      );
      if (toolNames[operation.kind]) {
        const call = f.providerCalls
          .filter(call => call.url.includes('mcp.atlassian.com'))
          .map(call => JSON.parse(call.body))
          .filter(call => call.method === 'tools/call')
          .at(-1);
        assert.equal(call.params.name, toolNames[operation.kind]);
        assert.equal(call.params.arguments.cloudId, cloudId);
      }
    });
});

test('worker blocks read-side writes, missing configuration, and uncertain replay', async t => {
  const f = await chatFixture(t);
  await t.test('read rejects a write before provider dispatch', async () => {
    const result = await f.run([
      { tool: 'atlassian.read', sourceId: f.source.id, operation: { kind: 'card.delete', cardId } },
    ]);
    assert.equal(result.receipts[0].status, 'failed');
    assert.equal(result.outputs[0].error, 'tool-failed');
    assert.equal(f.providerCalls.length, 0);
  });
  await t.test('missing worker keyring is actionable and contains no secrets', async () => {
    delete process.env.INTEGRATION_CREDENTIAL_KEY;
    const result = await f.run([{ tool: 'atlassian.sources' }]);
    assert.equal(result.outputs[0].error, 'atlassian-unavailable');
    assert.match(result.outputs[0].instruction, /worker credential keyring/);
    assert.equal(
      result.results[0].sources.some(source => source.kind === 'unknown'),
      false,
    );
    process.env.INTEGRATION_CREDENTIAL_KEY = f.keyring.keys.test;
  });
  await t.test('missing OAuth configuration fails closed', async () => {
    delete process.env.TRELLO_CLIENT_SECRET;
    const result = await f.run([
      { tool: 'atlassian.read', sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
    ]);
    assert.equal(result.receipts[0].status, 'failed');
    assert.equal(f.providerCalls.length, 0);
    process.env.TRELLO_CLIENT_SECRET = f.configurations.trello.clientSecret;
  });
  await t.test('unreviewed MCP configuration cannot dispatch an operation', async () => {
    const accountId = await f.connect('atlassian-mcp');
    const source = await f.operations.createSource(f.one.id, f.member.userId, {
      name: 'Unreviewed Jira',
      accountId,
      binding: { kind: 'jira', cloudId },
    });
    delete process.env.ATLASSIAN_MCP_TRUSTED_BINDINGS;
    const result = await f.run([
      { tool: 'atlassian.sources' },
      { tool: 'atlassian.read', sourceId: source.id, operation: { kind: 'jira.read', issueIdOrKey: 'OPS-1' } },
    ]);
    assert.equal(result.outputs[0].mcp.enabled, false);
    assert.equal(result.receipts[1].status, 'failed');
    assert.equal(f.providerCalls.length, 0);
    process.env.ATLASSIAN_MCP_TRUSTED_BINDINGS = JSON.stringify(bindings);
  });
  await t.test('model-selected forged approval cannot reach a tool or provider', async () => {
    const result = await f.run([{ tool: 'atlassian.execute', proposalId: randomUUID(), decision: 'approve' }]);
    assert.equal(result.status, 'retry');
    assert.deepEqual(result.receipts, []);
    assert.deepEqual(result.results, []);
    assert.equal(f.providerCalls.length, 0);
  });
  await t.test('uncertain provider write is never replayed by a new worker or turn', async () => {
    let proposal;
    f.setProvider(async (_url, init) => {
      if (init.method === 'POST') throw new Error('synthetic-access-token');
    });
    const result = await f.run(
      [
        {
          tool: 'atlassian.propose',
          sourceId: f.source.id,
          operation: { kind: 'card.create', listId, name: 'Maybe created' },
        },
        outputs => ({ tool: 'atlassian.execute', proposalId: outputs[0].id }),
      ],
      async (output, index) => {
        if (index === 0) {
          proposal = output;
          await f.decide(output);
        }
      },
    );
    assert.deepEqual(result.outputs[1], { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' });
    const count = f.providerCalls.length;
    const replay = await f.run([
      { tool: 'atlassian.execute', proposalId: proposal.id },
      { tool: 'atlassian.proposal', proposalId: proposal.id },
    ]);
    assert.equal(replay.outputs[0].status, 'outcome-unknown');
    assert.equal(replay.outputs[1].receipt.status, 'outcome-unknown');
    assert.equal(f.providerCalls.length, count);
    assert.equal(await createConversationActivities(f.runtime).processConversationReply(result.work), 'idle');
    assert.equal(f.providerCalls.length, count);
    assert.equal(JSON.stringify(f.requests).includes('synthetic-access-token'), false);
  });
});

test('worker rechecks live authority and preserves membership incarnation across provider I/O', async t => {
  const f = await chatFixture(t);
  const accountId = await f.connect('trello', 'business', f.one.userId);
  await f.service.setGrants(f.one.id, f.one.userId, accountId, {
    expectedVersion: 1,
    memberIds: [f.member.membershipId],
    teamIds: [],
  });
  const source = await f.operations.createSource(f.one.id, f.member.userId, {
    name: 'Business',
    accountId,
    binding: { kind: 'trello', boardId },
  });
  await t.test('revocation after read suppresses provider output', async () => {
    let revoked = false;
    f.setProvider(async () => {
      if (!revoked) {
        revoked = true;
        await f.service.setGrants(f.one.id, f.one.userId, accountId, {
          expectedVersion: 2,
          memberIds: [],
          teamIds: [],
        });
      }
    });
    const result = await f.run([
      { tool: 'atlassian.read', sourceId: source.id, operation: { kind: 'card.read', cardId } },
    ]);
    assert.equal(result.outputs[0].error, 'tool-failed');
    assert.equal(result.receipts[0].status, 'failed');
    assert.equal(revoked, true);
    assert.equal(JSON.stringify(f.requests).includes(card.name), false);
    f.setProvider(undefined);
    await f.service.setGrants(f.one.id, f.one.userId, accountId, {
      expectedVersion: 3,
      memberIds: [f.member.membershipId],
      teamIds: [],
    });
  });
  await t.test('revocation during preflight prevents write dispatch', async () => {
    f.setProvider(async url => {
      if (url.includes('/lists/'))
        await f.service.setGrants(f.one.id, f.one.userId, accountId, {
          expectedVersion: 4,
          memberIds: [],
          teamIds: [],
        });
    });
    const result = await f.run(
      [
        {
          tool: 'atlassian.propose',
          sourceId: source.id,
          operation: { kind: 'card.create', listId, name: 'No write' },
        },
        outputs => ({ tool: 'atlassian.execute', proposalId: outputs[0].id }),
      ],
      async (output, index) => {
        if (index === 0) await f.decide(output);
      },
    );
    assert.equal(result.outputs[1].error, 'access-denied');
    assert.equal(f.providerCalls.filter(call => call.method === 'POST').length, 0);
    f.setProvider(undefined);
  });
  await t.test('generation changes during read discard results', async () => {
    f.setProvider(async () => {
      await f.service.disconnect(f.one.id, f.member.userId, f.accountId);
    });
    const result = await f.run([
      { tool: 'atlassian.read', sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
    ]);
    assert.equal(result.outputs[0].error, 'tool-failed');
    f.setProvider(undefined);
    const started = await f.service.reconnect(f.one.id, f.member.userId, 'test-session', f.accountId);
    await f.service.complete('code', new URL(started.url).searchParams.get('state'), 'test-session', f.member.userId);
  });
  await t.test(
    'revocation after a dispatched write discards the result and retains a non-replayable receipt',
    async () => {
      let proposal;
      f.setProvider(async (_url, init) => {
        if (init.method === 'POST') await f.service.disconnect(f.one.id, f.member.userId, f.accountId);
      });
      const result = await f.run(
        [
          {
            tool: 'atlassian.propose',
            sourceId: f.source.id,
            operation: { kind: 'card.create', listId, name: 'Dispatch then revoke' },
          },
          outputs => ({ tool: 'atlassian.execute', proposalId: outputs[0].id }),
        ],
        async (output, index) => {
          if (index === 0) {
            proposal = output;
            await f.decide(output);
          }
        },
      );
      assert.equal(result.outputs[1].error, 'tool-failed');
      const receipt = (
        await f.db.platform.query(
          `SELECT status,result FROM ${f.table('tf_atlassian_receipts')} WHERE proposal_id=$1`,
          [proposal.id],
        )
      ).rows[0];
      assert.deepEqual(receipt, { status: 'outcome-unknown', result: null });
      assert.equal(f.providerCalls.filter(call => call.method === 'POST').length, 1);
      f.setProvider(undefined);
      const started = await f.service.reconnect(f.one.id, f.member.userId, 'test-session', f.accountId);
      await f.service.complete('code', new URL(started.url).searchParams.get('state'), 'test-session', f.member.userId);
      const count = f.providerCalls.length;
      const replay = await f.run([{ tool: 'atlassian.execute', proposalId: proposal.id }]);
      assert.equal(replay.outputs[0].status, 'outcome-unknown');
      assert.equal(f.providerCalls.length, count);
    },
  );
  await t.test('removed and replaced member cannot finish the old turn or use new authority', async () => {
    const actor = { kind: 'human', ...f.member };
    f.setProvider(async () => {
      await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        f.member.membershipId,
      ]);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        f.member.userId,
      ]);
    });
    const result = await f.run([
      { tool: 'atlassian.read', sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
    ]);
    assert.equal(result.status, 'stale');
    assert.equal(result.outputs.length, 0);
    assert.equal(result.results.length, 0);
    assert.equal(
      (
        await f.db.platform.query(`SELECT status FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
          result.work.turnId,
        ])
      ).rows[0].status,
      'blocked',
    );
    assert.equal(result.receipts[0].status, 'blocked');
    f.setProvider(undefined);
    const replacementAccount = await f.connect();
    const replacementSource = await f.operations.createSource(f.one.id, f.member.userId, {
      name: 'Replacement member source',
      accountId: replacementAccount,
      binding: { kind: 'trello', boardId },
    });
    const tools = createChatTools(f.runtime, { atlassian: f.operations });
    const context = { workspaceId: f.one.id, actor, callId: randomUUID() };
    const count = f.providerCalls.length;
    for (const call of [
      { tool: 'atlassian.sources' },
      { tool: 'atlassian.read', sourceId: replacementSource.id, operation: { kind: 'card.read', cardId } },
      {
        tool: 'atlassian.propose',
        sourceId: replacementSource.id,
        operation: { kind: 'card.create', listId, name: 'Forbidden' },
      },
    ])
      await assert.rejects(tools.invoke(context, parseToolCall(call, { kind: 'chat' })), AccessDenied);
    assert.equal(f.providerCalls.length, count);
  });
});

test('framework rejects forged approvals, credentials, command IDs, and unsupported saved-agent authority', () => {
  const sourceId = randomUUID(),
    proposalId = randomUUID();
  const proposal = { tool: 'atlassian.propose', sourceId, operation: { kind: 'card.create', listId, name: 'Exact' } };
  for (const call of [
    { ...proposal, commandId: randomUUID() },
    { ...proposal, actor: { kind: 'human' } },
    { ...proposal, accessToken: 'secret' },
    { ...proposal, operation: { ...proposal.operation, url: 'https://evil.test' } },
    { tool: 'atlassian.approve', proposalId },
    { tool: 'atlassian.execute', proposalId, decision: 'approve' },
    { tool: 'atlassian.execute', proposalId, operation: proposal.operation },
  ])
    assert.equal(frameworkCallSchema.safeParse(call).success, false);
  const names = discoverTools({ kind: 'chat' })
    .filter(tool => tool.name.startsWith('atlassian.'))
    .map(tool => tool.name);
  assert.deepEqual(names, [
    'atlassian.sources',
    'atlassian.read',
    'atlassian.propose',
    'atlassian.proposal',
    'atlassian.execute',
  ]);
  assert.deepEqual(discoverTools({ kind: 'agent', tools: names }), []);
  for (const tool of names) {
    const call = tool.endsWith('sources')
      ? { tool }
      : tool.endsWith('read')
        ? { tool, sourceId, operation: { kind: 'card.read', cardId } }
        : tool.endsWith('propose')
          ? proposal
          : { tool, proposalId };
    assert.throws(() => parseToolCall(call, { kind: 'agent', tools: names }), AccessDenied);
    assert.equal(toolCallSchema.safeParse(call).success, false);
    assert.equal(
      agentDefinitionSchema.safeParse({ name: 'Unsafe', instructions: 'Use a provider', tools: [tool] }).success,
      false,
    );
  }
});

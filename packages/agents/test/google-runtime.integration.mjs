import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createAgentChat } from '../src/chat.ts';
import { createChatTools, isExternalTool, parseToolCall } from '../src/tools.ts';
import { syntheticContinuity, syntheticModelBundle } from './continuity-fixture.mjs';
import { googleRuntimeFixture } from './google-fixture.mjs';

const read = { tool: 'google.read', operation: { kind: 'docs.documents.get', documentId: 'private-doc' } };
const propose = { tool: 'google.propose', operation: { kind: 'docs.documents.create', title: 'Owner approved' } };
const legacyOverwriteAppend = {
  tool: 'google.propose',
  operation: {
    kind: 'sheets.values.append',
    spreadsheetId: 'legacy-sheet',
    range: 'A1',
    values: [[1]],
    valueInputOption: 'RAW',
    insertDataOption: 'OVERWRITE',
  },
};

test('stored Google append OVERWRITE calls still parse through executor and chat reads', async () => {
  const f = await googleRuntimeFixture();
  try {
    const w = f.workspace.id,
      agent = await f.saveAgent();
    const run = await f.executor.startDelegated(w, f.member, { activationId: agent.activationId, scope: agent.scope });
    const ids = { workspaceId: w, runId: run.runId, callId: randomUUID() };
    await f.executor.queueCall(w, f.member, {
      runId: run.runId,
      callId: ids.callId,
      sequence: 0,
      call: legacyOverwriteAppend,
    });
    assert.equal(await f.executor.execute(ids), 'failed');
    const stored = await f.executor.readResult(ids, f.member);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.result.error, 'operation-unguarded-update');
    assert.match(stored.result.message, /in-place updates to Google originals are refused/);
    const chatId = randomUUID();
    await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
    const model = {
      ...syntheticContinuity(async () => ({ kind: 'tool', text: 'Stored legacy append.', call: read })),
      activeBundle: () => ({ bundle: syntheticModelBundle, activationRevision: 1 }),
      trustedBundle: () => syntheticModelBundle,
    };
    const chat = createAgentChat(f.runtime, model, undefined, f.factory);
    const turnId = randomUUID();
    await chat.submit(w, f.member.userId, agent.agentId, {
      id: turnId,
      activationId: agent.activationId,
      scope: agent.scope,
      prompt: 'Legacy append',
    });
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_chat_turns')} SET status='tool',decision=$2 WHERE id=$1`, [
      turnId,
      JSON.stringify({ kind: 'tool', text: 'Stored legacy append.', call: legacyOverwriteAppend }),
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_tool_calls')} (id,run_id,sequence,call,status,result) VALUES ($1,$1,0,$2,'failed',$3)`,
      [
        turnId,
        JSON.stringify(legacyOverwriteAppend),
        JSON.stringify({ provider: 'google-workspace', untrusted: true, error: 'operation-unguarded-update' }),
      ],
    );
    const result = await chat.read(w, f.member.userId, agent.agentId, turnId);
    assert.equal(result.status, 'tool');
    assert.deepEqual(result.call, legacyOverwriteAppend);
    assert.equal(result.execution.status, 'failed');
  } finally {
    await f.close();
  }
});

test('lost answer stops with its cause and keeps the Google proposal receipt without repeating actions', async () => {
  const f = await googleRuntimeFixture();
  try {
    const w = f.workspace.id,
      chatId = randomUUID();
    await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Read and propose a document.' }],
    });
    let proposal,
      attempts = 0;
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      attempts++;
      await executeTool(read.tool, true, context =>
        createChatTools(context.runtime, { google: f.factory }).invoke(context, read),
      );
      proposal = await executeTool(propose.tool, true, context =>
        createChatTools(context.runtime, { google: f.factory }).invoke(context, propose),
      );
      throw new Error('lost answer after completed proposal');
    });
    const work = { workspaceId: w, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    assert.equal(await executor.process(work), 'retry');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [sent.turnId],
    );
    assert.equal(await executor.process({ ...work, generation: 1 }), 'stale');
    const history = await f.store.history(w, f.member.userId, chatId);
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].turn.errorCode, 'transient-failure');
    assert.deepEqual(
      history.messages[0].tools.map(tool => [tool.tool, tool.status, tool.googleProposalId ?? null]),
      [
        ['google.read', 'completed', null],
        ['google.propose', 'completed', proposal.data.id],
      ],
    );
    assert.equal(attempts, 1);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_google_proposals')}`)).rows[0].count,
      1,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('a later "approved" reply carries the earlier proposal ID so the approved write executes', async () => {
  const f = await googleRuntimeFixture();
  try {
    const w = f.workspace.id,
      chatId = randomUUID();
    await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
    const first = await f.store.send(w, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Create a document called Owner approved.' }],
    });
    let proposal;
    const prepare = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      proposal = await executeTool(propose.tool, true, context =>
        createChatTools(context.runtime, { google: f.factory }).invoke(context, propose),
      );
      return { text: 'The document is prepared for your review.', sources: [{ kind: 'unknown' }] };
    });
    assert.equal(
      await prepare.process({ workspaceId: w, conversationId: chatId, turnId: first.turnId, generation: 0 }),
      'completed',
    );
    const prepared = await f.store.history(w, f.member.userId, chatId);
    assert.deepEqual(
      prepared.messages.flatMap(message => message.tools).map(tool => [tool.tool, tool.googleProposalId]),
      [['google.propose', proposal.data.id]],
    );
    await f.approve(w, f.member.userId, proposal.data.id, { digest: proposal.data.digest, decision: 'approve' });
    const second = await f.store.send(w, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'approved' }],
    });
    let context;
    const execute = createConversationExecutor(f.runtime, async ({ messages, executeTool }) => {
      context = messages;
      const proposalId = messages
        .map(message => message.text)
        .join('\n')
        .match(/^- ([0-9a-f-]{36}) /m)?.[1];
      const result = await executeTool('google.execute', true, tool =>
        createChatTools(tool.runtime, { google: f.factory }).invoke(tool, { tool: 'google.execute', proposalId }),
      );
      return { text: `Created ${result.data.result.data.documentId}.`, sources: [{ kind: 'unknown' }] };
    });
    assert.equal(
      await execute.process({ workspaceId: w, conversationId: chatId, turnId: second.turnId, generation: 0 }),
      'completed',
    );
    assert.ok(
      context.some(
        message =>
          message.role === 'user' &&
          message.text ===
            `Google proposals prepared earlier in this chat. The requester approves or rejects each one on its review card in this chat; never ask them for an ID. When the latest message asks to proceed, check with google.status, then run an approved one with google.execute.\n- ${proposal.data.id} docs.documents.create: approved, not executed`,
      ),
      JSON.stringify(context),
    );
    assert.equal(
      (await f.store.history(w, f.member.userId, chatId)).messages.at(-1).parts[0].text,
      'Created created-doc.',
    );
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    const third = await f.store.send(w, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'thanks' }],
    });
    const after = createConversationExecutor(f.runtime, async ({ messages }) => {
      context = messages;
      return 'You are welcome.';
    });
    assert.equal(
      await after.process({ workspaceId: w, conversationId: chatId, turnId: third.turnId, generation: 0 }),
      'completed',
    );
    assert.equal(
      context.some(message => message.text.startsWith('Google proposals prepared earlier')),
      false,
      'an executed proposal leaves the context',
    );
  } finally {
    await f.close();
  }
});

test('actual private chat and Google tools preserve owner, receipts, private lineage and separate approval', async () => {
  const f = await googleRuntimeFixture();
  try {
    const w = f.workspace.id,
      chatId = randomUUID();
    await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w, f.member.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Read my document and propose one.' }],
    });
    let proposal;
    const runtime = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      const result = await executeTool(read.tool, isExternalTool(read.tool), context =>
        createChatTools(context.runtime, { google: f.factory }).invoke(context, read),
      );
      assert.equal(result.data.data.title, 'Private document');
      proposal = await executeTool(propose.tool, isExternalTool(propose.tool), context =>
        createChatTools(context.runtime, { google: f.factory }).invoke(context, propose),
      );
      return {
        text: 'The document is private. The proposed write needs your approval.',
        sources: [{ kind: 'unknown' }],
      };
    });
    assert.equal(
      await runtime.process({ workspaceId: w, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    const receipts = (
      await f.db.platform.query(
        `SELECT id,tool,status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 ORDER BY sequence`,
        [sent.turnId],
      )
    ).rows;
    assert.deepEqual(
      receipts.map(({ tool, status }) => ({ tool, status })),
      [
        { tool: 'google.read', status: 'completed' },
        { tool: 'google.propose', status: 'completed' },
      ],
    );
    const tools = createChatTools(f.runtime, { google: f.factory });
    const context = { workspaceId: w, actor: f.member, callId: receipts[1].id };
    assert.equal((await tools.invoke(context, propose)).data.id, proposal.data.id);
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
          sent.turnId,
        ])
      ).rows[0].sources,
      [{ kind: 'private-conversation', conversationId: chatId }, { kind: 'unknown' }],
    );
    await assert.rejects(f.store.history(w, f.admin.userId, chatId), AccessDenied);
    assert.deepEqual(await tools.invoke(context, { tool: 'google.execute', proposalId: proposal.data.id }), {
      provider: 'google-workspace',
      untrusted: true,
      error: 'operation-approval-required',
    });
    await assert.rejects(
      f.approve(w, f.admin.userId, proposal.data.id, { digest: proposal.data.digest, decision: 'approve' }),
      AccessDenied,
    );
    await f.approve(w, f.member.userId, proposal.data.id, { digest: proposal.data.digest, decision: 'approve' });
    const completed = await tools.invoke(context, { tool: 'google.execute', proposalId: proposal.data.id });
    assert.equal(completed.data.status, 'succeeded');
    assert.equal(completed.data.result.data.documentId, 'created-doc');
    assert.deepEqual(await tools.invoke(context, { tool: 'google.execute', proposalId: proposal.data.id }), completed);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    for (const extra of [
      { userId: f.admin.userId },
      { commandId: randomUUID() },
      { token: 'forged' },
      { url: 'https://evil.test' },
    ])
      assert.throws(() => parseToolCall({ ...propose, ...extra }, { kind: 'chat' }));
    assert.throws(() => parseToolCall({ tool: 'google.approve', proposalId: proposal.data.id }, { kind: 'chat' }));
    const uncertain = await tools.invoke({ ...context, callId: randomUUID() }, propose);
    await f.approve(w, f.member.userId, uncertain.data.id, { digest: uncertain.data.digest, decision: 'approve' });
    f.failWrite();
    assert.equal(
      (await tools.invoke(context, { tool: 'google.execute', proposalId: uncertain.data.id })).data.status,
      'outcome-unknown',
    );
    assert.equal(
      (await tools.invoke(context, { tool: 'google.execute', proposalId: uncertain.data.id })).data.status,
      'outcome-unknown',
    );
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
  } finally {
    await f.close();
  }
});

test('private chat and delegated results expose missing integration and reconnect without granting authority', async () => {
  const f = await googleRuntimeFixture();
  try {
    const w = f.workspace.id,
      agent = await f.saveAgent();
    for (const [status, code] of [
      ['disconnected', 'integration-required'],
      ['reconnect-required', 'reconnect-required'],
    ]) {
      await f.db.platform.query(
        `UPDATE ${f.table('tf_google_integrations')} SET status=$1,credential=NULL WHERE id=$2`,
        [status, f.integration.integrationId],
      );
      const expected = { provider: 'google-workspace', untrusted: true, error: code };
      const chatId = randomUUID();
      await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w, f.member.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Read my document.' }],
      });
      const chat = createConversationExecutor(f.runtime, async ({ executeTool }) => {
        const result = await executeTool(read.tool, true, context =>
          createChatTools(context.runtime, { google: f.factory }).invoke(context, read),
        );
        assert.deepEqual(result, expected);
        return `Google ${result.error}`;
      });
      assert.equal(
        await chat.process({ workspaceId: w, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      const history = await f.store.history(w, f.member.userId, chatId);
      assert.equal(history.messages.at(-1).parts[0].text, `Google ${code}`);
      const run = await f.executor.startDelegated(w, f.member, {
        activationId: agent.activationId,
        scope: agent.scope,
      });
      const ids = { workspaceId: w, runId: run.runId, callId: randomUUID() };
      await f.executor.queueCall(w, f.member, { runId: run.runId, callId: ids.callId, sequence: 0, call: read });
      assert.equal(await f.executor.execute(ids), 'failed');
      assert.deepEqual(await f.executor.readResult(ids, f.member), { status: 'failed', result: expected });
      await assert.rejects(f.executor.readResult(ids, f.admin), AccessDenied);
    }
    const absent = await createChatTools(f.runtime, { google: f.factory }).invoke(
      { workspaceId: w, actor: f.admin, callId: randomUUID() },
      read,
    );
    assert.deepEqual(absent, { provider: 'google-workspace', untrusted: true, error: 'integration-required' });
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) SELECT $1,team_id FROM ${f.table('tf_agent_teams')} WHERE agent_id=$2`,
      [f.admin.membershipId, agent.agentId],
    );
    const missingRun = await f.executor.startDelegated(w, f.admin, {
      activationId: agent.activationId,
      scope: agent.scope,
    });
    const missingIds = { workspaceId: w, runId: missingRun.runId, callId: randomUUID() };
    await f.executor.queueCall(w, f.admin, {
      runId: missingRun.runId,
      callId: missingIds.callId,
      sequence: 0,
      call: read,
    });
    assert.equal(await f.executor.execute(missingIds), 'failed');
    assert.deepEqual(await f.executor.readResult(missingIds, f.admin), { status: 'failed', result: absent });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('saved-agent model and deterministic executor intersect selected tools, limits, live owner and run authority', async () => {
  const f = await googleRuntimeFixture();
  try {
    const w = f.workspace.id,
      agent = await f.saveAgent();
    const bundle = {
      ...syntheticModelBundle,
      routes: syntheticModelBundle.routes.map(route => ({ ...route, maxInputTokens: 200000 })),
    };
    const model = {
      ...syntheticContinuity(async () => ({ kind: 'tool', text: 'Reading privately.', call: read })),
      activeBundle: () => ({ bundle, activationRevision: 1 }),
      trustedBundle: () => bundle,
    };
    const chat = createAgentChat(f.runtime, model, undefined, f.factory);
    const id = randomUUID();
    await chat.submit(w, f.member.userId, agent.agentId, {
      id,
      activationId: agent.activationId,
      scope: agent.scope,
      prompt: 'Read the document.',
    });
    await chat.processTurn(w, id);
    const result = await chat.read(w, f.member.userId, agent.agentId, id);
    assert.equal(result.status, 'answered', JSON.stringify(result));
    assert.equal(result.execution.result.data.data.title, 'Private document');
    await assert.rejects(chat.read(w, f.admin.userId, agent.agentId, id), AccessDenied);
    const run = await f.executor.startDelegated(w, f.member, { activationId: agent.activationId, scope: agent.scope });
    const ids = { workspaceId: w, runId: run.runId, callId: randomUUID() };
    await f.executor.queueCall(w, f.member, { runId: run.runId, callId: ids.callId, sequence: 0, call: read });
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.equal((await f.executor.readResult(ids, f.member)).result.data.data.title, 'Private document');
    const restricted = await f.saveAgent(['google.status']);
    const restrictedRun = await f.executor.startDelegated(w, f.member, {
      activationId: restricted.activationId,
      scope: restricted.scope,
    });
    await assert.rejects(
      f.executor.queueCall(w, f.member, { runId: restrictedRun.runId, callId: randomUUID(), sequence: 0, call: read }),
      AccessDenied,
    );
    await f.executor.configure(w, f.admin, {
      agentId: agent.agentId,
      version: 1,
      enabled: true,
      teamIds: [],
      limits: [],
    });
    await assert.rejects(f.executor.readResult(ids, f.member), AccessDenied);
    const denied = { workspaceId: w, runId: run.runId, callId: randomUUID() };
    await f.executor.queueCall(w, f.member, { runId: run.runId, callId: denied.callId, sequence: 1, call: read });
    assert.equal(await f.executor.execute(denied), 'blocked');
    // Admin status grants no integration permissions, so an admin cannot sponsor scheduled use of a member's personal integration.
    await assert.rejects(
      f.executor.authorizeSchedule(w, f.admin, { activationId: agent.activationId, scope: agent.scope }),
      AccessDenied,
    );
    assert.equal(f.calls.length, 2);
    const fresh = await f.saveAgent();
    const oldOwner = await f.executor.startDelegated(w, f.member, {
      activationId: fresh.activationId,
      scope: fresh.scope,
    });
    const stale = { workspaceId: w, runId: oldOwner.runId, callId: randomUUID() };
    await f.executor.queueCall(w, f.member, { runId: oldOwner.runId, callId: stale.callId, sequence: 0, call: read });
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.member.membershipId,
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      randomUUID(),
      f.member.userId,
    ]);
    assert.equal(await f.executor.execute(stale), 'blocked');
    await assert.rejects(
      createChatTools(f.runtime, { google: f.factory }).invoke(
        { workspaceId: w, actor: f.member, callId: randomUUID() },
        read,
      ),
      AccessDenied,
    );
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

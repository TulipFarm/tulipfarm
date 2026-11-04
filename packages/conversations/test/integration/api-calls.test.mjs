import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createChatTools, frameworkCallSchema } from '../../../agents/src/tools.ts';
import { decideApiCall, resumeApiCall, viewApiCall } from '../../../api-calls/dist/index.js';
import { routes, server } from '../../../api-calls/test/https-fixture.mjs';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

const change = {
  tool: 'api.request',
  method: 'POST',
  url: 'https://api.example.test/created',
  body: { kind: 'json', value: { email: 'ana@example.test' } },
};

test('a chat change waits for approval, is sent once and resumes the reply', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    api = await server(t, routes),
    chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Create the customer' }],
  });
  const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
  const replies = [];
  let resumes = 0;
  const executor = createConversationExecutor(
    f.runtime,
    async input => {
      replies.push(input);
      if (replies.length > 1) return { text: 'Created the customer.', sources: [] };
      const call = frameworkCallSchema.parse(change);
      await input.executeTool(
        call.tool,
        true,
        context => createChatTools(context.runtime, { apiApprovals: true }).invokeWithSources(context, call),
        [],
        call,
      );
      return { text: 'unreachable', sources: [] };
    },
    ...Array(10).fill(undefined),
    async context => {
      resumes++;
      const resumed = await resumeApiCall(context.runtime, context.workspaceId, context.callId, {
        dependencies: api.options().dependencies,
      });
      return resumed.state === 'waiting' ? resumed : { ...resumed, sources: [] };
    },
  );
  const turn = async () =>
    (
      await f.db.platform.query(`SELECT status, error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
        sent.turnId,
      ])
    ).rows[0];

  await executor.process(work);
  assert.deepEqual(await turn(), { status: 'waiting', error_code: 'api-call-waiting' });
  assert.equal(api.received.length, 0);
  const callId = (
    await f.db.platform.query(`SELECT id FROM ${f.table('tf_api_calls')} WHERE turn_id=$1`, [sent.turnId])
  ).rows[0].id;

  assert.equal(await executor.process(work), 'idle');
  assert.equal(resumes, 1);
  assert.equal(api.received.length, 0);

  const view = await f.runtime.transaction(w.id, commonCompatibility, tx => viewApiCall(tx, actor, callId));
  await withMaintenanceTransaction({
    workspaceId: w.id,
    connectionString: f.db.login(w, 'confirmation'),
    capability: 'confirmation',
    operation: tx =>
      decideApiCall(tx, actor, callId, { commandId: randomUUID(), decision: 'approve', digest: view.digest }),
  });
  await executor.process(work);
  assert.equal(api.received.length, 1);
  assert.equal(api.received[0].method, 'POST');
  const step = (
    await f.db.platform.query(`SELECT output FROM ${f.table('tf_conversation_execution_steps')} WHERE call_id=$1`, [
      callId,
    ])
  ).rows[0];
  assert.equal(step.output.result.status, 'sent');

  await executor.process(work);
  assert.equal((await turn()).status, 'completed');
  assert.equal(replies.length, 2);
  assert.equal(api.received.length, 1);
});

test('a change in a chat without approvals is refused before it is stored', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Create the customer' }],
  });
  let outcome;
  const executor = createConversationExecutor(f.runtime, async input => {
    const call = frameworkCallSchema.parse(change);
    outcome = await input.executeTool(
      call.tool,
      true,
      context => createChatTools(context.runtime, { telemetryRuntime: 'slack' }).invokeWithSources(context, call),
      [],
      call,
    );
    return { text: 'Changes need approval in the app.', sources: [] };
  });
  await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
  assert.equal(outcome.result.code, 'approval-unavailable');
  assert.equal((await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_api_calls')}`)).rowCount, 0);
});

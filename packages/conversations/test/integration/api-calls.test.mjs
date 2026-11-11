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
import { inferWithTools } from '../../../agents/src/inference.ts';
import { ownServiceRefusal } from '../../../agents/src/own-service.ts';
import {
  completionReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  toolResults,
  useCall,
} from '../../../agents/test/native-fixture.mjs';

const change = {
  tool: 'api.request',
  method: 'POST',
  url: 'https://api.example.test/created',
  body: { kind: 'json', value: { email: 'ana@example.test' } },
};

test(
  'own-service recovery instructions stay out of saved activity and visible refusal text',
  { timeout: 60000 },
  async t => {
    const previous = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = 'https://app.tulipfarm.ai';
    t.after(() => {
      if (previous === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = previous;
    });
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Read my current plan.' }],
    });
    const call = frameworkCallSchema.parse({
      tool: 'api.request',
      method: 'GET',
      url: 'https://api.tulipfarm.ai/v1/plans',
    });
    let rounds = 0;
    let modelResult;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply('azure'));
      if (rounds++ === 0) return Response.json(nativeReply('azure', { calls: [useCall(call)] }));
      modelResult = toolResults('azure', body)[0].output;
      return Response.json(nativeReply('azure', { text: ownServiceRefusal.message }));
    });
    const executor = createConversationExecutor(f.runtime, async input => {
      const answer = await inferWithTools(
        { ...nativeRoutes.azure, model: 'grok-4.3' },
        input.messages,
        async (call, activity) =>
          (
            await input.executeTool(
              call.tool,
              true,
              async () => ({ result: structuredClone(ownServiceRefusal), sources: [] }),
              [],
              call,
              activity,
            )
          ).result,
      );
      return { text: answer.text, sources: [] };
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    assert.equal(rounds, 2);
    assert.match(modelResult, /Available built-in tools: plans_create/);
    assert.match(modelResult, /Call tools_search/);
    const [saved] = (
      await f.db.platform.query(`SELECT output FROM ${f.table('tf_conversation_execution_steps')} WHERE turn_id=$1`, [
        sent.turnId,
      ])
    ).rows;
    assert.deepEqual(saved.output.result, ownServiceRefusal);
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.equal(history.messages.at(-1).parts[0].text, ownServiceRefusal.message);
    assert.equal(history.messages.flatMap(message => message.tools).length, 1);
    const visible = history.messages.flatMap(message => [
      ...message.parts.filter(part => part.kind === 'text').map(part => part.text),
      ...message.tools.flatMap(tool => [tool.presentation.label, tool.detail ?? '']),
    ]);
    assert.doesNotMatch(
      visible.join('\n'),
      /plans_create|plans_read|plans_update|tools_search|Available built-in tools/,
    );
  },
);

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

test(
  'denied API addresses end in a completed reply after three calls, without model retries',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'List my projects.' }],
    });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      assert.ok(++requests <= 3, 'no final model request or automatic retry is needed');
      return Response.json(
        nativeReply('azure', {
          calls: [useCall({ tool: 'api.request', method: 'GET', url: `https://localhost/projects/${requests}` })],
        }),
      );
    });
    const executor = createConversationExecutor(f.runtime, async input => {
      const answer = await inferWithTools(
        { ...nativeRoutes.azure, model: 'grok-4.3' },
        input.messages,
        async (call, activity) =>
          (
            await input.executeTool(
              call.tool,
              true,
              context => createChatTools(context.runtime).invokeWithSources(context, call),
              [],
              call,
              activity,
            )
          ).result,
        undefined,
        false,
        null,
        input,
      );
      return { text: answer.text, sources: [] };
    });
    const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    assert.equal(await executor.process(work), 'completed');
    assert.equal(await executor.process(work), 'idle');
    const turn = (
      await f.db.platform.query(
        `SELECT status,error_code,attempts FROM ${f.table('tf_conversation_turns')} WHERE id=$1`,
        [sent.turnId],
      )
    ).rows[0];
    assert.deepEqual(turn, { status: 'completed', error_code: null, attempts: 1 });
    assert.equal(requests, 3);
    assert.equal(
      (
        await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1`, [
          sent.turnId,
        ])
      ).rowCount,
      3,
    );
    assert.equal((await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_api_calls')}`)).rowCount, 0);
  },
);

test(
  'refused API attempts share fifty activity slots across retries; a new turn gets a fresh limit',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const send = () =>
      f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Read the next pages.' }],
      });
    const sent = await send();
    let attempts = 0,
      dispatched = 0;
    const executor = createConversationExecutor(
      f.runtime,
      async input => {
        attempts++;
        const request = async () => {
          const call = frameworkCallSchema.parse({
            tool: 'api.request',
            method: 'GET',
            url: `https://localhost/pages/${dispatched}`,
          });
          return input.executeTool(
            call.tool,
            true,
            async context => {
              dispatched++;
              return createChatTools(context.runtime).invokeWithSources(context, call);
            },
            [],
            call,
          );
        };
        if (attempts === 1) {
          for (let i = 0; i < 25; i++) assert.equal((await request()).result.code, 'address-denied');
          throw new Error('Temporary interruption');
        }
        if (attempts === 2) {
          assert.equal(input.priorCalls, 25);
          assert.equal(input.priorToolResults.length, 25);
          assert.ok(input.priorToolResults.every(step => step.output.code === 'address-denied'));
          for (let i = 0; i < 25; i++) assert.equal((await request()).result.code, 'address-denied');
          assert.equal((await request()).result.code, 'call-limit');
        } else assert.equal((await request()).result.code, 'address-denied');
        return { text: 'Some pages could not be read.', sources: [] };
      },
      ...Array(10).fill(undefined),
      async () => assert.fail('No API change is waiting for approval'),
    );
    const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    assert.equal(await executor.process(work), 'retry');
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp() WHERE id=$1`, [
      sent.turnId,
    ]);
    assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
    assert.equal(dispatched, 50);
    assert.equal(
      (
        await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1`, [
          sent.turnId,
        ])
      ).rowCount,
      50,
    );
    const next = await send();
    assert.equal(await executor.process({ ...work, turnId: next.turnId }), 'completed');
    assert.equal(dispatched, 51);
  },
);

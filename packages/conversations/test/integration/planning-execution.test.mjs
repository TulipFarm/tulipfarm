import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chatSkills } from '../../../agents/src/chat-skills.ts';
import { conversationPlanning, createChatTools, frameworkCallSchema } from '../../../agents/src/tools.ts';
import { createAgentPlans } from '../../../agents/src/plans.ts';
import { createPlanRuntime } from '../../../agents/src/plan-runtime.ts';
import { createConversations } from '../../src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

const boundaryPlan = {
  title: 'Check table inventory',
  planning: {
    requirements: [{ key: 'inventory', description: 'Tables checked', tasks: ['inspect'] }],
    prerequisites: [],
    verificationTask: 'verify',
  },
  tasks: [
    { key: 'inspect', title: 'Inspect tables', criteria: ['Inventory checked'], assignee: { kind: 'coordinator' } },
    {
      key: 'verify',
      title: 'Verify result',
      criteria: ['Request met'],
      dependsOn: ['inspect'],
      assignee: { kind: 'coordinator' },
    },
  ],
};

test('a confirmed Slack action resumes the same plan instead of ending its reply', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID(),
      store = createConversations(f.runtime, chatSkills);
    await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Send a notice, then verify the setup.' }],
    });
    let calls = 0,
      slices = 0,
      actionId;
    const executor = createConversationExecutor(
      f.runtime,
      async input => {
        const invoke = value => {
          const call = frameworkCallSchema.parse(value);
          return input.executeTool(
            call.tool,
            false,
            context => createChatTools(context.runtime).invokeWithSources(context, call),
            [],
            call,
          );
        };
        if (++slices === 1) {
          const { result: plan } = await invoke({ tool: 'plans.create', ...boundaryPlan });
          await invoke({ tool: 'plans.claim', planId: plan.planId, task: 'inspect', expectedVersion: plan.version });
          await input.executeTool(
            'slack.message.send',
            true,
            async context => {
              calls++;
              actionId = context.callId;
              return { result: { provider: 'slack', status: 'pending', id: actionId }, sources: [] };
            },
            [],
            { tool: 'slack.message.send' },
          );
        } else {
          assert.ok(input.messages.some(message => message.text.includes(actionId) && message.text.includes('sent')));
          await invoke({ tool: 'tables.list' });
        }
        return { text: 'The remaining checks still need verification.', sources: [] };
      },
      undefined,
      async () => ({ id: actionId, status: 'sent' }),
      undefined,
      undefined,
      undefined,
      chatSkills,
      undefined,
      conversationPlanning,
    );
    const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
    assert.equal(await executor.process(work), 'idle');
    assert.equal(await executor.process(work), 'retry');
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::integer AS n FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`,
          [sent.turnId],
        )
      ).rows[0].n,
      0,
      'provider confirmation does not declare the whole plan finished',
    );
    assert.equal(await executor.process({ ...work, generation: 1 }), 'retry');
    assert.equal(calls, 1, 'the pending action is never sent again');
    assert.equal(slices, 2);
  } finally {
    await f.close();
  }
});

test('Pause, Stop, and newer messages fence business tools before the first claim', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      store = createConversations(f.runtime, chatSkills),
      plans = createAgentPlans(f.runtime);
    for (const action of ['pause', 'stop', 'new-message']) {
      const chatId = randomUUID();
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Check the tables.' }],
      });
      let writes = 0,
        planId;
      const executor = createConversationExecutor(
        f.runtime,
        async input => {
          const plan = await plans.create(w.id, w.userId, chatId, randomUUID(), boundaryPlan, sent.turnId);
          planId = plan.id;
          if (action === 'new-message')
            await store.send(w.id, w.userId, chatId, {
              commandId: randomUUID(),
              messageId: randomUUID(),
              parts: [{ kind: 'text', text: 'Stop, do not change anything.' }],
            });
          else
            await plans.control(w.id, w.userId, plan.id, {
              requestId: randomUUID(),
              action,
              expectedVersion: plan.version,
            });
          const result = await input.executeTool(
            'rows.create',
            false,
            async () => {
              writes++;
              return { result: {}, sources: [] };
            },
            [],
            { tool: 'rows.create' },
          );
          assert.equal(result.result.error, 'access-denied');
          return { text: 'Work is not complete.', sources: [] };
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        chatSkills,
        undefined,
        conversationPlanning,
      );
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
      assert.equal(writes, 0, `${action} prevents the business callback`);
      await createPlanRuntime(f.runtime).advance(w.id, planId);
      assert.equal((await plans.read(w.id, w.userId, planId)).lifecycle, action === 'stop' ? 'stopped' : 'paused');
    }
  } finally {
    await f.close();
  }
});

test(
  'MCP admission over the plan budget never dispatches or creates a phantom action wait',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID(),
        store = createConversations(f.runtime, chatSkills);
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Check the tables.' }],
      });
      let dispatched = 0;
      const executor = createConversationExecutor(
        f.runtime,
        async input => {
          const invoke = value => {
            const call = frameworkCallSchema.parse(value);
            return input.executeTool(
              call.tool,
              false,
              context => createChatTools(context.runtime).invokeWithSources(context, call),
              [],
              call,
            );
          };
          const { result: plan } = await invoke({ tool: 'plans.create', ...boundaryPlan });
          await f.db.platform.query(`UPDATE ${f.table('tf_agent_plans')} SET budget=$2 WHERE id=$1`, [
            plan.planId,
            { toolCalls: 1, activeMilliseconds: 10000, credits: 10 },
          ]);
          await invoke({ tool: 'plans.claim', planId: plan.planId, task: 'inspect', expectedVersion: plan.version });
          assert.equal(
            (await invoke({ tool: 'tables.list' })).result.error,
            undefined,
            'the last allowed call succeeds',
          );
          const denied = await input.executeTool(
            'mcp.call',
            true,
            async () => {
              dispatched++;
              return { result: {}, sources: [] };
            },
            [],
            { tool: 'mcp.call' },
          );
          assert.equal(denied.result.error, 'plan-budget');
          return { text: 'The plan budget was reached.', sources: [] };
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        chatSkills,
        undefined,
        conversationPlanning,
      );
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
      assert.equal(dispatched, 0);
      const turn = (
        await f.db.platform.query(`SELECT status,error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
          sent.turnId,
        ])
      ).rows[0];
      assert.notEqual(turn.error_code, 'mcp-action-waiting');
      assert.notEqual(turn.status, 'waiting');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 AND tool='mcp.call'`,
            [sent.turnId],
          )
        ).rows[0].status,
        'blocked',
      );
    } finally {
      await f.close();
    }
  },
);

test('new messages, Pause, and Stop wake a worker-waiting plan once', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    for (const action of ['new-message', 'pause', 'stop']) {
      const w = f.workspace,
        chatId = randomUUID(),
        store = createConversations(f.runtime, chatSkills);
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Research skills.' }],
      });
      let planId,
        slices = 0;
      const executor = createConversationExecutor(
        f.runtime,
        async () => {
          if (++slices === 1) {
            const created = await createAgentPlans(f.runtime).create(
              w.id,
              w.userId,
              chatId,
              randomUUID(),
              {
                ...boundaryPlan,
                specialists: [
                  {
                    key: 'reader',
                    name: 'Skill reader',
                    role: 'Read skills',
                    instructions: 'List the available skills.',
                    tools: ['skills.list'],
                  },
                ],
                tasks: [
                  { ...boundaryPlan.tasks[0], assignee: { kind: 'specialist', specialist: 'reader' } },
                  boundaryPlan.tasks[1],
                ],
              },
              sent.turnId,
            );
            planId = created.id;
          }
          return { text: 'The remaining work is not verified.', sources: [] };
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        chatSkills,
        undefined,
        conversationPlanning,
      );
      const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      await executor.process(work);
      assert.equal(
        (
          await f.db.platform.query(`SELECT error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
            sent.turnId,
          ])
        ).rows[0].error_code,
        'plan-worker-waiting',
      );
      let next;
      if (action === 'new-message') {
        const message = {
          commandId: randomUUID(),
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: 'Pause this and answer my question.' }],
        };
        next = await store.send(w.id, w.userId, chatId, message);
        assert.deepEqual(await store.send(w.id, w.userId, chatId, message), next);
      } else {
        const plans = createAgentPlans(f.runtime);
        const view = await plans.read(w.id, w.userId, planId);
        const command = { requestId: randomUUID(), expectedVersion: view.version, action };
        const controlled = await plans.control(w.id, w.userId, planId, command);
        assert.deepEqual(await plans.control(w.id, w.userId, planId, command), controlled);
      }
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::integer AS n FROM ${f.table('tf_conversation_outbox')} WHERE turn_id=$1 AND generation=1`,
            [sent.turnId],
          )
        ).rows[0].n,
        1,
      );
      await createPlanRuntime(f.runtime).advance(w.id, planId);
      assert.equal(
        (await createAgentPlans(f.runtime).read(w.id, w.userId, planId)).lifecycle,
        action === 'stop' ? 'stopped' : 'paused',
      );
      assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
      if (next) assert.equal(await executor.process({ ...work, turnId: next.turnId }), 'completed');
    }
  } finally {
    await f.close();
  }
});
test(
  'main-agent work resumes the same source turn without replaying actions or fabricating messages',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID(),
        store = createConversations(f.runtime, chatSkills);
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [
          { kind: 'skill', skillId: 'planning', revision: 'latest' },
          { kind: 'text', text: 'Inspect the existing tables and verify the result.' },
        ],
      });
      let slices = 0,
        planId,
        attemptId,
        evidence;
      const report = item => ({
        outcome: 'passed',
        summary: 'The table inventory was checked.',
        checks: [{ criterion: 0, outcome: 'passed', evidence: [item] }],
      });
      const executor = createConversationExecutor(
        f.runtime,
        async input => {
          const invoke = async value => {
            const call = frameworkCallSchema.parse(value);
            let receiptId;
            const output = await input.executeTool(
              call.tool,
              false,
              async context => {
                receiptId = context.callId;
                return createChatTools(context.runtime).invokeWithSources(context, call);
              },
              [],
              call,
            );
            assert.equal(output.result.error, undefined, JSON.stringify(output.result));
            return { ...output.result, receiptId };
          };
          if (++slices === 1) {
            const created = await invoke({
              tool: 'plans.create',
              title: 'Inspect tables',
              execution: 'execute',
              planning: {
                requirements: [{ key: 'inventory', description: 'Existing tables checked', tasks: ['inspect'] }],
                prerequisites: [],
                verificationTask: 'verify',
              },
              tasks: [
                {
                  key: 'inspect',
                  title: 'Inspect tables',
                  criteria: ['Inventory checked'],
                  assignee: { kind: 'coordinator' },
                },
                {
                  key: 'verify',
                  title: 'Verify result',
                  criteria: ['Original request met'],
                  dependsOn: ['inspect'],
                  assignee: { kind: 'coordinator' },
                },
              ],
            });
            planId = created.planId;
            const claimed = await invoke({
              tool: 'plans.claim',
              planId,
              task: 'inspect',
              expectedVersion: created.version,
            });
            attemptId = claimed.attemptId;
            const result = await invoke({ tool: 'tables.list' });
            evidence = { callId: result.receiptId, summary: 'Read existing tables.' };
            return { text: 'Inventory checked; verification is next.', sources: [] };
          }
          assert.equal(input.priorCalls, 3, 'the next slice retains the same durable allowance');
          assert.ok(input.messages.some(message => message.text.includes(attemptId)));
          assert.ok(input.messages.some(message => message.text.includes(evidence.callId)));
          const accepted = await invoke({ tool: 'plans.report', planId, attemptId, report: report(evidence) });
          const final = await invoke({
            tool: 'plans.claim',
            planId,
            task: 'verify',
            expectedVersion: accepted.version,
          });
          const checked = await invoke({ tool: 'tables.list' });
          const finalEvidence = { callId: checked.receiptId, summary: 'Read back the current table inventory.' };
          await invoke({
            tool: 'plans.report',
            planId,
            attemptId: final.attemptId,
            report: {
              ...report(finalEvidence),
              requirements: [{ key: 'inventory', outcome: 'passed', evidence: [finalEvidence] }],
            },
          });
          return { text: 'The inventory and original request are verified.', sources: [] };
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        chatSkills,
        undefined,
        conversationPlanning,
      );
      const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      assert.equal(await executor.process(work), 'retry');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::integer AS n FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`,
            [sent.turnId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
      assert.equal(slices, 2);
      assert.equal((await createAgentPlans(f.runtime).read(w.id, w.userId, planId)).lifecycle, 'completed');
      const history = await store.history(w.id, w.userId, chatId);
      assert.equal(history.messages.filter(message => message.author === 'human').length, 1);
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::integer AS n FROM ${f.table('tf_conversation_turns')} WHERE conversation_id=$1`,
            [chatId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::integer AS n FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 AND tool='tables.list'`,
            [sent.turnId],
          )
        ).rows[0].n,
        2,
      );
      const timed = (
        await f.db.platform.query(
          `SELECT s.call_id,s.plan_attempt_id,s.plan_milliseconds::text AS elapsed
      FROM ${f.table('tf_conversation_execution_steps')} s WHERE turn_id=$1 AND plan_attempt_id IS NOT NULL`,
          [sent.turnId],
        )
      ).rows;
      assert.equal(timed.length, 2, 'only the two business reads count toward task active time');
      assert.ok(timed.every(row => Number(row.elapsed) > 0));
      const before = (
        await f.db.platform.query(
          `SELECT sum(active_milliseconds)::text AS elapsed FROM ${f.table('tf_agent_plan_attempts')} WHERE plan_id=$1`,
          [planId],
        )
      ).rows[0].elapsed;
      await f.runtime.transaction(w.id, createPlanRuntime(f.runtime).compatibility, tx =>
        conversationPlanning.recordToolTime(tx, timed[0].call_id, 10000),
      );
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT sum(active_milliseconds)::text AS elapsed FROM ${f.table('tf_agent_plan_attempts')} WHERE plan_id=$1`,
            [planId],
          )
        ).rows[0].elapsed,
        before,
        'replayed time recording is idempotent',
      );
    } finally {
      await f.close();
    }
  },
);

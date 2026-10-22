import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversations } from '../../../packages/conversations/src/index.ts';
import { createConversationDispatch } from '../../../packages/conversations/src/dispatch.ts';
import { chatSkills } from '../../../packages/agents/src/chat-skills.ts';
import { createAgentPlans } from '../../../packages/agents/src/plans.ts';
import { createConversationActivities } from '../dist/conversation-activities.js';
import {
  anthropicChat,
  anthropicText,
  completionReply,
  isCompletionRequest,
  isTitleRequest,
} from './native-chat-fixture.mjs';
import { useModelFamilies } from './model-families-fixture.mjs';

test(
  'Planning survives worker restart and lost dispatch acknowledgement without repeated work or charges',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture(),
      w = f.workspace;
    const connection = await NativeConnection.connect({ address: process.env.TASK_TEST_TEMPORAL_ADDRESS });
    const clientConnection = await Connection.connect({ address: process.env.TASK_TEST_TEMPORAL_ADDRESS });
    const client = new Client({ connection: clientConnection }),
      taskQueue = randomUUID();
    const workflowsPath = fileURLToPath(new URL('../dist/workflows.js', import.meta.url));
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-only';
    t.after(useModelFamilies());
    let runtime = f.runtime,
      modelCalls = 0,
      lostAck = false;
    const chatId = randomUUID(),
      handles = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(new URL(url).hostname, 'api.anthropic.com');
      const request = JSON.parse(options.body);
      if (isTitleRequest(request)) return Response.json(anthropicText('Inspect table inventory'));
      if (isCompletionRequest(request)) return Response.json(completionReply('anthropic'));
      const step = modelCalls++;
      const plan = (
        await f.db.platform.query(`SELECT id,version FROM ${f.table('tf_agent_plans')} WHERE conversation_id=$1`, [
          chatId,
        ])
      ).rows[0];
      const attempt =
        plan &&
        (
          await f.db.platform.query(
            `SELECT id FROM ${f.table('tf_agent_plan_attempts')} WHERE plan_id=$1 AND settled_at IS NULL`,
            [plan.id],
          )
        ).rows[0];
      const checked = (
        await f.db.platform.query(
          `SELECT id FROM ${f.table('tf_conversation_tool_calls')} WHERE conversation_id=$1 AND tool='tables.list' AND status='completed' ORDER BY sequence DESC LIMIT 1`,
          [chatId],
        )
      ).rows[0];
      const evidence = checked ? [{ callId: checked.id, summary: 'Read the current table inventory.' }] : [];
      let call;
      if (step === 0)
        call = {
          tool: 'plans.create',
          title: 'Inspect table inventory',
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
              title: 'Verify the request',
              criteria: ['Original request met'],
              dependsOn: ['inspect'],
              assignee: { kind: 'coordinator' },
            },
          ],
        };
      else if (step === 1 || step === 5)
        call = {
          tool: 'plans.claim',
          planId: plan.id,
          expectedVersion: plan.version,
          task: step === 1 ? 'inspect' : 'verify',
        };
      else if (step === 2 || step === 6) call = { tool: 'tables.list' };
      else if (step === 4 || step === 7)
        call = {
          tool: 'plans.report',
          planId: plan.id,
          attemptId: attempt.id,
          report: {
            outcome: 'passed',
            summary: 'Inventory checked.',
            checks: [{ criterion: 0, outcome: 'passed', evidence }],
            ...(step === 7 ? { requirements: [{ key: 'inventory', outcome: 'passed', evidence }] } : {}),
          },
        };
      else {
        assert.ok(step === 3 || step === 8, `unexpected model step ${step}`);
        return Response.json(
          anthropicText(
            step === 3 ? 'The inventory is checked; final verification is next.' : 'The original request is verified.',
          ),
        );
      }
      return Response.json(anthropicChat({ kind: 'tool', call }));
    });
    try {
      const store = createConversations(runtime, chatSkills);
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-sonnet',
        parts: [
          { kind: 'skill', skillId: 'planning', revision: 'latest' },
          { kind: 'text', text: 'Inspect existing tables and verify the result.' },
        ],
      });
      const dispatch = () =>
        createConversationDispatch({
          runtime,
          start: async work => {
            const handle = await client.workflow.start('conversationReply', {
              workflowId: `planning-${work.turnId}-${work.generation}`,
              taskQueue,
              args: [work],
              workflowIdConflictPolicy: 'USE_EXISTING',
            });
            handles.push(handle);
            if (!lostAck) {
              lostAck = true;
              throw new Error('synthetic lost dispatch acknowledgement');
            }
          },
        })(w.id);
      for (let slice = 0; slice < 2; slice++) {
        const worker = await Worker.create({
          connection,
          taskQueue,
          workflowsPath,
          activities: createConversationActivities(runtime),
        });
        await worker.runUntil(async () => {
          if (slice === 0) await assert.rejects(dispatch(), /conversation-dispatch-incomplete/);
          else await dispatch();
          assert.equal(await handles.at(-1).result(), slice === 0 ? 'retry' : 'completed');
        });
        await Worker.runReplayHistory({ workflowsPath }, await handles.at(-1).fetchHistory());
        if (slice === 0) {
          await runtime.close();
          runtime = f.createRuntime();
        }
      }
      assert.equal(modelCalls, 9);
      assert.equal(handles.length, 2);
      const planId = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_agent_plans')} WHERE conversation_id=$1`, [chatId])
      ).rows[0].id;
      assert.equal((await createAgentPlans(runtime).read(w.id, w.userId, planId)).lifecycle, 'completed');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::integer AS n FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 AND tool='tables.list'`,
            [sent.turnId],
          )
        ).rows[0].n,
        2,
      );
      const billing = await f.db.platform.query(
        `SELECT id,flow_id,charged::text,reserved::text,plan_attempt_id FROM ${f.table('tf_credit_usage')} ORDER BY id`,
      );
      assert.ok(billing.rows.some(row => row.plan_attempt_id));
      assert.ok(billing.rows.filter(row => row.plan_attempt_id).every(row => row.flow_id === chatId));
      assert.equal(
        await createConversationActivities(runtime).processConversationReply({
          workspaceId: w.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 1,
        }),
        'idle',
      );
      assert.equal(modelCalls, 9, 'delivery replay makes no provider call');
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT id,flow_id,charged::text,reserved::text,plan_attempt_id FROM ${f.table('tf_credit_usage')} ORDER BY id`,
          )
        ).rows,
        billing.rows,
        'delivery replay creates no charge or hold',
      );
      assert.equal(
        (await createConversations(runtime, chatSkills).history(w.id, w.userId, chatId)).messages.filter(
          message => message.author === 'human',
        ).length,
        1,
      );
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      await clientConnection.close();
      await connection.close();
      if (runtime !== f.runtime) await runtime.close();
      await f.close();
    }
  },
);

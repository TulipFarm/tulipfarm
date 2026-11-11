import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chatSkills } from '../../../agents/src/chat-skills.ts';
import { conversationPlanning, createChatTools } from '../../../agents/src/tools.ts';
import { inferWithTools } from '../../../agents/src/inference.ts';
import {
  azureStreamReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  offeredTools,
  selectReply,
  use,
} from '../../../agents/test/native-fixture.mjs';
import { createAgentPlans } from '../../../agents/src/plans.ts';
import { createPlanRuntime } from '../../../agents/src/plan-runtime.ts';
import { createConversations } from '../../src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

test(
  'native planning creates a three-step draft and records only the planning activity',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    try {
      const w = f.workspace;
      const store = createConversations(f.runtime, chatSkills);
      const plans = createAgentPlans(f.runtime);
      const tasks = [
        { key: 'prepare', title: 'Prepare the release' },
        { key: 'review', title: 'Review the release' },
        { key: 'publish', title: 'Publish the release' },
      ];
      let round = 0;
      let streaming = false;
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const body = JSON.parse(init.body);
        if (isCompletionRequest(body))
          return Response.json(selectReply('azure', { status: 'completed', reason: 'The plan draft was saved.' }));
        assert.ok(offeredTools('azure', body).some(tool => tool.name === 'plans_create'));
        const reply = nativeReply(
          'azure',
          round++ % 2 === 0
            ? {
                calls: [
                  use(
                    'plans.create',
                    {
                      title: 'Launch checklist',
                      execution: 'plan-only',
                      tasks,
                      planning: {
                        requirements: [
                          {
                            key: 'launch',
                            description: 'Prepare, review and publish',
                            tasks: ['prepare'],
                          },
                        ],
                      },
                    },
                    'Saving your plan draft',
                  ),
                ],
              }
            : { text: 'Your plan draft is ready. No work has started.' },
        );
        return streaming ? azureStreamReply(reply) : Response.json(reply);
      });
      for (const model of ['grok-4.3', 'Kimi-K2.6'])
        for (const mode of ['plan', undefined])
          for (const stream of [false, true])
            for (let run = 0; run < 5; run++) {
              streaming = stream;
              const chatId = randomUUID();
              await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
              const sent = await store.send(w.id, w.userId, chatId, {
                commandId: randomUUID(),
                messageId: randomUUID(),
                ...(mode ? { mode } : {}),
                parts: [
                  { kind: 'text', text: 'Save a Launch checklist plan-only draft with Prepare, Review, Publish.' },
                ],
              });
              const executor = createConversationExecutor(
                f.runtime,
                async input => {
                  const result = await inferWithTools(
                    { ...nativeRoutes.azure, model },
                    input.messages,
                    async (call, activity, narration) => {
                      const output = await input.executeTool(
                        call.tool,
                        false,
                        context => createChatTools(context.runtime).invokeWithSources(context, call),
                        [],
                        call,
                        activity,
                        narration,
                      );
                      return output.result;
                    },
                    undefined,
                    false,
                    null,
                    { builtinSkills: input.builtinSkills },
                  );
                  return { text: result.text, sources: [] };
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
              assert.equal(
                await executor.process({
                  workspaceId: w.id,
                  conversationId: chatId,
                  turnId: sent.turnId,
                  generation: 0,
                }),
                'completed',
              );
              const [saved] = await plans.list(w.id, w.userId, chatId);
              const view = await plans.read(w.id, w.userId, saved.id);
              assert.equal(view.title, 'Launch checklist');
              assert.equal(view.lifecycle, 'draft');
              const persisted = await f.db.platform.query(
                `SELECT execution FROM ${f.table('tf_agent_plans')} WHERE id=$1`,
                [saved.id],
              );
              assert.equal(persisted.rows[0].execution, 'plan-only');
              assert.equal(view.canControl, true);
              assert.deepEqual(
                view.tasks
                  .filter(task => task.key !== view.planning.verificationTask)
                  .map(({ key, title }) => ({ key, title })),
                tasks,
              );
              assert.equal(view.tasks.length, 4);
              assert.equal(view.planning.requirements.length, 3);
              assert.ok(view.tasks.every(task => task.assignee.kind === 'coordinator' && task.criteria.length > 0));
              assert.deepEqual(await createPlanRuntime(f.runtime).step(w.id, saved.id), {
                kind: 'terminal',
                specialists: [],
              });
              const activity = await f.db.platform.query(
                `SELECT tool,status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1 ORDER BY sequence`,
                [sent.turnId],
              );
              assert.deepEqual(activity.rows, [{ tool: 'plans.create', status: 'completed' }]);
            }
    } finally {
      await f.close();
    }
  },
);

test(
  'Plan mode survives retry, loads Planning alongside a domain skill, and refuses writes at the executor',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID();
      const store = createConversations(f.runtime, chatSkills);
      await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        mode: 'plan',
        parts: [
          { kind: 'skill', skillId: 'table-authoring', revision: 'latest' },
          { kind: 'text', text: 'Plan an alert triage setup.' },
        ],
      });
      let attempts = 0,
        writes = 0,
        reads = 0,
        planId;
      const executor = createConversationExecutor(
        f.runtime,
        async input => {
          assert.equal(
            input.messages.filter(message => message.text.includes('"name":"Plan, execute, and verify work"')).length,
            1,
          );
          assert.ok(
            input.messages.some(message => message.text.includes('"name":"Propose business records for review"')),
          );
          assert.ok(input.messages.some(message => message.text.startsWith('Server-enforced Plan mode:')));
          assert.equal(
            input.sourceMessages.some(message => message.text.includes('Server-enforced')),
            false,
          );
          if (++attempts === 1) throw new Error('synthetic-transient-failure');
          const read = await input.executeTool(
            'agents.list',
            false,
            async () => {
              reads++;
              return { result: { agents: [] }, sources: [] };
            },
            [],
            { tool: 'agents.list' },
          );
          assert.deepEqual(read.result, { agents: [] });
          for (const call of [
            { tool: 'tables.propose', input: '{"plans":[]}' },
            { tool: 'plans.create', title: 'Do work now', execution: 'execute', tasks: [{ key: 'act', title: 'Act' }] },
            { tool: 'mcp.call', handle: 'untrusted-write', arguments: {} },
          ]) {
            const denied = await input.executeTool(
              call.tool,
              false,
              async () => {
                writes++;
                throw new Error('A business write must never run');
              },
              [],
              call,
            );
            assert.equal(denied.result.error, 'plan-only');
          }
          const call = {
            tool: 'plans.create',
            title: 'Alert triage',
            execution: 'plan-only',
            planning: {
              requirements: [{ key: 'triage', description: 'An active triage setup', tasks: ['agent'] }],
              prerequisites: [],
              verificationTask: 'verify',
            },
            tasks: [
              { key: 'agent', title: 'Set up agent', criteria: ['Agent active'], assignee: { kind: 'coordinator' } },
              {
                key: 'verify',
                title: 'Verify setup',
                criteria: ['Original request met'],
                assignee: { kind: 'coordinator' },
                dependsOn: ['agent'],
              },
            ],
          };
          const saved = await input.executeTool(
            call.tool,
            false,
            async context => {
              const { tool: _tool, ...body } = call;
              return {
                result: await createAgentPlans(context.runtime).create(
                  w.id,
                  w.userId,
                  chatId,
                  context.callId,
                  body,
                  sent.turnId,
                ),
                sources: [],
              };
            },
            [],
            call,
          );
          planId = saved.result.id;
          return { text: 'The plan is saved. No setup work has started.', sources: [] };
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
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET retry_at=clock_timestamp() WHERE id=$1`,
        [sent.turnId],
      );
      assert.equal(await executor.process({ ...work, generation: 1 }), 'completed');
      assert.equal(reads, 1);
      assert.equal(writes, 0);
      const history = await store.history(w.id, w.userId, chatId);
      assert.equal(history.messages[0].turn.mode, 'plan');
      assert.deepEqual(
        history.messages[1].parts.filter(part => part.kind === 'skill-use').map(part => part.skillId),
        ['table-authoring'],
        'mode metadata carries Planning without a second selected-skill part',
      );
      const plans = createAgentPlans(f.runtime);
      assert.equal((await plans.read(w.id, w.userId, planId)).lifecycle, 'draft');
      assert.deepEqual(await createPlanRuntime(f.runtime).step(w.id, planId), { kind: 'terminal', specialists: [] });
    } finally {
      await f.close();
    }
  },
);

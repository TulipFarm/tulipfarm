import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chatSkills } from '../../../agents/src/chat-skills.ts';
import { conversationPlanning } from '../../../agents/src/tools.ts';
import { createAgentPlans } from '../../../agents/src/plans.ts';
import { createPlanRuntime } from '../../../agents/src/plan-runtime.ts';
import { createConversations } from '../../src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

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

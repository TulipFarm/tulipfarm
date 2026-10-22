import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createPersonalMemoryService } from '../../conversations/src/personal-memory.ts';
import { createProjects } from '../../conversations/src/projects.ts';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createAgentChat } from '../src/chat.ts';
import { savedTaskAgent, seedExecution } from './task-fixture.mjs';
import { syntheticContinuity } from './continuity-fixture.mjs';
import { createTableWithRows, tableDefinition } from '../../tables/test/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';

test(
  'private runtime reads fresh member memory and preserves project and standalone boundaries',
  { timeout: 120000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const { workspace: w, store } = f;
    const memory = createPersonalMemoryService(f.runtime);
    const first = await memory.save(w.id, w.userId, { content: 'PRIVATE_PREFERENCE_ONLY', expectedRevision: 0 });
    const reader = { user: randomUUID(), id: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      reader.id,
      reader.user,
    ]);
    await memory.save(w.id, reader.user, { content: 'OTHER_MEMBER_ONLY', expectedRevision: 0 });
    const chatId = randomUUID();
    await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const send = (id, text) =>
      store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text }],
      });
    const seen = [];
    const executor = createConversationExecutor(f.runtime, async input => {
      assert.equal(JSON.stringify(input.messages).includes('PRIVATE_PREFERENCE_ONLY'), false);
      seen.push(await input.readPersonalMemory());
      const next = await memory.save(w.id, w.userId, {
        content: 'UPDATED_PREFERENCE_ONLY',
        expectedRevision: first.revision,
      });
      seen.push(await input.readPersonalMemory());
      await memory.delete(w.id, w.userId, { expectedRevision: next.revision });
      seen.push(await input.readPersonalMemory());
      return { text: 'Private answer.', sources: [] };
    });

    await t.test(
      'compaction never captures ephemeral memory and memory-derived authored drafts fail before persistence',
      { timeout: 120000 },
      async t => {
        const f = await conversationFixture();
        t.after(() => f.close());
        const { workspace: w, store } = f;
        const memory = createPersonalMemoryService(f.runtime);
        const secret = 'EPHEMERAL_PREFERENCE_NEVER_SNAPSHOT';
        const saved = await memory.save(w.id, w.userId, { content: secret, expectedRevision: 0 });
        const chatId = randomUUID();
        await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
        const summarizeCalls = [];
        const compactor = {
          policy: async () => ({
            automatic: true,
            triggerPercent: 70,
            targetPercent: 30,
            outputPrompt: null,
            revision: 0,
            families: ['claude-haiku'],
          }),
          measure: async input => {
            assert.equal(JSON.stringify(input).includes(secret), false);
            return { tokens: input.messages.reduce((n, m) => n + m.text.length, 0), window: 16000 };
          },
          window: async () => 200000,
          summarize: async input => {
            assert.equal(JSON.stringify(input).includes(secret), false);
            summarizeCalls.push(input.purpose);
            return {
              text:
                input.purpose === 'summary'
                  ? JSON.stringify({ goal: 'Complete the request', state: 'In progress', decisions: [], openWork: [] })
                  : 'Continue the request.',
              familyId: 'claude-haiku',
              fallbackFrom: null,
            };
          },
        };
        const reads = [];
        const executor = createConversationExecutor(
          f.runtime,
          async input => {
            assert.equal(JSON.stringify(input.messages).includes(secret), false);
            reads.push(await input.readPersonalMemory());
            return { text: 'Ordinary answer.', sources: [] };
          },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          compactor,
        );
        const exchange = async (parts, engine = executor) => {
          const sent = await store.send(w.id, w.userId, chatId, {
            commandId: randomUUID(),
            messageId: randomUUID(),
            parts,
          });
          assert.equal(
            await engine.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
            'completed',
          );
        };
        for (const label of ['one', 'two', 'three', 'four'])
          await exchange([{ kind: 'text', text: `${label} ${'x'.repeat(3000)}` }]);
        assert.ok(summarizeCalls.includes('summary'), 'automatic compaction ran');
        const priorReads = reads.length;
        await exchange([{ kind: 'compact' }]);
        assert.equal(reads.length, priorReads, 'manual compaction does not load preference memory');
        assert.ok(summarizeCalls.includes('handoff'));
        await memory.delete(w.id, w.userId, { expectedRevision: saved.revision });
        await exchange([{ kind: 'text', text: 'Continue after deletion' }]);
        assert.deepEqual(reads.at(-1), { content: '', revision: 2 });
        for (const name of [
          'tf_conversation_turns',
          'tf_conversation_working_summaries',
          'tf_conversation_handoffs',
          'tf_conversation_parts',
          'tf_conversation_results',
        ]) {
          const rows = (await f.db.platform.query(`SELECT row_to_json(t) AS retained FROM ${f.table(name)} t`)).rows;
          assert.equal(JSON.stringify(rows).includes(secret), false, `${name} must not capture injected memory`);
        }
        const proposals = [
          {
            kind: 'agent',
            targetId: randomUUID(),
            input: {
              expectedSoulRevision: 'a'.repeat(40),
              expectedSavedRevision: null,
              owningTeamId: randomUUID(),
              definition: { name: 'Derived agent', instructions: 'Preference-derived content', tools: [] },
            },
          },
          {
            kind: 'skill',
            targetId: randomUUID(),
            input: {
              expectedVersion: 0,
              definition: { name: 'Derived skill', instructions: 'Preference-derived content' },
            },
          },
          {
            kind: 'workflow',
            targetId: randomUUID(),
            input: {
              expectedRevision: null,
              activate: false,
              definition: {
                version: 1,
                name: 'Derived workflow',
                trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
                steps: [{ id: 'review', kind: 'human', prompt: 'Review', timeoutSeconds: 86400 }],
              },
            },
          },
        ];
        const draftExecutor = createConversationExecutor(f.runtime, async input => {
          assert.deepEqual(await input.readPersonalMemory(), { content: '', revision: 2 });
          for (const proposal of proposals) {
            const output = await input.executeTool(
              `${proposal.kind === 'skill' ? 'skills' : proposal.kind === 'agent' ? 'agents' : 'workflows'}.draft`,
              false,
              context =>
                createAuthoringDrafts(context.runtime).propose(
                  w.id,
                  context.actor,
                  randomUUID(),
                  context.origin,
                  proposal,
                ),
            );
            assert.equal(
              output.result.error,
              'access-denied',
              'retained memory provenance must stop authored-definition persistence after deletion',
            );
          }
          return { text: 'Drafts were denied.', sources: [] };
        });
        await exchange([{ kind: 'text', text: 'Create definitions from earlier context' }], draftExecutor);
        assert.equal(
          (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_chat_authoring_drafts')}`)).rows[0]
            .n,
          0,
        );
      },
    );
    const sent = await send(chatId, 'Private question');
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    assert.deepEqual(seen, [first, { content: 'UPDATED_PREFERENCE_ONLY', revision: 2 }, { content: '', revision: 3 }]);
    const retained = JSON.stringify((await store.history(w.id, w.userId, chatId)).messages);
    assert.equal(retained.includes('PREFERENCE_ONLY'), false);
    assert.equal(retained.includes('OTHER_MEMBER_ONLY'), false);

    const projects = createProjects(f.runtime),
      projectId = randomUUID();
    await projects.create(w.id, w.userId, { id: projectId, name: 'Shared project' });
    await projects.member(w.id, w.userId, projectId, { membershipId: reader.id, role: 'member', removed: false });
    const projectChat = randomUUID();
    await store.create(w.id, w.userId, { chatId: projectChat, commandId: randomUUID(), projectId });
    const projectSent = await send(projectChat, 'Project question');
    const projectExecutor = createConversationExecutor(f.runtime, async input => {
      assert.equal(await input.readPersonalMemory(), undefined);
      return { text: 'Project answer.', sources: [] };
    });
    assert.equal(
      await projectExecutor.process({
        workspaceId: w.id,
        conversationId: projectChat,
        turnId: projectSent.turnId,
        generation: 0,
      }),
      'completed',
    );
    await store.move(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      projectId,
      confirmFullHistoryIncludingAdmins: true,
    });
    const shared = await store.history(w.id, reader.user, chatId);
    assert.equal(
      JSON.stringify(shared).includes('Private answer.'),
      false,
      'A memory-influenced answer must not widen to another member',
    );

    const agent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], []);
    await seedExecution(f.db, w, agent.agentId, [agent.teamId], []);
    const tasks = createAgentTasks(f.runtime);
    const saved = await memory.save(w.id, w.userId, { content: 'TASK_PREFERENCE_ONLY', expectedRevision: 3 });
    let step = 0;
    const engine = createTaskRuntime(
      f.runtime,
      syntheticContinuity(async input => {
        assert.equal(JSON.stringify(JSON.parse(input.prompt)).includes('TASK_PREFERENCE_ONLY'), false);
        assert.deepEqual(input.personalMemory, step++ === 0 ? saved : { content: '', revision: 5 });
        return step === 1 ? { kind: 'clarify', text: 'Continue?' } : { kind: 'answer', text: 'Task finished.' };
      }),
    );
    const task = await tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Private task',
    });
    await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, w.userId, task.id)).status, 'waiting-clarification');
    const history = await tasks.history(w.id, w.userId, task.id);
    await memory.delete(w.id, w.userId, { expectedRevision: saved.revision });
    await tasks.continueTask(w.id, w.userId, task.id, {
      requestId: randomUUID(),
      expectedGeneration: 0,
      expectedSequence: history.messages.at(-1).sequence,
      text: 'Continue',
    });
    await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, w.userId, task.id)).status, 'completed');
    assert.equal(JSON.stringify(await tasks.history(w.id, w.userId, task.id)).includes('TASK_PREFERENCE_ONLY'), false);
    const standalone = createAgentChat(
      f.runtime,
      syntheticContinuity(async input => {
        assert.equal(input.personalMemory, undefined);
        return { kind: 'answer', text: 'Standalone answer.' };
      }),
    );
    const runId = randomUUID();
    await standalone.submit(w.id, w.userId, agent.agentId, {
      id: runId,
      activationId: agent.activationId,
      prompt: 'Standalone run',
      scope: [],
    });
    await standalone.processTurn(w.id, runId);
    assert.equal((await standalone.read(w.id, w.userId, agent.agentId, runId)).text, 'Standalone answer.');

    await f.db.platform.query(`UPDATE ${f.table('tf_teams')} SET name='First task owner' WHERE id=$1`, [agent.teamId]);
    const readerAgent = await savedTaskAgent(f.db, w, f.runtime, reader.user, reader.id, [], ['rows.list']);
    const revision = 'a'.repeat(40);
    const { tableId } = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      revision,
      definition: tableDefinition({ owningTeamId: readerAgent.teamId, label: 'Restricted source', fields: [] }),
      records: [],
    });
    const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
    await seedExecution(f.db, w, readerAgent.agentId, [readerAgent.teamId], scope);
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      readerAgent.activationId,
      JSON.stringify(scope),
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [readerAgent.teamId, tableId],
    );
    const restricted = await tasks.start(w.id, reader.user, {
      requestId: randomUUID(),
      agentId: readerAgent.agentId,
      text: 'Read this source',
      scope,
      sources: [{ kind: 'table', tableId }],
    });
    await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE team_id=$1 AND asset_id=$2`, [
      readerAgent.teamId,
      tableId,
    ]);
    const denied = createTaskRuntime(
      f.runtime,
      syntheticContinuity(() => assert.fail('Memory must not bypass revoked current source access')),
    );
    await denied.process(w.id, restricted.id);
    assert.equal(
      (await f.db.platform.query(`SELECT status FROM ${f.table('tf_agent_tasks')} WHERE id=$1`, [restricted.id]))
        .rows[0].status,
      'failed',
    );
  },
);

test(
  'schema version 15 keeps private chats and tasks running without personal memory during rollout',
  { timeout: 120000 },
  async t => {
    const f = await conversationFixture(stream => stream.slice(0, 15));
    t.after(() => f.close());
    const { workspace: w, store } = f;
    assert.equal(
      (await f.db.platform.query(`SELECT to_regclass($1) AS name`, [f.table('tf_personal_memory')])).rows[0].name,
      null,
    );
    const chatId = randomUUID();
    await store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Existing chat' }],
    });
    const executor = createConversationExecutor(f.runtime, async input => {
      assert.deepEqual(await input.readPersonalMemory(), { content: '', revision: 0 });
      return { text: 'Existing chat still works.', sources: [] };
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    const agent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], []);
    await seedExecution(f.db, w, agent.agentId, [agent.teamId], []);
    const tasks = createAgentTasks(f.runtime);
    const task = await tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Existing task',
    });
    const engine = createTaskRuntime(
      f.runtime,
      syntheticContinuity(async input => {
        assert.deepEqual(input.personalMemory, { content: '', revision: 0 });
        return { kind: 'answer', text: 'Existing task still works.' };
      }),
    );
    await engine.process(w.id, task.id);
    assert.equal((await tasks.read(w.id, w.userId, task.id)).status, 'completed');
  },
);

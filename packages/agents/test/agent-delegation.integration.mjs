import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { reserveCredits, settleCredits } from '@tulipfarm/workspace-storage/credits';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskApprovals } from '../src/task-approvals.ts';
import { createChatTools } from '../src/tools.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createAgentStore } from '../src/store.ts';
import { createAgentExecutor } from '../src/executor.ts';

test('saved-agent delegation intersects authority, links history, shares credits, and bounds descendants', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  const parent = await savedTaskAgent(
    db,
    w,
    runtime,
    user,
    member,
    [],
    ['agents.task.start', 'agents.task.read', 'rows.list'],
  );
  const childAgent = await savedTaskAgent(
    db,
    w,
    runtime,
    user,
    member,
    [],
    ['agents.task.start', 'rows.list', 'rows.update'],
  );
  const assetId = randomUUID();
  const parentScope = [{ assetId, permissions: ['table.row.read'] }];
  const childScope = [{ assetId, permissions: ['table.row.read', 'table.row.update'] }];
  for (const [agent, scope] of [
    [parent, parentScope],
    [childAgent, childScope],
  ]) {
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      agent.activationId,
      JSON.stringify(scope),
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_limits')} (agent_id,scope,task_limits) VALUES ($1,$2,'{"toolCalls":1000,"activeMilliseconds":3600000,"credits":10000}'::jsonb) ON CONFLICT (agent_id) DO UPDATE SET scope=EXCLUDED.scope,task_limits=EXCLUDED.task_limits`,
      [agent.agentId, JSON.stringify(scope)],
    );
    for (const permission of scope[0].permissions)
      await db.platform.query(`INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
        agent.teamId,
        assetId,
        permission,
      ]);
  }

  const tasks = createAgentTasks(runtime),
    approvals = createTaskApprovals(runtime);
  const root = await tasks.start(w.id, user, {
    requestId: randomUUID(),
    agentId: parent.agentId,
    scope: parentScope,
    text: 'Coordinate bounded work.',
  });
  const rootRun = await approvals.bindRun(w.id, user, root.id, { generation: 0 });
  const child = await tasks.delegate(w.id, user, root.id, rootRun.runId, randomUUID(), {
    agentId: childAgent.agentId,
    scope: childScope,
    limits: { toolCalls: 20, activeMilliseconds: 120000, credits: 20 },
    text: 'Inspect the shared resource.',
  });

  await t.test(
    'chat-started delegation and grandchildren retain queued root budgets across same-generation human continuation',
    { timeout: 60000 },
    async t => {
      const f = await conversationFixture(),
        w = f.workspace;
      t.after(() => f.close());
      const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
      const tools = ['agents.task.start', 'knowledge.search', 'knowledge.read'];
      const parentAgent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], tools);
      const childAgent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], tools);
      const searchOnly = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], ['knowledge.search']);
      const executor = createAgentExecutor({
        runtime: f.runtime,
        knowledge: () => ({
          retrieve: async (_workspace, _actor, input) => ({
            result: {
              provider: 'knowledge',
              action: input.action,
              branches: [
                {
                  index: 0,
                  status: 'no-match',
                  mode: 'keyword-only',
                  reason: null,
                  coverage: 'keyword-only',
                  documents: [],
                },
              ],
              instruction: 'No matching evidence.',
            },
            sources: [],
          }),
        }),
      });
      for (const agent of [parentAgent, childAgent, searchOnly])
        await executor.configure(w.id, actor, {
          agentId: agent.agentId,
          version: 0,
          enabled: true,
          teamIds: [agent.teamId],
          limits: [],
        });
      const chatId = randomUUID(),
        startCallId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Research supplier terms.' }],
      });
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'agents.task.start','running')`,
        [startCallId, chatId, sent.turnId],
      );
      const started = await createChatTools(f.runtime).invoke(
        {
          workspaceId: w.id,
          actor,
          callId: startCallId,
          origin: {
            conversationId: chatId,
            turnId: sent.turnId,
            sources: [{ kind: 'private-conversation', conversationId: chatId }],
          },
        },
        { tool: 'agents.task.start', agentId: parentAgent.agentId, text: 'Research supplier terms.' },
      );
      const tasks = createAgentTasks(f.runtime),
        approvals = createTaskApprovals(f.runtime),
        store = createAgentStore(f.runtime);
      const parent = await tasks.read(w.id, w.userId, started.taskId);
      const root = { kind: 'chat', id: sent.turnId };
      const rootOf = async id =>
        (await f.db.platform.query(`SELECT knowledge_root FROM ${f.table('tf_agent_tasks')} WHERE id=$1`, [id])).rows[0]
          .knowledge_root;
      assert.deepEqual(await rootOf(parent.id), root);
      assert.deepEqual((await tasks.history(w.id, w.userId, parent.id)).messages[0].sources, [
        { kind: 'private-conversation', conversationId: chatId },
      ]);
      const run = await approvals.bindRun(w.id, w.userId, parent.id, { generation: 0 });
      async function queue(runId, sequence, call) {
        const callId = randomUUID();
        await store.queueCall(w.id, actor, { runId, callId, sequence, call });
        return { workspaceId: w.id, runId, callId };
      }
      const initial = await queue(run.runId, 0, {
        tool: 'knowledge.retrieve',
        action: 'search',
        query: 'supplier terms',
      });
      assert.equal(await executor.execute(initial), 'completed');
      const delegated = await queue(run.runId, 1, {
        tool: 'agents.task.start',
        agentId: childAgent.agentId,
        text: 'Inspect remaining supplier gaps.',
      });
      await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='paused' WHERE id=$1`, [parent.id]);
      const continued = await tasks.continueTask(w.id, w.userId, parent.id, {
        requestId: randomUUID(),
        expectedGeneration: 0,
        expectedSequence: 0,
        text: 'A new human request may research deeper.',
        sources: [],
      });
      assert.equal(continued.generation, 0, 'a genuine continuation does not need a generation change');
      assert.deepEqual(await rootOf(parent.id), { kind: 'task', id: parent.id, sequence: 1 });
      assert.equal(await executor.execute(delegated), 'completed');
      const childId = (
        await f.db.platform.query(`SELECT result->>'taskId' AS id FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`, [
          delegated.callId,
        ])
      ).rows[0].id;
      assert.deepEqual(
        await rootOf(childId),
        root,
        'queued delegation keeps the source request, not the latest parent message',
      );
      assert.equal(await executor.execute(delegated), 'completed', 'transport replay does not create another child');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS count FROM ${f.table('tf_agent_tasks')} WHERE parent_task_id=$1`,
            [parent.id],
          )
        ).rows[0].count,
        1,
      );
      assert.ok(
        (await tasks.history(w.id, w.userId, childId)).messages[0].sources.some(
          source => source.kind === 'task' && source.taskId === parent.id,
        ),
      );
      const childRun = await approvals.bindRun(w.id, w.userId, childId, { generation: 0 });
      const bypass = await queue(childRun.runId, 0, {
        tool: 'knowledge.retrieve',
        action: 'search',
        query: 'try a fresh query in the child',
      });
      assert.equal(await executor.execute(bypass), 'completed');
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT result->>'error' AS error FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`,
            [bypass.callId],
          )
        ).rows[0].error,
        'knowledge-action-required',
        'the shared root has spent its initial search, so the child must expand instead',
      );
      const deep = await queue(childRun.runId, 1, {
        tool: 'knowledge.retrieve',
        action: 'expand',
        branches: [{ query: 'supplier exceptions', reason: 'Check missing exceptions' }],
      });
      assert.equal(await executor.execute(deep), 'completed');
      const grandchild = await queue(childRun.runId, 2, {
        tool: 'agents.task.start',
        agentId: childAgent.agentId,
        text: 'Inspect the last gap.',
      });
      assert.equal(await executor.execute(grandchild), 'completed');
      const grandchildId = (
        await f.db.platform.query(`SELECT result->>'taskId' AS id FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`, [
          grandchild.callId,
        ])
      ).rows[0].id;
      assert.deepEqual(await rootOf(grandchildId), root);
      const state = (
        await f.db.platform.query(`SELECT knowledge_budget FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
          sent.turnId,
        ])
      ).rows[0].knowledge_budget;
      assert.deepEqual(
        state.operations.map(operation => operation.phase),
        ['initial', 'deep'],
      );
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT knowledge_budget FROM ${f.table('tf_agent_task_messages')} WHERE task_id=$1 AND sequence=1`,
            [parent.id],
          )
        ).rows[0].knowledge_budget.operations.length,
        0,
      );
      const restricted = await tasks.start(w.id, w.userId, {
        requestId: randomUUID(),
        agentId: searchOnly.agentId,
        text: 'Search only.',
      });
      const restrictedRun = await approvals.bindRun(w.id, w.userId, restricted.id, { generation: 0 });
      await assert.rejects(
        queue(restrictedRun.runId, 0, { tool: 'knowledge.retrieve', action: 'search', query: 'not granted' }),
        AccessDenied,
      );
    },
  );
  const childSummary = await tasks.read(w.id, user, child.id);
  assert.equal(childSummary.parentTaskId, root.id);
  assert.equal(childSummary.delegationDepth, 1);
  assert.equal(childSummary.flowId, (await tasks.read(w.id, user, root.id)).flowId);
  assert.deepEqual(childSummary.scope, parentScope, 'the child scope cannot exceed the parent activation');
  assert.deepEqual(
    (await db.platform.query(`SELECT delegation_tools FROM ${table('tf_agent_tasks')} WHERE id=$1`, [child.id])).rows[0]
      .delegation_tools,
    ['agents.task.start', 'rows.list'],
  );
  assert.deepEqual((await tasks.history(w.id, user, root.id)).messages.at(-1).sources, [
    { kind: 'task', taskId: child.id, throughSequence: 0 },
  ]);
  assert.deepEqual(await tasks.readResult(w.id, user, child.id, root.id), { taskId: child.id, status: 'pending' });
  await assert.rejects(tasks.readResult(w.id, user, child.id, randomUUID()), AccessDenied);

  const childRun = await approvals.bindRun(w.id, user, child.id, { generation: 0 });
  const grandchild = await tasks.delegate(w.id, user, child.id, childRun.runId, randomUUID(), {
    agentId: childAgent.agentId,
    text: 'Continue within inherited scope.',
  });
  assert.equal((await tasks.read(w.id, user, grandchild.id)).delegationDepth, 2);
  const grandchildRun = await approvals.bindRun(w.id, user, grandchild.id, { generation: 0 });
  const greatGrandchild = await tasks.delegate(w.id, user, grandchild.id, grandchildRun.runId, randomUUID(), {
    agentId: childAgent.agentId,
    text: 'One last bounded handoff.',
  });
  assert.equal((await tasks.read(w.id, user, greatGrandchild.id)).delegationDepth, 3);
  const greatGrandchildRun = await approvals.bindRun(w.id, user, greatGrandchild.id, { generation: 0 });
  await assert.rejects(
    tasks.delegate(w.id, user, greatGrandchild.id, greatGrandchildRun.runId, randomUUID(), {
      agentId: childAgent.agentId,
      text: 'Exceed the maximum depth.',
    }),
    error => error.code === 'delegation-depth',
  );

  for (let index = 0; index < 4; index++) {
    await tasks.delegate(w.id, user, root.id, rootRun.runId, randomUUID(), {
      agentId: childAgent.agentId,
      text: `Bounded sibling ${index + 1}.`,
    });
  }
  await assert.rejects(
    tasks.delegate(w.id, user, root.id, rootRun.runId, randomUUID(), {
      agentId: childAgent.agentId,
      text: 'Exceed the child limit.',
    }),
    error => error.code === 'delegation-limit',
  );

  const attemptId = randomUUID();
  await runtime.transaction(w.id, commonCompatibility, async tx => {
    await reserveCredits(tx, {
      id: attemptId,
      flowId: root.id,
      modelId: 'delegation-fixture',
      agentId: parent.agentId,
      activity: 'agent',
      providerPicoUsd: '1000000000000',
      pricingRevision: 'fixture',
    });
    await settleCredits(tx, attemptId, '1000000000000');
  });
  assert.deepEqual(
    (await tasks.read(w.id, user, child.id)).cost,
    (await tasks.read(w.id, user, root.id)).cost,
    'all descendants charge the parent flow',
  );

  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [child.id]);
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) SELECT $1,COALESCE(max(sequence),-1)+1,0,'agent','The shared resource is ready.','[]'::jsonb FROM ${table('tf_agent_task_messages')} WHERE task_id=$1`,
    [child.id],
  );
  assert.deepEqual(await tasks.readResult(w.id, user, child.id, root.id), {
    taskId: child.id,
    status: 'completed',
    result: 'The shared resource is ready.',
  });

  const chatTools = createChatTools(runtime),
    callId = randomUUID();
  const chatStart = await chatTools.invoke(
    { workspaceId: w.id, actor: { kind: 'human', userId: user, membershipId: member }, callId },
    { tool: 'agents.task.start', agentId: childAgent.agentId, text: 'Handle this private-chat request.' },
  );
  assert.equal(chatStart.status, 'pending');
  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [chatStart.taskId]);
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,1,0,'agent','Finished the private-chat request.','[]'::jsonb)`,
    [chatStart.taskId],
  );
  assert.deepEqual(
    await chatTools.invoke(
      { workspaceId: w.id, actor: { kind: 'human', userId: user, membershipId: member }, callId: randomUUID() },
      { tool: 'agents.task.read', taskId: chatStart.taskId },
    ),
    {
      taskId: chatStart.taskId,
      status: 'completed',
      result: 'Finished the private-chat request.',
    },
  );
});

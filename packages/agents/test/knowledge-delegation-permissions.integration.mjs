import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFiles } from '@tulipfarm/files';
import { reserveCredits, settleCredits } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
  withKnowledgeSourceAuthorization,
} from '../../knowledge/dist/index.js';
import { createAgentExecutor } from '../src/executor.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskApprovals } from '../src/task-approvals.ts';
import { createAgentPlans } from '../src/plans.ts';
import { createPlanRuntime } from '../src/plan-runtime.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { savedTaskAgent } from './task-fixture.mjs';

test('a pinned automatic skill read cannot bypass the delegated tool intersection', { timeout: 60000 }, async t => {
  const f = await conversationFixture(),
    w = f.workspace;
  t.after(() => f.close());
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const skills = createWorkspaceSkills(f.runtime),
    skillId = randomUUID();
  const saved = await skills.save(w.id, actor, skillId, {
    requestId: randomUUID(),
    expectedVersion: 0,
    definition: {
      name: 'Supplier checks',
      description: 'Checks supplier evidence.',
      instructions: 'Check supplier evidence and report missing facts.',
    },
  });
  await skills.review(w.id, actor, skillId, {
    requestId: randomUUID(),
    expectedVersion: 1,
    revision: saved.savedRevision,
  });
  const agent = await savedTaskAgent(
    f.db,
    w,
    f.runtime,
    w.userId,
    w.membershipId,
    [{ id: skillId, revision: saved.savedRevision }],
    ['knowledge.search', 'knowledge.read'],
  );
  const executor = createAgentExecutor({ runtime: f.runtime }),
    tasks = createAgentTasks(f.runtime),
    approvals = createTaskApprovals(f.runtime);
  await executor.configure(w.id, actor, {
    agentId: agent.agentId,
    version: 0,
    enabled: true,
    teamIds: [agent.teamId],
    limits: [],
  });
  const task = await tasks.start(w.id, w.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Read supplier guidance within delegated authority.',
  });
  const run = await approvals.bindRun(w.id, w.userId, task.id, { generation: 0 });
  const call = { tool: 'skills.read', skillId, revision: saved.savedRevision };
  const initial = { workspaceId: w.id, runId: run.runId, callId: randomUUID() };
  await executor.queueCall(w.id, actor, { runId: run.runId, callId: initial.callId, sequence: 0, call });
  assert.equal(await executor.execute(initial), 'completed', 'pinned skill reads remain automatic outside delegation');
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET delegation_tools=$2 WHERE id=$1`, [
    task.id,
    JSON.stringify(['knowledge.search', 'knowledge.read']),
  ]);
  const restricted = { workspaceId: w.id, runId: run.runId, callId: randomUUID() };
  await executor.queueCall(w.id, actor, { runId: run.runId, callId: restricted.callId, sequence: 1, call });
  assert.equal(
    await executor.execute(restricted),
    'blocked',
    'automatic selection never overrides a narrower delegation grant',
  );
  const output = (
    await f.db.platform.query(`SELECT result FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`, [restricted.callId])
  ).rows[0].result;
  assert.deepEqual(
    output,
    { code: 'access-denied' },
    'denied delegation retains only its safe denial code, never skill instructions',
  );
});

async function knowledgeFixture(t) {
  const f = await conversationFixture(),
    w = f.workspace;
  t.after(() => f.close());
  const runtime = withKnowledgeSourceAuthorization(f.runtime);
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const bytes = new Map();
  const local = createLocalKnowledge({
    runtime: f.runtime,
    files: createFiles(f.runtime, {
      putIfAbsent: async (key, value) => bytes.set(key, value),
      read: async key => bytes.get(key),
    }),
  });
  const note = await local.save(w.id, w.userId, {
    commandId: randomUUID(),
    documentId: randomUUID(),
    expectedRevisionId: null,
    title: 'Supplier policy',
    input: { kind: 'note', text: 'Suppliers are paid in 37 days.' },
  });
  for (const work of await local.due(w.id)) await local.process(work);
  const publication = (
    await f.db.platform.query(`SELECT lexical_publication_id FROM ${f.table('tf_knowledge_documents')} WHERE id=$1`, [
      note.documentId,
    ])
  ).rows[0].lexical_publication_id;
  let calls = 0;
  const embeddings = createKnowledgeEmbeddings({ runtime: f.runtime, config: { kind: 'disabled' } });
  const knowledge = guarded => {
    const domain = createKnowledgeAgentTools({
      runtime: guarded,
      search: createKnowledgeSearch({ runtime: guarded, embeddings }),
    });
    return {
      ...domain,
      retrieve: async (...args) => {
        calls++;
        return domain.retrieve(...args);
      },
    };
  };
  const agent = await savedTaskAgent(
    f.db,
    w,
    runtime,
    w.userId,
    w.membershipId,
    [],
    ['agents.task.start', 'knowledge.search', 'knowledge.read'],
  );
  const executor = createAgentExecutor({ runtime, knowledge }),
    tasks = createAgentTasks(runtime),
    approvals = createTaskApprovals(runtime);
  await executor.configure(w.id, actor, {
    agentId: agent.agentId,
    version: 0,
    enabled: true,
    teamIds: [agent.teamId],
    limits: [],
  });
  async function queue(runId, sequence, call) {
    const ids = { workspaceId: w.id, runId, callId: randomUUID() };
    await executor.queueCall(w.id, actor, { runId, callId: ids.callId, sequence, call });
    return ids;
  }
  const result = async ids =>
    (await f.db.platform.query(`SELECT result FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`, [ids.callId]))
      .rows[0].result;
  return {
    f,
    w,
    runtime,
    actor,
    local,
    note,
    publication,
    agent,
    executor,
    tasks,
    approvals,
    queue,
    result,
    calls: () => calls,
  };
}

test(
  'a delegated child denies revoked Knowledge retained through the parent task source closure',
  { timeout: 60000 },
  async t => {
    const f = await knowledgeFixture(t);
    const parent = await f.tasks.start(f.w.id, f.w.userId, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      text: 'Research suppliers.',
    });
    const run = await f.approvals.bindRun(f.w.id, f.w.userId, parent.id, { generation: 0 });
    const initial = await f.queue(run.runId, 0, {
      tool: 'knowledge.retrieve',
      action: 'search',
      query: 'supplier policy',
    });
    assert.equal(await f.executor.execute(initial), 'completed');
    const output = await f.result(initial);
    assert.ok(output.sources.some(source => source.kind === 'knowledge-document'));
    await f.f.db.platform.query(
      `INSERT INTO ${f.f.table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,1,0,'agent','Evidence retained.',$2)`,
      [parent.id, JSON.stringify(output.sources)],
    );
    const delegation = await f.queue(run.runId, 1, {
      tool: 'agents.task.start',
      agentId: f.agent.agentId,
      text: 'Check remaining supplier gaps.',
    });
    assert.equal(await f.executor.execute(delegation), 'completed');
    const childId = (await f.result(delegation)).taskId;
    const childRun = await f.approvals.bindRun(f.w.id, f.w.userId, childId, { generation: 0 });
    const childRead = await f.queue(childRun.runId, 0, {
      tool: 'knowledge.retrieve',
      action: 'expand',
      branches: [{ query: 'supplier exceptions', reason: 'A remaining gap' }],
    });
    await f.local.remove(f.w.id, f.w.userId, {
      commandId: randomUUID(),
      documentId: f.note.documentId,
      expectedRevisionId: f.note.revisionId,
    });
    assert.equal(await f.executor.execute(childRead), 'blocked');
    assert.deepEqual(await f.result(childRead), { code: 'access-denied' });
    assert.equal(f.calls(), 1, 'the child never reaches Knowledge after inherited evidence is revoked');
    const budget = (
      await f.f.db.platform.query(
        `SELECT knowledge_budget FROM ${f.f.table('tf_agent_task_messages')} WHERE task_id=$1 AND sequence=0`,
        [parent.id],
      )
    ).rows[0].knowledge_budget;
    assert.equal(budget.operations.length, 1);
  },
);

for (const boundary of ['credits', 'mcp'])
  test(
    `anchor-only task expansion survives ${boundary} restriction while query expansion is denied`,
    { timeout: 60000 },
    async t => {
      const f = await knowledgeFixture(t),
        sources = [];
      if (boundary === 'mcp') {
        const source = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
        await f.f.db.platform.query(
          `INSERT INTO ${f.f.table('tf_mcp_integrations')} (id,ownership,owner_membership_id,name,endpoint,server_identity,auth_method,lifecycle,authorization_epoch,credential) VALUES ($1,'personal',$2,'Anchor fixture','https://example.test/mcp','fixture','none','active',1,'{}')`,
          [source.integrationId, f.w.membershipId],
        );
        sources.push(source);
      }
      const task = await f.tasks.start(f.w.id, f.w.userId, {
        requestId: randomUUID(),
        agentId: f.agent.agentId,
        text: 'Read a retained anchor without sending a query.',
        sources,
        limits: { toolCalls: 20, activeMilliseconds: 120000, credits: boundary === 'credits' ? 1 : 10 },
      });
      const run = await f.approvals.bindRun(f.w.id, f.w.userId, task.id, { generation: 0 });
      if (boundary === 'credits') {
        await f.f.db.platform.query(
          `UPDATE ${f.f.table('tf_credit_account')} SET available=1000000000000000,granted=1000000000000000`,
        );
        await f.runtime.transaction(f.w.id, commonCompatibility, async tx => {
          const id = randomUUID();
          assert.equal(
            await reserveCredits(tx, {
              id,
              flowId: task.id,
              modelId: 'fixture',
              agentId: f.agent.agentId,
              activity: 'agent',
              providerPicoUsd: '1000000000000',
              pricingRevision: 'fixture',
            }),
            true,
          );
          await settleCredits(tx, id, '1000000000000');
        });
      }
      const initial = await f.queue(run.runId, 0, { tool: 'knowledge.read', citationId: `${f.publication}:99` });
      assert.equal(await f.executor.execute(initial), 'completed');
      const anchor = await f.queue(run.runId, 1, {
        tool: 'knowledge.retrieve',
        action: 'expand',
        branches: [{ citationIds: [`${f.publication}:0`], reason: 'Read the retained supplier anchor' }],
      });
      assert.equal(await f.executor.execute(anchor), 'completed');
      assert.match(JSON.stringify(await f.result(anchor)), /37 days/);
      assert.equal(f.calls(), 1);
      const query = await f.queue(run.runId, 2, {
        tool: 'knowledge.retrieve',
        action: 'expand',
        branches: [{ query: 'supplier exceptions', reason: 'Would require query egress' }],
      });
      assert.equal(await f.executor.execute(query), boundary === 'mcp' ? 'blocked' : 'completed');
      if (boundary === 'credits') assert.equal((await f.result(query)).error, 'knowledge-unavailable');
      assert.equal(f.calls(), 1, 'query admission fails before another domain or provider call');
    },
  );

test(
  'public request IDs cannot graft another owner’s known chat call or plan attempt onto a task root',
  { timeout: 60000 },
  async t => {
    const f = await knowledgeFixture(t),
      chatId = randomUUID(),
      callId = randomUUID();
    await f.f.store.create(f.w.id, f.w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.f.store.send(f.w.id, f.w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Victim research request.' }],
    });
    await f.f.db.platform.query(
      `INSERT INTO ${f.f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'agents.task.start','running')`,
      [callId, chatId, sent.turnId],
    );
    const plan = await createAgentPlans(f.runtime).create(
      f.w.id,
      f.w.userId,
      chatId,
      randomUUID(),
      {
        title: 'Victim research plan',
        specialists: [
          {
            key: 'researcher',
            name: 'Researcher',
            role: 'Research',
            instructions: 'Find supplier facts.',
            tools: ['knowledge.search', 'knowledge.read'],
          },
        ],
        tasks: [{ key: 'research', title: 'Find facts', assignee: { kind: 'specialist', specialist: 'researcher' } }],
        budget: { toolCalls: 16, activeMilliseconds: 120000, credits: 100 },
      },
      sent.turnId,
    );
    const [attemptId] = (await createPlanRuntime(f.runtime).step(f.w.id, plan.id)).specialists;
    assert.ok(attemptId);
    const attacker = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await f.f.db.platform.query(
      `INSERT INTO ${f.f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`,
      [attacker.membershipId, attacker.userId],
    );
    await f.f.db.platform.query(`INSERT INTO ${f.f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      attacker.membershipId,
      f.agent.teamId,
    ]);
    const before = (
      await f.f.db.platform.query(`SELECT knowledge_budget FROM ${f.f.table('tf_conversation_turns')} WHERE id=$1`, [
        sent.turnId,
      ])
    ).rows[0].knowledge_budget;
    for (const requestId of [callId, attemptId]) {
      const task = await f.tasks.start(f.w.id, attacker.userId, {
        requestId,
        agentId: f.agent.agentId,
        text: 'A separate public request.',
      });
      const root = (
        await f.f.db.platform.query(`SELECT knowledge_root FROM ${f.f.table('tf_agent_tasks')} WHERE id=$1`, [task.id])
      ).rows[0].knowledge_root;
      assert.deepEqual(root, { kind: 'task', id: task.id, sequence: 0 });
      const run = await f.approvals.bindRun(f.w.id, attacker.userId, task.id, { generation: 0 });
      const ids = { workspaceId: f.w.id, runId: run.runId, callId: randomUUID() };
      await f.executor.queueCall(f.w.id, attacker, {
        runId: run.runId,
        callId: ids.callId,
        sequence: 0,
        call: { tool: 'knowledge.retrieve', action: 'search', query: 'Separate public supplier request' },
      });
      assert.equal(await f.executor.execute(ids), 'completed');
      assert.equal(
        (
          await f.f.db.platform.query(
            `SELECT knowledge_budget FROM ${f.f.table('tf_agent_task_messages')} WHERE task_id=$1 AND sequence=0`,
            [task.id],
          )
        ).rows[0].knowledge_budget.operations.length,
        1,
      );
    }
    assert.deepEqual(
      (
        await f.f.db.platform.query(`SELECT knowledge_budget FROM ${f.f.table('tf_conversation_turns')} WHERE id=$1`, [
          sent.turnId,
        ])
      ).rows[0].knowledge_budget,
      before,
    );
  },
);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskApprovals } from '../src/task-approvals.ts';
import { createAgentStore } from '../src/store.ts';

test('private tasks expose labeled tool receipts only to their owner', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const agent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], ['skills.list']);
    await createAgentStore(f.runtime).configure(w.id, actor, {
      agentId: agent.agentId,
      version: 0,
      enabled: true,
      teamIds: [agent.teamId],
      limits: [],
    });
    const tasks = createAgentTasks(f.runtime);
    const task = await tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'List procedures',
    });
    const run = await createTaskApprovals(f.runtime).bindRun(w.id, w.userId, task.id, { generation: 0 });
    const callId = randomUUID();
    await createAgentStore(f.runtime).queueCall(w.id, actor, {
      runId: run.runId,
      callId,
      sequence: 0,
      call: { tool: 'skills.list' },
    });
    assert.deepEqual((await tasks.read(w.id, w.userId, task.id)).activity, [
      {
        id: callId,
        tool: 'skills.list',
        status: 'queued',
        presentation: { label: 'Checking available procedures', brand: null },
      },
    ]);
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_tool_calls')} SET status='completed',result=$2 WHERE id=$1`, [
      callId,
      { skills: [], source: 'bundled' },
    ]);
    assert.equal((await tasks.read(w.id, w.userId, task.id)).activity[0].status, 'completed');
    await assert.rejects(tasks.read(w.id, randomUUID(), task.id));
  } finally {
    await f.close();
  }
});

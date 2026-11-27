import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration } from '@tulipfarm/tables/store';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createRowAssignments } from '../src/row-assignments.ts';
import { createTaskClarifications } from '../src/task-clarifications.ts';
import { createAgentTasks } from '../src/tasks.ts';

test('multi-recipient escalation notifies both founders, lets non-sponsor founder answer & resume, denies third member, and resolves sibling inbox items', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const workspace = await db.create(await workspaceTableMigrations());
  const s = `"${workspace.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({
      workspaceId: workspace.id,
      generation: 1,
      connectionString: db.login(workspace),
    }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const query = async (sql, params) => (await db.platform.query(sql, params)).rows;

  const founder1 = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
  const founder2 = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  const outsider = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  for (const person of [founder2, outsider]) {
    await query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      person.membershipId,
      person.userId,
    ]);
  }

  const agentId = randomUUID();
  const revision = 'a'.repeat(40);
  const definitionRevision = 'b'.repeat(64);
  const definition = {
    name: 'Support Triage',
    instructions: 'Escalate low-confidence cases to the founders.',
    tools: [],
    escalationPolicy: {
      rules: 'Escalate billing and refund requests to founders.',
      minConfidence: 0.7,
      targetMembershipIds: [founder1.membershipId, founder2.membershipId],
    },
  };
  await query(`INSERT INTO ${s}.tf_agents(id,enabled,display_name) VALUES($1,true,'Support Triage')`, [agentId]);
  await query(`INSERT INTO ${s}.tf_agent_definitions(agent_id,revision,definition) VALUES($1,$2,$3::jsonb)`, [
    agentId,
    definitionRevision,
    JSON.stringify(definition),
  ]);
  const command = randomUUID();
  await query(
    `INSERT INTO ${s}.tf_agent_commands(id,agent_id,membership_id,user_id,request_id,input) VALUES($1,$2,$3,$4,$5,'{}')`,
    [command, agentId, founder1.membershipId, founder1.userId, randomUUID()],
  );
  await query(
    `INSERT INTO ${s}.tf_soul_revisions(revision,agent_command_id,bundle_key,bundle_sha256) VALUES($1,$2,'k','s')`,
    [revision, command],
  );
  await query(
    `INSERT INTO ${s}.tf_agent_saved_revisions(agent_id,soul_revision,definition_revision,projection) VALUES($1,$2,$3,'{}')`,
    [agentId, revision, definitionRevision],
  );
  await query(`UPDATE ${s}.tf_agents SET saved_revision=$2 WHERE id=$1`, [agentId, revision]);
  const activationId = randomUUID();
  await query(`INSERT INTO ${s}.tf_agent_activations(id,agent_id,definition_revision,scope) VALUES($1,$2,$3,'[]')`, [
    activationId,
    agentId,
    definitionRevision,
  ]);
  await query(`INSERT INTO ${s}.tf_agent_assignment_limits(agent_id,concurrent) VALUES($1,2)`, [agentId]);
  await query(`INSERT INTO ${s}.tf_agent_person_grants(agent_id,membership_id,permission) VALUES($1,$2,'invoke')`, [
    agentId,
    founder1.membershipId,
  ]);

  const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  const [{ id: tableId }] = await query(
    `SELECT core_definition->>'id' AS id FROM ${s}.tf_system_tables WHERE kind='tasks'`,
  );
  const { revision: tableRevision } = await runtime.transaction(workspace.id, commonCompatibility, tx =>
    activeGeneration(tx, tableId),
  );
  const row = await tables.mutate(workspace.id, founder1.userId, {
    tableId,
    revision: tableRevision,
    kind: 'create',
    recordId: randomUUID(),
    values: {
      [taskFields.title]: { kind: 'text', value: 'Refund request from customer@example.com' },
      [taskFields.assignee]: { kind: 'actor', actor: { type: 'agent', id: agentId } },
    },
  });

  const woken = [];
  let createdTaskId = null;
  const engine = createRowAssignments({
    runtime,
    start: async (_workspace, userId, input) => {
      const id = randomUUID();
      createdTaskId = id;
      await query(
        `INSERT INTO ${s}.tf_agent_tasks(id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id)
          VALUES($1,$2,$3,$4,$5,$6,'[]','[]',$7,gen_random_uuid())`,
        [
          id,
          userId,
          founder1.membershipId,
          agentId,
          activationId,
          definitionRevision,
          JSON.stringify(input.limits ?? {}),
        ],
      );
      return { id };
    },
    pause: async () => {},
    wake: async (_workspace, taskId) => woken.push(taskId),
  });

  await engine.step(workspace.id);
  assert.ok(createdTaskId);

  // Complete the run with an OUTCOME: waiting + CLARIFICATION block and let row-assignments process it.
  const clarifications = createTaskClarifications({ runtime });
  const replyText = [
    'OUTCOME: waiting',
    'REASON: Need founder approval on refund amount',
    'CLARIFICATION: {"title":"Approve refund","summary":"Customer requested a full refund.","fields":[{"id":"decision","label":"Decision","kind":"text","required":true}]}',
  ].join('\n');
  await query(
    `INSERT INTO ${s}.tf_agent_task_messages(task_id,sequence,generation,role,text,sources) VALUES($1,1,0,'agent',$2,'[]')`,
    [createdTaskId, replyText],
  );
  await query(`UPDATE ${s}.tf_agent_tasks SET status='completed' WHERE id=$1`, [createdTaskId]);
  await engine.step(workspace.id);

  // Both Founder 1 and Founder 2 should have open Inbox items; outsider should not.
  const openInbox = await query(
    `SELECT membership_id, kind, resolved_at FROM ${s}.tf_inbox_items WHERE row_id = $1 ORDER BY membership_id`,
    [row.id],
  );
  const openMembers = new Set(openInbox.filter(r => r.resolved_at === null).map(r => r.membership_id));
  assert.equal(openMembers.has(founder1.membershipId), true);
  assert.equal(openMembers.has(founder2.membershipId), true);
  assert.equal(openMembers.has(outsider.membershipId), false);

  const [{ id: clarificationId }] = await query(
    `SELECT id FROM ${s}.tf_row_clarifications WHERE row_id = $1 AND status = 'open'`,
    [row.id],
  );

  // Unauthorized third member is denied.
  await assert.rejects(
    clarifications.answer(workspace.id, outsider, clarificationId, { answers: { decision: 'Approve' } }, 'web'),
    AccessDenied,
  );

  // Founder 2 (non-sponsor) CAN answer and resume the task.
  const answered = await clarifications.answer(
    workspace.id,
    founder2,
    clarificationId,
    { answers: { decision: 'Approve full refund' } },
    'web',
  );
  assert.equal(answered.status, 'answered');
  const [{ run_state: stateAfterAnswer }] = await query(
    `SELECT run_state FROM ${s}.tf_row_assignments WHERE row_id = $1`,
    [row.id],
  );
  assert.equal(stateAfterAnswer, 'queued');

  // Next engine.step() resumes the row with a new task run.
  const wokenBeforeResume = woken.length;
  await engine.step(workspace.id);
  assert.equal(woken.length, wokenBeforeResume + 1);

  // Both Founder 1's and Founder 2's sibling Inbox items are now resolved.
  const afterInbox = await query(`SELECT membership_id, resolved_at FROM ${s}.tf_inbox_items WHERE row_id = $1`, [
    row.id,
  ]);
  assert.equal(afterInbox.length >= 2, true);
  assert.equal(
    afterInbox.every(r => r.resolved_at !== null),
    true,
    'All sibling Inbox items should be resolved once answered',
  );

  // Also verify tasks.continueTask() allows Founder 2 to continue a waiting-clarification task and denies outsider.
  const tasks = createAgentTasks(runtime);
  const waitingTaskId = randomUUID();
  const flowId = randomUUID();
  await query(
    `INSERT INTO ${s}.tf_agent_tasks(id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,status,flow_id)
      VALUES($1,$2,$3,$4,$5,$6,'[]','[]','{}','waiting-clarification',$7)`,
    [waitingTaskId, founder1.userId, founder1.membershipId, agentId, activationId, definitionRevision, flowId],
  );
  await query(
    `INSERT INTO ${s}.tf_agent_task_messages(task_id,sequence,generation,role,text,sources) VALUES($1,0,0,'owner','Initial brief','[]')`,
    [waitingTaskId],
  );
  for (const recipientId of [founder1.membershipId, founder2.membershipId]) {
    await query(
      `INSERT INTO ${s}.tf_inbox_items(id,membership_id,kind,table_id,row_id,source_id,summary)
        VALUES($1,$2,'waiting',$3,$4,$5,'Waiting for founder reply')`,
      [randomUUID(), recipientId, tableId, row.id, waitingTaskId],
    );
  }

  await assert.rejects(
    tasks.continueTask(workspace.id, outsider.userId, waitingTaskId, {
      requestId: randomUUID(),
      text: 'Unauthorized reply',
      expectedGeneration: 0,
      expectedSequence: 0,
    }),
    AccessDenied,
  );

  const continued = await tasks.continueTask(workspace.id, founder2.userId, waitingTaskId, {
    requestId: randomUUID(),
    text: 'Founder 2 clarification reply',
    expectedGeneration: 0,
    expectedSequence: 0,
  });
  assert.equal(continued.status, 'pending');

  const taskInboxAfter = await query(
    `SELECT membership_id, resolved_at FROM ${s}.tf_inbox_items WHERE source_id = $1`,
    [waitingTaskId],
  );
  assert.equal(taskInboxAfter.length, 2);
  assert.equal(
    taskInboxAfter.every(r => r.resolved_at !== null),
    true,
    'Sibling task Inbox items should be resolved on continueTask',
  );
});

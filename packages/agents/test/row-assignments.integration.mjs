import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration } from '@tulipfarm/tables/store';
import { runStateOf, taskFields } from '@tulipfarm/tables/tasks-table';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createRowAssignments } from '../src/row-assignments.ts';

test(
  'assigning a row to an agent queues it, starts one run within limits and stops it on reassignment',
  { timeout: 60000 },
  async t => {
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
    const agentId = randomUUID();
    const revision = 'a'.repeat(40);
    const definitionRevision = 'b'.repeat(64);
    await query(`INSERT INTO ${s}.tf_agents(id,enabled,display_name) VALUES($1,true,'Ops Helper')`, [agentId]);
    await query(`INSERT INTO ${s}.tf_agent_definitions(agent_id,revision,definition) VALUES($1,$2,'{}')`, [
      agentId,
      definitionRevision,
    ]);
    const command = randomUUID();
    await query(
      `INSERT INTO ${s}.tf_agent_commands(id,agent_id,membership_id,user_id,request_id,input) VALUES($1,$2,$3,$4,$5,'{}')`,
      [command, agentId, workspace.membershipId, workspace.userId, randomUUID()],
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
    await query(`INSERT INTO ${s}.tf_agent_assignment_limits(agent_id,concurrent) VALUES($1,1)`, [agentId]);

    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const [{ id: tableId }] = await query(
      `SELECT core_definition->>'id' AS id FROM ${s}.tf_system_tables WHERE kind='tasks'`,
    );
    const { revision: tableRevision } = await runtime.transaction(workspace.id, commonCompatibility, tx =>
      activeGeneration(tx, tableId),
    );
    const base = { tableId, revision: tableRevision };
    const agent = { kind: 'actor', actor: { type: 'agent', id: agentId } };
    const create = text =>
      tables.mutate(workspace.id, workspace.userId, {
        ...base,
        kind: 'create',
        recordId: randomUUID(),
        values: { [taskFields.title]: { kind: 'text', value: text }, [taskFields.assignee]: agent },
      });
    const runState = async id =>
      runStateOf(
        (await tables.read(workspace.id, workspace.userId, { ...base, recordId: id })).values[taskFields.runState]
          ?.optionId,
      );
    const assignment = async id =>
      (await query(`SELECT run_state,reason,current_task_id FROM ${s}.tf_row_assignments WHERE row_id=$1`, [id]))[0];

    const started = [];
    const woken = [];
    let refuse = false;
    const engine = createRowAssignments({
      runtime,
      start: async (_workspace, userId, input) => {
        if (refuse) throw new AccessDenied('agent');
        started.push({ userId, ...input });
        const id = randomUUID();
        await query(
          `INSERT INTO ${s}.tf_agent_tasks(id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id)
          VALUES($1,$2,$3,$4,$5,$6,'[]','[]','{}',gen_random_uuid())`,
          [id, userId, workspace.membershipId, agentId, activationId, definitionRevision],
        );
        return { id };
      },
      pause: async () => undefined,
      wake: async (_workspace, taskId) => woken.push(taskId),
    });

    const first = await create('Call the logistics partner');
    const second = await create('Book the warehouse slot');
    assert.equal(await runState(first.id), 'queued');
    assert.deepEqual(await assignment(first.id), { run_state: 'queued', reason: null, current_task_id: null });

    await engine.step(workspace.id, true);
    assert.equal(started.length, 1, 'The agent limit of 1 admits one row');
    assert.equal(started[0].agentId, agentId);
    assert.equal(started[0].userId, workspace.userId, 'The run acts for the person who assigned it');
    assert.match(started[0].text, /Call the logistics partner/);
    assert.equal(woken.length, 1);
    assert.equal(await runState(first.id), 'working');
    assert.match((await assignment(second.id)).reason, /Ops Helper is working on 1 rows/);

    await engine.step(workspace.id, true);
    assert.equal(started.length, 1, 'A step never starts a second run for a working row');

    const current = await tables.read(workspace.id, workspace.userId, { ...base, recordId: first.id });
    await tables.mutate(workspace.id, workspace.userId, {
      ...base,
      kind: 'update',
      recordId: first.id,
      expectedToken: current.token,
      values: { [taskFields.assignee]: { kind: 'actor', actor: { type: 'member', id: workspace.membershipId } } },
    });
    refuse = true;
    await engine.step(workspace.id, true);
    assert.equal((await assignment(first.id)).current_task_id, null, 'Reassigning stops the run');
    assert.equal(await runState(first.id), null);
    assert.deepEqual(
      (
        await query(`SELECT event->>'type' AS type FROM ${s}.tf_row_thread_items WHERE row_id=$1 ORDER BY created_at`, [
          first.id,
        ])
      ).map(row => row.type),
      ['assigned', 'reassigned', 'run-stopped'],
    );
    assert.deepEqual(await assignment(second.id), {
      run_state: 'waiting',
      reason: "The sponsor can't use this agent",
      current_task_id: null,
    });
    assert.equal(await runState(second.id), 'waiting');
    assert.deepEqual(
      await query(`SELECT kind FROM ${s}.tf_inbox_items WHERE row_id=$1 AND membership_id=$2 AND resolved_at IS NULL`, [
        second.id,
        workspace.membershipId,
      ]),
      [{ kind: 'waiting' }],
    );
  },
);

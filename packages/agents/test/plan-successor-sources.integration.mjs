import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../tables/test/fixture.mjs';
import { createAgentPlans } from '../src/plans.ts';
import { createPlanRuntime } from '../src/plan-runtime.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { savedTaskAgent } from './task-fixture.mjs';

test('plan successors keep the sources of the results they copy', { timeout: 120000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const [starter, starterMember] = [randomUUID(), randomUUID()];
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    starterMember,
    starter,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, starter, starterMember, [], ['rows.list']);

  const tableTeam = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Private tables')`, [tableTeam]);
  const field = textField('Note');
  const secret = `Private note ${randomUUID()}`;
  const { tableId } = await createTableWithRows({
    db,
    workspace: w,
    runtime,
    definition: tableDefinition({ owningTeamId: tableTeam, label: 'Notes', fields: [field] }),
    records: [{ id: randomUUID(), values: textValues(field, secret) }],
  });
  const grant = () =>
    db.platform.query(
      `INSERT INTO ${table('tf_table_person_grants')} (membership_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [starterMember, tableId],
    );
  const revoke = () =>
    db.platform.query(`DELETE FROM ${table('tf_table_person_grants')} WHERE membership_id=$1 AND asset_id=$2`, [
      starterMember,
      tableId,
    ]);
  const source = { kind: 'table', tableId };
  await grant();

  const plans = createAgentPlans(runtime);
  const tasks = createAgentTasks(runtime);
  const scheduler = createPlanRuntime(runtime, tasks);
  const specialist = {
    key: 'reader',
    name: 'Reader',
    role: 'Reads notes',
    instructions: 'Read the notes.',
    tools: ['rows.get'],
  };
  const create = async () => {
    const chatId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
      [chatId, starter, starterMember],
    );
    return plans.create(w.id, starter, chatId, randomUUID(), {
      title: 'Notes',
      specialists: [specialist],
      tasks: [
        { key: 'read', title: 'Read', assignee: { kind: 'specialist', specialist: 'reader' } },
        { key: 'report', title: 'Report', dependsOn: ['read'], assignee: { kind: 'agent', agentId: agent.agentId } },
        { key: 'review', title: 'Review', dependsOn: ['read'], assignee: { kind: 'specialist', specialist: 'reader' } },
      ],
    });
  };
  const settleRead = async plan => {
    const [attemptId] = (await scheduler.step(w.id, plan.id)).specialists;
    assert.ok(await scheduler.claimSpecialist(w.id, attemptId));
    assert.equal(
      await scheduler.settleSpecialist(
        w.id,
        attemptId,
        { kind: 'completed', result: `Found: ${secret}`, sources: [source] },
        { toolCalls: 1, activeMilliseconds: 10 },
      ),
      true,
    );
  };
  const attempt = async (plan, key) =>
    (
      await db.platform.query(
        `SELECT id, status, failure_code AS failure, agent_task_id AS "agentTaskId" FROM ${table('tf_agent_plan_attempts')} WHERE plan_id=$1 AND task_key=$2 ORDER BY generation DESC LIMIT 1`,
        [plan.id, key],
      )
    ).rows[0];

  const kept = await create();
  await settleRead(kept);
  await scheduler.step(w.id, kept.id);
  const report = await attempt(kept, 'report');
  assert.ok(report.agentTaskId, 'the starter can still read the result, so the successor starts');
  const [first] = (await tasks.history(w.id, starter, report.agentTaskId)).messages;
  assert.match(first.text, new RegExp(secret));
  assert.deepEqual(first.sources, [source], 'the copied result carries its table source');
  const review = await attempt(kept, 'review');
  assert.deepEqual((await scheduler.claimSpecialist(w.id, review.id)).inputSources, [source]);

  const revoked = await create();
  await settleRead(revoked);
  await revoke();
  await assert.rejects(
    tasks.history(w.id, starter, report.agentTaskId),
    AccessDenied,
    'a successor started before revocation is no longer readable',
  );
  await assert.rejects(
    runtime.transaction(w.id, scheduler.compatibility, tx =>
      tasks.requireSources(tx, { kind: 'human', userId: starter, membershipId: starterMember }, [source]),
    ),
    AccessDenied,
  );

  await scheduler.step(w.id, revoked.id);
  const refused = await attempt(revoked, 'report');
  assert.deepEqual(
    [refused.status, refused.failure, refused.agentTaskId],
    ['failed', 'access-revoked', null],
    'a successor does not start with a result its starter can no longer read',
  );
  assert.equal((await plans.read(w.id, starter, revoked.id)).tasks.find(task => task.key === 'report').state, 'failed');
  const pending = await attempt(revoked, 'review');
  assert.deepEqual(
    (await scheduler.claimSpecialist(w.id, pending.id)).inputSources,
    [source],
    'a specialist successor receives the sources its starter must still read',
  );
});

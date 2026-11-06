import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyCommonMigrations, inTransaction, qualified } from '../../src/provisioning.ts';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { fixture } from './fixture.mjs';

test('0041 ends live scheduled runs, keeps them as history and drops agent schedules', async () => {
  const db = await fixture();
  try {
    const current = await workspaceTableMigrations();
    const index = current.findIndex(migration => migration.name === '0041_drop_agent_schedules.sql');
    assert.ok(index > 0);
    const workspace = await db.create(current.slice(0, index));
    const table = name => qualified(workspace.names.schema, name);
    const agentId = randomUUID(),
      activationId = randomUUID(),
      scheduleId = randomUUID(),
      revision = 'a'.repeat(64);
    await db.platform.query(`INSERT INTO ${table('tf_agents')} (id) VALUES ($1)`, [agentId]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,'{}')`,
      [agentId, revision],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,'[]')`,
      [activationId, agentId, revision],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_schedules')} (id,activation_id,scope,sponsor_membership_id) VALUES ($1,$2,'[]',$3)`,
      [scheduleId, activationId, workspace.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_schedule_audience')} (schedule_id,membership_id) VALUES ($1,$2)`,
      [scheduleId, workspace.membershipId],
    );
    const runs = { running: randomUUID(), completed: randomUUID(), delegated: randomUUID() };
    for (const [id, status] of [
      [runs.running, 'running'],
      [runs.completed, 'completed'],
    ])
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,schedule_id,scope,status,sponsor_membership_id) VALUES ($1,$2,$3,$4,'scheduled',$5,'[]',$6,$7)`,
        [id, agentId, activationId, revision, scheduleId, status, workspace.membershipId],
      );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope,status) VALUES ($1,$2,$3,$4,'delegated',$5,$6,'[]','running')`,
      [runs.delegated, agentId, activationId, revision, workspace.userId, workspace.membershipId],
    );
    for (const [run, sequence] of [
      [runs.running, 0],
      [runs.delegated, 0],
    ])
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_tool_calls')} (id,run_id,sequence,call) VALUES ($1,$2,$3,'{}')`,
        [randomUUID(), run, sequence],
      );

    assert.equal(
      await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, current)),
      current.length,
    );

    const relation = async name =>
      (await db.platform.query('SELECT to_regclass($1) AS relation', [table(name)])).rows[0].relation;
    assert.equal(await relation('tf_agent_schedules'), null);
    assert.equal(await relation('tf_agent_schedule_audience'), null);
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'schedule_id' AND table_name LIKE 'tf_agent_%'`,
          [workspace.names.schema],
        )
      ).rows,
      [],
    );
    const status = async id =>
      (await db.platform.query(`SELECT status FROM ${table('tf_agent_runs')} WHERE id = $1`, [id])).rows[0].status;
    assert.equal(await status(runs.running), 'cancelled');
    assert.equal(await status(runs.completed), 'completed');
    assert.equal(await status(runs.delegated), 'running');
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT run_id, status FROM ${table('tf_agent_tool_calls')} WHERE run_id = ANY($1::uuid[]) ORDER BY status`,
          [[runs.running, runs.delegated]],
        )
      ).rows,
      [
        { run_id: runs.running, status: 'blocked' },
        { run_id: runs.delegated, status: 'pending' },
      ],
    );
    await assert.rejects(
      db.platform.query(
        `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,scope) VALUES ($1,$2,$3,$4,'scheduled','[]')`,
        [randomUUID(), agentId, activationId, revision],
      ),
      error => error.code === '23514',
      'no new scheduled run can start',
    );
  } finally {
    await db.close();
  }
});

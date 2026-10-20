import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createSavedAgentService } from '../src/saved-service.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { savedTaskAgent } from './task-fixture.mjs';

test('catalog searches cross page boundaries without exposing unreadable agents, drafts or task sources', async () => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => `"${w.names.schema}".${name}`;
    const user = randomUUID(),
      member = randomUUID(),
      stranger = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
      [member, user, randomUUID(), stranger],
    );
    const agent = await savedTaskAgent(db, w, runtime, user, member);
    const agents = createSavedAgentService(runtime);
    await db.platform.query('BEGIN');
    await db.platform.query('SET CONSTRAINTS ALL DEFERRED');
    await db.platform.query(`UPDATE ${table('tf_agents')} SET saved_revision=NULL WHERE id=$1`, [agent.agentId]);
    const oldRevision = (
      await db.platform.query(`SELECT soul_revision FROM ${table('tf_agent_saved_revisions')} WHERE agent_id=$1`, [
        agent.agentId,
      ])
    ).rows[0].soul_revision;
    await db.platform.query(`DELETE FROM ${table('tf_agent_saved_revisions')} WHERE agent_id=$1`, [agent.agentId]);
    await db.platform.query(`UPDATE ${table('tf_soul_revisions')} SET revision=$2 WHERE revision=$1`, [
      oldRevision,
      'a'.repeat(40),
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
      [agent.agentId, 'a'.repeat(40), agent.revision],
    );
    await db.platform.query(`UPDATE ${table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [
      agent.agentId,
      'a'.repeat(40),
    ]);
    await db.platform.query('COMMIT');
    assert.deepEqual(
      (await agents.list(w.id, user, { search: 'PRIVATE' })).agents.map(item => item.id),
      [agent.agentId],
    );
    assert.equal((await agents.list(w.id, user, { search: '%' })).count, 0);
    assert.equal((await agents.list(w.id, stranger, { search: 'Private' })).count, 0);
    const tasks = createAgentTasks(runtime),
      skills = createWorkspaceSkills(runtime);
    const taskIds = [],
      skillIds = [];
    for (let index = 0; index < 27; index++) {
      taskIds.push(
        (
          await tasks.start(w.id, user, {
            requestId: randomUUID(),
            agentId: agent.agentId,
            text: `Catalog task [${index}]`,
          })
        ).id,
      );
      const id = randomUUID();
      skillIds.push(id);
      await skills.save(w.id, user, id, {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: {
          name: `Catalog skill [${index}]`,
          description: 'Review before changing data.',
          instructions: 'Ask before changing data.',
        },
      });
    }
    const targetTask = taskIds.indexOf([...taskIds].sort().at(-1));
    const targetSkill = skillIds.indexOf([...skillIds].sort().at(-1));
    assert.equal(
      (await tasks.list(w.id, user)).tasks.some(task => task.id === taskIds[targetTask]),
      false,
    );
    assert.deepEqual(
      (await tasks.list(w.id, user, { search: `Catalog task [${targetTask}]` })).tasks.map(task => task.id),
      [taskIds[targetTask]],
    );
    assert.equal(
      (await skills.list(w.id, user)).workspace.some(skill => skill.id === skillIds[targetSkill]),
      false,
    );
    assert.deepEqual(
      (await skills.list(w.id, user, { search: `Catalog skill [${targetSkill}]` })).workspace.map(skill => skill.id),
      [skillIds[targetSkill]],
    );
    assert.deepEqual((await skills.list(w.id, stranger, { search: 'Catalog' })).workspace, []);
    const tableId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'search_source','Source','fixture')`,
      [tableId, agent.teamId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [agent.teamId, tableId],
    );
    await tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Sensitive source request',
      sources: [{ kind: 'table', tableId }],
    });
    await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE asset_id=$1`, [tableId]);
    assert.deepEqual((await tasks.list(w.id, user, { search: 'Sensitive source' })).tasks, []);
    await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
      agent.agentId,
    ]);
    assert.deepEqual((await tasks.list(w.id, user, { search: 'Catalog task' })).tasks, []);
    assert.equal((await tasks.list(w.id, user)).tasks.length, 25);
  } finally {
    await runtime?.close();
    await db.close();
  }
});

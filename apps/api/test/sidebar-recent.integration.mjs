import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createWorkflows } from '@tulipfarm/workflows';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { registerAgents } from '../src/agents.ts';
import { registerAgentTasks } from '../src/agent-tasks.ts';
import { registerWorkflows } from '../src/workflows.ts';
import { protectBusinessRequests } from '../src/business.ts';

test('recent endpoints return the newest three accessible items, not UUID order', { timeout: 60000 }, async t => {
  const f = await knowledgeFixture();
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await f.close();
  });
  protectBusinessRequests(app);
  const workflows = createWorkflows(f.runtime),
    tasks = createAgentTasks(f.runtime);
  registerAgents(app, { runtime: f.runtime, pool: f.signed.identity, auth: f.signed.auth });
  registerAgentTasks(app, { runtime: f.runtime, auth: f.signed.auth });
  registerWorkflows(app, { service: workflows, auth: f.signed.auth });
  const w = f.workspace,
    owner = f.signed.owner;
  const stamp = index => `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`;
  const ids = rows => rows.map(row => row.id);
  async function recent(domain, cookie = owner.cookie, status = 200) {
    const result = await app.inject({
      method: 'GET',
      url: `/workspaces/${w.id}/${domain}/recent`,
      headers: { cookie },
    });
    assert.equal(result.statusCode, status, result.body);
    assert.equal(result.headers['cache-control'], 'no-store');
    return result.json();
  }
  for (const domain of ['agents', 'agent-tasks', 'workflows']) {
    await recent(domain, '', 401);
    assert.deepEqual(await recent(domain), []);
  }
  const agents = [],
    taskIds = [],
    workflowIds = [],
    fileIds = [];
  // Pin fixture times without the production rename trigger preserving its own stamp.
  await f.db.platform.query(`ALTER TABLE ${f.table('tf_files')} DISABLE TRIGGER tf_files_stamp_modified`);
  for (let index = 0; index < 5; index++) {
    const agent = await savedTaskAgent(f.db, w, f.runtime, owner.id, w.membershipId);
    agents.push(agent);
    await f.db.platform.query(`UPDATE ${f.table('tf_teams')} SET name=$2 WHERE id=$1`, [
      agent.teamId,
      `Task invokers ${index}`,
    ]);
    await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET display_name=$2 WHERE id=$1`, [
      agent.agentId,
      `Agent ${index}`,
    ]);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_soul_revisions')} SET accepted_at=$2 WHERE revision=(SELECT saved_revision FROM ${f.table('tf_agents')} WHERE id=$1)`,
      [agent.agentId, stamp(index)],
    );
    const task = await tasks.start(w.id, owner.id, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: `Task\n  ${index}`,
    });
    taskIds.push(task.id);
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET created_at=$2 WHERE id=$1`, [
      task.id,
      stamp(index),
    ]);
    const workflowId = randomUUID(),
      revision = randomUUID();
    workflowIds.push(workflowId);
    await workflows.save(w.id, owner.id, workflowId, {
      revision,
      expectedRevision: null,
      definition: {
        version: 1,
        name: `Workflow ${index}`,
        trigger: { kind: 'manual' },
        steps: [{ id: 'copy', kind: 'transform', fields: { value: { kind: 'literal', value: index } } }],
      },
    });
    await f.db.platform.query(`UPDATE ${f.table('tf_workflow_revisions')} SET created_at=$2 WHERE id=$1`, [
      revision,
      stamp(index),
    ]);
    const fileId = randomUUID();
    fileIds.push(fileId);
    assert.equal((await f.upload(fileId, `Content ${index}`, `File ${index}.txt`)).status, 200);
    await f.db.platform.query(`UPDATE ${f.table('tf_files')} SET modified_at=$2,created_at=$2 WHERE id=$1`, [
      fileId,
      stamp(index),
    ]);
  }
  assert.deepEqual(
    await recent('agents'),
    [4, 3, 2].map(i => ({ id: agents[i].agentId, name: `Agent ${i}` })),
  );
  assert.deepEqual(
    await recent('agent-tasks'),
    [4, 3, 2].map(i => ({ id: taskIds[i], name: `Task ${i}` })),
  );
  assert.deepEqual(
    await recent('workflows'),
    [4, 3, 2].map(i => ({ id: workflowIds[i], name: `Workflow ${i}` })),
  );
  assert.deepEqual(
    await recent('agent-tasks', f.signed.admin.cookie),
    [],
    'workspace admin cannot see another owner tasks',
  );
  assert.deepEqual(await recent('agents', f.signed.admin.cookie), [], 'workspace admin is not an agent grant');
  assert.deepEqual(await recent('workflows', f.signed.admin.cookie), []);
  await f.db.platform.query(`DELETE FROM ${f.table('tf_agent_person_grants')} WHERE agent_id=$1`, [agents[4].agentId]);
  await f.db.platform.query(`DELETE FROM ${f.table('tf_agent_grants')} WHERE agent_id=$1`, [agents[4].agentId]);
  assert.deepEqual(
    ids(await recent('agents')),
    [3, 2, 1].map(i => agents[i].agentId),
    'revoked newest agent is filtered before the cap',
  );
  assert.deepEqual(
    ids(await recent('agent-tasks')),
    [3, 2, 1].map(i => taskIds[i]),
    'revoked invocation hides the task name',
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agents')} SET deleted_at=now() WHERE id=$1`, [agents[3].agentId]);
  assert.deepEqual(
    ids(await recent('agents')),
    [2, 1, 0].map(i => agents[i].agentId),
  );
  await f.db.platform.query(
    `UPDATE ${f.table('tf_agent_task_messages')} SET sources=$2 WHERE task_id=$1 AND role='owner'`,
    [taskIds[2], JSON.stringify([{ kind: 'file', fileId: randomUUID() }])],
  );
  assert.ok(
    !ids(await recent('agent-tasks')).includes(taskIds[2]),
    'a no-longer-readable source hides the private prompt',
  );
  await f.db.platform.query(`DELETE FROM ${f.table('tf_workflow_grants')} WHERE workflow_id=$1`, [workflowIds[4]]);
  await f.db.platform.query(`UPDATE ${f.table('tf_workflows')} SET archived_at=now() WHERE id=$1`, [workflowIds[3]]);
  assert.deepEqual(
    ids(await recent('workflows')),
    [2, 1, 0].map(i => workflowIds[i]),
    'permissions and archive filter precede the limit',
  );

  const fileBase = `/v1/workspaces/${w.id}/files`;
  async function recentFiles(cookie = owner.cookie, after) {
    const response = await f.call(`${fileBase}/recent${after ? `?after=${after}` : ''}`, { cookie });
    assert.equal(response.status, 200, response.bytes.toString());
    return response.json();
  }
  assert.equal((await f.call(`${fileBase}/recent`, { cookie: '' })).status, 401);
  assert.deepEqual(
    ids((await recentFiles()).items),
    [4, 3, 2].map(i => fileIds[i]),
  );
  assert.deepEqual(
    (await f.files.suggestions(w.id, owner.id, { query: '' })).items,
    [],
    'normal suggestions still require prior use',
  );
  const folderId = randomUUID();
  await f.files.createFolder(w.id, owner.id, folderId, { name: 'Nested', parentId: null });
  await f.db.platform.query(`UPDATE ${f.table('tf_files')} SET parent_id=$2 WHERE id=$1`, [fileIds[4], folderId]);
  assert.deepEqual(
    ids((await recentFiles()).items),
    [4, 3, 2].map(i => fileIds[i]),
    'recent includes nested files, not folders',
  );
  assert.deepEqual((await recentFiles(f.signed.admin.cookie)).items, [], 'private files stay private');
  assert.equal((await f.share(fileIds[4], 'viewer')).status, 200);
  assert.deepEqual(ids((await recentFiles(f.signed.admin.cookie)).items), [fileIds[4]]);
  await f.files.trash(w.id, owner.id, folderId, true);
  assert.deepEqual(
    ids((await recentFiles()).items),
    [3, 2, 1].map(i => fileIds[i]),
    'a trashed ancestor hides its descendants',
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_files')} SET modified_at=NULL,created_at=$2 WHERE id=$1`, [
    fileIds[0],
    stamp(6),
  ]);
  await f.db.platform.query(`ALTER TABLE ${f.table('tf_files')} ENABLE TRIGGER tf_files_stamp_modified`);
  const page = await recentFiles();
  assert.deepEqual(
    ids(page.items),
    [0, 3, 2].map(i => fileIds[i]),
    'legacy files use creation time',
  );
  assert.deepEqual(
    ids((await recentFiles(owner.cookie, page.next)).items),
    [fileIds[1]],
    'chronological cursor advances without duplicates',
  );
});

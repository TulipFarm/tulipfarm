import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, PersonalMemoryDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { authorizeMcpSelection, authorizeMcpSources } from '../src/mcp-authority.ts';
import { agentCompatibility } from '../src/store.ts';
import { savedTaskAgent } from './task-fixture.mjs';

test('an MCP selection uses the newest live activation and empties for a task whose activation was revoked', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const slot = { id: 'tickets', serverIdentity: 'b'.repeat(64), tools: [{ name: 'create', revision: 'a'.repeat(64) }] };
  const agent = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId, [], ['rows.list'], [slot]);
  await db.platform.query(`UPDATE ${table('tf_agents')} SET enabled=true WHERE id=$1`, [agent.agentId]);
  const authorize = subject =>
    runtime.transaction(w.id, agentCompatibility, transaction =>
      authorizeMcpSelection({ transaction, actor, subject }),
    );
  const { id: slotId, ...granted } = slot,
    slots = [{ slotId, ...granted }];
  const draft = { kind: 'task-draft', id: randomUUID(), agentId: agent.agentId };

  await agent.activate();
  assert.equal(
    (
      await db.platform.query(
        `SELECT count(*)::integer AS n FROM ${table('tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL`,
        [agent.agentId],
      )
    ).rows[0].n,
    2,
  );
  assert.deepEqual((await authorize(draft)).slots, slots, 'two live activations still allow a selection');

  const taskId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id,status)
    VALUES ($1,$2,$3,$4,$5,$6,'[]','[]','{}',gen_random_uuid(),'completed')`,
    [taskId, w.userId, w.membershipId, agent.agentId, agent.activationId, agent.revision],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,0,0,'owner','Open a ticket.','[]'::jsonb)`,
    [taskId],
  );
  assert.deepEqual((await authorize({ kind: 'task', id: taskId })).slots, slots);

  await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=now() WHERE agent_id=$1`, [
    agent.agentId,
  ]);
  const revoked = await authorize({ kind: 'task', id: taskId });
  assert.deepEqual(revoked.slots, [], 'a task whose activation was revoked opens with no MCP integrations');
  assert.deepEqual(revoked.sources[0], { kind: 'private-task', taskId });
  await assert.rejects(authorize(draft), AccessDenied, 'an agent without a live activation offers no selection');
});

test("MCP source checks accept the requester's own personal memory and refuse other memory, Slack turns and unknown provenance", async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const other = randomUUID();
  await db.platform.query(`INSERT INTO "${w.names.schema}".tf_memberships (id,user_id,role) VALUES ($1,$2,'member')`, [
    other,
    randomUUID(),
  ]);
  const authorize = sources =>
    runtime.transaction(w.id, agentCompatibility, transaction => authorizeMcpSources({ transaction, actor, sources }));

  await authorize([{ kind: 'personal-memory', membershipId: w.membershipId }]);
  await assert.rejects(
    authorize([{ kind: 'personal-memory', membershipId: other }]),
    PersonalMemoryDenied,
    "another member's memory is refused",
  );
  for (const source of [
    { kind: 'shared-slack-turn', eventId: randomUUID() },
    { kind: 'unknown' },
    { kind: 'unavailable' },
  ])
    await assert.rejects(authorize([source]), AccessDenied, `${source.kind} is refused`);
});

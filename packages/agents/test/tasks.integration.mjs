import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { reserveCredits, settleCredits } from '@tulipfarm/workspace-storage/credits';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { registerExtension } from '@tulipfarm/extensions';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

test('member capacity counts active tasks, not completed or failed history, including reopened work', async t => {
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
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const agent = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId);
  const tasks = createAgentTasks(runtime);
  const input = { agentId: agent.agentId, text: 'Check capacity.' };
  const history = (
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id,status)
    SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'[]','[]','{}',gen_random_uuid(),'completed' FROM generate_series(1,1000) RETURNING id`,
      [w.userId, w.membershipId, agent.agentId, agent.activationId, agent.revision],
    )
  ).rows.map(row => row.id);
  const completed = await tasks.start(w.id, w.userId, { ...input, requestId: randomUUID() });
  assert.equal(completed.status, 'pending');
  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='failed' WHERE id=ANY($1::uuid[])`, [history]);
  const failed = await tasks.start(w.id, w.userId, { ...input, requestId: randomUUID() });
  assert.equal(failed.status, 'pending');
  await db.platform.query(
    `UPDATE ${table('tf_agent_tasks')} SET status=CASE WHEN id=$1 THEN 'completed' ELSE 'failed' END WHERE id IN ($1,$2)`,
    [completed.id, failed.id],
  );

  const start = { ...input, requestId: randomUUID() };
  const reopen = { requestId: randomUUID(), expectedGeneration: 0, text: 'Reopen within capacity.' };
  const retry = { requestId: randomUUID(), expectedGeneration: 0, expectedSequence: 0, text: 'Retry within capacity.' };
  for (const status of ['pending', 'waiting-clarification', 'waiting-approval', 'paused']) {
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status=$2 WHERE id=ANY($1::uuid[])`, [
      history,
      status,
    ]);
    await assert.rejects(tasks.start(w.id, w.userId, start), error => error.code === 'task-limit');
    await assert.rejects(tasks.reopen(w.id, w.userId, completed.id, reopen), error => error.code === 'task-limit');
    await assert.rejects(tasks.continueTask(w.id, w.userId, failed.id, retry), error => error.code === 'task-limit');
    await assert.rejects(
      tasks.pause(w.id, w.userId, failed.id, { expectedGeneration: 0 }),
      error => error.code === 'task-limit',
    );
  }
  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [history[0]]);
  const results = await Promise.allSettled([
    tasks.start(w.id, w.userId, start),
    tasks.reopen(w.id, w.userId, completed.id, reopen),
    tasks.continueTask(w.id, w.userId, failed.id, retry),
  ]);
  assert.equal(
    results.filter(result => result.status === 'fulfilled').length,
    1,
    'concurrent admissions share the last slot',
  );
  for (const result of results.filter(result => result.status === 'rejected'))
    assert.equal(result.reason.code, 'task-limit');
  const active = async () =>
    (
      await db.platform.query(
        `SELECT count(*)::integer AS count FROM ${table('tf_agent_tasks')} WHERE owner_membership_id=$1 AND status IN ('pending','waiting-clarification','waiting-approval','paused')`,
        [w.membershipId],
      )
    ).rows[0].count;
  assert.equal(await active(), 1000);
  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='failed' WHERE id=ANY($1::uuid[])`, [history]);
  const reopened = await tasks.reopen(w.id, w.userId, completed.id, reopen);
  const retried = await tasks.continueTask(w.id, w.userId, failed.id, retry);
  const started = await tasks.start(w.id, w.userId, start);
  assert.equal(reopened.status, 'pending');
  assert.equal(retried.status, 'pending');
  assert.equal(started.status, 'pending');
  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='pending' WHERE id=ANY($1::uuid[])`, [
    history.slice(0, 997),
  ]);
  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='paused' WHERE id=$1`, [started.id]);
  assert.equal(await active(), 1000);
  assert.equal(
    (await tasks.continueTask(w.id, w.userId, started.id, { ...retry, requestId: randomUUID() })).status,
    'pending',
    'continuing active work consumes no new slot',
  );
  assert.deepEqual(await tasks.start(w.id, w.userId, start), started);
  assert.deepEqual(await tasks.reopen(w.id, w.userId, completed.id, reopen), reopened);
  assert.deepEqual(await tasks.continueTask(w.id, w.userId, failed.id, retry), retried);
  await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='failed' WHERE id IN ($1,$2)`, [
    failed.id,
    history[0],
  ]);
  assert.equal((await tasks.pause(w.id, w.userId, failed.id, { expectedGeneration: 0 })).status, 'paused');
  assert.equal(await active(), 999);
});

test('private tasks preserve owner incarnation, exact pins, replay, history, references and cumulative flow across reopen', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  const w = await db.create(stream),
    other = await db.create(stream);
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({
      workspaceId: id,
      generation: 1,
      connectionString: db.login(id === w.id ? w : other),
    }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const user = randomUUID(),
    member = randomUUID(),
    stranger = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
    [member, user, randomUUID(), stranger],
  );
  const skills = createWorkspaceSkills(runtime),
    skillId = randomUUID();
  const saved = await skills.save(w.id, user, skillId, {
    requestId: randomUUID(),
    expectedVersion: 0,
    definition: {
      name: 'Reviewed procedure',
      description: 'Inspect records before proposing changes.',
      instructions: 'Inspect before proposing changes.',
    },
  });
  await skills.review(w.id, user, skillId, {
    requestId: randomUUID(),
    expectedVersion: 1,
    revision: saved.savedRevision,
  });
  const selection = [{ id: skillId, revision: saved.savedRevision }];
  const agent = await savedTaskAgent(db, w, runtime, user, member, selection);
  let tasks = createAgentTasks(runtime);
  const input = { requestId: randomUUID(), agentId: agent.agentId, text: 'Clean records only after exact approval.' };
  let first, capped;
  await t.test('concurrent and changed replays never duplicate work or produce an executable run', async () => {
    const receipts = await Promise.all([tasks.start(w.id, user, input), tasks.start(w.id, user, input)]);
    first = receipts[0];
    assert.deepEqual(receipts[1], first);
    assert.equal(first.status, 'pending');
    assert.equal(first.generation, 0);
    await assert.rejects(
      tasks.start(w.id, user, { ...input, text: 'Changed' }),
      error => error.code === 'idempotency-conflict',
    );
    for (const name of ['tf_agent_runs', 'tf_agent_tool_calls', 'tf_agent_chat_turns'])
      assert.equal((await db.platform.query(`SELECT count(*)::integer AS count FROM ${table(name)}`)).rows[0].count, 0);
    assert.deepEqual(
      (await tasks.history(w.id, user, first.id)).messages.map(m => [m.sequence, m.text, m.sources]),
      [[0, input.text, []]],
    );
    assert.deepEqual(
      (await tasks.list(w.id, user, { search: 'CLEAN RECORDS' })).tasks.map(task => task.id),
      [first.id],
    );
    assert.deepEqual((await tasks.list(w.id, user, { search: '%' })).tasks, []);
    for (const who of [stranger, w.userId]) {
      await assert.rejects(tasks.read(w.id, who, first.id), AccessDenied);
      await assert.rejects(tasks.history(w.id, who, first.id), AccessDenied);
      assert.deepEqual((await tasks.list(w.id, who)).tasks, []);
      assert.deepEqual((await tasks.list(w.id, who, { search: 'Clean' })).tasks, []);
    }
    await assert.rejects(tasks.read(other.id, other.userId, first.id), AccessDenied);
  });
  await t.test('agent task maxima clamp starts and continuations', async () => {
    const taskLimits = { toolCalls: 2, credits: 25, activeMilliseconds: 60000 };
    // Configuring the agent creates its limits row; this agent was never configured.
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_limits')} (agent_id,scope,task_limits) VALUES ($1,'[]',$2) ON CONFLICT (agent_id) DO UPDATE SET task_limits=EXCLUDED.task_limits`,
      [agent.agentId, JSON.stringify(taskLimits)],
    );
    try {
      capped = await tasks.start(w.id, user, {
        ...input,
        requestId: randomUUID(),
        limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
      });
      assert.deepEqual((await tasks.read(w.id, user, capped.id)).limits, taskLimits);
      await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='paused' WHERE id=$1`, [capped.id]);
      const sequence = (await tasks.history(w.id, user, capped.id)).messages.at(-1).sequence;
      await tasks.continueTask(w.id, user, capped.id, {
        requestId: randomUUID(),
        expectedGeneration: 0,
        expectedSequence: sequence,
        text: 'Continue within the agent maximum.',
        limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
      });
      assert.deepEqual((await tasks.read(w.id, user, capped.id)).limits, taskLimits);
    } finally {
      // Later tests reopen tasks of this agent and expect its default maxima.
      await db.platform.query(`DELETE FROM ${table('tf_agent_limits')} WHERE agent_id=$1`, [agent.agentId]);
    }
  });
  await t.test(
    'new tasks select latest activation while old tasks retain reviewed procedure and definition revisions',
    async () => {
      const changed = await skills.save(w.id, user, skillId, {
        requestId: randomUUID(),
        expectedVersion: 2,
        definition: {
          name: 'New procedure',
          description: 'A revised process.',
          instructions: 'New reviewed instructions.',
        },
      });
      await skills.review(w.id, user, skillId, {
        requestId: randomUUID(),
        expectedVersion: 3,
        revision: changed.savedRevision,
      });
      const latest = await agent.activate([{ id: skillId, revision: changed.savedRevision }]);
      const second = await tasks.start(w.id, user, { ...input, requestId: randomUUID() });
      assert.equal((await tasks.read(w.id, user, second.id)).activationId, latest.activationId);
      assert.equal((await tasks.read(w.id, user, second.id)).definitionRevision, latest.revision);
      assert.deepEqual((await tasks.read(w.id, user, first.id)).skills, selection);
      assert.equal((await tasks.read(w.id, user, first.id)).definitionRevision, agent.revision);
      const listed = [];
      for (let after; ;) {
        const page = await tasks.list(w.id, user, { limit: 1, ...(after ? { after } : {}) });
        listed.push(...page.tasks.map(item => item.id));
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
      assert.deepEqual(listed.toSorted(), [first.id, capped.id, second.id].toSorted());
    },
  );
  await t.test(
    'only completion permits continuation, replay survives lost acknowledgement, limits and charged versus held costs persist',
    async () => {
      const reopen = { requestId: randomUUID(), expectedGeneration: 0, text: 'Follow up on the same work.' };
      await assert.rejects(tasks.reopen(w.id, user, first.id, reopen), error => error.code === 'task-not-completed');
      const attempt = randomUUID();
      await runtime.transaction(w.id, commonCompatibility, async tx => {
        await reserveCredits(tx, {
          id: attempt,
          flowId: first.id,
          modelId: 'fixture',
          agentId: agent.agentId,
          activity: 'agent',
          providerPicoUsd: '1000000000',
          pricingRevision: 'fixture',
        });
        await settleCredits(tx, attempt, '1000000000');
        await reserveCredits(tx, {
          id: randomUUID(),
          flowId: first.id,
          modelId: 'fixture',
          agentId: agent.agentId,
          activity: 'agent',
          providerPicoUsd: '1000000000',
          pricingRevision: 'fixture',
        });
      });
      await db.platform.query(
        `UPDATE ${table('tf_agent_tasks')} SET status='completed',active_milliseconds=1200,tool_calls=2 WHERE id=$1`,
        [first.id],
      );
      const before = await tasks.read(w.id, user, first.id);
      const receipts = await Promise.all([
        tasks.reopen(w.id, user, first.id, reopen),
        tasks.reopen(w.id, user, first.id, reopen),
      ]);
      assert.deepEqual(receipts, [
        { id: first.id, generation: 1, status: 'pending' },
        { id: first.id, generation: 1, status: 'pending' },
      ]);
      tasks = createAgentTasks(runtime);
      assert.deepEqual(await tasks.reopen(w.id, user, first.id, reopen), receipts[0]);
      await assert.rejects(
        tasks.reopen(w.id, user, first.id, { ...reopen, requestId: randomUUID() }),
        error => error.code === 'generation-conflict',
      );
      const after = await tasks.read(w.id, user, first.id);
      assert.deepEqual(after.cost, { chargedCreditUnits: '1000000000000', heldCreditUnits: '1000000000000' });
      for (const key of [
        'limits',
        'flowId',
        'activeMilliseconds',
        'toolCalls',
        'skills',
        'definitionRevision',
        'activationId',
      ])
        assert.deepEqual(after[key], before[key]);
      const page = await tasks.history(w.id, user, first.id, { limit: 1 });
      assert.equal(page.nextCursor, 0);
      assert.deepEqual(
        (await tasks.history(w.id, user, first.id, { after: page.nextCursor })).messages.map(m => [
          m.sequence,
          m.generation,
          m.text,
        ]),
        [[1, 1, reopen.text]],
      );
    },
  );
  await t.test('explicit references retain a bounded history range and revalidate every linked resource', async () => {
    const tableId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'task_source','Source','fixture')`,
      [tableId, agent.teamId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [agent.teamId, tableId],
    );
    const source = await tasks.start(w.id, user, {
      ...input,
      requestId: randomUUID(),
      sources: [{ kind: 'table', tableId }],
    });
    const reference = { kind: 'task', taskId: source.id, throughSequence: 0 };
    const linked = await tasks.start(w.id, user, { ...input, requestId: randomUUID(), sources: [reference] });
    assert.deepEqual((await tasks.history(w.id, user, linked.id)).messages[0].sources, [reference]);
    await assert.rejects(
      tasks.start(w.id, stranger, { ...input, requestId: randomUUID(), sources: [reference] }),
      AccessDenied,
    );
    await assert.rejects(
      tasks.start(w.id, w.userId, { ...input, requestId: randomUUID(), sources: [reference] }),
      AccessDenied,
    );
    await assert.rejects(
      tasks.start(w.id, user, { ...input, requestId: randomUUID(), sources: [{ ...reference, throughSequence: 99 }] }),
      AccessDenied,
    );
    await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE asset_id=$1`, [tableId]);
    await assert.rejects(tasks.history(w.id, user, linked.id), AccessDenied);
    await assert.rejects(
      tasks.start(w.id, user, { ...input, requestId: randomUUID(), sources: [reference] }),
      AccessDenied,
    );
    assert.equal((await tasks.read(w.id, user, linked.id)).id, linked.id);
    assert.equal((await tasks.history(w.id, user, first.id)).messages[0].text, input.text);
  });
  await t.test('a task reference is admitted only within the runtime message limit', async () => {
    const source = await tasks.start(w.id, user, { ...input, requestId: randomUUID() });
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) SELECT $1,s,0,'owner','m'||s,'[]'::jsonb FROM generate_series(1,100) s`,
      [source.id],
    );
    await assert.rejects(
      tasks.start(w.id, user, {
        ...input,
        requestId: randomUUID(),
        sources: [{ kind: 'task', taskId: source.id, throughSequence: 100 }],
      }),
      { code: 'context-limit' },
    );
    assert.equal(
      (
        await tasks.start(w.id, user, {
          ...input,
          requestId: randomUUID(),
          sources: [{ kind: 'task', taskId: source.id, throughSequence: 99 }],
        })
      ).status,
      'pending',
    );
    await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [source.id]);
    assert.equal(
      (await tasks.reopen(w.id, user, source.id, { requestId: randomUUID(), expectedGeneration: 0, text: 'Again' }))
        .status,
      'pending',
      'a long task can still be reopened',
    );
  });
  await t.test(
    'revocation blocks continuation without hiding safe receipts and never transfers private ownership on rejoin',
    async () => {
      await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [first.id]);
      const reopen = { requestId: randomUUID(), expectedGeneration: 1, text: 'Again' };
      await skills.setEnabled(w.id, user, skillId, { requestId: randomUUID(), expectedVersion: 4, enabled: false });
      await assert.rejects(tasks.reopen(w.id, user, first.id, reopen), AccessDenied);
      assert.equal((await tasks.read(w.id, user, first.id)).status, 'completed');
      await skills.setEnabled(w.id, user, skillId, { requestId: randomUUID(), expectedVersion: 5, enabled: true });
      await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
        member,
        agent.teamId,
      ]);
      await assert.rejects(tasks.reopen(w.id, user, first.id, reopen), AccessDenied);
      await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        member,
        agent.teamId,
      ]);
      await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=now() WHERE id=$1`, [
        agent.activationId,
      ]);
      await assert.rejects(tasks.reopen(w.id, user, first.id, reopen), AccessDenied);
      await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=NULL WHERE id=$1`, [
        agent.activationId,
      ]);
      await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
        agent.agentId,
      ]);
      await assert.rejects(tasks.reopen(w.id, user, first.id, reopen), AccessDenied);
      const login = await connect(db.login(w));
      try {
        for (const sql of [
          `UPDATE ${table('tf_agent_tasks')} SET owner_user_id='stolen'`,
          `UPDATE ${table('tf_agent_tasks')} SET activation_id=gen_random_uuid()`,
          `UPDATE ${table('tf_agent_task_messages')} SET text='forged'`,
          `DELETE FROM ${table('tf_agent_task_commands')}`,
          `SELECT * FROM "${other.names.schema}".tf_agent_tasks`,
        ])
          await denied(login, sql);
      } finally {
        await login.end();
      }
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [member]);
      await assert.rejects(tasks.read(w.id, user, first.id), AccessDenied);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        user,
      ]);
      await assert.rejects(tasks.read(w.id, user, first.id), AccessDenied);
      assert.deepEqual((await tasks.list(w.id, user)).tasks, []);
    },
  );
});

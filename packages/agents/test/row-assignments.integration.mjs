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
import { createInboxSlackNotifier } from '../src/inbox-slack.ts';
import { createRowAssignments, deliverComment } from '../src/row-assignments.ts';
import { createRowWork } from '../src/row-work.ts';

async function harness(t) {
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
  await query(`INSERT INTO ${s}.tf_agent_person_grants(agent_id,membership_id,permission) VALUES($1,$2,'invoke')`, [
    agentId,
    workspace.membershipId,
  ]);

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
  const paused = [];
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
          VALUES($1,$2,$3,$4,$5,$6,'[]','[]',$7,gen_random_uuid())`,
        [
          id,
          userId,
          workspace.membershipId,
          agentId,
          activationId,
          definitionRevision,
          JSON.stringify(input.limits ?? {}),
        ],
      );
      return { id };
    },
    pause: async (_workspace, _user, taskId) => paused.push(taskId),
    wake: async (_workspace, taskId) => woken.push(taskId),
  });

  const transaction = work => runtime.transaction(workspace.id, commonCompatibility, work);
  return {
    workspace,
    runtime,
    s,
    query,
    agentId,
    tableId,
    tables,
    base,
    create,
    runState,
    assignment,
    started,
    woken,
    paused,
    engine,
    activationId,
    definitionRevision,
    transaction,
    refuse: on => (refuse = on),
  };
}

test(
  'assigning a row to an agent queues it, starts one run within limits and stops it on reassignment',
  { timeout: 60000 },
  async t => {
    const { workspace, s, query, agentId, tables, base, create, runState, assignment, started, woken, engine, refuse } =
      await harness(t);
    const first = await create('Call the logistics partner');
    const second = await create('Book the warehouse slot');
    assert.equal(await runState(first.id), 'queued');
    assert.deepEqual(await assignment(first.id), { run_state: 'queued', reason: null, current_task_id: null });

    await engine.step(workspace.id);
    assert.equal(started.length, 1, 'The agent limit of 1 admits one row');
    assert.equal(started[0].agentId, agentId);
    assert.equal(started[0].userId, workspace.userId, 'The run acts for the person who assigned it');
    assert.match(started[0].text, /Call the logistics partner/);
    assert.equal(woken.length, 1);
    assert.equal(await runState(first.id), 'working');
    assert.match((await assignment(second.id)).reason, /Ops Helper is working on 1 rows/);

    await engine.step(workspace.id);
    assert.equal(started.length, 1, 'A step never starts a second run for a working row');

    const current = await tables.read(workspace.id, workspace.userId, { ...base, recordId: first.id });
    await tables.mutate(workspace.id, workspace.userId, {
      ...base,
      kind: 'update',
      recordId: first.id,
      expectedToken: current.token,
      values: { [taskFields.assignee]: { kind: 'actor', actor: { type: 'member', id: workspace.membershipId } } },
    });
    refuse(true);
    await engine.step(workspace.id);
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

const credit = 1_000_000_000_000n;

test(
  'daily credit caps count today in the workspace time zone and limit what each run may spend',
  { timeout: 60000 },
  async t => {
    const { workspace: ws, s, query, agentId, create, assignment, started, engine } = await harness(t);
    await query(`UPDATE ${s}.tf_agent_assignment_limits SET concurrent=5 WHERE agent_id=$1`, [agentId]);
    await query(
      `INSERT INTO ${s}.tf_workspace_assignment_limits(concurrent,time_zone,daily_credits) VALUES(10,'Pacific/Kiritimati',150)`,
    );
    const spend = (flow, credits, at) =>
      query(
        `INSERT INTO ${s}.tf_credit_usage(id,flow_id,model_id,activity,reserved,charged,pricing_revision,created_at)
      VALUES($1,$2,'m','agent',$3,$3,'p',COALESCE($4::timestamptz,clock_timestamp()))`,
        [randomUUID(), flow, String(BigInt(credits) * credit), at ?? null],
      );

    const earlier = await create('Earlier row');
    await engine.step(ws.id);
    assert.equal(started[0].limits.credits, 100, 'Without a cap reached, a run gets the usual 100-credit budget');
    const { current_task_id: earlierTask } = await assignment(earlier.id);
    const [{ flow }] = await query(`SELECT flow_id::text AS flow FROM ${s}.tf_agent_tasks WHERE id=$1`, [earlierTask]);
    await query(`UPDATE ${s}.tf_agent_tasks SET status='completed' WHERE id=$1`, [earlierTask]);
    await spend(flow, 40);
    // 30 credits spent just before whichever midnight, UTC or Kiritimati, came later. They count only when that was
    // the UTC midnight, which proves the cap uses the workspace's day.
    const [{ utc, local }] = await query(
      `SELECT date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS utc,
      date_trunc('day',clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati') AT TIME ZONE 'Pacific/Kiritimati' AS local`,
    );
    const localLater = local > utc;
    await spend(flow, 30, new Date(Math.max(utc.getTime(), local.getTime()) - 60_000));
    const spentToday = 40 + (localLater ? 0 : 30);

    const first = await create('First capped row');
    await engine.step(ws.id);
    const firstCredits = Math.min(100, 150 - spentToday);
    assert.equal(started[1].limits.credits, firstCredits);
    const second = await create('Second capped row');
    const third = await create('Third capped row');
    await engine.step(ws.id);
    const left = 150 - spentToday - firstCredits;
    const held = left >= 1 ? third : second;
    if (left >= 1) assert.equal(started[2].limits.credits, left, 'A working run counts its whole budget');
    assert.equal(
      (await assignment(held.id)).reason,
      'Waiting: the workspace reached its daily credit limit for assigned work',
    );
    assert.equal((await assignment(first.id)).run_state, 'working');

    await query(`UPDATE ${s}.tf_agent_assignment_limits SET daily_credits=1 WHERE agent_id=$1`, [agentId]);
    await query(`UPDATE ${s}.tf_workspace_assignment_limits SET daily_credits=NULL`);
    await engine.step(ws.id);
    assert.equal((await assignment(held.id)).reason, 'Waiting: Ops Helper reached its daily credit limit');
  },
);

test(
  'a comment reaches the working run, and a comment it never saw starts one more run',
  { timeout: 60000 },
  async t => {
    const { workspace: ws, s, query, tableId, create, assignment, started, engine, transaction } = await harness(t);
    const row = await create('Ship the samples');
    await engine.step(ws.id);
    const { current_task_id: taskId } = await assignment(row.id);
    await query(
      `INSERT INTO ${s}.tf_agent_task_messages(task_id,sequence,generation,role,text,sources) VALUES($1,0,0,'owner','brief','[]')`,
      [taskId],
    );
    assert.equal(
      await transaction(tx => deliverComment(tx, tableId, row.id, ws.membershipId, 'Use the blue pallets')),
      true,
    );
    const [message] = await query(
      `SELECT sequence,text FROM ${s}.tf_agent_task_messages WHERE task_id=$1 AND sequence>0`,
      [taskId],
    );
    assert.equal(message.sequence, 1);
    assert.match(message.text, /Use the blue pallets/);

    await query(`UPDATE ${s}.tf_agent_tasks SET status='completed' WHERE id=$1`, [taskId]);
    await engine.step(ws.id);
    assert.equal(started.length, 1);
    assert.equal((await assignment(row.id)).run_state, 'done');
    await engine.step(ws.id);
    assert.equal(started.length, 2, 'The comment arrived after the last model call, so the agent runs again');

    const { current_task_id: secondTask } = await assignment(row.id);
    const [{ flow }] = await query(`SELECT flow_id::text AS flow FROM ${s}.tf_agent_tasks WHERE id=$1`, [secondTask]);
    await query(
      `INSERT INTO ${s}.tf_credit_usage(id,flow_id,model_id,activity,reserved,charged,pricing_revision) VALUES($1,$2,'m','agent',1,1,'p')`,
      [randomUUID(), flow],
    );
    await query(`UPDATE ${s}.tf_agent_tasks SET status='completed' WHERE id=$1`, [secondTask]);
    await engine.step(ws.id);
    await engine.step(ws.id);
    assert.equal(started.length, 2, 'Without an unseen comment the row stays done');
  },
);

test('Inbox items go to Slack once, only for kinds the member keeps on', { timeout: 60000 }, async t => {
  const { workspace: ws, s, query, tableId, create, runtime } = await harness(t);
  const installation = randomUUID();
  await query(
    `INSERT INTO ${s}.tf_slack_installations(id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after)
    VALUES($1,'A0APP','T0TEAM','U0BOT',1,'active','{}','{}',0)`,
    [installation],
  );
  await query(
    `INSERT INTO ${s}.tf_slack_identities(id,installation_id,generation,slack_user_id,user_id,membership_id,state)
    VALUES($1,$2,1,'U0MEMBER',$3,$4,'consent-required')`,
    [randomUUID(), installation, ws.userId, ws.membershipId],
  );
  const row = await create('Call the logistics partner');
  const item = (kind, age = '0 minutes') =>
    query(
      `INSERT INTO ${s}.tf_inbox_items(id,membership_id,kind,table_id,row_id,source_id,summary,created_at)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,gen_random_uuid(),'Asked a question',clock_timestamp()-$5::interval)`,
      [ws.membershipId, kind, tableId, row.id, age],
    );
  await item('waiting');
  await item('mention');
  await item('finished', '2 hours');
  await query(`INSERT INTO ${s}.tf_inbox_slack_muted(membership_id,kind) VALUES($1,'mention')`, [ws.membershipId]);

  const posts = [];
  const fetcher = async (url, init) => {
    if (String(url).endsWith('conversations.open'))
      return Response.json({ ok: true, channel: { id: 'D0MEMBER', is_im: true, user: 'U0MEMBER' } });
    posts.push(JSON.parse(init.body));
    return Response.json({ ok: true, channel: 'D0MEMBER', ts: '1700000000.000100' });
  };
  const notifier = createInboxSlackNotifier({
    runtime,
    appId: 'A0APP',
    cipher: { decrypt: () => 'xoxb-test' },
    rowLink: async () => 'https://app.example/acme/tables/t?row=r',
    fetcher,
  });
  assert.equal(await notifier.notify(ws.id), 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'D0MEMBER');
  assert.match(posts[0].text, /Waiting for you/);
  assert.match(posts[0].text, /Call the logistics partner/);
  assert.equal(await notifier.notify(ws.id), 0, 'Each item is sent at most once');
  assert.deepEqual(await query(`SELECT count(*)::int AS n FROM ${s}.tf_inbox_items WHERE notified_at IS NULL`), [
    { n: 0 },
  ]);
});

test('a working run stops when its agent is turned off or its sponsor leaves', { timeout: 60000 }, async t => {
  const { workspace: ws, s, query, agentId, create, assignment, paused, started, engine } = await harness(t);
  const row = await create('Reconcile the invoices');
  await engine.step(ws.id);
  const { current_task_id: taskId } = await assignment(row.id);
  await query(`UPDATE ${s}.tf_agents SET enabled=false WHERE id=$1`, [agentId]);
  await engine.step(ws.id);
  assert.deepEqual(paused, [taskId]);
  assert.deepEqual(await assignment(row.id), {
    run_state: 'waiting',
    reason: 'Agent unavailable',
    current_task_id: null,
  });
  await engine.step(ws.id);
  assert.equal(started.length, 1, 'No new run starts by itself');

  await query(`UPDATE ${s}.tf_agents SET enabled=true WHERE id=$1`, [agentId]);
  const other = await create('Chase the late payment');
  await engine.step(ws.id);
  assert.equal((await assignment(other.id)).run_state, 'working');
  await query(`UPDATE ${s}.tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`, [ws.membershipId]);
  await engine.step(ws.id);
  assert.deepEqual(await assignment(other.id), {
    run_state: 'waiting',
    reason: 'Needs reassignment',
    current_task_id: null,
  });
});

test('the Tasks page reads live activity and marks tasks done or reopens them', { timeout: 60000 }, async t => {
  const {
    workspace: ws,
    s,
    query,
    tableId,
    tables,
    base,
    create,
    runState,
    assignment,
    engine,
    runtime,
  } = await harness(t);
  const work = createRowWork(runtime, commonCompatibility);
  assert.deepEqual(await work.tasksTable(ws.id, ws.userId), { tableId });

  const running = await create('Reconcile the invoices');
  const waiting = await create('Chase the late payment');
  await engine.step(ws.id);
  const activity = await work.taskActivity(ws.id, ws.userId);
  assert.equal(activity.tableId, tableId);
  assert.equal(activity.me, ws.membershipId);
  const byRow = new Map(activity.tasks.map(task => [task.rowId, task]));
  assert.equal(byRow.get(running.id).runState, 'working');
  assert.equal(byRow.get(running.id).run.steps, 0);
  assert.equal(byRow.get(waiting.id).runState, 'queued');
  assert.match(byRow.get(waiting.id).reason, /working on 1 rows/);

  await assert.rejects(work.completeTask(ws.id, ws.userId, tableId, running.id), { code: 'run-state-protected' });
  await assert.rejects(work.reopenTask(ws.id, ws.userId, tableId, waiting.id), { code: 'run-state-protected' });

  await work.completeTask(ws.id, ws.userId, tableId, waiting.id);
  assert.equal((await assignment(waiting.id)).run_state, 'done');
  assert.equal(await runState(waiting.id), 'done');
  assert.deepEqual(
    await query(`SELECT count(*)::int AS n FROM ${s}.tf_inbox_items WHERE row_id=$1 AND resolved_at IS NULL`, [
      waiting.id,
    ]),
    [{ n: 0 }],
    'A done task leaves nothing open in the Inbox',
  );

  const plain = await tables.mutate(ws.id, ws.userId, {
    ...base,
    kind: 'create',
    recordId: randomUUID(),
    values: { [taskFields.title]: { kind: 'text', value: 'Order new labels' } },
  });
  await work.completeTask(ws.id, ws.userId, tableId, plain.id);
  assert.equal(await runState(plain.id), 'done');
  await work.reopenTask(ws.id, ws.userId, tableId, plain.id);
  assert.equal(await runState(plain.id), null);
  assert.deepEqual(
    (
      await query(
        `SELECT event->>'type' AS type FROM ${s}.tf_row_thread_items WHERE row_id=$1 AND kind='event' ORDER BY created_at`,
        [plain.id],
      )
    ).map(row => row.type),
    ['marked-done', 'reopened'],
  );
});

test(
  'a run that hands its browser to a person puts a browser item in the owner’s Inbox',
  { timeout: 60000 },
  async t => {
    const { workspace, runtime, s, query, agentId, activationId, definitionRevision, create, assignment, engine } =
      await harness(t);
    const row = await create('Download the latest invoice');
    await engine.step(workspace.id);
    const taskId = (await assignment(row.id)).current_task_id;
    const runId = randomUUID();
    await query(
      `INSERT INTO ${s}.tf_agent_runs(id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope,task_id,task_generation)
      VALUES($1,$2,$3,$4,'delegated',$5,$6,'[]',$7,0)`,
      [runId, agentId, activationId, definitionRevision, workspace.userId, workspace.membershipId, taskId],
    );
    await query(
      `INSERT INTO ${s}.tf_agent_tool_calls(id,run_id,sequence,call,status,result) VALUES($1,$2,0,$3,'waiting',$4)`,
      [
        randomUUID(),
        runId,
        JSON.stringify({ tool: 'browser.handoff', reason: 'Solve the captcha' }),
        JSON.stringify({ browser: { status: 'waiting-for-person' }, waitingUntil: new Date(Date.now() + 3600000) }),
      ],
    );
    await query(`UPDATE ${s}.tf_agent_tasks SET status='waiting-approval' WHERE id=$1`, [taskId]);
    await engine.step(workspace.id);
    assert.deepEqual(
      await query(`SELECT kind,source_id,summary FROM ${s}.tf_inbox_items WHERE row_id=$1 AND resolved_at IS NULL`, [
        row.id,
      ]),
      [{ kind: 'waiting', source_id: taskId, summary: 'An agent needs you to take over its browser' }],
    );
    const { items } = await createRowWork(runtime, commonCompatibility).inbox(workspace.id, workspace.userId);
    assert.equal(items.find(item => item.rowId === row.id)?.taskId, taskId, 'the item opens the run and its browser');
  },
);

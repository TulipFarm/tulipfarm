import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows, WorkflowConflict } from '../src/service.ts';
import { providerSetupFetch } from './provider-fixture.mjs';
import { activate } from './commands.fixture.mjs';

test(
  'restricted persistence pins revisions, deduplicates starts, resumes waits and blocks revoked authority',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, login;
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
      const service = createWorkflows(runtime),
        id = randomUUID(),
        revision = randomUUID();
      const table = name => qualified(w.names.schema, name);
      const definition = {
        version: 1,
        name: 'Review order',
        trigger: { kind: 'manual' },
        steps: [
          { id: 'copy', kind: 'transform', fields: { amount: { kind: 'input', path: ['amount'] } } },
          { id: 'review', kind: 'human', prompt: 'Approve this order?', timeoutSeconds: 60 },
          {
            id: 'result',
            kind: 'transform',
            fields: { approved: { kind: 'step', step: 'review', path: ['approved'] } },
          },
        ],
      };
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      assert.equal((await service.list(w.id, w.userId))[0].definition.name, 'Review order');
      await assert.rejects(
        service.start(w.id, w.userId, id, { requestId: randomUUID(), input: {} }),
        /workflow-disabled/,
      );
      await activate(service, w.id, w.userId, id, revision, true);
      const request = { requestId: randomUUID(), input: { amount: 12 } };
      const [first, duplicate] = await Promise.all([
        service.start(w.id, w.userId, id, request),
        service.start(w.id, w.userId, id, request),
      ]);
      assert.deepEqual(first, duplicate);
      await assert.rejects(service.start(w.id, w.userId, id, { ...request, input: { amount: 13 } }), WorkflowConflict);
      const work = { workspaceId: w.id, runId: first.runId };
      assert.deepEqual(await service.advance(work), { kind: 'continue' });
      assert.deepEqual(await service.advance(work), { kind: 'wait', seconds: 60 });
      const next = randomUUID();
      await service.save(w.id, w.userId, id, {
        revision: next,
        expectedRevision: revision,
        definition: { ...definition, name: 'Edited' },
      });
      await activate(service, w.id, w.userId, id, next, true);
      assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs))[0].revision, revision);
      const response = { stepId: 'review', responseId: randomUUID(), output: { approved: true } };
      await service.respond(w.id, w.userId, id, first.runId, response);
      assert.deepEqual(await service.respond(w.id, w.userId, id, first.runId, response), { saved: true });
      const restarted = createWorkflows(runtime);
      await restarted.advance(work);
      await restarted.advance(work);
      const history = await restarted.history(w.id, w.userId, id).then(page => page.runs);
      assert.equal(history[0].status, 'completed');
      assert.deepEqual(
        history[0].steps.map(step => step.output),
        [{ amount: 12 }, { approved: true }, { approved: true }],
      );
      const blocked = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: { amount: 5 } });
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      assert.deepEqual(await service.advance({ workspaceId: w.id, runId: blocked.runId }), { kind: 'done' });
      await assert.rejects(service.list(w.id, w.userId), AccessDenied);
      assert.equal(
        (await db.platform.query(`SELECT status FROM ${table('tf_workflow_runs')} WHERE id=$1`, [blocked.runId]))
          .rows[0].status,
        'blocked',
      );
      login = await connect(db.login(w));
      await denied(login, `UPDATE ${table('tf_workflow_revisions')} SET definition='{}'`);
      await denied(login, `UPDATE ${table('tf_workflow_runs')} SET input='{}'`);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL,role='member' WHERE id=$1`, [
        w.membershipId,
      ]);
      const waiting = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: { amount: 5 } });
      const waitingWork = { workspaceId: w.id, runId: waiting.runId };
      await service.advance(waitingWork);
      await service.advance(waitingWork);
      await activate(service, w.id, w.userId, id, next, false);
      await activate(service, w.id, w.userId, id, next, true);
      await service.advance(waitingWork);
      assert.equal(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).find(run => run.id === waiting.runId)
          .status,
        'blocked',
        'disable permanently fences existing runs even after reenable',
      );
      const expiring = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: { amount: 5 } });
      const expiringWork = { workspaceId: w.id, runId: expiring.runId };
      await service.advance(expiringWork);
      await service.advance(expiringWork);
      await db.platform.query(
        `UPDATE ${table('tf_workflow_steps')} SET due_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,
        [expiring.runId],
      );
      await assert.rejects(
        service.respond(w.id, w.userId, id, expiring.runId, { ...response, responseId: randomUUID() }),
        /wait-closed/,
      );
      await service.advance(expiringWork);
      assert.equal(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).find(run => run.id === expiring.runId)
          .error,
        'human-input-expired',
      );
    } finally {
      await login?.end();
      await runtime?.close();
      await db.close();
    }
  },
);

test('the schedule sweep reads due workflows through the next_run_at index', { timeout: 120000 }, async () => {
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
    const plans = [];
    const explaining = {
      ...runtime,
      transaction: (workspaceId, compatibility, operation) =>
        runtime.transaction(workspaceId, compatibility, tx =>
          operation({
            ...tx,
            client: new Proxy(tx.client, {
              get(client, key) {
                if (key !== 'query') {
                  const value = client[key];
                  return typeof value === 'function' ? value.bind(client) : value;
                }
                return async (sql, params) => {
                  if (typeof sql === 'string' && /w\.next_run_at\s*<=/.test(sql)) {
                    // An empty table always plans as a sequential scan; disabling it shows whether the index can serve this query.
                    await client.query('SET LOCAL enable_seqscan = off');
                    plans.push((await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN']);
                  }
                  return client.query(sql, params);
                };
              },
            }),
          }),
        ),
    };
    await createWorkflows(explaining).due(w.id);
    const conditions = [];
    const visit = node => {
      if (node['Index Name'] === 'tf_workflow_schedule_due') conditions.push(node['Index Cond']);
      (node.Plans ?? []).forEach(visit);
    };
    plans.forEach(plan => visit(plan[0].Plan));
    assert.equal(plans.length, 1);
    assert.equal(conditions.length, 1);
    assert.match(conditions[0], /^\(next_run_at <= /);
  } finally {
    await runtime?.close();
    await db.close();
  }
});

test(
  'one workflow failing inside the sweep is recorded and the other workflows still fire',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const broken = new Set();
      const failing = {
        ...runtime,
        transaction: (workspaceId, compatibility, operation) =>
          runtime.transaction(workspaceId, compatibility, tx =>
            operation({
              ...tx,
              client: new Proxy(tx.client, {
                get(client, key) {
                  if (key !== 'query') {
                    const value = client[key];
                    return typeof value === 'function' ? value.bind(client) : value;
                  }
                  return async (sql, params) => {
                    // The run row is already written when the audience insert fails, so the rollback has partial work to discard.
                    if (
                      typeof sql === 'string' &&
                      sql.includes('INSERT INTO') &&
                      sql.includes('tf_workflow_run_audience') &&
                      broken.has(params?.[1])
                    )
                      await client.query('SELECT 1/0');
                    return client.query(sql, params);
                  };
                },
              }),
            }),
          ),
      };
      const keyring = { activeKeyId: 'test', keys: { test: '07'.repeat(32) } };
      const service = createWorkflows(failing, { keyring, providerFetch: providerSetupFetch });
      const integrationId = randomUUID();
      await service.providers.create(w.id, w.userId, {
        id: integrationId,
        name: 'Orders',
        token: 'fixture',
        source: { provider: 'sheets', spreadsheetId: 'orders', range: 'Orders!A2:B1000', keyColumn: 0 },
        consent: true,
      });
      const steps = [{ id: 'copy', kind: 'transform', fields: { at: { kind: 'input', path: [] } } }];
      const launch = async trigger => {
        const id = randomUUID(),
          revision = randomUUID();
        await service.save(w.id, w.userId, id, {
          revision,
          expectedRevision: null,
          definition: { version: 1, name: 'Sweep', trigger, steps },
        });
        await service.sponsorship(w.id, w.userId, id, {
          sponsorMembershipId: w.membershipId,
          historyAudience: [w.membershipId],
        });
        await activate(service, w.id, w.userId, id, revision, true);
        return { id, revision };
      };
      const brokenSchedule = await launch({ kind: 'interval', minutes: 60 }),
        healthySchedule = await launch({ kind: 'interval', minutes: 60 });
      const brokenProvider = await launch({ kind: 'provider', integrationId, event: 'created', minutes: 1 }),
        healthyProvider = await launch({ kind: 'provider', integrationId, event: 'created', minutes: 1 });
      const event = ({ id, revision }, key, age) =>
        db.platform.query(
          `INSERT INTO ${table('tf_provider_events')} (workflow_id,revision,event_key,payload,created_at) VALUES ($1,$2,$3,$4,clock_timestamp()-$5*interval '1 second')`,
          [id, revision, key, JSON.stringify({ values: [key] }), age],
        );
      for (let n = 0; n < 20; n++) await event(brokenProvider, `row-${n}`, 100 - n);
      await event(healthyProvider, 'row-0', 1);
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=date_trunc('second',clock_timestamp())-interval '2 minutes' WHERE id=$1`,
        [brokenSchedule.id],
      );
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [healthySchedule.id],
      );
      const nextRun = async ({ id }) =>
        (
          await db.platform.query(
            `SELECT to_char(next_run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM ${table('tf_workflows')} WHERE id=$1`,
            [id],
          )
        ).rows[0].at;
      const originalDue = await nextRun(brokenSchedule);
      const history = ({ id }) => service.history(w.id, w.userId, id).then(page => page.runs);
      const runs = async workflow => (await history(workflow)).map(run => [run.source, run.status]);
      const failures = async ({ id }) =>
        (
          await db.platform.query(
            `SELECT actor_id,operation FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation LIKE 'workflow.sweep%'`,
            [id],
          )
        ).rows;
      const recorded = [{ actor_id: 'system:workflow-sweep', operation: 'workflow.sweep-failed' }];

      broken.add(brokenSchedule.id).add(brokenProvider.id);
      const dispatched = await service.due(w.id);
      assert.deepEqual(
        await runs(healthySchedule),
        [['schedule', 'queued']],
        'a schedule swept after a failed one still fires',
      );
      assert.deepEqual(
        dispatched.map(work => work.runId),
        (await history(healthySchedule)).map(run => run.id),
        'the sweep still dispatches the admitted run',
      );
      for (const workflow of [brokenSchedule, brokenProvider]) {
        assert.deepEqual(await runs(workflow), [], 'the failed workflow keeps none of its partial work');
        assert.deepEqual(
          await failures(workflow),
          recorded,
          "the sweep records the failure once, and skips the failed workflow's other events",
        );
      }
      assert.equal(await nextRun(brokenSchedule), originalDue, 'the failed schedule keeps its due time');
      assert.equal(
        (await service.list(w.id, w.userId)).find(item => item.id === brokenSchedule.id).enabled,
        true,
        'a failure does not disable the workflow',
      );

      await service.due(w.id);
      assert.deepEqual(
        await runs(healthyProvider),
        [['provider', 'queued']],
        "a failed workflow's backlog no longer fills the sweep ahead of other events",
      );
      for (const workflow of [brokenSchedule, brokenProvider])
        assert.deepEqual(
          await failures(workflow),
          recorded,
          'a failed workflow sits out the sweeps right after its failure',
        );

      broken.clear();
      await db.platform.query(
        `UPDATE ${table('tf_audit_events')} SET created_at=created_at-interval '6 minutes' WHERE operation='workflow.sweep-failed'`,
      );
      await service.due(w.id);
      assert.deepEqual(
        (await history(brokenSchedule)).map(run => [run.status, run.input]),
        [['queued', { scheduledFor: originalDue }]],
        'the retried schedule fires for its original due time',
      );
      assert.equal(
        (await runs(brokenProvider)).length,
        10,
        "the failed workflow's events are admitted up to its run cap once the failure clears",
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);

import assert from 'node:assert/strict';
import { activate } from './commands.fixture.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';

test(
  'a scheduled run admitted by the sweep completes through businessWorkflowV1 and blocks the next tick while in flight',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, native, connection, worker, running;
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
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Hourly digest',
          trigger: { kind: 'cron', expression: '0 * * * *', timezone: 'Europe/London' },
          steps: [
            { id: 'pause', kind: 'delay', seconds: 2 },
            { id: 'result', kind: 'transform', fields: { done: { kind: 'literal', value: true } } },
          ],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, revision, true);
      const elapse = () =>
        db.databaseAdmin.query(
          `UPDATE "${w.names.schema}".tf_workflows SET next_run_at=clock_timestamp()-interval '2 hours' WHERE id=$1`,
          [id],
        );
      native = await NativeConnection.connect({ address: '127.0.0.1:7233' });
      connection = await Connection.connect({ address: '127.0.0.1:7233' });
      const client = new Client({ connection }),
        taskQueue = `workflow-schedule-${randomUUID()}`;
      worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../src/temporal.ts', import.meta.url)),
        activities: { advanceWorkflow: work => service.advance(work) },
      });
      running = worker.run();
      const dispatch = async () =>
        Promise.all(
          (await service.due(w.id)).map(work =>
            client.workflow.start('businessWorkflowV1', {
              workflowId: `business-workflow-v1-${work.workspaceId}-${work.runId}`,
              taskQueue,
              args: [work],
              workflowIdConflictPolicy: 'USE_EXISTING',
              workflowIdReusePolicy: 'ALLOW_DUPLICATE',
            }),
          ),
        );

      await elapse();
      const [handle, ...rest] = await dispatch();
      assert.ok(handle);
      assert.equal(rest.length, 0);
      for (
        let attempt = 0;
        attempt < 100 && (await service.history(w.id, w.userId, id).then(page => page.runs))[0]?.status !== 'waiting';
        attempt++
      )
        await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs))[0].status, 'waiting');
      await elapse();
      const duringRun = await dispatch();
      const suppressed = await service.history(w.id, w.userId, id).then(page => page.runs);
      assert.deepEqual(
        suppressed.filter(run => run.status !== 'skipped').map(run => run.source),
        ['schedule'],
        'the in-flight scheduled run suppresses the next occurrence',
      );
      assert.equal(
        suppressed.find(run => run.error === 'previous-run-unfinished')?.input.missedCount,
        3,
        'the suppressed occurrence and the two hourly ticks missed before the sweep are recorded together',
      );
      assert.equal(
        suppressed.filter(run => run.error === 'missed-occurrences-coalesced').length,
        1,
        'only the admitted late run records coalesced ticks',
      );
      assert.equal(duringRun.length, 1, 'only the in-flight run is redispatched');
      await handle.result();

      const runs = (await service.history(w.id, w.userId, id).then(page => page.runs)).filter(
        run => run.status !== 'skipped',
      );
      assert.deepEqual(
        runs.map(run => [run.source, run.status]),
        [['schedule', 'completed']],
      );
      assert.deepEqual(
        runs[0].steps.map(step => step.output),
        [null, { done: true }],
      );
      const next = (await service.list(w.id, w.userId)).find(item => item.id === id).nextRunAt;
      assert.ok(Date.parse(next) > Date.now() && new Date(next).getUTCMinutes() === 0, next);
      assert.ok(
        (await handle.fetchHistory()).events.some(event => event.timerStartedEventAttributes),
        'the delay step used a durable Temporal timer',
      );
    } finally {
      if (worker) {
        worker.shutdown();
        await running;
      }
      await native?.close();
      await connection?.close();
      await runtime?.close();
      await db.close();
    }
  },
);

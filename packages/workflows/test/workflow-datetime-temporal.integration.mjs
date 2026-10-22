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

test('a due one-time trigger runs a short delay step to completion on real Temporal', { timeout: 120000 }, async () => {
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
        name: 'Scheduled pause',
        trigger: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString() },
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
    await db.platform.query(
      `UPDATE "${w.names.schema}".tf_workflows SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [id],
    );
    const [work] = await service.due(w.id);
    assert.ok(work, 'The due sweep admits the one-time run');
    native = await NativeConnection.connect({ address: '127.0.0.1:7233' });
    connection = await Connection.connect({ address: '127.0.0.1:7233' });
    const client = new Client({ connection }),
      taskQueue = `workflow-datetime-${randomUUID()}`;
    worker = await Worker.create({
      connection: native,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../src/temporal.ts', import.meta.url)),
      activities: { advanceWorkflow: work => service.advance(work) },
    });
    running = worker.run();
    const started = Date.now();
    const handle = await client.workflow.start('businessWorkflowV1', {
      workflowId: `datetime-${work.runId}`,
      taskQueue,
      args: [work],
    });
    await handle.result();
    assert.ok(Date.now() - started >= 2000, 'The run waited for the delay');
    const [run] = await service.history(w.id, w.userId, id).then(page => page.runs);
    assert.equal(run.source, 'schedule');
    assert.equal(run.status, 'completed');
    assert.deepEqual(
      run.steps.map(step => [step.stepId, step.status, step.output]),
      [
        ['pause', 'completed', null],
        ['result', 'completed', { done: true }],
      ],
    );
    assert.ok(
      (await handle.fetchHistory()).events.some(event => event.timerStartedEventAttributes),
      'The delay used a durable timer',
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
});

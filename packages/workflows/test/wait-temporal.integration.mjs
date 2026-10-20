import assert from 'node:assert/strict';
import { activate } from './commands.fixture.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { businessWorkflowId, wakeSignal } from '../src/contracts.ts';

const address = process.env.TASK_TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const day = 86400;

test(
  'long waits use one durable timer that cancel, disable, responses and elapsed due times end promptly',
  { timeout: 180000 },
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
      native = await NativeConnection.connect({ address });
      connection = await Connection.connect({ address });
      const client = new Client({ connection }),
        taskQueue = `workflow-wait-${randomUUID()}`;
      const wake = async work => {
        try {
          await client.workflow.getHandle(businessWorkflowId(work)).signal(wakeSignal);
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError)) throw error;
        }
      };
      const service = createWorkflows(runtime, { wake });
      let advances = 0;
      worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../src/temporal.ts', import.meta.url)),
        activities: {
          advanceWorkflow: work => {
            advances++;
            return service.advance(work);
          },
        },
      });
      running = worker.run();

      const create = async (name, steps) => {
        const id = randomUUID(),
          revision = randomUUID();
        await service.save(w.id, w.userId, id, {
          revision,
          expectedRevision: null,
          definition: { version: 1, name, trigger: { kind: 'manual' }, steps },
        });
        await activate(service, w.id, w.userId, id, revision, true);
        return { id, revision };
      };
      const launch = async (workflow, input = {}) => {
        const { runId } = await service.start(w.id, w.userId, workflow.id, { requestId: randomUUID(), input });
        const work = { workspaceId: w.id, runId };
        return client.workflow.start('businessWorkflowV1', {
          workflowId: businessWorkflowId(work),
          taskQueue,
          args: [work],
        });
      };
      const run = async (workflow, handle) =>
        (await service.history(w.id, w.userId, workflow.id).then(page => page.runs)).find(item =>
          handle.workflowId.endsWith(item.id),
        );
      const waiting = async (workflow, handle) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (
            (await run(workflow, handle))?.status === 'waiting' &&
            (await handle.fetchHistory()).events.some(event => event.timerStartedEventAttributes)
          )
            return;
          await delay(50);
        }
        assert.fail('run reached its waiting timer');
      };
      const timers = async handle =>
        (await handle.fetchHistory()).events
          .filter(event => event.timerStartedEventAttributes)
          .map(event => Number(String(event.timerStartedEventAttributes.startToFireTimeout.seconds)));
      const settled = (handle, limit = 10000) =>
        Promise.race([handle.result(), delay(limit).then(() => assert.fail('workflow finished promptly'))]);

      const longDelay = await create('Long delay', [
        { id: 'pause', kind: 'delay', seconds: 300 * day },
        { id: 'done', kind: 'transform', fields: { ok: { kind: 'literal', value: true } } },
      ]);
      const elapsed = await launch(longDelay);
      await waiting(longDelay, elapsed);
      const before = advances;
      await delay(2000);
      assert.equal(advances, before, 'A waiting run makes no activity calls');
      assert.deepEqual(await timers(elapsed), [300 * day], 'One durable timer covers the whole 300-day delay');
      await db.platform.query(
        `UPDATE "${w.names.schema}".tf_workflow_steps SET due_at=clock_timestamp() WHERE run_id=$1`,
        [(await run(longDelay, elapsed)).id],
      );
      await elapsed.signal(wakeSignal);
      await settled(elapsed);
      const finished = await run(longDelay, elapsed);
      assert.equal(finished.status, 'completed');
      assert.deepEqual(
        finished.steps.map(step => [step.stepId, step.status, step.output]),
        [
          ['pause', 'completed', null],
          ['done', 'completed', { ok: true }],
        ],
      );

      const cancelled = await launch(longDelay);
      await waiting(longDelay, cancelled);
      assert.deepEqual(await timers(cancelled), [300 * day]);
      await service.cancel(w.id, w.userId, longDelay.id, (await run(longDelay, cancelled)).id);
      await settled(cancelled);
      assert.equal((await run(longDelay, cancelled)).status, 'cancelled');
      assert.ok(
        (await cancelled.fetchHistory()).events.some(event => event.timerCanceledEventAttributes),
        'Cancel interrupts the timer',
      );

      const reminder = await create('Reminder', [
        { id: 'request', kind: 'transform', fields: { due: { kind: 'input', path: ['contract', 'start'] } } },
        { id: 'start', kind: 'wait-until', at: { kind: 'step', step: 'request', path: ['due'] } },
        { id: 'done', kind: 'transform', fields: { ok: { kind: 'literal', value: true } } },
      ]);
      const due = new Date(Math.ceil(Date.now() / 1000) * 1000 + 4000).toISOString();
      const started = Date.now();
      const scheduled = await launch(reminder, { contract: { start: due } });
      await waiting(reminder, scheduled);
      assert.equal((await run(reminder, scheduled)).steps[1].dueAt, due, 'History shows when the wait ends');
      await settled(scheduled, 15000);
      assert.ok(Date.now() >= Date.parse(due), 'The run waited until the instant');
      assert.ok(Date.now() - started < 12000, 'The run continued right after the instant');
      assert.equal((await run(reminder, scheduled)).status, 'completed');
      assert.equal((await timers(scheduled)).length, 1, 'One timer covered the wait-until step');

      const disabled = await launch(reminder, {
        contract: { start: new Date(Date.now() + 200 * day * 1000).toISOString() },
      });
      await waiting(reminder, disabled);
      await activate(service, w.id, w.userId, reminder.id, reminder.revision, false);
      await settled(disabled);
      const blocked = await run(reminder, disabled);
      assert.deepEqual([blocked.status, blocked.error], ['blocked', 'workflow-disabled']);
      await activate(service, w.id, w.userId, reminder.id, reminder.revision, true);

      for (const [input, error] of [
        [{ contract: { start: 'soon' } }, 'wait-until-invalid'],
        [{ contract: { start: null } }, 'wait-until-invalid'],
        [{ contract: { start: new Date(Date.now() + 400 * day * 1000).toISOString() } }, 'wait-until-too-far'],
      ]) {
        const handle = await launch(reminder, input);
        await settled(handle);
        const failed = await run(reminder, handle);
        assert.deepEqual([failed.status, failed.error], ['failed', error]);
        assert.deepEqual(
          failed.steps.map(step => step.stepId),
          ['request'],
          'A rejected instant leaves no waiting step',
        );
      }
      const past = await launch(reminder, { contract: { start: '2020-01-01' } });
      await settled(past);
      assert.equal((await run(reminder, past)).status, 'completed', 'A passed instant continues immediately');

      const review = await create('Review', [
        { id: 'review', kind: 'human', prompt: 'Approve?', timeoutSeconds: 30 * day },
        { id: 'done', kind: 'transform', fields: { decision: { kind: 'step', step: 'review', path: ['approved'] } } },
      ]);
      const answered = await launch(review);
      await waiting(review, answered);
      assert.deepEqual(await timers(answered), [30 * day]);
      await service.respond(w.id, w.userId, review.id, (await run(review, answered)).id, {
        stepId: 'review',
        responseId: randomUUID(),
        output: { approved: true },
      });
      await settled(answered);
      const reviewed = await run(review, answered);
      assert.equal(reviewed.status, 'completed');
      assert.deepEqual(reviewed.steps.at(-1).output, { decision: true });

      const silent = createWorkflows(runtime, { wake: async () => {} });
      const lost = await launch(review);
      await waiting(review, lost);
      const lostRun = (await run(review, lost)).id;
      assert.deepEqual(await silent.resumable(w.id), [], 'Waiting runs are not resumable');
      await silent.respond(w.id, w.userId, review.id, lostRun, {
        stepId: 'review',
        responseId: randomUUID(),
        output: { approved: false },
      });
      await delay(1000);
      assert.equal((await run(review, lost)).status, 'running', 'Without a wake the run sleeps on its timer');
      const stalled = await silent.resumable(w.id);
      assert.deepEqual(
        stalled,
        [{ workspaceId: w.id, runId: lostRun }],
        'The sweep finds a responded run whose wake was lost',
      );
      await Promise.all(stalled.map(wake));
      await settled(lost);
      assert.equal((await run(review, lost)).status, 'completed');

      const routed = await create('Routed delay', [
        {
          id: 'urgent',
          kind: 'condition',
          when: { left: { kind: 'input', path: ['urgent'] }, op: 'eq', right: { kind: 'literal', value: true } },
          ifMet: [],
          otherwise: ['pause'],
        },
        { id: 'pause', kind: 'delay', seconds: 300 * day },
        { id: 'done', kind: 'transform', fields: { ok: { kind: 'literal', value: true } } },
      ]);
      const urgent = await launch(routed, { urgent: true });
      await settled(urgent);
      assert.deepEqual(await timers(urgent), [], 'A delay on the branch not taken starts no timer');
      assert.deepEqual(
        (await run(routed, urgent)).steps.map(step => step.stepId),
        ['urgent', 'done'],
      );
      const routine = await launch(routed, { urgent: false });
      await waiting(routed, routine);
      assert.deepEqual(await timers(routine), [300 * day], 'The branch taken waits on its delay');
      await service.cancel(w.id, w.userId, routed.id, (await run(routed, routine)).id);
      await settled(routine);
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

test(
  'histories written by the earlier polling workflow replay on the timer workflow',
  { timeout: 120000 },
  async () => {
    let native, connection, worker, running;
    try {
      native = await NativeConnection.connect({ address });
      connection = await Connection.connect({ address });
      const client = new Client({ connection }),
        taskQueue = `workflow-replay-${randomUUID()}`,
        work = { workspaceId: randomUUID(), runId: randomUUID() };
      const progress = [
        { kind: 'continue' },
        { kind: 'wait', seconds: 1 },
        { kind: 'wait', seconds: 1 },
        { kind: 'done' },
      ];
      worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('./legacy-temporal.fixture.mjs', import.meta.url)),
        activities: { advanceWorkflow: async () => progress.shift() },
      });
      running = worker.run();
      const handle = await client.workflow.start('businessWorkflowV1', {
        workflowId: `replay-${work.runId}`,
        taskQueue,
        args: [work],
      });
      await handle.result();
      const history = await handle.fetchHistory();
      assert.equal(history.events.filter(event => event.timerStartedEventAttributes).length, 2);
      await Worker.runReplayHistory(
        { workflowsPath: fileURLToPath(new URL('../src/temporal.ts', import.meta.url)) },
        history,
        handle.workflowId,
      );
    } finally {
      if (worker) {
        worker.shutdown();
        await running;
      }
      await native?.close();
      await connection?.close();
    }
  },
);

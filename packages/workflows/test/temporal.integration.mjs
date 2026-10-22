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
  'real Temporal retries lost activity acknowledgement and replays after worker restart without payload history',
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
          name: 'Private workflow',
          trigger: { kind: 'manual' },
          steps: [
            { id: 'copy', kind: 'transform', fields: { value: { kind: 'input', path: ['secret'] } } },
            { id: 'pause', kind: 'delay', seconds: 3 },
            { id: 'result', kind: 'transform', fields: { value: { kind: 'step', step: 'copy', path: ['value'] } } },
          ],
        },
      });
      await activate(service, w.id, w.userId, id, revision, true);
      const { runId } = await service.start(w.id, w.userId, id, {
        requestId: randomUUID(),
        input: { secret: 'sensitive-payload-marker' },
      });
      native = await NativeConnection.connect({ address: '127.0.0.1:7233' });
      connection = await Connection.connect({ address: '127.0.0.1:7233' });
      const client = new Client({ connection }),
        taskQueue = `workflow-proof-${randomUUID()}`;
      let loseAck = true;
      const create = () =>
        Worker.create({
          connection: native,
          taskQueue,
          workflowsPath: fileURLToPath(new URL('../src/temporal.ts', import.meta.url)),
          activities: {
            advanceWorkflow: async work => {
              const result = await service.advance(work);
              if (loseAck) {
                loseAck = false;
                throw new Error('lost-ack');
              }
              return result;
            },
          },
        });
      worker = await create();
      running = worker.run();
      const args = {
        workflowId: `proof-${runId}`,
        taskQueue,
        args: [{ workspaceId: w.id, runId }],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      };
      const handle = await client.workflow.start('businessWorkflowV1', args);
      await client.workflow.start('businessWorkflowV1', args);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await service.history(w.id, w.userId, id).then(page => page.runs))[0].status === 'waiting') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs))[0].status, 'waiting');
      worker.shutdown();
      await running;
      worker = undefined;
      worker = await create();
      running = worker.run();
      await handle.result();
      const runs = await service.history(w.id, w.userId, id).then(page => page.runs);
      assert.equal(runs[0].status, 'completed');
      assert.deepEqual(
        runs[0].steps.map(step => step.output),
        [{ value: 'sensitive-payload-marker' }, null, { value: 'sensitive-payload-marker' }],
      );
      const history = await handle.fetchHistory();
      const decoded = JSON.stringify(history, (_key, value) =>
        value?.type === 'Buffer' ? Buffer.from(value.data).toString('utf8') : value,
      );
      assert.equal(decoded.includes('sensitive-payload-marker'), false);
      assert.equal(decoded.includes('Private workflow'), false);
      assert.ok(
        history.events.some(event => event.timerStartedEventAttributes),
        'A real durable timer was scheduled',
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

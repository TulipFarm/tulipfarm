import assert from 'node:assert/strict';
import { activate } from './commands.fixture.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Worker, NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { createSnippetBroker } from '../../workflow-snippets/src/broker.ts';
import { createSnippetClient } from '../../workflow-snippets/src/client.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';

test(
  'Temporal drives authenticated isolated JS and Python with retry, worker restart and authority fencing',
  { timeout: 120000 },
  async () => {
    assert.ok(
      process.env.SNIPPET_TEST_IMAGE,
      'Set SNIPPET_TEST_IMAGE to the local snippet image ID. See docs/verification.md',
    );
    const db = await fixture(),
      directory = await mkdtemp(join(tmpdir(), 'workflow-snippets-'));
    let broker, runtime, native, connection, worker, running;
    try {
      const token = randomBytes(32).toString('hex');
      broker = await createSnippetBroker({
        database: join(directory, 'broker.sqlite'),
        token,
        image: process.env.SNIPPET_TEST_IMAGE,
        runtime: 'runc',
        allowLocalRunc: true,
      });
      await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
      const client = createSnippetClient({
        url: `http://127.0.0.1:${broker.server.address().port}`,
        token,
        allowLocalHttp: true,
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
      let loseResult = true;
      const service = createWorkflows(runtime, {
        snippets: {
          submit: async job => {
            const result = await client.submit(job);
            if (result.kind === 'completed' && loseResult) {
              loseResult = false;
              throw new Error('lost broker acknowledgement');
            }
            return result;
          },
        },
      });
      const steps = [
        {
          id: 'js',
          kind: 'code',
          language: 'javascript',
          source: 'return {total: input.value + 2, marker: input.marker};',
          input: { kind: 'input', path: [] },
        },
        {
          id: 'python',
          kind: 'code',
          language: 'python',
          source: 'return {"total": input["total"] * 3, "marker": input["marker"]}',
          input: { kind: 'step', step: 'js', path: [] },
        },
      ];
      async function admit(selectedSteps = steps) {
        const id = randomUUID(),
          revision = randomUUID();
        await service.save(w.id, w.userId, id, {
          revision,
          expectedRevision: null,
          definition: { version: 1, name: 'Snippet proof', trigger: { kind: 'manual' }, steps: selectedSteps },
        });
        await activate(service, w.id, w.userId, id, revision, true);
        const { runId } = await service.start(w.id, w.userId, id, {
          requestId: randomUUID(),
          input: { value: 5, marker: 'snippet-private-marker' },
        });
        return { id, revision, work: { workspaceId: w.id, runId } };
      }
      native = await NativeConnection.connect({ address: '127.0.0.1:7233' });
      connection = await Connection.connect({ address: '127.0.0.1:7233' });
      const temporal = new Client({ connection }),
        taskQueue = `snippet-proof-${randomUUID()}`;
      let loseActivityAck = true;
      const create = () =>
        Worker.create({
          connection: native,
          taskQueue,
          workflowsPath: fileURLToPath(new URL('../src/temporal.ts', import.meta.url)),
          activities: {
            advanceWorkflow: async work => {
              const progress = await service.activity(work);
              if (progress.kind === 'continue' && loseActivityAck) {
                loseActivityAck = false;
                throw new Error('lost activity acknowledgement');
              }
              return progress;
            },
          },
        });
      worker = await create();
      running = worker.run();
      const first = await admit();
      const handle = await temporal.workflow.start('businessWorkflowV1', {
        workflowId: randomUUID(),
        taskQueue,
        args: [first.work],
      });
      for (let i = 0; i < 100; i++) {
        if ((await service.history(w.id, w.userId, first.id).then(page => page.runs))[0].status === 'waiting') break;
        await setTimeout(50);
      }
      assert.equal((await service.history(w.id, w.userId, first.id).then(page => page.runs))[0].status, 'waiting');
      worker.shutdown();
      await running;
      worker = undefined;
      worker = await create();
      running = worker.run();
      await handle.result();
      const run = (await service.history(w.id, w.userId, first.id).then(page => page.runs))[0];
      assert.equal(run.status, 'completed');
      assert.equal(run.steps.length, 2);
      assert.deepEqual(
        run.steps.map(step => step.output),
        [
          { total: 7, marker: 'snippet-private-marker' },
          { total: 21, marker: 'snippet-private-marker' },
        ],
      );
      assert.equal(loseResult, false);
      assert.equal(loseActivityAck, false);
      const history = JSON.stringify(await handle.fetchHistory(), (_key, value) =>
        value?.type === 'Buffer' ? Buffer.from(value.data).toString('utf8') : value,
      );
      assert.equal(history.includes('snippet-private-marker'), false);
      assert.equal(history.includes('return {total'), false);
      const absent = await admit();
      await createWorkflows(runtime).advance(absent.work);
      assert.equal(
        (await service.history(w.id, w.userId, absent.id).then(page => page.runs))[0].error,
        'snippet-runner-unavailable',
      );
      const unavailable = await admit();
      const offline = createWorkflows(runtime, {
        snippets: {
          submit: async () => {
            throw new Error('offline');
          },
        },
      });
      assert.equal((await offline.advance(unavailable.work)).kind, 'wait');
      await db.platform.query(
        `UPDATE "${w.names.schema}".tf_workflow_steps SET due_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,
        [unavailable.work.runId],
      );
      await offline.advance(unavailable.work);
      assert.equal(
        (await service.history(w.id, w.userId, unavailable.id).then(page => page.runs))[0].error,
        'snippet-runner-deadline',
      );
      let rejectedCalls = 0;
      const rejectingBroker = createServer((request, response) => {
        rejectedCalls++;
        request.resume();
        response.writeHead(413);
        response.end('{}');
      });
      await new Promise(resolve => rejectingBroker.listen(0, '127.0.0.1', resolve));
      try {
        const rejected = await admit();
        const rejecting = createWorkflows(runtime, {
          snippets: createSnippetClient({
            url: `http://127.0.0.1:${rejectingBroker.address().port}`,
            token,
            allowLocalHttp: true,
          }),
        });
        assert.deepEqual(await rejecting.advance(rejected.work), { kind: 'done' });
        assert.deepEqual(await rejecting.advance(rejected.work), { kind: 'done' });
        assert.equal(rejectedCalls, 1);
        assert.equal(
          (await service.history(w.id, w.userId, rejected.id).then(page => page.runs))[0].error,
          'snippet-broker-rejected',
        );
      } finally {
        await new Promise(resolve => rejectingBroker.close(resolve));
      }
      await assert.rejects(admit([{ ...steps[0], source: `/*${'界'.repeat(32740)}*/return input` }]));
      for (const action of ['cancel', 'disable', 'revoke']) {
        const fenced = await admit();
        const fencing = createWorkflows(runtime, {
          snippets: {
            submit: async job => {
              let result;
              for (let i = 0; i < 100; i++) {
                result = await client.submit(job);
                if (result.kind !== 'pending') break;
                await setTimeout(50);
              }
              assert.equal(result.kind, 'completed');
              if (action === 'cancel') await service.cancel(w.id, w.userId, fenced.id, fenced.work.runId);
              if (action === 'disable') {
                await activate(service, w.id, w.userId, fenced.id, fenced.revision, false);
                await activate(service, w.id, w.userId, fenced.id, fenced.revision, true);
              }
              if (action === 'revoke')
                await db.platform.query(
                  `UPDATE "${w.names.schema}".tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`,
                  [w.membershipId],
                );
              return result;
            },
          },
        });
        await fencing.advance(fenced.work);
        await db.platform.query(
          `UPDATE "${w.names.schema}".tf_memberships SET removed_at=NULL,role='member' WHERE id=$1`,
          [w.membershipId],
        );
        const result = (await service.history(w.id, w.userId, fenced.id).then(page => page.runs))[0];
        assert.equal(result.status, action === 'cancel' ? 'cancelled' : 'blocked');
        assert.equal(result.steps[0].output, null);
      }
    } finally {
      if (worker) {
        worker.shutdown();
        await running;
      }
      await native?.close();
      await connection?.close();
      await runtime?.close();
      await db.close();
      await broker?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

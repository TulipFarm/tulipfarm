import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Client, Connection } from '@temporalio/client';
import { fixture, markWorkspaceReady } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '@tulipfarm/workflows';
import { registerWorkflows } from '../src/workflows.ts';
import { registerWorkflowDispatch } from '../src/workflow-dispatch.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { registerSecurity, securityServerOptions } from '../src/security.ts';

const { Worker, NativeConnection } = createRequire(new URL('../../worker/package.json', import.meta.url))(
  '@temporalio/worker',
);

test(
  'a webhook POST is dispatched by the workflow sweep and completes on real Temporal',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, app, native, connection, worker, running;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
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
          name: 'Private webhook workflow',
          trigger: { kind: 'webhook' },
          steps: [
            { id: 'copy', kind: 'transform', fields: { order: { kind: 'input', path: ['order'] } } },
            { id: 'pause', kind: 'delay', seconds: 1 },
          ],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      const active = await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 2,
        revision,
        enabled: true,
      });
      const { key } = await service.webhookKey(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: active.generation,
        mode: 'bearer',
      });

      await markWorkspaceReady(db.platform, w.id);
      native = await NativeConnection.connect({ address: '127.0.0.1:7233' });
      connection = await Connection.connect({ address: '127.0.0.1:7233' });
      const client = new Client({ connection }),
        taskQueue = `workflow-webhook-${randomUUID()}`;
      worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../../../packages/workflows/src/temporal.ts', import.meta.url)),
        activities: { advanceWorkflow: service.advance },
      });
      running = worker.run();

      app = Fastify({ ...securityServerOptions(), logger: false });
      registerSecurity(app, 'http://localhost:5173');
      app.register(
        async v1 => {
          protectBusinessRequests(v1);
          registerWorkflows(v1, { service, auth: { api: { getSession: async () => null } } });
          registerWorkflowDispatch(v1, {
            pool: db.platform,
            service,
            temporal: {
              connection,
              client: {
                workflow: { start: (type, options) => client.workflow.start(type, { ...options, taskQueue }) },
              },
            },
          });
        },
        { prefix: '/v1' },
      );
      const address = await app.listen({ host: '127.0.0.1', port: 0 });

      const response = await fetch(`${address}/v1/workspaces/${w.id}/workflows/${id}/webhook`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: randomUUID(), input: { order: 'webhook-payload-marker' } }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const { runId } = await response.json();

      const handle = client.workflow.getHandle(`business-workflow-v1-${w.id}-${runId}`);
      for (let attempt = 0; ; attempt++) {
        try {
          await handle.describe();
          break;
        } catch (error) {
          if (attempt >= 100) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      await handle.result();
      const [run] = await service.history(w.id, w.userId, id).then(page => page.runs);
      assert.equal(run.id, runId);
      assert.equal(run.source, 'webhook');
      assert.equal(run.status, 'completed');
      assert.deepEqual(
        run.steps.map(step => step.output),
        [{ order: 'webhook-payload-marker' }, null],
      );
      const history = await handle.fetchHistory();
      assert.equal(history.events[0].workflowExecutionStartedEventAttributes.workflowType.name, 'businessWorkflowV1');
      assert.ok(
        history.events.some(event => event.timerStartedEventAttributes),
        'The delay step used a durable Temporal timer',
      );
      const decoded = JSON.stringify(history, (_key, value) =>
        value?.type === 'Buffer' ? Buffer.from(value.data).toString('utf8') : value,
      );
      assert.equal(decoded.includes('webhook-payload-marker'), false);
      assert.equal(decoded.includes(key), false);
    } finally {
      await app?.close();
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

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, Connection } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';

test(
  'app publish workflows settle a failed copy, switch a staged release and replay the same way',
  { timeout: 60000 },
  async () => {
    const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    assert.ok(address, 'Owned Temporal is required');
    const taskQueue = `app-workflows-${randomUUID()}`;
    const calls = [];
    const activities = {
      async buildApp(input) {
        calls.push(['build', input.buildId]);
        return { status: 'succeeded' };
      },
      async stageAppRelease(input) {
        calls.push(['stage', input.operationId]);
        if (input.operationId === 'broken') throw ApplicationFailure.nonRetryable('copy failed');
        return input.operationId !== 'ended';
      },
      async failAppOperation(input) {
        calls.push(['fail', input.operationId]);
      },
      async switchAppRelease(input) {
        calls.push(['switch', input.operationId]);
        return { appId: 'app-1', status: 'succeeded', switched: true };
      },
      async projectAppEdge(input) {
        calls.push(['project', input.appId]);
      },
    };
    const native = await NativeConnection.connect({ address });
    const connection = await Connection.connect({ address });
    try {
      const client = new Client({ connection });
      const workflowsPath = fileURLToPath(new URL('../dist/app-workflows.js', import.meta.url));
      const worker = await Worker.create({ connection: native, taskQueue, workflowsPath, activities });
      await worker.runUntil(async () => {
        const run = (name, args) =>
          client.workflow.start(name, { taskQueue, workflowId: `${name}-${randomUUID()}`, args: [args] });
        const workspaceId = randomUUID();
        const handles = await Promise.all([
          run('appBuild', { workspaceId, buildId: 'b1' }),
          run('appPublish', { workspaceId, operationId: 'good' }),
          run('appRollback', { workspaceId, operationId: 'broken' }),
          run('appPublish', { workspaceId, operationId: 'ended' }),
          run('appProjectEdge', { workspaceId, appId: 'app-2' }),
        ]);
        assert.deepEqual(await Promise.all(handles.map(handle => handle.result())), [
          'succeeded',
          'succeeded',
          'failed',
          'ended',
          undefined,
        ]);
        const count = calls.length;
        for (const handle of handles) await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory());
        assert.equal(calls.length, count, 'replay never repeats activity work');
      });
      assert.deepEqual(calls.filter(([kind]) => kind !== 'build' && kind !== 'stage').sort(), [
        ['fail', 'broken'],
        ['project', 'app-1'],
        ['project', 'app-2'],
        ['switch', 'good'],
      ]);
    } finally {
      await connection.close();
      await native.close();
    }
  },
);

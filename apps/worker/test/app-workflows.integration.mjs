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

test('server app workflows give up a host that loses and replay the same way', { timeout: 60000 }, async () => {
  const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
  assert.ok(address, 'Owned Temporal is required');
  const taskQueue = `app-server-workflows-${randomUUID()}`;
  const calls = [];
  const target = { appId: 'app-1', releaseId: 'release-1', size: { vcpu: 1, memMiB: 1024 }, output: {} };
  const activities = {
    async prepareAppServer(input) {
      calls.push(['prepare', input.operationId]);
      return input.operationId === 'no-host' ? null : target;
    },
    async provisionAppServer(input) {
      calls.push(['provision', input.operationId]);
      if (input.operationId === 'no-start') throw ApplicationFailure.nonRetryable('boot failed');
      if (input.operationId === 'refused') return { ok: false };
      return { ok: true, hostRef: `host-${input.operationId}` };
    },
    async recordAppServerCandidate(input) {
      calls.push(['record', input.operationId]);
      if (input.operationId === 'late') return { status: 'superseded', retiredHostRef: input.hostRef };
      return { status: 'staging', retiredHostRef: input.operationId === 'resize' ? 'host-sibling' : null };
    },
    async switchAppServer(input) {
      calls.push(['switch', input.operationId]);
      if (input.operationId === 'stuck') throw ApplicationFailure.nonRetryable('not ready');
      if (input.operationId === 'lost')
        return { appId: 'app-1', status: 'superseded', switched: false, retiredHostRef: input.hostRef };
      return { appId: 'app-1', status: 'switched', switched: true, retiredHostRef: 'host-old' };
    },
    async failAppServerOperation(input) {
      calls.push(['fail', input.operationId]);
      return { status: 'failed', retiredHostRef: input.operationId === 'stuck' ? 'host-stuck' : null };
    },
    async removeAppHost(input) {
      calls.push(['remove', input.hostRef]);
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
      const run = (name, operationId) =>
        client.workflow.start(name, {
          taskQueue,
          workflowId: `${name}-${randomUUID()}`,
          args: [{ workspaceId: 'workspace-1', operationId }],
        });
      const handles = await Promise.all([
        run('appServerPublish', 'good'),
        run('appServerPublish', 'no-host'),
        run('appServerPublish', 'refused'),
        run('appServerRollback', 'no-start'),
        run('appServerPublish', 'late'),
        run('appServerPublish', 'lost'),
        run('appServerRollback', 'stuck'),
        run('appServerResize', 'resize'),
      ]);
      assert.deepEqual(await Promise.all(handles.map(handle => handle.result())), [
        'switched',
        'ended',
        'failed',
        'failed',
        'superseded',
        'superseded',
        'failed',
        'switched',
      ]);
      const count = calls.length;
      for (const handle of handles) await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory());
      assert.equal(calls.length, count, 'replay never repeats activity work');
    });
    const of = id => calls.filter(([, subject]) => subject === id || subject === `host-${id}`).map(([kind]) => kind);
    assert.deepEqual(of('good'), ['prepare', 'provision', 'record', 'switch']);
    assert.deepEqual(of('no-host'), ['prepare']);
    assert.deepEqual(of('refused'), ['prepare', 'provision']);
    assert.deepEqual(of('no-start'), ['prepare', 'provision', 'fail']);
    assert.deepEqual(of('late'), ['prepare', 'provision', 'record', 'remove']);
    assert.deepEqual(of('lost'), ['prepare', 'provision', 'record', 'switch', 'remove']);
    assert.deepEqual(of('stuck'), ['prepare', 'provision', 'record', 'switch', 'fail', 'remove']);
    assert.deepEqual(of('resize'), ['prepare', 'provision', 'record', 'switch']);
    assert.deepEqual(calls.filter(([kind]) => kind === 'project' || kind === 'remove').sort(), [
      ['project', 'app-1'],
      ['project', 'app-1'],
      ['remove', 'host-late'],
      ['remove', 'host-lost'],
      ['remove', 'host-old'],
      ['remove', 'host-old'],
      ['remove', 'host-sibling'],
      ['remove', 'host-stuck'],
    ]);
  } finally {
    await connection.close();
    await native.close();
  }
});

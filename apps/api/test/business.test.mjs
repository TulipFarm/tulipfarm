import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { protectBusinessRequests } from '../src/business.ts';
import { buildApp } from '../src/app.ts';

test('Turbo dev passes Soul read and integration credentials to the API in strict mode', () => {
  const credentials = {
    R2_SOUL_READ_ACCESS_KEY_ID: 'regression-read-id',
    R2_SOUL_READ_SECRET_ACCESS_KEY: 'regression-read-secret',
    INTEGRATION_CREDENTIAL_KEY_ID: 'regression-integration',
    INTEGRATION_CREDENTIAL_KEY: 'ab'.repeat(32),
    INTEGRATION_CREDENTIAL_PREVIOUS_KEYS: '{}',
  };
  const output = execFileSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'dev', '--filter=@tulipfarm/api', '--env-mode=strict', '--dry=json'],
    {
      cwd: new URL('../../../', import.meta.url),
      env: { ...process.env, ...credentials },
      encoding: 'utf8',
    },
  );
  const result = JSON.parse(output);
  const task = result.tasks.find(task => task.taskId === '@tulipfarm/api#dev');
  assert.equal(task.envMode, 'strict');
  for (const [key, value] of Object.entries(credentials)) {
    assert.ok(task.environmentVariables.specified.passThroughEnv.includes(key), `${key} must be configured`);
    const hash = createHash('sha256').update(value).digest('hex');
    assert.ok(task.environmentVariables.passthrough.includes(`${key}=${hash}`), `${key} must reach the task`);
  }
});

test('every unsafe business method rejects absent and foreign origins before its handler', async () => {
  const app = Fastify();
  protectBusinessRequests(app);
  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/operation',
    handler: async () => ({ ok: true }),
  });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const headers of [{}, { origin: 'https://evil.example' }]) {
        const response = await app.inject({ method, url: '/operation', headers });
        assert.equal(response.statusCode, 403);
        assert.deepEqual(response.json(), { error: 'Untrusted request origin' });
      }
      assert.equal(
        (await app.inject({ method, url: '/operation', headers: { origin: 'http://localhost:5173' } })).statusCode,
        200,
      );
    }
    assert.equal((await app.inject({ url: '/operation' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('browser preflight permits supported mutations only for the configured web origin', async () => {
  const app = buildApp();
  try {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/v1/workspaces/example/tables/example/rows/example',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(response.statusCode, 204);
      assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
      assert.equal(response.headers['access-control-allow-credentials'], 'true');
      assert.ok(
        response.headers['access-control-allow-methods']
          .split(',')
          .map(value => value.trim())
          .includes(method),
      );
    }
    const foreign = await app.inject({
      method: 'OPTIONS',
      url: '/v1/workspaces',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'PUT',
      },
    });
    assert.notEqual(foreign.headers['access-control-allow-origin'], 'https://evil.example');
  } finally {
    await app.close();
  }
});

for (const failingWorkflow of ['executeTableProposal', 'prepareAgentSave']) {
  test(`independent dispatch paths run when ${failingWorkflow} fails and retry stable IDs`, async context => {
    const { registerTableDispatch } = await import('../src/table-dispatch.ts');
    const { setImmediate } = await import('node:timers/promises');
    context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_800_000_000_000 });
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const agentId = '44444444-4444-4444-8444-444444444444';
    const proposalId = '55555555-5555-4555-8555-555555555555';
    const starts = [],
      logs = [];
    let failing = true;
    let agentDispatchedAt = null;
    const app = Fastify({
      logger: {
        stream: {
          write(line) {
            logs.push(JSON.parse(line));
          },
        },
      },
    });
    const client = {
      async query(sql, values) {
        if (sql.startsWith('SELECT p.id FROM') && sql.includes('tf_table_proposals'))
          return { rows: [{ id: proposalId }] };
        if (sql.startsWith('SELECT id FROM') && sql.includes('"tf_agent_commands"')) return { rows: [{ id: agentId }] };
        if (sql.startsWith('UPDATE') && sql.includes('"tf_agent_commands"')) {
          assert.match(sql, /SET dispatched_at = now\(\) WHERE id = \$1/);
          assert.deepEqual(values, [agentId]);
          agentDispatchedAt = Date.now();
          return { rows: [], rowCount: 1 };
        }
        return {
          rows: sql.includes('tf_authorization_lock') ? [{ id: 1 }] : [],
          rowCount: sql.includes('tf_authorization_lock') ? 1 : 0,
        };
      },
    };
    registerTableDispatch(app, {
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM app\.workspace_storage WHERE stage = 'ready'/);
          assert.deepEqual(values, [null]);
          return { rows: [{ workspace_id: workspaceId }] };
        },
      },
      runtime: {
        async transaction(id, _compatibility, operation) {
          assert.equal(id, workspaceId);
          return operation({ schema: 'dispatch_test', client });
        },
      },
      temporal: {
        connection: { withDeadline: (_deadline, operation) => operation() },
        client: {
          workflow: {
            async start(workflow, options) {
              starts.push({ workflow, ...options });
              if (failing && workflow === failingWorkflow) throw new Error('Controlled resource start failure');
            },
          },
        },
      },
    });
    try {
      await app.ready();
      await setImmediate();
      const expectedStarts = [
        {
          workflow: 'executeTableProposal',
          workflowId: `table-proposal-v2-${workspaceId}-${proposalId}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [workspaceId, proposalId, process.env.TEMPORAL_STORAGE_TASK_QUEUE ?? 'tulipfarm-storage-v1'],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
        {
          workflow: 'prepareAgentSave',
          workflowId: `agent-save-v1-${workspaceId}-${agentId}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [workspaceId, agentId],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
      ];
      assert.deepEqual(starts, expectedStarts);
      assert.equal(agentDispatchedAt, failingWorkflow === 'prepareAgentSave' ? null : 1_800_000_000_000);
      assert.deepEqual(
        logs.map(({ msg, workspaceId }) => ({ msg, workspaceId })),
        [
          {
            msg:
              failingWorkflow === 'prepareAgentSave'
                ? 'Agent dispatch will retry'
                : 'Table proposal dispatch will retry',
            workspaceId,
          },
        ],
      );

      failing = false;
      context.mock.timers.tick(2000);
      await setImmediate();
      assert.deepEqual(starts, [...expectedStarts, ...expectedStarts]);
      assert.equal(agentDispatchedAt, 1_800_000_002_000);
      assert.equal(logs.length, 1);
    } finally {
      await app.close();
    }
    context.mock.timers.tick(2000);
    await setImmediate();
    assert.equal(starts.length, 4);
  });
}

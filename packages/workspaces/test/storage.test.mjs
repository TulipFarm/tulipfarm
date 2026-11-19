import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceRuntime } from '../src/storage.ts';

const fleet = {
  api: { tasks: 1, connectionsPerPool: 3 },
  'api-jobs': { tasks: 1 },
  worker: { tasks: 1 },
  'knowledge-worker': { tasks: 1 },
  'storage-worker': { tasks: 1 },
  gateway: { tasks: 1 },
};

function withEnv(env, run) {
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

const runtime = (env, connectionsPerPool) =>
  withEnv(
    {
      WORKSPACE_RUNTIME_KEY_ID: 'test',
      WORKSPACE_RUNTIME_KEY: '11'.repeat(32),
      WORKSPACE_STORAGE_CONNECTIONS_PER_POOL: connectionsPerPool,
      ...env,
    },
    () => workspaceRuntime({ query: async () => ({ rows: [] }) }),
  );

test('a declared fleet is charged per task from each service pool sizes', async () => {
  const budget = { WORKSPACE_DATABASE_CONNECTION_BUDGET: '180' };
  const fits = runtime({ ...budget, DATABASE_CONNECTION_FLEET: JSON.stringify(fleet) }, '3');
  await fits.close();
  const twoApis = { ...fleet, api: { tasks: 2, connectionsPerPool: 3 } };
  assert.throws(
    () => runtime({ ...budget, DATABASE_CONNECTION_FLEET: JSON.stringify(twoApis) }, '3'),
    /234 database connections exceed its connection budget of 180/,
  );
  const twoGateways = { ...fleet, gateway: { tasks: 2 } };
  assert.throws(
    () => runtime({ ...budget, DATABASE_CONNECTION_FLEET: JSON.stringify(twoGateways) }, '2'),
    /202 database connections exceed/,
  );
});

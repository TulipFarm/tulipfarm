import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { databaseConnectionFleet, databasePools, fleetConnections } from '../dist/database-connections.js';

const declared = JSON.parse(readFileSync(new URL('../src/database-connections.json', import.meta.url), 'utf8'));
const hosted = {
  api: { tasks: 1, connectionsPerPool: 3 },
  'api-jobs': { tasks: 1 },
  worker: { tasks: 1 },
  'knowledge-worker': { tasks: 1 },
  'storage-worker': { tasks: 1 },
  gateway: { tasks: 1 },
};

test('every task of a service adds its declared pools and its workspace pools', () => {
  // api 34 + 8 x 3, api-jobs 15 + 16, worker 18 + 16, knowledge-worker 4 + 16, storage-worker 7, gateway 10 + 16.
  assert.equal(fleetConnections(hosted), 176);
  assert.equal(fleetConnections({ ...hosted, api: { tasks: 2, connectionsPerPool: 3 } }), 176 + 34 + 24);
  assert.equal(fleetConnections({ ...hosted, worker: { tasks: 3 } }), 176 + 2 * (18 + 16));
  assert.equal(fleetConnections({ 'storage-worker': { tasks: 2 } }), 14);
  assert.equal(fleetConnections({ gateway: { tasks: 0 } }), 0);
  assert.equal(fleetConnections({ 'api-jobs': { tasks: 1, maxPools: 4, connectionsPerPool: 1 } }), 15 + 4);
});

test('a hosted deployment declares its fleet as JSON', () => {
  assert.equal(databaseConnectionFleet({}), undefined);
  assert.deepEqual(databaseConnectionFleet({ DATABASE_CONNECTION_FLEET: JSON.stringify(hosted) }), hosted);
  for (const value of ['{', '{"web":{"tasks":1}}', '{"api":{"tasks":-1}}', '{"api":{"tasks":1,"replicas":2}}'])
    assert.throws(() => databaseConnectionFleet({ DATABASE_CONNECTION_FLEET: value }), /DATABASE_CONNECTION_FLEET/);
});

test('services declare only known pools and every pool belongs to a service', () => {
  const used = new Set(Object.values(declared.services).flatMap(service => service.pools));
  assert.deepEqual(
    [...used].filter(pool => !(pool in databasePools)),
    [],
  );
  assert.deepEqual(
    Object.keys(databasePools).filter(pool => !used.has(pool)),
    [],
  );
});

// One-off commands and the workspace pools, which the fleet counts from each service's workspace limits.
const unservedPools = new Set([
  'apps/api/src/auth-reset-password.ts',
  'apps/worker/src/recommendation-operations.ts',
  'packages/workspace-storage/src/runtime.ts',
]);

test('every pool a deployed service opens takes its size from the declared pools', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const sources = [
    'apps/api',
    'apps/worker',
    'apps/gateway',
    ...readdirSync(join(root, 'packages')).map(name => `packages/${name}`),
  ];
  const undeclared = [];
  for (const source of sources) {
    const directory = join(root, source, 'src');
    let files;
    try {
      files = readdirSync(directory, { recursive: true }).filter(file => /\.tsx?$/.test(file));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = relative(root, join(directory, file));
      if (unservedPools.has(path)) continue;
      const text = readFileSync(join(directory, file), 'utf8');
      for (const match of text.matchAll(/new Pool\(\{[^}]*\}/g))
        if (!/max: databasePools\.\w+/.test(match[0])) undeclared.push(path);
    }
  }
  assert.deepEqual(undeclared, []);
});

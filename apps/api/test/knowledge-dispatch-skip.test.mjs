import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { registerGitHubKnowledgeDispatch } from '../src/knowledge-github-dispatch.ts';

// The same OpenTelemetry API instance that @tulipfarm/observability records through.
const { metrics } = createRequire(fileURLToPath(import.meta.resolve('@tulipfarm/observability')))('@opentelemetry/api');

test('a workspace skipped for an incompatible storage version is counted without workspace labels', async () => {
  const counted = [];
  const instrument = { add() {}, record() {}, addCallback() {}, removeCallback() {} };
  const meter = new Proxy(
    {},
    {
      get: (_target, method) => name =>
        method === 'createCounter' && name === 'cloud_dispatch_skipped_workspaces'
          ? { add: (value, attributes) => counted.push({ value, attributes }) }
          : instrument,
    },
  );
  assert.ok(metrics.setGlobalMeterProvider({ getMeter: () => meter }));
  const app = Fastify();
  const errors = [];
  app.log.error = message => errors.push(message);
  const workspaceId = randomUUID();
  let pass;
  const swept = new Promise(resolve => {
    pass = resolve;
  });
  registerGitHubKnowledgeDispatch(app, {
    pool: { query: async () => ({ rows: [{ workspace_id: workspaceId }] }) },
    service: {
      health: async () => {
        throw new StorageUnavailableError('incompatible_version');
      },
      due: async () => assert.fail('a skipped workspace dispatches nothing'),
    },
    temporal: { connection: {}, client: {} },
  });
  const poll = setInterval(() => counted.length && pass(), 10);
  try {
    await app.ready();
    await swept;
    assert.equal(counted[0].value, 1);
    assert.equal(counted[0].attributes.dispatcher, 'github');
    assert.equal(counted[0].attributes.reason, 'incompatible_version');
    assert.ok(!Object.values(counted[0].attributes).includes(workspaceId), 'no workspace label');
    assert.deepEqual(errors, [], 'a version skip is a metric, not an error log');
  } finally {
    clearInterval(poll);
    await app.close();
    metrics.disable();
  }
});

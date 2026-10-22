import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';

// The app serves the shipped model catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

test('health executes work and detects a stopped worker', { timeout: 30000 }, async () => {
  process.env.TEMPORAL_TASK_QUEUE = `health-test-${randomUUID()}`;
  const app = buildApp({ agentModel: null });
  const worker = spawn(process.execPath, [new URL('../../worker/src/worker.ts', import.meta.url).pathname], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(worker, 'exit');
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker startup timed out: ${output}`)), 10000);
      worker.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`Worker exited: ${output}`));
      });
      worker.stderr.on('data', chunk => {
        output += chunk;
        if (output.includes('RUNNING')) {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.stdout.on('data', chunk => {
        output += chunk;
      });
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/v1/health`);
    const health = await response.json();
    assert.equal(response.status, 200, JSON.stringify(health));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(health.status, 'ok');
    assert.equal(health.version, 'development');
    assert.equal(health.commit, 'development');
    for (const service of ['api', 'postgres', 'temporal', 'workers', 'temporalUi']) {
      assert.equal(health.services[service].status, 'ok');
    }

    worker.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
    const degraded = await fetch(`${address}/v1/health`);
    assert.equal(degraded.status, 503);
    const body = await degraded.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.version, 'development');
    assert.equal(body.commit, 'development');
    assert.equal(body.services.workers.status, 'unavailable');
    assert.equal(body.services.temporal.status, 'ok');
    assert.equal(body.services.postgres.status, 'ok');
    const live = await fetch(`${address}/v1/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok', version: 'development', commit: 'development' });
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGTERM');
      await exited;
    }
    await app.close();
  }
});

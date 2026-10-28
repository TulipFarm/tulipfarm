import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerRole, workerTelemetryService } from '../dist/worker-role.js';

test('worker role defaults to all, accepts core and knowledge, and rejects anything else', () => {
  assert.equal(workerRole({}), 'all');
  assert.equal(workerRole({ TULIPFARM_WORKER_ROLE: ' ' }), 'all');
  assert.equal(workerRole({ TULIPFARM_WORKER_ROLE: 'core' }), 'core');
  assert.equal(workerRole({ TULIPFARM_WORKER_ROLE: 'knowledge' }), 'knowledge');
  assert.throws(() => workerRole({ TULIPFARM_WORKER_ROLE: 'Knowledge' }), /must be all, core or knowledge/);
  assert.equal(workerTelemetryService('knowledge'), 'tulipfarm-knowledge-worker');
  assert.equal(workerTelemetryService('core'), undefined);
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createKnowledgeWorker } from '../dist/knowledge-worker.js';
import { workflowSource } from '../dist/workflow-source.js';
import { workerTelemetry } from '../dist/telemetry.js';
import { temporalWorkflowInterceptorModule } from '../dist/temporal-tracing.js';

const capture = () => {
  const created = [];
  return {
    created,
    createWorker: async options => {
      created.push(options);
      return {};
    },
  };
};

test('one worker serves every knowledge part on the knowledge queue with the same total activity slots', async () => {
  const { created, createWorker } = capture();
  const ingest = { processKnowledge: async () => {} };
  const slack = { processSlackKnowledge: async () => {} };
  const keep = { dueKnowledgeKeep: async () => [], syncKnowledgeKeep: async () => {} };
  await createKnowledgeWorker({
    connection: {},
    env: { TEMPORAL_TASK_QUEUE: 'fixture', TEMPORAL_NAMESPACE: 'fixture-space' },
    parts: { ingest, slack, keep },
    createWorker,
  });
  const [options] = created;
  assert.equal(created.length, 1);
  assert.equal(options.taskQueue, 'fixture-knowledge');
  assert.equal(options.namespace, 'fixture-space');
  assert.equal(options.maxConcurrentActivityTaskExecutions, 6);
  assert.equal(options.shutdownGraceTime, '40 seconds');
  assert.deepEqual(Object.keys(options.activities), [
    'processKnowledge',
    'processSlackKnowledge',
    'dueKnowledgeKeep',
    'syncKnowledgeKeep',
  ]);
  assert.equal(options.activities.processSlackKnowledge, slack.processSlackKnowledge);
  assert.match(options.workflowBundle.codePath, /knowledge-all-workflows\.bundle\.js$/);
});

test('the knowledge worker refuses two parts that register the same activity', async () => {
  const { created, createWorker } = capture();
  await assert.rejects(
    createKnowledgeWorker({
      connection: {},
      env: {},
      parts: { google: { processKnowledge: async () => {} }, ingest: { processKnowledge: async () => {} } },
      createWorker,
    }),
    /processKnowledge is registered by both google and ingest/,
  );
  assert.equal(created.length, 0);
});

test('compiled workers load the prebuilt bundle that matches their workflow interceptors', () => {
  const plain = workflowSource('knowledge-all-workflows', workerTelemetry());
  assert.match(plain.workflowBundle.codePath, /knowledge-all-workflows\.bundle\.js$/);
  assert.ok(existsSync(plain.workflowBundle.codePath));
  assert.equal(plain.workflowsPath, undefined);

  const traced = workflowSource('workflows', {
    interceptors: { workflowModules: [temporalWorkflowInterceptorModule], activity: [] },
  });
  assert.match(traced.workflowBundle.codePath, /workflows\.traced\.bundle\.js$/);
  assert.ok(existsSync(traced.workflowBundle.codePath));
  assert.deepEqual(traced.interceptors, { activity: [] }, 'the bundle already holds the workflow interceptors');

  const custom = workflowSource('storage-workflows', { interceptors: { workflowModules: ['/elsewhere.js'] } });
  assert.match(custom.workflowsPath, /storage-workflows\.js$/);
  assert.equal(custom.workflowBundle, undefined);
  assert.deepEqual(custom.interceptors, { workflowModules: ['/elsewhere.js'] });
});

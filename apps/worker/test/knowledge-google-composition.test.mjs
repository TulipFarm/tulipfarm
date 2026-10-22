import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGoogleKnowledgeWorker } from '../dist/knowledge-google-composition.js';
import { createGoogleKnowledgeActivities } from '../dist/knowledge-google-activities.js';

test('Google corpus composition isolates and bounds provider activities', async () => {
  let options;
  const forbidden = async () => assert.fail('composition performs no external work');
  const worker = {};
  const composed = await createGoogleKnowledgeWorker({
    runtime: { transaction: forbidden },
    connection: {},
    env: { TEMPORAL_TASK_QUEUE: 'fixture', TEMPORAL_NAMESPACE: 'fixture-space' },
    googleService: { status: forbidden, withCredential: forbidden },
    providerFetch: forbidden,
    createWorker: async value => {
      options = value;
      return worker;
    },
  });
  assert.equal(composed.worker, worker);
  assert.equal(options.taskQueue, 'fixture-knowledge-google');
  assert.equal(options.namespace, 'fixture-space');
  assert.equal(options.maxConcurrentActivityTaskExecutions, 2);
  assert.match(options.workflowsPath, /knowledge-google-workflows\.js$/);
  assert.deepEqual(Object.keys(options.activities), ['processGoogleKnowledge']);
});

test('Google activity validates ID-only work, discards results, and sanitizes failures', async () => {
  const work = { workspaceId: randomUUID(), sourceId: randomUUID(), generation: 1 };
  const success = createGoogleKnowledgeActivities({
    process: async value => {
      assert.deepEqual(value, work);
      return { secret: 'private content' };
    },
  });
  assert.equal(await success.processGoogleKnowledge(work), undefined);
  await assert.rejects(success.processGoogleKnowledge({ ...work, credential: 'private' }), {
    type: 'InvalidGoogleKnowledgeWork',
    nonRetryable: true,
  });
  const failure = createGoogleKnowledgeActivities({
    process: async () => {
      throw new Error('private token and content');
    },
  });
  await assert.rejects(failure.processGoogleKnowledge(work), error => {
    assert.equal(error.type, 'GoogleKnowledgeUnavailable');
    assert.equal(error.nonRetryable, true);
    assert.equal(error.message, 'Google Knowledge processing unavailable');
    assert.equal(error.cause, undefined);
    return true;
  });
});

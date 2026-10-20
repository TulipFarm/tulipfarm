import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAtlassianKnowledgeWorker } from '../dist/knowledge-atlassian-composition.js';
import { createAtlassianKnowledgeActivities } from '../dist/knowledge-atlassian-activities.js';
import { atlassianCorpusFromEnvironment } from '@tulipfarm/atlassian/corpus';

test('Atlassian corpus composition isolates and bounds provider activities', async () => {
  let options;
  const forbidden = async () => assert.fail('composition performs no external work');
  const worker = {};
  const composed = await createAtlassianKnowledgeWorker({
    runtime: { transaction: forbidden },
    connection: {},
    env: { TEMPORAL_TASK_QUEUE: 'fixture', TEMPORAL_NAMESPACE: 'fixture-space' },
    atlassianCorpus: {
      sites: forbidden,
      discover: forbidden,
      inspectSelection: forbidden,
      access: forbidden,
      list: forbidden,
      read: forbidden,
    },
    createWorker: async value => {
      options = value;
      return worker;
    },
  });
  assert.equal(composed.worker, worker);
  assert.equal(options.taskQueue, 'fixture-knowledge-atlassian');
  assert.equal(options.namespace, 'fixture-space');
  assert.equal(options.maxConcurrentActivityTaskExecutions, 2);
  assert.match(options.workflowsPath, /knowledge-atlassian-workflows\.js$/);
  assert.deepEqual(Object.keys(options.activities), ['processAtlassianKnowledge']);
});

test('Atlassian composition without REST account configuration stays not-configured', async () => {
  let options;
  const composed = await createAtlassianKnowledgeWorker({
    runtime: { transaction: async () => assert.fail('no storage work') },
    connection: {},
    env: { ATLASSIAN_REST_CLIENT_ID: 'only-partial' },
    createWorker: async value => {
      options = value;
      return {};
    },
  });
  assert.equal(options.taskQueue, 'tulipfarm-knowledge-atlassian');
  assert.ok(composed.service);
  await assert.rejects(
    atlassianCorpusFromEnvironment({
      runtime: { transaction: async () => assert.fail('no storage work') },
      env: { ATLASSIAN_REST_CLIENT_ID: 'only-partial' },
    }).sites('11111111-1111-4111-8111-111111111111', 'user'),
    error => error.code === 'not-configured',
  );
});

test('Atlassian activity validates ID-only work, discards results, and sanitizes failures', async () => {
  const work = { workspaceId: randomUUID(), sourceId: randomUUID(), generation: 1 };
  const success = createAtlassianKnowledgeActivities({
    process: async value => {
      assert.deepEqual(value, work);
      return { secret: 'private page' };
    },
  });
  assert.equal(await success.processAtlassianKnowledge(work), undefined);
  await assert.rejects(success.processAtlassianKnowledge({ ...work, token: 'atlassian-private' }), {
    type: 'InvalidAtlassianKnowledgeWork',
    nonRetryable: true,
  });
  const failure = createAtlassianKnowledgeActivities({
    process: async () => {
      throw new Error('atlassian-private token and message');
    },
  });
  await assert.rejects(failure.processAtlassianKnowledge(work), error => {
    assert.equal(error.type, 'AtlassianKnowledgeUnavailable');
    assert.equal(error.nonRetryable, true);
    assert.equal(error.message, 'Atlassian Knowledge processing unavailable');
    assert.equal(error.cause, undefined);
    return true;
  });
});

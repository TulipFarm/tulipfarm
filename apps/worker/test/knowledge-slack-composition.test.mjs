import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSlackKnowledgeWorker } from '../dist/knowledge-slack-composition.js';
import { createSlackKnowledgeActivities } from '../dist/knowledge-slack-activities.js';

test('Slack corpus composition isolates and bounds provider activities', async () => {
  let options;
  const forbidden = async () => assert.fail('composition performs no external work');
  const worker = {};
  const composed = await createSlackKnowledgeWorker({
    runtime: { transaction: forbidden },
    connection: {},
    env: { TEMPORAL_TASK_QUEUE: 'fixture', TEMPORAL_NAMESPACE: 'fixture-space' },
    slackCorpus: {
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
  assert.equal(options.taskQueue, 'fixture-knowledge-slack');
  assert.equal(options.namespace, 'fixture-space');
  assert.equal(options.maxConcurrentActivityTaskExecutions, 2);
  assert.match(options.workflowsPath, /knowledge-slack-workflows\.js$/);
  assert.deepEqual(Object.keys(options.activities), ['processSlackKnowledge']);
});

test('Slack composition without linked-member configuration stays not-configured', async () => {
  let options;
  await createSlackKnowledgeWorker({
    runtime: { transaction: async () => assert.fail('no storage work') },
    connection: {},
    env: { SLACK_CONFIGURATION: '{"invalid":true}', SLACK_CREDENTIAL_KEYS: '{}' },
    createWorker: async value => {
      options = value;
      return {};
    },
  });
  assert.equal(options.taskQueue, 'tulipfarm-knowledge-slack');
});

test('Slack activity validates ID-only work, discards results, and sanitizes failures', async () => {
  const work = { workspaceId: randomUUID(), sourceId: randomUUID(), generation: 1 };
  const success = createSlackKnowledgeActivities({
    process: async value => {
      assert.deepEqual(value, work);
      return { secret: 'private message' };
    },
  });
  assert.equal(await success.processSlackKnowledge(work), undefined);
  await assert.rejects(success.processSlackKnowledge({ ...work, token: 'xoxp-private' }), {
    type: 'InvalidSlackKnowledgeWork',
    nonRetryable: true,
  });
  const failure = createSlackKnowledgeActivities({
    process: async () => {
      throw new Error('xoxp-private token and message');
    },
  });
  await assert.rejects(failure.processSlackKnowledge(work), error => {
    assert.equal(error.type, 'SlackKnowledgeUnavailable');
    assert.equal(error.nonRetryable, true);
    assert.equal(error.message, 'Slack Knowledge processing unavailable');
    assert.equal(error.cause, undefined);
    return true;
  });
});

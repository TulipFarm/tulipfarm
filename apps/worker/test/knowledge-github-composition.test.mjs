import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { asyncLocalStorage } from '@temporalio/activity';
import { createGitHubKnowledgeWorker } from '../dist/knowledge-github-composition.js';
import { createGitHubKnowledgeActivities } from '../dist/knowledge-github-activities.js';
import { githubCorpusFromEnvironment } from '@tulipfarm/github/corpus';

test('GitHub corpus composition isolates and bounds provider activities', async () => {
  let options;
  const forbidden = async () => assert.fail('composition performs no external work');
  const worker = {};
  const composed = await createGitHubKnowledgeWorker({
    runtime: { transaction: forbidden },
    connection: {},
    env: { TEMPORAL_TASK_QUEUE: 'fixture', TEMPORAL_NAMESPACE: 'fixture-space' },
    githubCorpus: {
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
  assert.equal(options.taskQueue, 'fixture-knowledge-github');
  assert.equal(options.namespace, 'fixture-space');
  assert.equal(options.maxConcurrentActivityTaskExecutions, 2);
  assert.match(options.workflowsPath, /knowledge-github-workflows\.js$/);
  assert.deepEqual(Object.keys(options.activities), ['processGitHubKnowledge']);
});

test('GitHub composition without OAuth configuration or keys stays not-configured', async () => {
  for (const env of [
    {},
    { GITHUB_OAUTH_CLIENT_ID: 'partial' },
    {
      GITHUB_OAUTH_CLIENT_ID: 'id',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      GITHUB_OAUTH_REDIRECT_URI: 'https://app.example/github/callback',
      GITHUB_OAUTH_SCOPES: 'repo',
    },
  ]) {
    let options;
    const composed = await createGitHubKnowledgeWorker({
      runtime: { transaction: async () => assert.fail('no storage work') },
      connection: {},
      env,
      createWorker: async value => {
        options = value;
        return {};
      },
    });
    assert.equal(options.taskQueue, 'tulipfarm-knowledge-github');
    assert.ok(composed.service);
    await assert.rejects(
      githubCorpusFromEnvironment({ runtime: { transaction: async () => assert.fail('no storage work') }, env }).access(
        'w',
        'u',
        {},
        '1',
      ),
      { code: 'not-configured' },
    );
  }
});

test('GitHub activity validates ID-only work, discards results, and sanitizes failures', async () => {
  const work = { workspaceId: randomUUID(), sourceId: randomUUID(), generation: 1 };
  const success = createGitHubKnowledgeActivities({
    process: async (value, options) => {
      assert.deepEqual(value, work);
      assert.deepEqual(options, {}, 'outside an activity there is nothing to heartbeat');
      return { secret: 'private issue' };
    },
  });
  assert.equal(await success.processGitHubKnowledge(work), undefined);
  await assert.rejects(success.processGitHubKnowledge({ ...work, token: 'gho_private' }), {
    type: 'InvalidGitHubKnowledgeWork',
    nonRetryable: true,
  });
  const failure = createGitHubKnowledgeActivities({
    process: async () => {
      throw new Error('gho_private token and message');
    },
  });
  await assert.rejects(failure.processGitHubKnowledge(work), error => {
    assert.equal(error.type, 'GitHubKnowledgeUnavailable');
    assert.equal(error.nonRetryable, true);
    assert.equal(error.message, 'GitHub Knowledge processing unavailable');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('GitHub activity heartbeats Temporal and passes cancellation while the run works', async () => {
  const work = { workspaceId: randomUUID(), sourceId: randomUUID(), generation: 1 };
  const signal = new AbortController().signal;
  let beats = 0;
  const activities = createGitHubKnowledgeActivities({
    process: async (_value, options) => {
      assert.equal(options.signal, signal);
      options.heartbeat();
      options.heartbeat();
      return { disposition: 'retry' };
    },
  });
  const context = { heartbeat: () => beats++, cancellationSignal: signal };
  await asyncLocalStorage.run(context, () => activities.processGitHubKnowledge(work));
  assert.equal(beats, 2);
});

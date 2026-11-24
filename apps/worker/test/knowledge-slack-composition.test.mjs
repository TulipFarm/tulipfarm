import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSlackKnowledgeParts } from '../dist/knowledge-slack-composition.js';
import { createSlackKnowledgeActivities } from '../dist/knowledge-slack-activities.js';

test('Slack corpus composition isolates provider activities', async () => {
  const forbidden = async () => assert.fail('composition performs no external work');
  const composed = createSlackKnowledgeParts({
    runtime: { transaction: forbidden },
    slackCorpus: {
      discover: forbidden,
      inspectSelection: forbidden,
      access: forbidden,
      list: forbidden,
      read: forbidden,
    },
  });
  assert.ok(composed.service);
  assert.deepEqual(Object.keys(composed.activities), ['processSlackKnowledge']);
});

test('Slack composition without linked-member configuration stays not-configured', async () => {
  const composed = createSlackKnowledgeParts({
    runtime: { transaction: async () => assert.fail('no storage work') },
    env: { SLACK_CONFIGURATION: '{"invalid":true}', SLACK_CREDENTIAL_KEYS: '{}' },
  });
  assert.ok(composed.service);
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

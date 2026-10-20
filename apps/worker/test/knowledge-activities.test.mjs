import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeActivities } from '../dist/knowledge-activities.js';

test('activity validates identifiers and replaces internal failures before Temporal records them', async () => {
  const activity = createKnowledgeActivities({
    transaction: async () => {
      throw new Error('private-document database password');
    },
  });
  await assert.rejects(
    activity.processKnowledge({ workspaceId: 'bad', revisionId: 'bad', generation: 1, text: 'private-document' }),
    error => {
      assert.equal(error.message, 'Invalid knowledge work');
      assert.equal(error.nonRetryable, true);
      return true;
    },
  );
  await assert.rejects(
    activity.processKnowledge({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      revisionId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
    }),
    error => {
      assert.equal(error.message, 'Knowledge processing unavailable');
      assert.equal(error.nonRetryable, true);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

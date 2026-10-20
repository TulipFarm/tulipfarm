import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createKnowledgeEmbeddingActivities } from '../dist/knowledge-embedding-activities.js';

test('embedding activity accepts ID-only work and returns no provider or document result to Temporal', async () => {
  const work = { workspaceId: randomUUID(), jobId: randomUUID() };
  const processed = [];
  const activities = createKnowledgeEmbeddingActivities({
    process: async value => {
      processed.push(value);
      return { vector: [1, 2], text: 'private text' };
    },
  });
  assert.equal(await activities.processKnowledgeEmbedding(work), undefined);
  assert.deepEqual(processed, [work]);
  await assert.rejects(activities.processKnowledgeEmbedding({ ...work, query: 'private text' }), error => {
    assert.equal(error.type, 'InvalidKnowledgeEmbeddingWork');
    assert.equal(error.nonRetryable, true);
    return true;
  });
  assert.deepEqual(processed, [work]);
});

test('embedding activity scrubs errors and leaves retry ownership to SQL', async () => {
  const activities = createKnowledgeEmbeddingActivities({
    process: async () => {
      throw new Error('private query and provider credential');
    },
  });
  await assert.rejects(
    activities.processKnowledgeEmbedding({ workspaceId: randomUUID(), jobId: randomUUID() }),
    error => {
      assert.equal(error.message, 'Knowledge embedding processing unavailable');
      assert.equal(error.type, 'KnowledgeEmbeddingUnavailable');
      assert.equal(error.nonRetryable, true);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

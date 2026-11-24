import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGoogleKnowledgeParts } from '../dist/knowledge-google-composition.js';
import { createGoogleKnowledgeActivities } from '../dist/knowledge-google-activities.js';

test('Google corpus composition isolates provider activities', async () => {
  const forbidden = async () => assert.fail('composition performs no external work');
  const composed = createGoogleKnowledgeParts({
    runtime: { transaction: forbidden },
    googleService: { status: forbidden, withCredential: forbidden },
    providerFetch: forbidden,
  });
  assert.ok(composed.service);
  assert.deepEqual(Object.keys(composed.activities), ['processGoogleKnowledge']);
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

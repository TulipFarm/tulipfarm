import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAtlassianKnowledgeParts } from '../dist/knowledge-atlassian-composition.js';
import { createAtlassianKnowledgeActivities } from '../dist/knowledge-atlassian-activities.js';
import { atlassianCorpusFromEnvironment } from '@tulipfarm/atlassian/corpus';

test('Atlassian corpus composition isolates provider activities', async () => {
  const forbidden = async () => assert.fail('composition performs no external work');
  const composed = createAtlassianKnowledgeParts({
    runtime: { transaction: forbidden },
    atlassianCorpus: {
      sites: forbidden,
      discover: forbidden,
      inspectSelection: forbidden,
      access: forbidden,
      list: forbidden,
      read: forbidden,
    },
  });
  assert.ok(composed.service);
  assert.deepEqual(Object.keys(composed.activities), ['processAtlassianKnowledge']);
});

test('Atlassian composition without REST account configuration stays not-configured', async () => {
  const composed = createAtlassianKnowledgeParts({
    runtime: { transaction: async () => assert.fail('no storage work') },
    env: { ATLASSIAN_REST_CLIENT_ID: 'only-partial' },
  });
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

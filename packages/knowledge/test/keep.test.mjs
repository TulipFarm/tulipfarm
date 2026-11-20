import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { keepWorkspaceKnowledgeScope } from '@tulipfarm/memory-keep';
import { createKnowledgeKeepIndex, KnowledgeSearchUnavailable } from '../dist/index.js';

const ws = randomUUID();
const hit = (documentId, ordinal, score, metadata = { documentId, publicationId: randomUUID() }) => ({
  id: `${documentId}#${ordinal}`,
  score,
  sourceId: documentId,
  text: 'passage',
  citation: {
    sourceId: documentId,
    sourceTitle: 'Title',
    episodeId: `${documentId}#${ordinal}`,
    charStart: 0,
    charEnd: 7,
    quote: 'passage',
    sourceMetadata: metadata,
  },
});

test('Keep index splits large allowlists, keeps only allowed mapped hits and merges by score', async () => {
  const ids = Array.from({ length: 2500 }, () => randomUUID());
  const outsider = randomUUID();
  const calls = [];
  const index = createKnowledgeKeepIndex({
    enabled: async () => true,
    client: () => ({
      searchKnowledge: async input => {
        calls.push(input);
        const first = input.sourceIds[0];
        return {
          status: 'ok',
          value: {
            omitted: 0,
            hits: [
              hit(first, 3, calls.length),
              hit(outsider, 0, 99),
              hit(input.sourceIds[1], 0, 50, { documentId: outsider, publicationId: randomUUID() }),
              hit(input.sourceIds[2], 0, 50, { documentId: input.sourceIds[2] }),
            ],
          },
        };
      },
    }),
  });
  const found = await index.search(ws, 'query', ids);
  assert.deepEqual(
    calls.map(call => call.sourceIds.length),
    [1000, 1000, 500],
  );
  assert.ok(calls.every(call => call.scope.user === keepWorkspaceKnowledgeScope(ws).user));
  assert.deepEqual(new Set(calls.flatMap(call => call.sourceIds)), new Set(ids));
  assert.deepEqual(
    found.map(item => [item.documentId, item.ordinal, item.score]),
    [
      [ids[2000], 3, 3],
      [ids[1000], 3, 2],
      [ids[0], 3, 1],
    ],
  );
});

test('Keep index reports unavailability instead of an empty result', async () => {
  const unreachable = createKnowledgeKeepIndex({
    enabled: async () => true,
    client: () => ({ searchKnowledge: async () => ({ status: 'unavailable', reason: 'unreachable' }) }),
  });
  await assert.rejects(unreachable.search(ws, 'query', [randomUUID()]), KnowledgeSearchUnavailable);
  const unconfigured = createKnowledgeKeepIndex({ enabled: async () => true, client: () => undefined });
  await assert.rejects(unconfigured.search(ws, 'query', [randomUUID()]), error => error.reason === 'not-configured');
});

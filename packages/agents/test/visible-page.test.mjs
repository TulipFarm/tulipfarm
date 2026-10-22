import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { visiblePage } from '../src/visible-page.ts';

test('visible pages skip denied batches and authorize the lookahead before issuing a cursor', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    id: String(index).padStart(4, '0'),
    name: `Agent ${index}`,
  }));
  const load = async (after, limit) => rows.filter(row => !after || row.id > after).slice(0, limit);
  const authorize = async row => {
    if (!['0101', '0201', '0204'].includes(row.id)) throw new AccessDenied();
  };
  assert.deepEqual(await visiblePage({ limit: 2 }, load, authorize), {
    items: [
      { id: '0101', name: 'Agent 101' },
      { id: '0201', name: 'Agent 201' },
    ],
    nextCursor: '0201',
  });
  assert.deepEqual(await visiblePage({ limit: 2, after: '0201' }, load, authorize), {
    items: [{ id: '0204', name: 'Agent 204' }],
    nextCursor: null,
  });
});

test('an unavailable authorization or exhausted scan cannot claim an empty final page', async () => {
  const rows = [{ id: '1' }, { id: '2' }];
  await assert.rejects(
    visiblePage(
      { limit: 1 },
      async () => rows,
      async row => {
        if (row.id === '2') throw new SourceAuthorizationUnavailable();
      },
    ),
    SourceAuthorizationUnavailable,
  );
  await assert.rejects(
    visiblePage(
      { limit: 1 },
      async () => Array.from({ length: 100 }, (_, index) => ({ id: String(index) })),
      async () => {
        throw new AccessDenied();
      },
    ),
    SourceAuthorizationUnavailable,
  );
  assert.deepEqual(
    await visiblePage(
      { limit: 2 },
      async () => rows,
      async () => {},
    ),
    { items: rows, nextCursor: null },
  );
});

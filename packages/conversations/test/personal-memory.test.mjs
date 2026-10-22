import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import {
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  readPersonalMemory,
  createPersonalMemoryService,
} from '../src/personal-memory.ts';

test('memory contracts bound Unicode characters, reject invalid text and caller owner IDs', () => {
  for (const content of ['x'.repeat(10000), '🌷'.repeat(10000), '', ' \n ']) {
    assert.equal(savePersonalMemorySchema.parse({ content, expectedRevision: 0 }).content, content);
  }
  for (const content of ['x'.repeat(10001), '🌷'.repeat(10001), '\0', '\uD800', '\uDC00']) {
    assert.equal(savePersonalMemorySchema.safeParse({ content, expectedRevision: 0 }).success, false);
  }
  for (const expectedRevision of [-1, 1.5, '0', 2147483647]) {
    assert.equal(deletePersonalMemorySchema.safeParse({ expectedRevision }).success, false);
  }
  assert.equal(
    savePersonalMemorySchema.safeParse({ content: 'private', expectedRevision: 0, membershipId: randomUUID() }).success,
    false,
  );
  assert.equal(deletePersonalMemorySchema.safeParse({ expectedRevision: 0, userId: 'someone-else' }).success, false);
});

test('runtime reader checks current membership before any personal content read', async () => {
  const queries = [];
  const tx = {
    schema: 'ws_test',
    client: {
      query: async (sql, values) => {
        queries.push({ sql, values });
        return sql.includes('tf_authorization_lock') ? { rowCount: 1, rows: [{ id: 1 }] } : { rowCount: 0, rows: [] };
      },
    },
  };
  const actor = { kind: 'human', userId: 'removed', membershipId: randomUUID() };
  await assert.rejects(readPersonalMemory(tx, actor), AccessDenied);
  assert.equal(
    queries.some(query => query.sql.includes('tf_personal_memory')),
    false,
  );
  assert.deepEqual(queries.at(-1).values, [actor.membershipId, actor.userId]);
  await assert.rejects(readPersonalMemory(tx, { ...actor, kind: 'agent' }));
});

test('invalid saves never open a storage transaction', () => {
  const service = createPersonalMemoryService({ transaction: () => assert.fail('storage must not be reached') });
  assert.throws(() => service.save(randomUUID(), 'user', { content: 'x'.repeat(10001), expectedRevision: 0 }));
  assert.throws(() => service.delete(randomUUID(), 'user', { expectedRevision: -1 }));
});

test('runtime reader treats not-yet-migrated workspaces as empty after checking membership', async () => {
  const actor = { kind: 'human', userId: 'current', membershipId: randomUUID() };
  const tx = {
    schema: 'ws_test',
    commonVersion: 0,
    client: {
      query: async sql => {
        if (sql.includes('tf_authorization_lock')) return { rowCount: 1, rows: [{ id: 1 }] };
        if (sql.includes('tf_memberships'))
          return { rowCount: 1, rows: [{ id: actor.membershipId, user_id: actor.userId, role: 'member' }] };
        assert.fail('old workspaces have no personal memory table');
      },
    },
  };
  assert.deepEqual(await readPersonalMemory(tx, actor), { content: '', revision: 0 });
});

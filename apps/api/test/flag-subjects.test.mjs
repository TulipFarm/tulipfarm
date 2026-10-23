import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFlagSubjects } from '../src/flag-subjects.ts';

test('the API flag resolver reads the user email and workspace attributes it was asked for', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push([sql, values]);
      if (sql.includes('app.users')) return { rows: [{ email: 'ada@example.test' }] };
      return { rows: [{ slug: 'acme', name: 'Acme', created_at: new Date('2026-01-01T00:00:00Z') }] };
    },
  };
  const resolve = apiFlagSubjects(pool);
  assert.deepEqual(await resolve({ userId: 'u', workspaceId: 'w' }), {
    user: { email: 'ada@example.test' },
    workspace: { slug: 'acme', name: 'Acme', createdAt: '2026-01-01T00:00:00.000Z' },
  });
  queries.length = 0;
  await resolve({ workspaceId: 'w' });
  assert.equal(queries.length, 1);
  assert.ok(queries[0][0].includes('app.workspaces'), 'a workspace-only lookup never reads the user');
});

test('the API flag resolver returns nothing for missing records', async () => {
  const resolve = apiFlagSubjects({ query: async () => ({ rows: [] }) });
  assert.deepEqual(await resolve({ userId: 'u', workspaceId: 'w' }), {});
});

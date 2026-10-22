import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { listWorkspaces, WorkspaceDiscoveryUnavailable } from '../src/store.ts';

function fixture(count) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    name: String(index).padStart(4, '0'),
    slug: `workspace-${index}`,
    created_by: randomUUID(),
    created_at: new Date(),
    soul_commit: 'a'.repeat(40),
  }));
  const pages = [];
  let checked = 0;
  let released = false;
  const client = {
    async query(sql, values) {
      if (!sql.startsWith('SELECT w.*')) return { rows: [] };
      const start = values[0] === null ? 0 : rows.findIndex(row => row.id === values[1]) + 1;
      const page = rows.slice(start, start + values[2]);
      pages.push(page.length);
      return { rows: page };
    },
    release() {
      released = true;
    },
  };
  const store = {
    pool: { connect: async () => client },
    runtime: {
      async transaction() {
        checked++;
        return true;
      },
    },
  };
  return { store, client, pages, checked: () => checked, released: () => released };
}

test('discovery allows the safety boundary and explicitly rejects overflow instead of returning a partial list', async () => {
  const full = fixture(1000);
  assert.equal((await listWorkspaces(full.store, randomUUID())).length, 1000);
  assert.deepEqual(full.pages, [...Array(10).fill(100), 0]);
  assert.equal(full.checked(), 1000);
  const overflow = fixture(1001);
  await assert.rejects(listWorkspaces(overflow.store, randomUUID()), /1000-candidate safety limit/);
  assert.deepEqual(overflow.pages, [...Array(10).fill(100), 1]);
  assert.equal(overflow.checked(), 0);
  assert.equal(overflow.released(), true);
});

test('discovery checks its elapsed budget after draining a batch and returns no partial success', async t => {
  const db = fixture(200);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let checks = 0;
  db.store.runtime.transaction = async () => {
    checks++;
    now = 30001;
    return true;
  };
  await assert.rejects(listWorkspaces(db.store, randomUUID()), /time budget/);
  assert.equal(checks, 4);
  assert.deepEqual(db.pages, [100, 100, 0]);
  assert.equal(db.released(), true);
});

test('discovery reports a failed later registry page and releases its integration', async () => {
  const db = fixture(200);
  const query = db.client.query;
  db.client.query = async (sql, values) => {
    if (sql.startsWith('SELECT w.*') && values[0] !== null) throw new Error('registry unavailable');
    return query(sql, values);
  };
  await assert.rejects(listWorkspaces(db.store, randomUUID()), WorkspaceDiscoveryUnavailable);
  assert.equal(db.checked(), 0);
  assert.equal(db.released(), true);
});

test('discovery releases the registry snapshot before permission checks need the pool', async () => {
  const db = fixture(102);
  db.store.runtime.transaction = async () => {
    assert.equal(db.released(), true);
    return true;
  };
  assert.equal((await listWorkspaces(db.store, randomUUID())).length, 102);
});

test('discovery reports registry integration failures as unavailable', async () => {
  const db = fixture(0);
  db.store.pool.connect = async () => {
    throw new Error('connection failed');
  };
  await assert.rejects(listWorkspaces(db.store, randomUUID()), WorkspaceDiscoveryUnavailable);
});

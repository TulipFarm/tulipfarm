import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadStoredRecents,
  matchesWords,
  saveStoredRecents,
  type StoredRecentEntry,
} from '../src/features/search/recent-storage.ts';

function withLocalStorage(run: (store: Map<string, string>) => void) {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    },
  });
  try {
    run(store);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  }
}

test('loadStoredRecents and saveStoredRecents cap entries at four per workspace', () => {
  withLocalStorage(() => {
    const entries: StoredRecentEntry[] = [1, 2, 3, 4, 5].map(n => ({
      id: `table-${n}`,
      title: `Table ${n}`,
      category: 'tables',
      target: { kind: 'table', tableId: `id-${n}` },
    }));
    saveStoredRecents('ws-a', entries);
    assert.deepEqual(
      loadStoredRecents('ws-a').map(entry => entry.id),
      ['table-1', 'table-2', 'table-3', 'table-4'],
    );
    assert.deepEqual(loadStoredRecents('ws-b'), []);
  });
});

test('loadStoredRecents ignores malformed JSON and invalid target schemas', () => {
  withLocalStorage(store => {
    store.set('tf:search-recents:ws-corrupt', '{not valid json');
    assert.deepEqual(loadStoredRecents('ws-corrupt'), []);

    store.set(
      'tf:search-recents:ws-bad-shape',
      JSON.stringify([{ id: 'x', title: 'Bad', category: 'tables', target: { kind: 'unknown' } }]),
    );
    assert.deepEqual(loadStoredRecents('ws-bad-shape'), []);
  });
});

test('matchesWords requires every word case-insensitively', () => {
  assert.equal(matchesWords('Customer Orders 2026', ['orders', 'cust']), true);
  assert.equal(matchesWords('Customer Orders 2026', ['orders', 'missing']), false);
});

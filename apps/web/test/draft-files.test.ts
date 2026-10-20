import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import {
  addDraftFiles,
  clearDraftFiles,
  readDraftFiles,
  referenceLimit,
  writeDraftFiles,
  type FileReference,
} from '../src/features/chat/draft-files.ts';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const owner = { workspaceId: 'workspace-a', membershipId: 'member-a' };
const local: FileReference = {
  source: 'tulipfarm',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Budget.csv',
  mediaType: 'text/csv',
  size: 1024,
};
const google: FileReference = {
  source: 'google',
  id: 'drive-file',
  name: 'Plan',
  mediaType: 'application/pdf',
  binding: { integrationId: '22222222-2222-4222-8222-222222222222', accountId: 'account-a', generation: 3 },
};

beforeEach(() => {
  const values: Record<string, string> = {};
  Object.defineProperties(values, {
    getItem: { value: (key: string) => values[key] ?? null },
    setItem: {
      value: (key: string, value: string) => {
        values[key] = value;
      },
    },
    removeItem: {
      value: (key: string) => {
        delete values[key];
      },
    },
  });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: values });
});
after(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});

test('drafts retain file identities and Google integration bindings in the existing storage format', () => {
  writeDraftFiles(owner, 'new', [local, google]);
  assert.deepEqual(readDraftFiles(owner, 'new'), [local, google]);
  assert.equal(
    sessionStorage.getItem('tulipfarm:chat-draft-files:["workspace-a","member-a","new"]'),
    JSON.stringify([local, google]),
  );
  assert.deepEqual(readDraftFiles({ ...owner, membershipId: 'member-b' }, 'new'), []);
  assert.deepEqual(readDraftFiles({ ...owner, workspaceId: 'workspace-b' }, 'new'), []);
  assert.deepEqual(readDraftFiles(owner, 'task:one'), []);
});

test('adding files deduplicates existing references and leaves an over-limit draft unchanged', () => {
  writeDraftFiles(owner, 'new', [local]);
  assert.equal(addDraftFiles(owner, 'new', [local, google]), true);
  assert.deepEqual(readDraftFiles(owner, 'new'), [local, google]);
  const added = Array.from({ length: referenceLimit }, (_, i) => ({ ...google, id: `drive-${i}` }));
  assert.equal(addDraftFiles(owner, 'new', added), false);
  assert.deepEqual(readDraftFiles(owner, 'new'), [local, google]);
});

test('clearing one sent draft leaves other targets intact', () => {
  writeDraftFiles(owner, 'new', [local]);
  writeDraftFiles(owner, 'task:one', [google]);
  writeDraftFiles(owner, 'new', []);
  assert.deepEqual(readDraftFiles(owner, 'new'), []);
  assert.deepEqual(readDraftFiles(owner, 'task:one'), [google]);
});

test('logout clears all draft-file owners and targets but preserves unrelated storage', () => {
  writeDraftFiles(owner, 'new', [local]);
  writeDraftFiles(owner, 'task:one', [google]);
  writeDraftFiles({ ...owner, membershipId: 'member-b' }, 'chat:two', [local]);
  sessionStorage.setItem('tulipfarm:chat-draft-files-other', 'keep');
  clearDraftFiles();
  assert.deepEqual(Object.keys(sessionStorage), ['tulipfarm:chat-draft-files-other']);
  assert.equal(sessionStorage.getItem('tulipfarm:chat-draft-files-other'), 'keep');
  clearDraftFiles();
  assert.deepEqual(readDraftFiles(owner, 'new'), []);
});

test('existing drafts default local sources and reject malformed references', () => {
  const key = 'tulipfarm:chat-draft-files:["workspace-a","member-a","new"]';
  const { source: _source, ...legacy } = local;
  sessionStorage.setItem(key, JSON.stringify([legacy]));
  assert.deepEqual(readDraftFiles(owner, 'new'), [local]);
  for (const raw of ['{', '{}', JSON.stringify([{ ...google, binding: { ...google.binding, generation: 0 } }])]) {
    sessionStorage.setItem(key, raw);
    assert.deepEqual(readDraftFiles(owner, 'new'), []);
  }
});

test('unavailable tab storage preserves the existing in-memory-only fallback', () => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('Storage disabled');
    },
  });
  assert.deepEqual(readDraftFiles(owner, 'new'), []);
  assert.doesNotThrow(() => writeDraftFiles(owner, 'new', [local]));
  assert.doesNotThrow(clearDraftFiles);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editList } from '../src/features/chat/chat-edits.ts';
import type { Chat } from '../src/features/chat/conversation-api.ts';

const chat = (id: string, extra: Partial<Chat> = {}) =>
  ({ id, title: id, titleRevision: 1, titleManual: false, archived: false, pinned: false, ...extra }) as Chat;
const [a, b] = [chat('a'), chat('b')];
const active = ['conversations', 'list', false, ''];
const pinned = ['conversations', 'list', 'pinned'];
const sidebar = ['conversations', 'list', 'sidebar'];
const pinnedIds = (data: unknown) => (data as Chat[]).map(item => item.id);
const ids = (data: unknown) => (data as { chats: Chat[] }).chats.map(item => item.id);

test('a rename shows in lists and the sidebar and leaves reads without the chat alone', () => {
  const list = { chats: [a, b] };
  const renamed = editList(list, active, a, { kind: 'rename', title: 'Plan' }) as { chats: Chat[] };
  assert.deepEqual(renamed.chats[0], { ...a, title: 'Plan', titleRevision: 2, titleManual: true });
  const other = { chats: [b] };
  assert.equal(editList(other, active, a, { kind: 'rename', title: 'Plan' }), other);
  assert.deepEqual(editList([{ id: 'a', name: 'a' }], sidebar, a, { kind: 'rename', title: 'Plan' }), [
    { id: 'a', name: 'Plan' },
  ]);
});

test('archive and delete drop the chat only from lists whose state it leaves', () => {
  const list = { chats: [a, b] };
  assert.deepEqual(ids(editList(list, active, a, { kind: 'archive', archived: true })), ['b']);
  const archived = { chats: [chat('a', { archived: true })] };
  assert.deepEqual(ids(editList(archived, active, a, { kind: 'archive', archived: true })), ['a']);
  assert.deepEqual(ids(editList(archived, active, a, { kind: 'archive', archived: false })), []);
  assert.deepEqual(ids(editList(list, active, a, { kind: 'delete' })), ['b']);
  assert.deepEqual(editList([{ id: 'a', name: 'a' }], sidebar, a, { kind: 'archive', archived: true }), []);
});

test('a pin joins the pinned list and the sidebar top; an unpin, archive or delete leaves the pinned list', () => {
  // The pinned read caches the chats array itself, like the sidebar, so only the key tells them apart.
  assert.deepEqual(editList([b], pinned, a, { kind: 'pin', pinned: true }), [{ ...a, pinned: true }, b]);
  assert.deepEqual(pinnedIds(editList([a, b], pinned, a, { kind: 'pin', pinned: false })), ['b']);
  assert.deepEqual(pinnedIds(editList([a, b], pinned, a, { kind: 'archive', archived: true })), ['b']);
  assert.deepEqual(pinnedIds(editList([a, b], pinned, a, { kind: 'delete' })), ['b']);
  assert.deepEqual(editList([a], pinned, a, { kind: 'rename', title: 'Plan' }), [
    { ...a, title: 'Plan', titleRevision: 2, titleManual: true },
  ]);
  const hidden = chat('c', { archived: true });
  const list = [b];
  assert.equal(editList(list, pinned, hidden, { kind: 'pin', pinned: true }), list);
  assert.deepEqual(
    editList(
      [
        { id: 'b', name: 'b' },
        { id: 'a', name: 'a' },
      ],
      sidebar,
      a,
      { kind: 'pin', pinned: true },
    ),
    [
      { id: 'a', name: 'a', pinned: true },
      { id: 'b', name: 'b' },
    ],
  );
});

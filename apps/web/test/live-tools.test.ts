import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newestTools, reconcileLiveTools, unclaimedToolTurns } from '../src/features/chat/live-tools.ts';
import type { ConversationMessage } from '../src/features/chat/conversation-api.ts';
import type { StreamTool } from '@tulipfarm/conversations/events';

const update: StreamTool = {
  id: 'call',
  turnId: 'turn',
  generation: 1,
  epoch: 2,
  sequence: 1,
  tool: 'slack.search',
  status: 'running',
  presentation: { label: 'Looking up Slack messages', brand: 'slack' },
};
const message: ConversationMessage = {
  id: 'message',
  sequence: 2,
  author: 'human',
  createdAt: '2026-10-12T00:00:00Z',
  parts: [],
  calendarResults: [],
  tools: [],
  turn: { id: 'turn', generation: 1, epoch: 2, status: 'processing' },
};
const reconcile = (saved: ConversationMessage, event = update) =>
  reconcileLiveTools([saved], new Map([[event.id, event]]))[0]!;

test('live calls precede history, keep receipts, and cannot resurrect a terminal call or an old attempt', () => {
  assert.equal(reconcile(message).tools[0]?.status, 'running');
  assert.equal(reconcile(message, { ...update, status: 'completed' }).tools[0]?.status, 'completed');
  const receipt = { id: update.id, tool: update.tool, status: 'completed' as const, fileId: 'file' };
  assert.deepEqual(reconcile({ ...message, tools: [receipt] }).tools, [receipt]);
  assert.deepEqual(reconcile(message, { ...update, generation: 0 }).tools, []);
  assert.deepEqual(reconcile(message, { ...update, epoch: 1 }).tools, []);
  assert.equal(
    reconcile({ ...message, turn: { ...message.turn!, status: 'queued', epoch: 1 } }).tools[0]?.status,
    'running',
    'call start can overtake the coalesced claim snapshot',
  );
  assert.deepEqual(reconcile({ ...message, turn: { ...message.turn!, status: 'cancelled' } }).tools, []);
});

test('newest-first spans messages and preserves every call for expansion', () => {
  const tools = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    tool: 'rows.get',
    status: 'completed' as const,
  }));
  const ordered = newestTools([
    { ...message, sequence: 2, tools: tools.slice(5) },
    { ...message, sequence: 1, tools: tools.slice(0, 5) },
  ]);
  assert.deepEqual(
    ordered.slice(0, 7).map(tool => tool.id),
    ['11', '10', '9', '8', '7', '6', '5'],
  );
  assert.deepEqual(
    ordered.map(tool => tool.id),
    [...tools].reverse().map(tool => tool.id),
  );
});

test('a first call can render before its message history arrives, then reconciles without duplication', () => {
  const updates = new Map([[update.id, update]]);
  assert.equal(newestTools([], updates)[0]?.status, 'running');
  assert.equal(newestTools(reconcileLiveTools([message], updates), updates).length, 1);
});

test('provisional activity keeps turn identity and execution order until saved history claims it', () => {
  const later = { ...update, id: 'later', sequence: 3 };
  const other = { ...update, id: 'other', turnId: 'other-turn', sequence: 2 };
  const updates = new Map([later, other, update].map(tool => [tool.id, tool]));
  assert.deepEqual(
    unclaimedToolTurns([], updates).map(turn => [turn.id, turn.tools.map(tool => tool.id)]),
    [
      ['turn', ['call', 'later']],
      ['other-turn', ['other']],
    ],
  );
  assert.deepEqual(
    unclaimedToolTurns([message], updates).map(turn => turn.id),
    ['other-turn'],
  );
});

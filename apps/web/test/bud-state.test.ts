import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budState, emptyChatIntro } from '../src/features/chat/bud-state.ts';
import type { ConversationMessage } from '../src/features/chat/conversation-api.ts';
import type { ConversationStreamSnapshot } from '../src/features/chat/conversation-stream.ts';

const turn = { id: 'turn', generation: 1, status: 'processing' as const };
const message: ConversationMessage = {
  id: 'message',
  sequence: 1,
  author: 'human',
  createdAt: '',
  parts: [],
  turn,
  tools: [],
  calendarResults: [],
};
const stream: ConversationStreamSnapshot = {
  status: 'open',
  previews: new Map(),
  progress: new Map(),
  avatars: new Map([
    ['turn', { turnId: 'turn', generation: 1, epoch: 2, step: 0, seq: 1, avatar: { name: 'Bud', state: 'Solving' } }],
  ]),
};
test('Bud uses only the current turn and generation, with explicit idle, waiting, and failure poses', () => {
  assert.equal(budState([], false, stream), 'Idle');
  assert.equal(budState([], true, stream), 'Thinking');
  assert.equal(budState([message], false, stream), 'Solving');
  assert.equal(budState([message], false, { ...stream, status: 'unavailable' }), 'Thinking');
  assert.equal(
    budState([message], false, {
      ...stream,
      progress: new Map([['turn', { ...turn, epoch: 3, step: 0, round: 1, turnId: 'turn' }]]),
    }),
    'Thinking',
  );
  for (const [status, expected] of [
    ['failed', 'Confused'],
    ['blocked', 'Confused'],
    ['cancelled', 'Idle'],
    ['waiting', 'Listening'],
    ['completed', 'Solving'],
  ] as const) {
    assert.equal(budState([{ ...message, turn: { ...turn, status } }], false, stream), expected);
  }
  assert.equal(budState([{ ...message, turn: { ...turn, generation: 2 } }], false, stream), 'Thinking');
  assert.equal(budState([{ ...message, turn: { ...turn, id: 'other' } }], false, stream), 'Thinking');
});

test('Empty chat intro invites a first message; the sharing scope lives on the composer control', () => {
  assert.equal(emptyChatIntro(true), 'Ask anything, or start from a task below.');
  assert.equal(emptyChatIntro(false), 'Turn a business task into a clear next step.');
});

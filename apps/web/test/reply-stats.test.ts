import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConversationMessage } from '../src/features/chat/conversation-api.ts';
import { replyStats } from '../src/features/chat/reply-stats.ts';

const families = [
  { id: 'gpt-luna', displayName: 'GPT-6 Luna' },
  { id: 'claude-sonnet', displayName: 'Claude Sonnet 5' },
];
const message = (author: 'human' | 'assistant', turn: unknown = null) =>
  ({ id: crypto.randomUUID(), sequence: 1, author, createdAt: '', parts: [], turn }) as unknown as ConversationMessage;
const stats = { model: 'gpt-luna', firstTextMs: 1200, durationMs: 4000, traceId: 'abc' };

test('a reply shows the stats of the message that asked for it, with the model display name', () => {
  const messages = [message('human', { id: 't', status: 'completed', stats }), message('assistant')];
  assert.deepEqual(replyStats(messages, 1, families), {
    model: 'GPT-6 Luna',
    firstTokenMs: 1200,
    durationMs: 4000,
    traceId: 'abc',
  });
  assert.equal(replyStats(messages, 0, families), undefined);
});

test('a fallback reply names the model that answered, and an unknown family keeps its ID', () => {
  const fallback = { id: 't', status: 'completed', errorCode: 'model-fallback:claude-sonnet', stats };
  assert.equal(replyStats([message('human', fallback), message('assistant')], 1, families)?.model, 'Claude Sonnet 5');
  const unknown = { id: 't', status: 'completed', stats: { ...stats, model: 'new-model' } };
  assert.equal(replyStats([message('human', unknown), message('assistant')], 1, families)?.model, 'new-model');
});

test('a reply from a plan model the catalog no longer lists shows its versioned name', () => {
  const plan = { id: 't', status: 'completed', stats: { ...stats, model: 'claude-plan-claude-fable-5-2' } };
  assert.equal(replyStats([message('human', plan), message('assistant')], 1, families)?.model, 'Claude Fable 5.2');
});

test('stats never come from an older message when the nearest one has none', () => {
  const messages = [
    message('human', { id: 'old', status: 'completed', stats }),
    message('assistant'),
    message('human'),
    message('assistant'),
  ];
  assert.equal(replyStats(messages, 3, families), undefined);
});

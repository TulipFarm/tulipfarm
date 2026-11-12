import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyChatIntro } from '../src/features/chat/empty-chat.ts';

test('Empty chat intro invites a first message; the sharing scope lives on the composer control', () => {
  assert.equal(emptyChatIntro(true), 'Ask anything, or start from a task below.');
  assert.equal(emptyChatIntro(false), 'Turn a business task into a clear next step.');
});

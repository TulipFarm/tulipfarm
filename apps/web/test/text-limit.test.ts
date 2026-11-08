import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textLengthError } from '../src/features/chat/text-limit.ts';

test('a message at the limit has no notice', () => {
  assert.equal(textLengthError('x'.repeat(65536)), null);
  assert.equal(textLengthError('🌱'.repeat(16384)), null);
});

test('an over-limit ASCII message states its length and the limit in characters', () => {
  assert.equal(
    textLengthError('x'.repeat(70000)),
    'This message is 70,000 characters. Keep it under 65,536 characters.',
  );
});

test('an over-limit multibyte message shows how many of its characters fit', () => {
  assert.equal(
    textLengthError('🌱'.repeat(20000)),
    'This message is 20,000 characters. Keep it under 16,384 characters.',
  );
  assert.equal(
    textLengthError(`${'é'.repeat(30000)}${'x'.repeat(10000)}`),
    'This message is 40,000 characters. Keep it under 35,536 characters.',
  );
});

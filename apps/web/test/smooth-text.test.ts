import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advance, revealPoint } from '../src/features/chat/smooth-text.ts';

const frames = (length: number, from: number, ms: number) => {
  let position = from;
  for (let elapsed = 0; elapsed < ms; elapsed += 16) position = advance(length, position, 16);
  return position;
};

test('a streamed burst types out over frames and finishes within about half a second', () => {
  assert.ok(advance(120, 0, 16) < 10);
  assert.ok(frames(120, 0, 200) < 120);
  assert.equal(frames(120, 0, 600), 120);
});

test('a frame stamped before the reveal started reveals nothing', () => {
  assert.equal(advance(120, 0, -5), 0);
  assert.equal(revealPoint('Hello there', Math.floor(advance(11, 0, -5))), 5);
});

test('the reveal stops at the end of a word', () => {
  const text = 'Create the **account** now';
  assert.equal(revealPoint(text, 0), 6);
  assert.equal(revealPoint(text, 13), 22);
  assert.equal(revealPoint(text, 24), text.length);
  assert.equal(revealPoint(text, 99), text.length);
});

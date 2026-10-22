import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageTime, messageTimeTitle, plainTextFromMarkdown } from '../src/lib/message-copy.ts';

test('writes a link once when label equals url', () => {
  assert.equal(plainTextFromMarkdown('See [https://x.com](https://x.com) now'), 'See https://x.com now');
  assert.equal(plainTextFromMarkdown('See <https://x.com>'), 'See https://x.com');
});

test('writes label and url when they differ', () => {
  assert.equal(
    plainTextFromMarkdown('Open [the docs](https://x.com/docs "Docs").'),
    'Open the docs (https://x.com/docs).',
  );
});

test('keeps code and line breaks', () => {
  const text = '```\nconst a = 1;\nb\n```';
  assert.equal(plainTextFromMarkdown(text), text);
});

test('formats today, yesterday, and older times', () => {
  const now = new Date(2026, 9, 10, 18, 0);
  assert.doesNotMatch(messageTime(new Date(2026, 9, 10, 15, 44).toISOString(), now), /Yesterday|Oct/);
  assert.match(messageTime(new Date(2026, 9, 9, 15, 44).toISOString(), now), /^Yesterday /);
  assert.match(messageTime(new Date(2026, 9, 7, 15, 44).toISOString(), now), /\b7\b/);
  assert.match(messageTime(new Date(2025, 9, 7, 15, 44).toISOString(), now), /2025/);
});

test('reused formatters preserve local time and full timestamp titles', () => {
  const now = new Date(2026, 9, 10, 18, 0);
  for (const date of [
    new Date(2026, 9, 10, 15, 44),
    new Date(2026, 9, 9, 15, 44),
    new Date(2026, 0, 7, 0, 5),
    new Date(2025, 6, 7, 23, 59),
  ]) {
    const iso = date.toISOString();
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
    const expected =
      date.getMonth() === 9 && date.getDate() === 10
        ? time
        : date.getMonth() === 9 && date.getDate() === 9
          ? `Yesterday ${time}`
          : `${day}, ${time}`;
    assert.equal(messageTime(iso, now), expected);
    assert.equal(messageTimeTitle(iso), date.toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' }));
  }
});

test('the same timestamp ages across midnight and the year boundary', () => {
  const date = new Date(2025, 11, 31, 23, 59);
  const iso = date.toISOString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(messageTime(iso, new Date(2025, 11, 31, 23, 59)), time);
  assert.equal(messageTime(iso, new Date(2026, 0, 1, 0, 1)), `Yesterday ${time}`);
  assert.equal(
    messageTime(iso, new Date(2026, 0, 2, 0, 1)),
    `${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`,
  );
});

test('invalid timestamps retain the existing display', () => {
  assert.equal(messageTime('invalid'), 'Invalid Date, Invalid Date');
  assert.equal(messageTimeTitle('invalid'), 'Invalid Date');
});

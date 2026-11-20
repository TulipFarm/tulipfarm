import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRunReply } from '../src/row-assignments.ts';

const now = new Date('2026-11-20T00:00:00Z');

test('a run reply ends with a status line, which is removed from the progress note', () => {
  assert.deepEqual(readRunReply('Sent the quote.\n**STATUS:** done', now), {
    outcome: 'done',
    reason: null,
    wakeAt: null,
    note: 'Sent the quote.',
  });
  const waiting = readRunReply('Drafted it.\nSTATUS: waiting Which supplier should I use?', now);
  assert.equal(waiting.outcome, 'waiting');
  assert.equal(waiting.reason, 'Which supplier should I use?');
  assert.equal(readRunReply('No closing line.', now).outcome, 'continue');
  assert.equal(readRunReply(`STATUS: waiting ${'x'.repeat(300)}`, now).reason.length, 200);
});

test('a wake time is kept only when it is in the future and at most 30 days ahead', () => {
  const wake = at => readRunReply(`Checking back later.\nSTATUS: continue\nWAKE: ${at}`, now).wakeAt;
  assert.deepEqual(wake('2026-11-21T09:00:00Z'), new Date('2026-11-21T09:00:00Z'));
  assert.equal(wake('2026-12-21T00:00:00Z'), null);
  assert.equal(wake('2026-11-19T00:00:00Z'), null);
  assert.equal(wake('tomorrow'), null);
});

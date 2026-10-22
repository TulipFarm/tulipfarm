import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budCommandSchema, budPreferenceAskSchema, budPreferenceProposeSchema } from '../src/bud-contracts.ts';
import { budCooldownElapsed, budCooldownMs, preferenceText } from '../src/bud-assistant.ts';

test('Bud enforces the exact thirty-minute presentation boundary', () => {
  const last = new Date('2026-10-12T00:00:00Z');
  assert.equal(budCooldownElapsed(null, last.getTime()), true);
  assert.equal(budCooldownElapsed(last, last.getTime() + budCooldownMs - 1), false);
  assert.equal(budCooldownElapsed(last, last.getTime() + budCooldownMs), true);
  assert.equal(budCooldownElapsed(last, last.getTime() - 1), false);
});
test('preference answers preserve the existing document and require explicit typed actions', () => {
  assert.equal(
    preferenceText('Existing context\n', 'reply-style', 'Keep it short.'),
    'Existing context\n\nReply style: Keep it short.',
  );
  assert.equal(preferenceText('', 'role', 'Support'), 'Work role: Support');
  assert.equal(
    budPreferenceAskSchema.safeParse({ tool: 'bud.preference.ask', topic: 'role', question: 'What is your role?' })
      .success,
    true,
  );
  assert.equal(
    budPreferenceProposeSchema.safeParse({
      tool: 'bud.preference.propose',
      topic: 'reply-style',
      question: 'Remember this?',
      value: 'Be brief.',
    }).success,
    true,
  );
  for (const input of [
    { kind: 'answer-preference', id: 'invalid', value: 'brief' },
    { kind: 'answer-preference', id: '11111111-1111-4111-8111-111111111111', value: '' },
    { kind: 'complete' },
    { kind: 'settings', admin: true },
  ])
    assert.equal(budCommandSchema.safeParse(input).success, false);
});

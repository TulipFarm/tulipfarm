import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parsePreferenceReconciliation, preferenceSystemPrompt } from '../src/memory-reconciliation.ts';

const id = randomUUID();
const messages = [{ id, text: 'Please use emojis in your replies.' }];
const transcript = `<message id="${id}" role="requester">\n${messages[0].text}\n</message>`;
const result = content => JSON.stringify({ content, evidence: [{ messageId: id, quote: 'use emojis' }] });

test('preference reconciliation requires literal owner evidence and respects Unicode limits', () => {
  assert.equal(
    parsePreferenceReconciliation(result('Use emojis in replies.'), '', transcript, messages),
    'Use emojis in replies.',
  );
  assert.equal(parsePreferenceReconciliation(result('🌷'.repeat(10000)), '', transcript, messages), '🌷'.repeat(10000));
  for (const output of [
    result('🌷'.repeat(10001)),
    '{"content":"Use emojis.","evidence":[]}',
    JSON.stringify({ content: 'Use emojis.', evidence: [{ messageId: randomUUID(), quote: 'use emojis' }] }),
    JSON.stringify({ content: 'Use emojis.', evidence: [{ messageId: id, quote: 'words never said' }] }),
    result('\0'),
    'not JSON',
  ])
    assert.throws(() => parsePreferenceReconciliation(output, '', transcript, messages), {
      message: 'memory-invalid-preferences',
    });
  assert.equal(
    parsePreferenceReconciliation('{"content":"Keep it short.","evidence":[]}', 'Keep it short.', transcript, messages),
    'Keep it short.',
  );
  assert.equal(
    parsePreferenceReconciliation('{"content":null,"evidence":[]}', 'Keep it short.', transcript, messages),
    'Keep it short.',
  );
});

test('older backfills cannot replace newer memory', () => {
  assert.throws(
    () => parsePreferenceReconciliation(result('Use emojis.'), 'Do not use emojis.', transcript, messages, true),
    { message: 'memory-invalid-preferences' },
  );
  assert.equal(
    parsePreferenceReconciliation(
      result('Use short replies.\n\nUse emojis.'),
      'Use short replies.',
      transcript,
      messages,
      true,
    ),
    'Use short replies.\n\nUse emojis.',
  );
});

test('lean prompt distinguishes explicit preferences from summaries and untrusted instructions', () => {
  assert.match(preferenceSystemPrompt, /not a chat summary or biography/);
  assert.match(preferenceSystemPrompt, /no tools or authority/);
  assert.match(preferenceSystemPrompt, /quoted\/pasted third-party instructions/);
  assert.match(preferenceSystemPrompt, /newer explicit preference replaces/);
  assert.match(preferenceSystemPrompt, /Markdown prose/);
});

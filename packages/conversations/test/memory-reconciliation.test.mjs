import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyMemoryEdit, learningBlockHash, parseMemoryEdits } from '../src/memory-proposals.ts';

const id = randomUUID();
const messages = [{ id, text: 'Please use emojis in your replies.' }];
const transcript = `<message id="${id}" role="requester">\n${messages[0].text}\n</message>`;

test('memory edits apply only where they fit exactly once', () => {
  const current = 'Use short replies.\n- Use emojis.\n- Greet me.';
  assert.equal(
    applyMemoryEdit(current, { kind: 'add', before: null, after: 'Use British spelling.' }),
    `${current}\nUse British spelling.`,
  );
  assert.equal(
    applyMemoryEdit('', { kind: 'add', before: null, after: 'Use British spelling.' }),
    'Use British spelling.',
  );
  assert.equal(applyMemoryEdit(current, { kind: 'add', before: null, after: 'Use emojis.' }), undefined);
  assert.equal(
    applyMemoryEdit(current, { kind: 'change', before: 'short', after: 'long' }),
    'Use long replies.\n- Use emojis.\n- Greet me.',
  );
  assert.equal(
    applyMemoryEdit(current, { kind: 'remove', before: 'Use emojis.', after: null }),
    'Use short replies.\n- Greet me.',
  );
  assert.equal(applyMemoryEdit(current, { kind: 'change', before: 'Use', after: 'Try' }), undefined, 'ambiguous text');
  assert.equal(applyMemoryEdit(current, { kind: 'remove', before: 'missing', after: null }), undefined);
  assert.equal(applyMemoryEdit(current, { kind: 'change', before: 'short', after: 'short' }), undefined, 'no-op');
  assert.equal(applyMemoryEdit('', { kind: 'add', before: null, after: '🌷'.repeat(10001) }), undefined, 'too long');
});

test('suggested edits need the member’s literal words and drop edits that do not fit', () => {
  const output = edits => JSON.stringify({ edits });
  const quote = 'use emojis';
  const add = { kind: 'add', before: null, after: 'Use emojis.', messageId: id, quote };
  assert.deepEqual(parseMemoryEdits(output([add]), '', transcript, messages), [add]);
  assert.deepEqual(parseMemoryEdits(output([add, add]), '', transcript, messages), [add], 'duplicates');
  for (const edit of [
    { ...add, quote: 'never said this' },
    { ...add, messageId: randomUUID() },
    { ...add, before: 'x' },
    { kind: 'remove', before: 'Absent.', after: null, messageId: id, quote },
    { kind: 'change', before: 'Use', after: null, messageId: id, quote },
  ])
    assert.deepEqual(parseMemoryEdits(output([edit]), 'Use short replies.', transcript, messages), []);
  assert.deepEqual(parseMemoryEdits(output([add]), 'Use emojis.', transcript, messages), [], 'already saved');
  assert.throws(() => parseMemoryEdits('not json', '', transcript, messages), /memory-invalid-preferences/);
  assert.throws(() => parseMemoryEdits('{"content":"x"}', '', transcript, messages), /memory-invalid-preferences/);
});

test('learning blocks hash normalized text, not the text itself', () => {
  assert.equal(learningBlockHash('Use  EMOJIS\n'), learningBlockHash('use emojis'));
  assert.match(learningBlockHash('use emojis'), /^[0-9a-f]{64}$/);
  assert.notEqual(learningBlockHash('use emojis'), learningBlockHash('no emojis'));
});

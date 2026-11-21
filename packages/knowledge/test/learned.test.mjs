import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learnedLimits, learnedParts, parseLearnedEntries, sensitiveLearnedText } from '../dist/index.js';

const messages = [
  { id: 'm1', text: 'Our Pro plan costs $49 per seat each month, billed yearly.' },
  { id: 'm2', text: 'Priya owns supplier onboarding now.' },
];
const answer = entries => JSON.stringify({ entries });
const entry = (overrides = {}) => ({
  title: 'Pro plan pricing',
  text: 'The Pro plan costs $49 per seat each month, billed yearly.',
  messageId: 'm1',
  quote: 'Pro plan costs $49 per seat',
  ...overrides,
});

test('keeps facts quoted from the member’s own messages', () => {
  const documentId = '0b0b9a4e-3a35-4f37-9d2b-6b8f0e9b2c11';
  assert.deepEqual(parseLearnedEntries(`Sure: ${answer([entry({ documentId })])} done`, messages), [
    { title: 'Pro plan pricing', text: 'The Pro plan costs $49 per seat each month, billed yearly.', documentId },
  ]);
  assert.equal(parseLearnedEntries(answer([entry({ documentId: 'not-an-id' })]), messages)[0].documentId, null);
});

test('drops entries without an exact quote from a listed message', () => {
  assert.deepEqual(parseLearnedEntries(answer([entry({ quote: 'Pro plan costs $59' })]), messages), []);
  assert.deepEqual(parseLearnedEntries(answer([entry({ messageId: 'm2' })]), messages), []);
  assert.deepEqual(parseLearnedEntries(answer([entry({ messageId: 'assistant' })]), messages), []);
  assert.deepEqual(parseLearnedEntries(answer([entry({ quote: '' })]), messages), []);
});

test('drops secrets, contact details and sensitive personal data', () => {
  for (const text of [
    'Support inbox is help@example.com.',
    'The staging password is hunter2.',
    'Use the API key sk-live_abcdefghijklmnop for billing.',
    'Docs live at https://internal.example.com.',
    'Call the warehouse on +1 415 555 0100.',
    'Token ghp_abcdefghijklmnopqrstuvwxyz0123456789.',
    'Sam was diagnosed with diabetes.',
    'The company card number ends the same as before.',
  ]) {
    assert.equal(sensitiveLearnedText(text), true, text);
    const message = { id: 'm1', text };
    assert.deepEqual(parseLearnedEntries(answer([entry({ text, quote: text })]), [message]), [], text);
  }
  assert.equal(sensitiveLearnedText('The Pro plan costs $49 per seat; Enterprise starts at $25,000 a year.'), false);
});

test('respects size limits, duplicates and the per-answer cap', () => {
  assert.deepEqual(parseLearnedEntries(answer([entry({ title: 'x'.repeat(learnedLimits.title + 1) })]), messages), []);
  assert.deepEqual(parseLearnedEntries(answer([entry({ text: 'x'.repeat(learnedLimits.text + 1) })]), messages), []);
  assert.equal(parseLearnedEntries(answer([entry(), entry({ title: 'PRO PLAN PRICING' })]), messages).length, 1);
  const many = Array.from({ length: 9 }, (_, index) => entry({ title: `Fact ${index}` }));
  assert.equal(parseLearnedEntries(answer(many), messages).length, learnedLimits.entriesPerPart);
  assert.deepEqual(parseLearnedEntries('no json here', messages), []);
  assert.deepEqual(parseLearnedEntries('{"entries": "nope"}', messages), []);
});

test('splits messages into bounded parts', () => {
  const big = 'a'.repeat(learnedLimits.partCharacters - 10);
  const parts = learnedParts([
    { id: '1', text: big },
    { id: '2', text: 'short fact' },
    { id: '3', text: '   ' },
    { id: '4', text: big },
  ]);
  assert.deepEqual(
    parts.map(part => part.map(message => message.id)),
    [['1', '2'], ['4']],
  );
  const lots = Array.from({ length: 20 }, (_, index) => ({ id: String(index), text: big }));
  assert.equal(learnedParts(lots).length, learnedLimits.partsPerSource);
});

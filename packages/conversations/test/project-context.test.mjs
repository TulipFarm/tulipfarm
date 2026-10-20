import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectProjectContext, projectContextReminder } from '../src/project-context.ts';

const pinned = {
  id: '00000000-0000-4000-8000-000000000001',
  revisionId: '00000000-0000-4000-8000-000000000002',
  title: 'Brief',
  content: 'All of this brief is required.',
  pinned: true,
};
const related = {
  ...pinned,
  id: '00000000-0000-4000-8000-000000000003',
  pinned: false,
  content: 'Campaign budget is 450 euros.',
};
const input = {
  projectId: '00000000-0000-4000-8000-000000000004',
  revision: 3,
  instructions: 'Use metric units.',
  files: [
    pinned,
    related,
    { ...related, id: '00000000-0000-4000-8000-000000000005', content: 'Office closes Friday.' },
  ],
};

test('keeps instructions and pinned files complete and retrieves relevant source passages', () => {
  const result = selectProjectContext(input, 'What is the campaign budget?', 4096);
  assert.equal(result.instructions, 'Use metric units.');
  assert.deepEqual(
    result.files.map(file => [file.content, file.start, file.end]),
    [
      ['All of this brief is required.', 0, 30],
      ['Campaign budget is 450 euros.', 0, 29],
    ],
  );
  assert.deepEqual(
    JSON.parse(projectContextReminder(result)).sources.map(source => [source.inclusion, source.citation]),
    [
      ['full', '#project-source=00000000-0000-4000-8000-000000000002'],
      ['passage', '#project-source=00000000-0000-4000-8000-000000000002'],
    ],
  );
  assert.equal(input.files.length, 3);
});

test('required budget includes serialized metadata and escaping, never truncates', () => {
  const required = { ...input, files: [{ ...pinned, content: '"\\\n🌿'.repeat(20) }] };
  const full = selectProjectContext(required, '', 4096);
  const bytes = Buffer.byteLength(projectContextReminder(full));
  assert.equal(selectProjectContext(required, '', bytes).files[0].content, '"\\\n🌿'.repeat(20));
  assert.throws(() => selectProjectContext(required, '', bytes - 1), { message: 'required-context-too-large' });
  for (const budget of [-1, NaN, Infinity, 0.5])
    assert.throws(() => selectProjectContext(required, '', budget), RangeError);
});

test('passage offsets preserve Unicode and selection is stable across database row order', () => {
  const document = { ...related, content: `${'a'.repeat(2999)}🌿 budget` };
  const original = { ...input, files: [document, pinned] };
  const result = selectProjectContext(original, 'budget', 4096);
  assert.deepEqual(
    result.files.map(file => [file.content, file.start, file.end]),
    [
      ['All of this brief is required.', 0, 30],
      ['🌿 budget', 2999, 3008],
    ],
  );
  assert.deepEqual(selectProjectContext({ ...original, files: [pinned, document] }, 'budget', 4096), result);
});

test('optional sources stay within budget and no-match queries retain only pinned knowledge', () => {
  assert.deepEqual(
    selectProjectContext(input, 'unrelated', 4096).files.map(file => file.id),
    [pinned.id],
  );
  const all = selectProjectContext(input, 'budget', 4096);
  const requiredBytes = Buffer.byteLength(projectContextReminder(selectProjectContext(input, '', 4096)));
  assert.equal(all.files.length, 2);
  assert.deepEqual(
    selectProjectContext(input, 'budget', requiredBytes).files.map(file => file.id),
    [pinned.id],
  );
});

test('retrieves exact query words crossing passage boundaries with original Unicode offsets', () => {
  for (const word of ['budget', '预算计划', '𐐀𐐁𐐂', 'budget_2026']) {
    for (const prefixLength of [2994, 2998, 5998]) {
      const document = { ...related, content: ' '.repeat(prefixLength) + word + ' 🌿' };
      const original = { ...input, files: [document, pinned] };
      const result = selectProjectContext(original, word, 100_000);
      assert.equal(result.files.length, 2, `${word} at offset ${prefixLength} must be retrievable`);
      assert.equal(result.files[0].content, pinned.content);
      assert.equal(result.instructions, input.instructions);
      const passage = result.files[1];
      assert.ok(passage.content.includes(word));
      assert.equal(passage.content, document.content.slice(passage.start, passage.end));
      assert.equal(passage.content.isWellFormed(), true);
      assert.ok(passage.content.length <= 3000);
      assert.deepEqual(selectProjectContext({ ...original, files: [pinned, document] }, word, 100_000), result);
      const bytes = Buffer.byteLength(projectContextReminder(result));
      assert.deepEqual(selectProjectContext(original, word, bytes), result);
      assert.deepEqual(
        selectProjectContext(original, word, bytes - 1).files.map(file => file.content),
        [pinned.content],
      );
    }
  }
});

test('overlong unbroken words keep bounded passages and make forward progress', () => {
  for (const word of ['budget', '𐐀𐐁𐐂']) {
    const document = { ...related, content: word.repeat(1001) };
    const result = selectProjectContext({ ...input, files: [document] }, word, 100_000);
    assert.deepEqual(
      result.files.map(file => [file.start, file.end]),
      [
        [0, 3000],
        [3000, 6000],
        [6000, 6006],
      ],
    );
    assert.equal(result.files.map(file => file.content).join(''), document.content);
    assert.ok(result.files.every(file => file.content.length <= 3000 && file.content.isWellFormed()));
  }
});

test('the reminder carries project sources but not the instructions, which go to the system prompt', () => {
  const reminder = JSON.parse(projectContextReminder(selectProjectContext(input, '', 4096)));
  assert.equal('instructions' in reminder, false);
  assert.ok(Array.isArray(reminder.sources));
});

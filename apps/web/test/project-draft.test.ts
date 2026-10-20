import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDirty, keepEdits, rebaseDraft, saveCommand, startDraft } from '../src/features/projects/draft.ts';

const first = { revision: 1, name: 'Spring launch', instructions: 'Answer as the launch team.', archived: false };
const typed = (instructions: string) => ({ ...startDraft(first), values: { name: first.name, instructions } });

test('a newer version of untouched fields joins the draft, and Save expects that version', () => {
  const renamed = { ...first, revision: 2, name: 'Autumn launch' };
  const { draft, conflicts } = rebaseDraft(typed('Quote prices in euros.'), renamed);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(draft, { base: renamed, values: { name: 'Autumn launch', instructions: 'Quote prices in euros.' } });
  assert.deepEqual(saveCommand(draft), {
    expectedRevision: 2,
    name: 'Autumn launch',
    instructions: 'Quote prices in euros.',
    archived: false,
  });
});

test('a newer version of an edited field conflicts until the edits are kept', () => {
  const rewritten = { ...first, revision: 2, instructions: 'Quote prices in dollars.' };
  const draft = typed('Quote prices in euros.');
  assert.deepEqual(rebaseDraft(draft, rewritten), { draft, conflicts: ['instructions'] });
  assert.equal(saveCommand(draft).expectedRevision, 1);
  const kept = keepEdits(draft, rewritten);
  assert.deepEqual(rebaseDraft(kept, rewritten), { draft: kept, conflicts: [] });
  assert.deepEqual(saveCommand(kept), {
    expectedRevision: 2,
    name: 'Spring launch',
    instructions: 'Quote prices in euros.',
    archived: false,
  });
});

test('a clean draft follows newer versions and ignores an older cached one', () => {
  const saved = startDraft({ ...first, revision: 2, instructions: 'Quote prices in euros.' });
  assert.deepEqual(rebaseDraft(saved, first), { draft: saved, conflicts: [] });
  const renamed = { ...first, revision: 3, name: 'Autumn launch', instructions: 'Quote prices in euros.' };
  assert.deepEqual(rebaseDraft(saved, renamed), { draft: startDraft(renamed), conflicts: [] });
  assert.equal(isDirty(saved), false);
});

test('the same change saved elsewhere is not a conflict, and spaces around a name are not an edit', () => {
  const draft = { ...startDraft(first), values: { name: 'Autumn launch ', instructions: first.instructions } };
  assert.equal(isDirty(draft), true);
  const { draft: rebased, conflicts } = rebaseDraft(draft, { ...first, revision: 2, name: 'Autumn launch' });
  assert.deepEqual(conflicts, []);
  assert.equal(isDirty(rebased), false);
  assert.equal(
    isDirty({ ...startDraft(first), values: { name: '  Spring launch  ', instructions: first.instructions } }),
    false,
  );
});

test('a draft that matched one version follows a later revert instead of saving over it', () => {
  const matched = rebaseDraft(typed('Quote prices in euros.'), {
    ...first,
    revision: 2,
    instructions: 'Quote prices in euros.',
  }).draft;
  const reverted = { ...first, revision: 3 };
  assert.deepEqual(rebaseDraft(matched, reverted), { draft: startDraft(reverted), conflicts: [] });
});

test('during a conflict, untouched fields still take the newer text and Save keeps the older revision', () => {
  const both = { ...first, revision: 2, name: 'Autumn launch', instructions: 'Quote prices in dollars.' };
  const { draft, conflicts } = rebaseDraft(typed('Quote prices in euros.'), both);
  assert.deepEqual(conflicts, ['instructions']);
  assert.deepEqual(draft, {
    base: { ...first, name: 'Autumn launch' },
    values: { name: 'Autumn launch', instructions: 'Quote prices in euros.' },
  });
  assert.equal(saveCommand(draft).expectedRevision, 1);
  assert.strictEqual(rebaseDraft(draft, both).draft, draft, 'a settled draft is returned unchanged');
  assert.deepEqual(saveCommand(keepEdits(draft, both)), {
    expectedRevision: 2,
    name: 'Autumn launch',
    instructions: 'Quote prices in euros.',
    archived: false,
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClarificationBlock } from '../dist/task-clarifications.js';
import {
  taskClarificationAnswerInputSchema,
  taskClarificationDraftSchema,
} from '../dist/task-clarification-contracts.js';

test('parseClarificationBlock extracts fenced CLARIFICATION JSON and strips it from visible text', () => {
  const reply = [
    'I checked workspace memory and still need two details before starting.',
    '',
    'CLARIFICATION:',
    '```json',
    JSON.stringify(
      {
        title: 'Need GitHub details',
        summary: 'Confirm which GitHub account and repository to use.',
        fields: [
          { id: 'github_account', kind: 'github_account', label: 'GitHub account', required: true },
          { id: 'repository', kind: 'github_repository', label: 'Repository', required: true },
        ],
      },
      null,
      2,
    ),
    '```',
  ].join('\n');

  const result = parseClarificationBlock(reply);
  assert.ok(result.draft);
  assert.equal(result.draft.title, 'Need GitHub details');
  assert.equal(result.draft.fields.length, 2);
  assert.equal(result.draft.fields[0]?.kind, 'github_account');
  assert.equal(result.draft.fields[1]?.kind, 'github_repository');
  assert.equal(result.text, 'I checked workspace memory and still need two details before starting.');
});

test('parseClarificationBlock extracts inline CLARIFICATION JSON', () => {
  const reply =
    'Waiting on channel.\nCLARIFICATION: {"title":"Pick channel","summary":"Where should I post?","fields":[{"id":"channel","kind":"select","label":"Channel","options":[{"value":"general","label":"#general"}]}]}';
  const result = parseClarificationBlock(reply);
  assert.ok(result.draft);
  assert.equal(result.draft.title, 'Pick channel');
  assert.equal(result.draft.fields[0]?.kind, 'select');
  assert.equal(result.text, 'Waiting on channel.');
});

test('parseClarificationBlock returns null draft for ordinary replies or malformed JSON', () => {
  const plain = parseClarificationBlock('All done, opened the PR.');
  assert.equal(plain.draft, null);
  assert.equal(plain.text, 'All done, opened the PR.');

  const broken = parseClarificationBlock('CLARIFICATION:\n```json\n{not valid json\n```');
  assert.equal(broken.draft, null);
});

test('taskClarificationDraftSchema rejects duplicate field ids and empty select options', () => {
  const dup = taskClarificationDraftSchema.safeParse({
    title: 'Dup',
    summary: 'Dup summary',
    fields: [
      { id: 'repo', kind: 'text', label: 'A' },
      { id: 'repo', kind: 'text', label: 'B' },
    ],
  });
  assert.equal(dup.success, false);

  const emptySelect = taskClarificationDraftSchema.safeParse({
    title: 'Empty',
    summary: 'Summary',
    fields: [{ id: 'env', kind: 'select', label: 'Env', options: [] }],
  });
  assert.equal(emptySelect.success, false);
});

test('taskClarificationAnswerInputSchema accepts valid field answers and rejects invalid field ids', () => {
  const ok = taskClarificationAnswerInputSchema.safeParse({
    answers: { github_account: 'personal:1:1', repository: 'TulipFarm/tulipfarm' },
  });
  assert.equal(ok.success, true);

  const badKey = taskClarificationAnswerInputSchema.safeParse({
    answers: { '123-invalid': 'value' },
  });
  assert.equal(badKey.success, false);
});

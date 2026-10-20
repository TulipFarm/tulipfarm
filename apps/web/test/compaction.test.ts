import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compactCommand,
  compactCommandError,
  compactionNote,
  compactionTitle,
  compactionUsage,
  compactsOnRetry,
  contextFailure,
  handoffLabel,
  offersCompact,
} from '../src/features/chat/compaction-copy.ts';
import { compactionCommand, compactionDraft, compactionErrors } from '../src/features/models/compaction-draft.ts';

test('only a whole-message /compact is a command', () => {
  assert.deepEqual(compactCommand('/compact'), {});
  assert.deepEqual(compactCommand('  /compact   '), {});
  assert.deepEqual(compactCommand('/compact  For the finance team\nKeep totals '), {
    prompt: 'For the finance team\nKeep totals',
  });
  for (const text of ['/compacted', 'please /compact', '/Compact', '/compactnow', 'compact'])
    assert.equal(compactCommand(text), null);
  assert.equal(compactCommandError(`/compact ${'x'.repeat(2000)}`), null);
  assert.match(compactCommandError(`/compact ${'x'.repeat(2001)}`) ?? '', /under 2,000 characters/u);
  assert.equal(compactCommandError('hello'), null);
});

test('the picker offers /compact for its prefixes and for instructions after it', () => {
  for (const query of ['c', 'com', 'compact', 'COMP', 'compact keep totals'])
    assert.equal(offersCompact(query), true, query);
  for (const query of ['', ' ', 'x', 'compacted', 'qualify']) assert.equal(offersCompact(query), false, query);
});

test('usage describes freed context in tokens and model-context share', () => {
  assert.equal(
    compactionUsage({ beforeTokens: 142_000, afterTokens: 51_000, windowTokens: 200_000 }),
    'About 142K → 51K tokens, 71% → 26% of the model context',
  );
  assert.equal(
    compactionUsage({ beforeTokens: 150_000, afterTokens: null, windowTokens: 200_000 }),
    'About 150K tokens of context',
  );
  assert.equal(compactionUsage({ beforeTokens: null, afterTokens: null, windowTokens: null }), null);
});

test('status copy distinguishes trigger and outcome and explains failures', () => {
  assert.equal(
    compactionTitle({ state: 'compacted', trigger: 'automatic' }),
    'Earlier messages summarized automatically',
  );
  assert.equal(compactionTitle({ state: 'compacted', trigger: 'manual' }), 'Conversation compacted');
  assert.equal(compactionTitle({ state: 'failed', trigger: 'automatic' }), 'Automatic compaction failed');
  assert.equal(compactionTitle({ state: 'compacted', trigger: 'inactivity' }), 'Automatic chat recap');
  assert.equal(compactionTitle({ state: 'failed', trigger: 'inactivity' }), 'Automatic recap needs attention');
  assert.match(compactionNote({ state: 'compacted', errorCode: null }), /full conversation stays here/u);
  assert.match(compactionNote({ state: 'failed', errorCode: 'compaction-model-unavailable' }), /Models settings/u);
  assert.match(compactionNote({ state: 'failed', errorCode: 'unknown' }), /unchanged/u);
  assert.equal(handoffLabel(null), null);
});

test('context-limit failures offer compact and retry; unavailable compaction does not', () => {
  for (const code of ['context-limit', 'compaction-paused', 'compaction-failed', 'model-context-overflow']) {
    assert.ok(contextFailure(code));
    assert.equal(compactsOnRetry(code), true);
  }
  assert.ok(contextFailure('compaction-unavailable'));
  assert.equal(compactsOnRetry('compaction-unavailable'), false);
  assert.equal(contextFailure('model-unavailable'), null);
  assert.equal(compactsOnRetry(null), false);
});

const families = [
  { id: 'claude-haiku' as const, name: 'Claude Haiku', enabled: true },
  { id: 'deepseek-flash' as const, name: 'DeepSeek Flash', enabled: true },
  { id: 'grok-fast' as const, name: 'Grok Fast', enabled: false },
];
const policy = {
  automatic: true,
  triggerPercent: 70,
  targetPercent: 30,
  modelFamilyId: 'claude-haiku' as const,
  fallbackFamilyId: null,
  outputPrompt: null,
  revision: 4,
  editorMembershipId: null,
  updatedAt: null,
  budgetFamilies: families,
};

test('the policy form validates percents, budget models, and instructions before saving', () => {
  const draft = compactionDraft(policy);
  assert.deepEqual(compactionErrors(draft, families), {});
  assert.deepEqual(Object.keys(compactionErrors({ ...draft, trigger: '30', target: '30' }, families)), ['target']);
  assert.deepEqual(Object.keys(compactionErrors({ ...draft, trigger: '100' }, families)), ['trigger']);
  assert.deepEqual(Object.keys(compactionErrors({ ...draft, target: '7.5' }, families)), ['target']);
  assert.deepEqual(Object.keys(compactionErrors({ ...draft, model: 'grok-fast' }, families)), ['model']);
  assert.deepEqual(Object.keys(compactionErrors({ ...draft, fallback: 'claude-haiku' }, families)), ['fallback']);
  assert.deepEqual(Object.keys(compactionErrors({ ...draft, prompt: 'x'.repeat(2001) }, families)), ['prompt']);
});

test('saving sends the expected revision and trims blank instructions to none', () => {
  const command = compactionCommand(
    { automatic: false, trigger: '80', target: '20', model: 'deepseek-flash', fallback: '', prompt: '   ' },
    4,
  );
  assert.match(command.requestId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(
    { ...command, requestId: '' },
    {
      requestId: '',
      expectedRevision: 4,
      automatic: false,
      triggerPercent: 80,
      targetPercent: 20,
      modelFamilyId: 'deepseek-flash',
      fallbackFamilyId: null,
      outputPrompt: null,
    },
  );
});

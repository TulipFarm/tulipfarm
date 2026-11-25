import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSessionBranchName,
  canTransitionCodeSessionStage,
  CODE_SESSION_COMMIT_TRAILER,
  codeSessionRequestAnswerSchema,
  codeSessionRequestPayloadSchema,
  codeSessionStartInputSchema,
  codeTerminalChunkSchema,
  deriveSessionTitle,
} from '../src/code-session-contracts.ts';

test('co-author trailer attributes TulipFarm commits', () => {
  assert.equal(CODE_SESSION_COMMIT_TRAILER, 'Co-Authored-By: TulipFarm <code@tulipfarm.ai>');
});

test('code session stage transitions allow lifecycle progression and reject illegal jumps', () => {
  assert.equal(canTransitionCodeSessionStage('brainstorm', 'plan'), true);
  assert.equal(canTransitionCodeSessionStage('plan', 'awaiting-plan-approval'), true);
  assert.equal(canTransitionCodeSessionStage('awaiting-plan-approval', 'code'), true);
  assert.equal(canTransitionCodeSessionStage('code', 'verify'), true);
  assert.equal(canTransitionCodeSessionStage('verify', 'pull-request'), true);
  assert.equal(canTransitionCodeSessionStage('pull-request', 'review'), true);
  assert.equal(canTransitionCodeSessionStage('review', 'awaiting-merge-approval'), true);
  assert.equal(canTransitionCodeSessionStage('awaiting-merge-approval', 'merging'), true);
  assert.equal(canTransitionCodeSessionStage('merging', 'merged'), true);
  assert.equal(canTransitionCodeSessionStage('brainstorm', 'merged'), false);
  assert.equal(canTransitionCodeSessionStage('merged', 'code'), false);
  assert.equal(canTransitionCodeSessionStage('stopped', 'code'), false);
});

test('session branch and title helpers normalize input safely', () => {
  const branch = buildSessionBranchName(
    'tulipfarm',
    'Fix OAuth callback & retry!',
    '12345678-1111-4222-8333-444444444444',
  );
  assert.equal(branch, 'tulipfarm/fix-oauth-callback-retry-12345678');
  assert.equal(deriveSessionTitle('  Add readiness probe\nwith extra details  '), 'Add readiness probe');
});

test('start input validates repository owner/name and base branch', () => {
  const valid = codeSessionStartInputSchema.parse({
    agent: 'copilot',
    repository: 'TulipFarm/tulipfarm',
    baseBranch: 'main',
  });
  assert.equal(valid.agent, 'copilot');
  assert.equal(valid.repository, 'TulipFarm/tulipfarm');

  assert.throws(() =>
    codeSessionStartInputSchema.parse({
      agent: 'copilot',
      repository: 'not-a-repo',
      baseBranch: 'main',
    }),
  );
  assert.throws(() =>
    codeSessionStartInputSchema.parse({
      agent: 'claude-code',
      repository: 'octo/app',
      baseBranch: 'bad branch with spaces',
    }),
  );
});

test('question request and answer schemas enforce structured choices and allowFreeText', () => {
  const payload = codeSessionRequestPayloadSchema.parse({
    kind: 'question',
    question: 'Which database check should readiness run?',
    questionIndex: 1,
    totalQuestions: 2,
    options: [
      { number: 1, label: 'Postgres + Temporal', recommended: true },
      { number: 2, label: 'Postgres only' },
    ],
    allowFreeText: true,
  });
  assert.equal(payload.kind, 'question');

  assert.throws(() =>
    codeSessionRequestPayloadSchema.parse({
      kind: 'question',
      question: 'Missing allowFreeText',
      questionIndex: 1,
      totalQuestions: 1,
      options: [{ number: 1, label: 'Yes' }],
    }),
  );

  const answer = codeSessionRequestAnswerSchema.parse({
    kind: 'question',
    optionNumber: 1,
    text: 'Postgres + Temporal',
  });
  assert.equal(answer.optionNumber, 1);

  const chunk = codeTerminalChunkSchema.parse({
    id: 1,
    sessionId: '12345678-1111-4222-8333-444444444444',
    stage: 'brainstorm',
    stream: 'prompt',
    chunk: '❓ Question (1/2)',
    createdAt: new Date().toISOString(),
  });
  assert.equal(chunk.stream, 'prompt');
});

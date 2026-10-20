import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitDraft, parseLimits, reachedTaskLimits } from '../src/features/tasks/limits.ts';

const start = { kind: 'start' } as const;
const valid = { toolCalls: '100', credits: '100', activeMilliseconds: '300' };

test('a new task accepts whole values inside each range and stores seconds as milliseconds', () => {
  assert.deepEqual(parseLimits(valid, start), {
    ok: true,
    limits: { toolCalls: 100, credits: 100, activeMilliseconds: 300000 },
  });
  assert.deepEqual(parseLimits({ toolCalls: '1000', credits: '1', activeMilliseconds: '3600' }, start), {
    ok: true,
    limits: { toolCalls: 1000, credits: 1, activeMilliseconds: 3600000 },
  });
});

test('a new task names the range of each invalid limit', () => {
  assert.deepEqual(parseLimits({ toolCalls: '1001', credits: '0', activeMilliseconds: '' }, start), {
    ok: false,
    errors: {
      toolCalls: 'Use 1 to 1,000 tool calls.',
      credits: 'Use 1 to 10,000 credits.',
      activeMilliseconds: 'Use 1 to 3,600 seconds.',
    },
  });
  assert.deepEqual(parseLimits({ ...valid, activeMilliseconds: '1.5' }, start), {
    ok: false,
    errors: { activeMilliseconds: 'Use 1 to 3,600 seconds.' },
  });
  assert.deepEqual(parseLimits({ ...valid, credits: 'ten' }, start), {
    ok: false,
    errors: { credits: 'Use 1 to 10,000 credits.' },
  });
});

test('a continuing task keeps its current limits as the minimums', () => {
  const reply = {
    kind: 'reply',
    task: { limits: { toolCalls: 3, credits: 250, activeMilliseconds: 300000 } },
  } as const;
  assert.deepEqual(parseLimits({ toolCalls: '3', credits: '250', activeMilliseconds: '300' }, reply), {
    ok: true,
    limits: { toolCalls: 3, credits: 250, activeMilliseconds: 300000 },
  });
  assert.deepEqual(parseLimits({ toolCalls: '2', credits: '249', activeMilliseconds: '299' }, reply), {
    ok: false,
    errors: {
      toolCalls: 'Use 3 to 1,000 tool calls.',
      credits: 'Use 250 to 10,000 credits.',
      activeMilliseconds: 'Use 300 to 3,600 seconds.',
    },
  });
  const fractional = {
    kind: 'reply',
    task: { limits: { toolCalls: 3, credits: 250, activeMilliseconds: 1500 } },
  } as const;
  assert.deepEqual(parseLimits({ toolCalls: '3', credits: '250', activeMilliseconds: '1' }, fractional), {
    ok: false,
    errors: { activeMilliseconds: 'Use 2 to 3,600 seconds.' },
  });
});

test('the inputs show the stored limits in seconds', () => {
  assert.deepEqual(limitDraft({ toolCalls: 100, credits: 100, activeMilliseconds: 300000 }), valid);
});

test('a paused task names only the limits it has used up', () => {
  const limits = { toolCalls: 3, credits: 2, activeMilliseconds: 300000 };
  const usage = (toolCalls: number, credits: string, activeMilliseconds: string) =>
    reachedTaskLimits({ limits, toolCalls, activeMilliseconds, cost: { chargedCreditUnits: credits } }).map(
      field => field.key,
    );
  assert.deepEqual(usage(1, '0', '1000'), []);
  assert.deepEqual(usage(3, '0', '1000'), ['toolCalls']);
  assert.deepEqual(usage(0, '1999999999999', '1000'), []);
  assert.deepEqual(usage(0, '2000000000000', '300000'), ['credits', 'activeMilliseconds']);
});

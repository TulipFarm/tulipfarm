import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { authoredDefinitionSchema } from '@tulipfarm/workflows/contracts';
import { definitionProblems } from '../src/features/workflows/definition-issues.ts';

const prepare = (id: string) => ({ id, kind: 'transform', fields: { total: { kind: 'input', path: ['total'] } } });
const failure = (definition: unknown) => {
  const parsed = authoredDefinitionSchema.safeParse(definition);
  assert.equal(parsed.success, false);
  return parsed.error;
};

test('definition problems name the step and the fix instead of a generic message', () => {
  const error = failure({
    version: 1,
    name: 'Orders',
    triggers: [],
    steps: [
      prepare('first'),
      {
        id: 'check',
        kind: 'condition',
        when: { left: { kind: 'input', path: ['total'] }, op: 'gt', right: { kind: 'literal', value: 100 } },
        ifMet: ['first'],
        otherwise: [],
      },
    ],
  });
  assert.deepEqual(
    definitionProblems(error, index => (index === 1 ? 'Step 2 (Check a condition)' : undefined)),
    ['Step 2 (Check a condition): A branch must name later steps.'],
  );
  assert.deepEqual(
    definitionProblems(
      failure({
        version: 1,
        name: 'Orders',
        triggers: [],
        steps: [{ id: 'call', kind: 'http', method: 'GET', url: 'http://example.com' }],
      }),
    ),
    ['Step 1: HTTP steps require an HTTPS URL.'],
  );
  assert.deepEqual(
    definitionProblems(
      failure({
        version: 1,
        name: 'Orders',
        triggers: [],
        steps: [{ id: 'call', kind: 'http', method: 'GET', url: 'example' }],
      }),
    ),
    ['Step 1: Enter a valid HTTPS URL.'],
    'a malformed URL names the step instead of failing the whole check',
  );
});

test('definition problems cover names, triggers, step counts, JSON syntax, and unknown failures', () => {
  assert.deepEqual(definitionProblems(failure({ version: 1, name: '', triggers: [], steps: [prepare('first')] })), [
    'Name: Enter a workflow name.',
  ]);
  assert.deepEqual(definitionProblems(failure({ version: 1, name: 'Orders', triggers: [], steps: [] })), [
    'Steps: Keep 1 to 32 steps.',
  ]);
  assert.deepEqual(
    definitionProblems(
      failure({
        version: 1,
        name: 'Orders',
        triggers: [
          { id: 'weekly', kind: 'event', name: 'weekly' },
          { id: 'nightly', kind: 'cron' },
        ],
        steps: [prepare('first')],
      }),
    ),
    ['Trigger 2: Check the expression.', 'Trigger 2: Check the timezone.'],
  );
  assert.deepEqual(
    definitionProblems(
      failure({
        version: 1,
        name: 'Orders',
        triggers: [
          { id: 'Bad Id', kind: 'event', name: 'weekly' },
          { id: 'hook', kind: 'webhook' },
        ],
        steps: [prepare('first')],
      }),
    ),
    [
      'Trigger 1: Use a trigger ID that starts with a lowercase letter and uses only lowercase letters, numbers, and underscores.',
    ],
    'a trigger ID problem names the trigger, not a step',
  );
  assert.deepEqual(
    definitionProblems(
      failure({
        version: 1,
        name: 'Orders',
        triggers: [
          { id: 'hook', kind: 'webhook' },
          { id: 'hook', kind: 'webhook' },
        ],
        steps: [prepare('first')],
      }),
    ),
    ['Trigger 2: Duplicate trigger ID.'],
  );
  assert.deepEqual(
    definitionProblems(
      failure({
        version: 1,
        name: 'Orders',
        triggers: Array.from({ length: 21 }, (_, index) => ({ id: `hook_${index}`, kind: 'webhook' })),
        steps: [prepare('first')],
      }),
    ),
    ['Triggers: Keep up to 20 triggers.'],
  );
  assert.deepEqual(definitionProblems(new SyntaxError('Unexpected token')), [
    'The definition is not valid JSON. Check for a missing comma, quote, or bracket.',
  ]);
  assert.deepEqual(definitionProblems(new Error('network')), [
    'The definition could not be checked. Review steps, references, and trigger settings.',
  ]);
});

test('each step problem appears once with its own fix', () => {
  const error = failure({
    version: 1,
    name: 'Orders',
    triggers: [],
    steps: [{ id: 'Bad Id', kind: 'delay', seconds: 0 }],
  });
  assert.deepEqual(definitionProblems(error), [
    'Step 1: Use a step ID that starts with a lowercase letter and uses only lowercase letters, numbers, and underscores.',
    'Step 1: Enter a valid wait length.',
  ]);
  const repeated = new z.ZodError([
    { code: 'custom', message: 'A branch must name later steps', path: ['steps', 1, 'ifMet'], input: ['first'] },
    { code: 'custom', message: 'A branch must name later steps', path: ['steps', 1, 'otherwise'], input: ['first'] },
  ]);
  assert.deepEqual(
    definitionProblems(repeated),
    ['Step 2: A branch must name later steps.'],
    'the same fix for one step appears once',
  );
});

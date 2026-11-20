import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evalCaseSchema } from '../src/contracts.ts';
import { selectSuites, suites } from '../suites/index.mjs';

test('every suite case is a valid eval case with a unique ID', () => {
  for (const suite of suites) {
    const ids = suite.cases.map(item => evalCaseSchema.parse({ priorTurns: [], ...item }).id);
    assert.equal(new Set(ids).size, ids.length, suite.name);
    assert.ok(suite.paths.length > 0, suite.name);
  }
  assert.equal(suites.find(suite => suite.name === 'guardrails').tolerance, 0);
});

test('a change runs only the suites whose source paths it touches', () => {
  const names = env => selectSuites(env).map(suite => suite.name);
  assert.deepEqual(names({}), ['tables', 'completion', 'tool-choice', 'guardrails']);
  assert.deepEqual(names({ EVALS_CHANGED_FILES: 'packages/agents/skills/table-authoring/SKILL.md' }), ['tables']);
  assert.deepEqual(names({ EVALS_CHANGED_FILES: 'apps/web/src/main.tsx\nREADME.md' }), []);
  assert.deepEqual(names({ EVALS_CHANGED_FILES: 'packages/agents/src/inference.ts', EVALS_SUITES: 'guardrails' }), [
    'guardrails',
  ]);
  assert.throws(() => selectSuites({ EVALS_SUITES: 'nope' }), /Unknown eval suite/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { stepCommand, stepResult } from '../src/workflow-code-steps.ts';

function run(language, source, input) {
  const command = stepCommand(language, source, JSON.stringify(input));
  const child = spawnSync(command.program, command.args, { encoding: 'utf8' });
  return stepResult(language, {
    state: 'completed',
    exitCode: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    truncated: false,
  });
}

const sum = {
  javascript: 'console.log("noise"); let total = 0; for (let i = 1; i <= input.n; i++) total += i; return { total };',
  typescript:
    'console.log("noise"); let total: number = 0; for (let i = 1; i <= input.n; i++) total += i; return { total };',
  python: 'print("noise")\ntotal = sum(range(1, input["n"] + 1))\nreturn {"total": total}',
};

for (const language of Object.keys(sum)) {
  test(`A ${language} step returns its value, not what it printed`, () => {
    assert.deepEqual(run(language, sum[language], { n: 5000 }), { kind: 'completed', output: { total: 12502500 } });
  });
}

test('A bash step reads $INPUT and its printed JSON becomes the output', () => {
  assert.deepEqual(run('bash', 'echo "{\\"input\\": $INPUT}"', { n: 3 }), {
    kind: 'completed',
    output: { input: { n: 3 } },
  });
  assert.deepEqual(run('bash', 'echo "  hello  "', null), { kind: 'completed', output: 'hello' });
});

test('A JavaScript step can await and use require', () => {
  const source =
    'const { basename } = require("node:path"); await new Promise(r => setTimeout(r, 1)); return basename("/a/b.txt");';
  assert.deepEqual(run('javascript', source, null), { kind: 'completed', output: 'b.txt' });
});

test('A throwing step or a step without JSON output fails', () => {
  assert.deepEqual(run('javascript', 'throw new Error("no")', null), { kind: 'failed', error: 'execution-failed' });
  assert.deepEqual(run('python', 'raise ValueError("no")', null), { kind: 'failed', error: 'execution-failed' });
  assert.deepEqual(run('python', 'return float("nan")', null), { kind: 'failed', error: 'execution-failed' });
  assert.deepEqual(run('bash', 'exit 3', null), { kind: 'failed', error: 'execution-failed' });
});

test('Machine outcomes map to step errors', () => {
  const finished = { exitCode: 0, stdout: '1', stderr: '', truncated: false };
  assert.deepEqual(stepResult('python', { ...finished, state: 'timed-out' }), { kind: 'failed', error: 'deadline' });
  assert.deepEqual(stepResult('python', { ...finished, state: 'cancelled' }), { kind: 'failed', error: 'interrupted' });
  assert.deepEqual(stepResult('python', { ...finished, state: 'completed', truncated: true }), {
    kind: 'failed',
    error: 'output-limit',
  });
  assert.deepEqual(stepResult('python', { ...finished, state: 'completed', stdout: 'not json' }), {
    kind: 'failed',
    error: 'invalid-output',
  });
});

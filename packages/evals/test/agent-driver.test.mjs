import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentDriver } from '../src/agent-driver.ts';
import { createCaps } from '../src/caps.ts';
import { evalCaseSchema } from '../src/contracts.ts';
import { runEvals } from '../src/runner.ts';

const tableId = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const fieldId = '1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c';
const definition = {
  name: 'Ops',
  instructions: 'Keep the leads table tidy.',
  tools: ['tables.list', 'rows.list', 'rows.create'],
};
const known = { kind: 'known', input: 100, output: 20, cacheRead: 5, cacheWrite: 0 };
const decided = decision => ({ kind: 'decision', decision, usage: known });

function driverWith(decisions, patch = {}) {
  const inputs = [];
  const driver = createAgentDriver({
    definition,
    scope: [],
    instructions: 'Task instructions.',
    decide: async (_model, input) => {
      inputs.push(JSON.parse(input.prompt));
      const next = decisions.shift();
      if (!next) throw new Error('no more decisions');
      return next;
    },
    price: () => 1000,
    isRead: call => call.tool.endsWith('.list'),
    live: async call => ({ items: [], tool: call.tool }),
    ...patch,
  });
  return { driver, inputs };
}

const run = (driver, checks, patch = {}) =>
  runEvals({
    cases: [evalCaseSchema.parse({ id: 'c', name: 'c', message: 'Add Acme to leads', checks, ...patch })],
    models: ['model-a'],
    repeats: 1,
    caps: createCaps({}),
    driver,
  });

test('the saved agent reads live, proposes a row, and the proposal is recorded as approved and simulated', async () => {
  const { driver, inputs } = driverWith([
    decided({ kind: 'tool', text: 'Finding the table', call: { tool: 'tables.list' } }),
    decided({
      kind: 'propose',
      text: 'Adding Acme',
      calls: [{ tool: 'rows.create', tableId, expectedAppliedRevision: 'a'.repeat(40), values: { [fieldId]: null } }],
    }),
    decided({ kind: 'answer', text: 'Added Acme to leads.' }),
  ]);
  const outcome = await run(driver, [{ kind: 'tool-called', tool: 'tables.list' }, { kind: 'approval-requested' }]);
  const [result] = outcome.results;
  assert.equal(result.pass, true, JSON.stringify(result.verdicts));
  assert.deepEqual(
    result.transcript.calls.map(call => [call.tool, call.mode, call.approval ?? false]),
    [
      ['tables.list', 'live', false],
      ['rows.create', 'simulated', true],
    ],
  );
  assert.equal(result.transcript.status, 'completed');
  assert.equal(outcome.agentUsage.requests, 3);
  assert.equal(outcome.agentUsage.inputTokens, 315);
  assert.equal(outcome.agentUsage.picoUsd, 3000);
  assert.equal(inputs[0].instructions, 'Task instructions.');
  assert.deepEqual(
    inputs[0].history.map(turn => [turn.role, turn.text]),
    [['owner', 'Add Acme to leads']],
  );
  assert.equal(inputs[1].results[0].result.tool, 'tables.list');
});

test('prior turns become history and a pinned read replaces the live one', async () => {
  const { driver, inputs } = driverWith([
    decided({ kind: 'tool', text: 'Reading', call: { tool: 'tables.list' } }),
    decided({ kind: 'clarify', text: 'Which leads table?' }),
  ]);
  const outcome = await run(driver, [{ kind: 'status', status: 'waiting' }], {
    priorTurns: [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ],
    pinnedReads: [{ tool: 'tables.list', result: { items: ['pinned'] } }],
  });
  assert.equal(outcome.results[0].pass, true);
  assert.deepEqual(
    inputs[0].history.map(turn => turn.role),
    ['owner', 'agent', 'owner'],
  );
  assert.deepEqual(inputs[1].results[0].result, { items: ['pinned'] });
});

test('a tool the agent may not use is rejected and the agent is told why', async () => {
  const { driver, inputs } = driverWith([
    decided({ kind: 'tool', text: 'Searching', call: { tool: 'knowledge.search', query: 'acme' } }),
    decided({ kind: 'answer', text: 'I could not search.', incomplete: true }),
  ]);
  const outcome = await run(driver, [{ kind: 'status', status: 'blocked' }]);
  assert.equal(outcome.results[0].pass, true);
  assert.equal(outcome.results[0].transcript.calls.length, 0);
  assert.ok(inputs[1].rejectedSteps.reasons.length > 0);
});

test('a refusal is a refused reply, and the step limit ends the reply as blocked', async () => {
  const refused = driverWith([{ kind: 'failure', reason: 'refusal', usage: known }]);
  assert.equal((await run(refused.driver, [{ kind: 'status', status: 'refused' }])).results[0].pass, true);
  const looping = driverWith(
    Array.from({ length: 3 }, () => decided({ kind: 'tool', text: 'Again', call: { tool: 'tables.list' } })),
    { maxSteps: 3 },
  );
  const outcome = await run(looping.driver, [{ kind: 'status', status: 'blocked' }]);
  assert.equal(outcome.results[0].pass, true);
  assert.equal(outcome.results[0].transcript.calls.length, 3);
});

test('a model failure fails the case with a reason', async () => {
  const { driver } = driverWith([{ kind: 'failure', reason: 'timeout', usage: { kind: 'unknown' } }]);
  const outcome = await run(driver, [{ kind: 'approval-requested' }]);
  assert.match(outcome.results[0].error, /timeout/);
});

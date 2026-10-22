import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentDraftErrors, agentDraftFooterError } from '../src/features/agents/draft.ts';

const complete = {
  name: 'Invoice follow-up',
  instructions: 'Chase invoices that are more than 30 days overdue.',
  tools: ['rows.list', 'rows.update'],
};

test('a complete agent has nothing to fix', () => {
  assert.deepEqual(agentDraftErrors(complete), {});
  assert.equal(agentDraftFooterError(agentDraftErrors(complete)), undefined);
});

test('blank name and instructions each ask for the missing text', () => {
  const errors = agentDraftErrors({ ...complete, name: '   ', instructions: '\n\t' });
  assert.deepEqual(errors, {
    name: 'Enter a name for this agent.',
    instructions: 'Write the instructions this agent follows.',
  });
  assert.equal(agentDraftFooterError(errors), 'Fix 2 fields to save the agent.');
  assert.equal(agentDraftFooterError(agentDraftErrors({ ...complete, name: '' })), 'Fix 1 field to save the agent.');
});

test('more than 20 permitted actions asks for fewer', () => {
  const tools = Array.from({ length: 21 }, (_, index) => `tool-${index}`);
  assert.deepEqual(agentDraftErrors({ ...complete, tools }), { tools: 'Choose 20 actions or fewer.' });
  assert.deepEqual(agentDraftErrors({ ...complete, tools: tools.slice(0, 20) }), {});
});

test('every problem counts once in the footer', () => {
  const tools = Array.from({ length: 25 }, (_, index) => `tool-${index}`);
  assert.equal(
    agentDraftFooterError(agentDraftErrors({ name: '', instructions: '', tools })),
    'Fix 3 fields to save the agent.',
  );
});

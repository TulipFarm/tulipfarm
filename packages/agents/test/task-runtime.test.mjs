import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcesFurtherWork } from '../src/task-runtime.ts';

test('a reply that ends by announcing its next step has not finished the work', () => {
  for (const text of [
    'Contacts has 3 rows.\n\nI will now propose adding the row…',
    'I’ll propose the new row next.',
    "Next, I'm going to read the table.",
    'Let me check the second page.',
    'The new row will have these values:',
  ])
    assert.equal(announcesFurtherWork(text), true, text);
});

test('a finished reply does not continue the task', () => {
  for (const text of [
    'Contacts has 3 rows. I proposed adding Alice for your review.',
    'The row was added.\n\nLet me know if you need anything else.',
    'I will propose the row next.\n\nI proposed adding Alice for your review.',
    'The review expired; I will propose again if needed.',
    'Once you approve, I’ll add the row.',
  ])
    assert.equal(announcesFurtherWork(text), false, text);
});

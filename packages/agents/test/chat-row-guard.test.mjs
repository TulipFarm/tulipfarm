import assert from 'node:assert/strict';
import { test } from 'node:test';
import { earlierRowWrites, namesTable } from '../src/chat-row-guard.ts';

test('a chat names a table by its title, ignoring case, punctuation and a plural s', () => {
  assert.equal(namesTable(['Add these rows to qa-rv3-mig.'], 'qa-rv3-mig'), true);
  assert.equal(namesTable(['add five fake tickets'], 'Tickets'), true);
  assert.equal(namesTable(['Add a customer called Acme'], 'Customers'), true);
  assert.equal(namesTable(['Log it in customer_orders'], 'Customer orders'), true);
});

test('a similar or partial title does not name the table', () => {
  assert.equal(namesTable(['Add these rows to qa-rv3-mig.'], 'qa-schema-mig'), false);
  assert.equal(namesTable(['Add a row to orderbook'], 'Order'), false);
  assert.equal(namesTable([], 'Tickets'), false);
});

test('earlier direct writes in a reply count their rows, and any review keeps the rest in review', () => {
  const written = (tool, result) => ({ tool, call: {}, output: { result }, drafted: false });
  assert.deepEqual(
    earlierRowWrites([
      written('rows.create.batch', { records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
      written('rows.update', { id: 'd' }),
      written('rows.create', { error: 'record-invalid' }),
      { tool: 'rows.create', call: {}, output: null, drafted: false },
    ]),
    { rows: 4, reviewing: false, singleCreate: false },
  );
  assert.equal(earlierRowWrites([written('rows.create', { id: 'e' })]).singleCreate, true);
  assert.equal(earlierRowWrites([written('rows.create.batch', { error: 'review-required' })]).reviewing, true);
  assert.equal(earlierRowWrites([{ ...written('rows.create', { draftId: 'x' }), drafted: true }]).reviewing, true);
});

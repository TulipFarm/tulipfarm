import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namesTable } from '../src/chat-row-guard.ts';

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
